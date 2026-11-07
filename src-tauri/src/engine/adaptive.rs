//! 自适应并发：按“全局连接预算”协调所有同时下载的任务。
//!
//! 单任务时预算就是该任务的连接数；多任务时预算按任务均分（余数给前几个），
//! 因此不会出现每个任务各自判定掉速、一起降到最低档的集体下探。
//!
//! 只降不升过用户的设定值：预算上限是各任务用户设定值之和，下限是任务数（每任务至少 1 条）。
//! 关闭开关时本模块不改变任何连接数。
//!
//! 阈值依据（实测见 docs/perf/adaptive-conn.md）：
//! - Wikimedia 同源 8 连接仅 288 KB/s（36 KB/s/连接），2 连接 2.47 MB/s（1.2 MB/s/连接）。
//! - 受控限速源：总并发 ≥4 时每连接 36 KB/s，≤3 时每连接 1.2 MB/s。
//! - 连续 2 个 3 秒窗口都偏低才降档，避免瞬时抖动。
//! - 连续两次降档都没有提升总速率时，恢复到“实测总速率最高的预算”，不再继续下探。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::Notify;

/// 每连接低于该速率视为“站点限制单连接/总带宽”。
pub const PER_CONN_MIN_BPS: u64 = 96 * 1024;
/// 连续偏低窗口数（窗口 = 监控 tick 3 秒）。
pub const LOW_WINDOWS_TO_DEGRADE: u32 = 2;
/// 恢复所需连续良好窗口数。
pub const GOOD_WINDOWS_TO_RECOVER: u32 = 3;
/// 起跑阶段不判定，避免首包/握手把速率拉低。
pub const WARMUP: Duration = Duration::from_secs(6);
/// 两次调整之间的最小间隔。
pub const MIN_CHANGE_GAP: Duration = Duration::from_secs(9);
/// 降档后评估是否有效的等待时间（比 MIN_CHANGE_GAP 短，便于尽快止损）。
pub const EVAL_GAP: Duration = Duration::from_secs(4);
/// 距离上次降档至少这么久才允许恢复。
pub const RECOVER_GAP: Duration = Duration::from_secs(15);
const THROTTLE_WINDOW: Duration = Duration::from_secs(10);
const THROTTLE_HITS: usize = 3;
/// 恢复判定：达到峰值的 70%。
const RECOVER_RATIO: f64 = 0.7;
/// 降档后总速率至少提升这么多才算“有效降档”。
const IMPROVE_RATIO: f64 = 1.15;
/// 只有最低并发不超过该值时才值得试探（实测断崖都在 2~3 条）。
const PROBE_MAX_CONNS: u32 = 3;

#[derive(Clone, Debug, Default)]
pub struct ConnInfo {
    pub base: u32,
    pub limit: u32,
    pub degraded: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct BudgetInfo {
    pub tasks: u32,
    pub base: u32,
    pub budget: u32,
    pub degraded: bool,
    pub reason: Option<String>,
}

/// 单任务并发闸门：只负责按当前上限发放名额，上限由全局预算下发。
struct Inner {
    base: u32,
    active: u32,
    /// 全局预算分给本任务的上限；None 表示未启用全局协调（不额外限制）。
    external: Option<u32>,
    degraded: bool,
    reason: Option<String>,
}

pub struct AdaptiveConn {
    inner: Mutex<Inner>,
    notify: Notify,
}

/// 一个并发名额。丢弃时归还；`yield_if_excess` 会在上限被调低时立刻让出。
pub struct ConnSlot<'a> {
    gate: &'a AdaptiveConn,
    held: bool,
}

fn effective(g: &Inner) -> u32 {
    g.external.map(|e| e.min(g.base)).unwrap_or(g.base).max(1)
}

/// 全局预算下限：多任务时每任务至少 1 条；单任务时不低于 2 条（1 条常被站点限速）。
fn floor_for(tasks: u32, base: u32) -> u32 {
    if tasks <= 1 {
        base.min(2).max(1)
    } else {
        tasks
    }
}

impl Drop for ConnSlot<'_> {
    fn drop(&mut self) {
        if self.held {
            let mut g = self.gate.inner.lock().unwrap();
            g.active = g.active.saturating_sub(1);
            drop(g);
            self.gate.notify.notify_waiters();
        }
    }
}

impl ConnSlot<'_> {
    /// 活跃连接数超过当前上限时，这一条应主动断开，让调度收敛到新上限。
    /// 返回 true 表示已经归还名额，调用方需要结束当前 HTTP 流（响应体随函数返回释放）。
    pub fn yield_if_excess(&mut self) -> bool {
        if !self.held {
            return false;
        }
        let mut g = self.gate.inner.lock().unwrap();
        if g.active > effective(&g) {
            g.active -= 1;
            self.held = false;
            drop(g);
            self.gate.notify.notify_waiters();
            true
        } else {
            false
        }
    }
}

impl AdaptiveConn {
    pub fn new(base: u32) -> Self {
        let base = base.clamp(1, 16);
        Self {
            inner: Mutex::new(Inner {
                base,
                active: 0,
                external: None,
                degraded: false,
                reason: None,
            }),
            notify: Notify::new(),
        }
    }

    /// 每轮下载开始时清除上一轮下发的全局上限。
    pub fn begin_run(&self) {
        let mut g = self.inner.lock().unwrap();
        g.external = None;
        g.degraded = false;
        g.reason = None;
        drop(g);
        self.notify.notify_waiters();
    }

    pub fn info(&self) -> ConnInfo {
        let g = self.inner.lock().unwrap();
        ConnInfo {
            base: g.base,
            limit: effective(&g),
            degraded: g.degraded,
            reason: g.reason.clone(),
        }
    }

    pub fn active(&self) -> u32 {
        self.inner.lock().unwrap().active
    }

    /// 全局协调器下发上限。返回 true 表示实际可用上限发生变化。
    pub fn apply_global(&self, cap: Option<u32>, reason: Option<String>) -> bool {
        let mut g = self.inner.lock().unwrap();
        let before = effective(&g);
        g.external = cap.map(|c| c.clamp(1, g.base));
        let after = effective(&g);
        g.degraded = after < g.base;
        g.reason = if g.degraded { reason } else { None };
        let changed = before != after;
        drop(g);
        if changed {
            self.notify.notify_waiters();
        }
        changed
    }

    pub async fn acquire(&self) -> ConnSlot<'_> {
        loop {
            {
                let mut g = self.inner.lock().unwrap();
                if g.active < effective(&g) {
                    g.active += 1;
                    return ConnSlot {
                        gate: self,
                        held: true,
                    };
                }
            }
            // 50ms 兜底轮询：即使漏掉一次唤醒也不会永久挂起。
            tokio::select! {
                _ = self.notify.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
        }
    }
}

struct GlobalInner {
    enabled: bool,
    tasks: u32,
    /// 各任务用户设定值之和（预算硬上限）。
    base: u32,
    budget: u32,
    low_wins: u32,
    ok_wins: u32,
    peak_bps: u64,
    last_bps: u64,
    started: Instant,
    last_change: Instant,
    degraded_at: Option<Instant>,
    throttles: Vec<Instant>,
    /// 已验证会掉速的预算档位，恢复时不回到这些值。
    bad_budgets: Vec<u32>,
    /// 当前这一档是否是“最低并发试探”。
    probing_floor: bool,
    /// 最低并发实测有效（总速率明显提升）。
    floor_ok: bool,
    last_step_bps: u64,
    last_change_was_step: bool,
    best_budget: u32,
    best_bps: u64,
    pinned: bool,
    reason: Option<String>,
}

/// 全局连接预算：同一时刻只按总吞吐做一次判断，再按任务均分下发。
pub struct GlobalBudget {
    inner: Mutex<GlobalInner>,
}

impl GlobalBudget {
    pub fn new(enabled: bool) -> Self {
        Self {
            inner: Mutex::new(GlobalInner {
                enabled,
                tasks: 0,
                base: 0,
                budget: 0,
                low_wins: 0,
                ok_wins: 0,
                peak_bps: 0,
                last_bps: 0,
                started: Instant::now(),
                last_change: Instant::now(),
                degraded_at: None,
                throttles: Vec::new(),
                bad_budgets: Vec::new(),
                probing_floor: false,
                floor_ok: false,
                last_step_bps: 0,
                last_change_was_step: false,
                best_budget: 0,
                best_bps: 0,
                pinned: false,
                reason: None,
            }),
        }
    }

    pub fn set_enabled(&self, on: bool) {
        let mut g = self.inner.lock().unwrap();
        if g.enabled == on {
            return;
        }
        g.enabled = on;
        Self::reset(&mut g);
    }

    /// 同步当前活跃任务数与用户设定值之和。任务集合变化时重新开始一轮判定。
    pub fn sync_tasks(&self, tasks: u32, base: u32) {
        let mut g = self.inner.lock().unwrap();
        if tasks == 0 || base == 0 {
            g.tasks = 0;
            g.base = 0;
            g.budget = 0;
            Self::reset(&mut g);
            return;
        }
        if g.tasks == tasks && g.base == base {
            return;
        }
        g.tasks = tasks;
        g.base = base;
        g.budget = if g.budget == 0 {
            base
        } else {
            g.budget.min(base).max(tasks)
        };
        let budget = g.budget;
        Self::reset(&mut g);
        g.budget = budget;
    }

    fn reset(g: &mut GlobalInner) {
        g.low_wins = 0;
        g.ok_wins = 0;
        g.peak_bps = 0;
        g.started = Instant::now();
        g.last_change = Instant::now();
        g.degraded_at = None;
        g.throttles.clear();
        g.bad_budgets.clear();
        g.probing_floor = false;
        g.floor_ok = false;
        g.last_step_bps = 0;
        g.last_change_was_step = false;
        g.best_budget = g.budget;
        g.best_bps = 0;
        g.pinned = false;
        g.reason = None;
    }

    pub fn info(&self) -> BudgetInfo {
        let g = self.inner.lock().unwrap();
        BudgetInfo {
            tasks: g.tasks,
            base: g.base,
            budget: g.budget,
            degraded: g.budget < g.base,
            reason: g.reason.clone(),
        }
    }

    pub fn reason(&self) -> Option<String> {
        self.inner.lock().unwrap().reason.clone()
    }

    /// 把当前预算按任务均分；余数优先给前几个任务，每个任务至少 1 条。
    pub fn alloc(&self, tasks: u32) -> Vec<u32> {
        let g = self.inner.lock().unwrap();
        if !g.enabled || tasks == 0 || g.budget == 0 {
            return Vec::new();
        }
        let total = g.budget.max(tasks);
        let each = total / tasks;
        let rem = total % tasks;
        (0..tasks).map(|i| each + if i < rem { 1 } else { 0 }).collect()
    }

    /// 采样一次全局总速率（所有活跃任务之和）。返回 true 表示预算变化。
    pub fn observe(&self, bps: u64) -> bool {
        let now = Instant::now();
        let mut g = self.inner.lock().unwrap();
        if !g.enabled || g.tasks == 0 {
            return false;
        }
        g.last_bps = bps;
        if bps > g.peak_bps {
            g.peak_bps = bps;
        }
        if now.duration_since(g.started) < WARMUP {
            return false;
        }

        let floor = floor_for(g.tasks, g.base);
        let mut since = now.duration_since(g.last_change);

        // 降档/试探之后先评估是否真的提升了总速率。
        if g.last_change_was_step && since >= EVAL_GAP {
            g.last_change_was_step = false;
            // 速率为 0 时没有可比基准，不做“无效”判断，避免把 0 当成探测失败。
            if g.last_step_bps == 0 {
                // 保持当前预算，下一轮继续按低速率判定。
            } else {
                let improved = bps as f64 >= g.last_step_bps as f64 * IMPROVE_RATIO;
            if improved {
                if g.probing_floor {
                    g.probing_floor = false;
                    g.floor_ok = true;
                }
                if bps > g.best_bps {
                    g.best_bps = bps;
                    g.best_budget = g.budget;
                }
            } else if !g.probing_floor && floor < g.budget && floor <= PROBE_MAX_CONNS {
                // 第一次降档没有提升：试探最低并发，捕捉“连接数断崖”。
                // 只在最低并发 ≤3 条时试探——实测的恢复点都出现在 2~3 条；
                // 多任务时最低并发已经 ≥4 条，再探只会白白损失总吞吐。
                if bps > g.best_bps {
                    g.best_bps = bps;
                    g.best_budget = g.budget;
                }
                let old = g.budget;
                g.bad_budgets.push(old);
                g.budget = floor;
                g.probing_floor = true;
                g.last_step_bps = bps;
                g.last_change_was_step = true;
                g.last_change = now;
                g.low_wins = 0;
                g.reason = Some(format!("降档未提升总速率，试探最低并发 {} 条", floor));
                return true;
            } else {
                // 最低并发也没有提升：回到实测最佳预算并锁定，避免继续伤害总吞吐。
                let target = if g.best_budget == 0 {
                    g.base
                } else {
                    g.best_budget.max(g.tasks).min(g.base)
                };
                g.budget = target;
                g.pinned = true;
                g.probing_floor = false;
                g.degraded_at = Some(now);
                g.last_change = now;
                g.low_wins = 0;
                g.ok_wins = 0;
                g.reason = Some(format!(
                    "降档与最低并发都未提升总速率，已恢复至 {} 条（站点总带宽受限）",
                    g.budget
                ));
                return true;
            }
            }
        }

        since = now.duration_since(g.last_change);
        if since < MIN_CHANGE_GAP {
            return false;
        }

        let per_conn = bps as f64 / g.budget.max(1) as f64;
        let low = bps == 0 || per_conn < PER_CONN_MIN_BPS as f64;

        if low {
            g.ok_wins = 0;
            if g.pinned || g.budget <= floor {
                return false;
            }
            g.low_wins += 1;
            if g.low_wins >= LOW_WINDOWS_TO_DEGRADE {
                let next = (g.budget / 2).max(floor);
                if next == g.budget {
                    return false;
                }
                // 已从最低并发恢复过、又掉速：关闭“最低并发有效”的记忆。
                if g.floor_ok && g.budget <= floor + 1 {
                    g.floor_ok = false;
                }
                if bps > g.best_bps {
                    g.best_bps = bps;
                    g.best_budget = g.budget;
                }
                let old = g.budget;
                g.bad_budgets.push(old);
                g.budget = next;
                g.degraded_at = Some(now);
                g.last_change = now;
                g.last_step_bps = bps;
                g.last_change_was_step = true;
                g.probing_floor = next == floor;
                g.low_wins = 0;
                g.reason = Some(format!(
                    "每连接仅 {} KB/s（持续 {} 秒），全局并发自动降至 {} 条",
                    per_conn as u64 / 1024,
                    LOW_WINDOWS_TO_DEGRADE * 3,
                    next
                ));
                return true;
            }
            return false;
        }

        // 速率健康：允许缓慢恢复，但不回到验证过会掉速的档位。
        g.low_wins = 0;
        g.pinned = false;
        let cap = if g.floor_ok {
            (floor + 1).min(g.base)
        } else {
            g.bad_budgets
                .iter()
                .copied()
                .min()
                .map(|m| m.saturating_sub(1))
                .unwrap_or(g.base)
                .max(floor)
        };
        if g.budget >= cap {
            return false;
        }
        let can_recover = g
            .degraded_at
            .map(|t| now.duration_since(t) >= RECOVER_GAP)
            .unwrap_or(true);
        let threshold = (g.peak_bps as f64 * RECOVER_RATIO) as u64;
        // 每连接至少达到判定阈值的 2 倍才算真正健康，否则只是站点总带宽没变。
        let healthy = per_conn >= PER_CONN_MIN_BPS as f64 * 2.0;
        if can_recover && healthy && threshold > 0 && bps >= threshold {
            g.ok_wins += 1;
            if g.ok_wins >= GOOD_WINDOWS_TO_RECOVER {
                g.budget += 1;
                g.ok_wins = 0;
                g.last_change = now;
                if g.budget >= g.base {
                    g.budget = g.base;
                    g.reason = None;
                } else {
                    g.reason = Some(format!("速率回升，全局并发恢复至 {}/{}", g.budget, g.base));
                }
                return true;
            }
        } else {
            g.ok_wins = 0;
        }
        false
    }

    /// 收到 429/503 时调用。10 秒内 3 次立即砍半。返回 true 表示预算变化。
    pub fn note_throttle(&self) -> bool {
        let now = Instant::now();
        let mut g = self.inner.lock().unwrap();
        if !g.enabled || g.tasks == 0 {
            return false;
        }
        g.throttles.retain(|t| now.duration_since(*t) < THROTTLE_WINDOW);
        g.throttles.push(now);
        let floor = floor_for(g.tasks, g.base);
        if g.throttles.len() < THROTTLE_HITS || g.budget <= floor {
            return false;
        }
        if g.last_bps > g.best_bps {
            g.best_bps = g.last_bps;
            g.best_budget = g.budget;
        }
        let old = g.budget;
        g.bad_budgets.push(old);
        g.budget = (g.budget / 2).max(floor);
        g.degraded_at = Some(now);
        g.last_change = now;
        g.last_step_bps = g.last_bps;
        g.last_change_was_step = true;
        g.low_wins = 0;
        g.ok_wins = 0;
        g.reason = Some(format!(
            "{} 秒内 {} 次 429/503，全局并发自动降至 {} 条",
            THROTTLE_WINDOW.as_secs(),
            g.throttles.len(),
            g.budget
        ));
        g.throttles.clear();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把时间戳往前拨，跳过预热与最小间隔，测试里不真的等待。
    fn age(b: &GlobalBudget, secs: u64) {
        let mut g = b.inner.lock().unwrap();
        let back = Duration::from_secs(secs);
        g.started = Instant::now() - back;
        g.last_change = Instant::now() - back;
        if let Some(t) = g.degraded_at {
            g.degraded_at = Some(t - back);
        }
    }

    fn budget(b: &GlobalBudget) -> u32 {
        b.info().budget
    }

    #[test]
    fn single_task_degrades_then_recovers() {
        let b = GlobalBudget::new(true);
        b.sync_tasks(1, 8);
        age(&b, 30);
        assert!(!b.observe(288 * 1024));
        age(&b, 30);
        assert!(b.observe(288 * 1024));
        assert_eq!(budget(&b), 4);
        // 降到 4 后仍无提升：直接试探最低并发 2。
        age(&b, 30);
        assert!(b.observe(288 * 1024));
        assert_eq!(budget(&b), 2);

        // 最低并发下速率跳到 2.4MB/s，判定探测有效。
        age(&b, 30);
        assert!(!b.observe(2_400_000));
        assert_eq!(budget(&b), 2);
        // 3 个健康窗口后恢复到 3（最低并发 + 1），不回到验证过会掉速的 4。
        for _ in 0..1 {
            age(&b, 30);
            assert!(!b.observe(2_400_000));
        }
        age(&b, 30);
        assert!(b.observe(2_400_000));
        assert_eq!(budget(&b), 3);
        assert!(b.info().degraded);
    }

    #[test]
    fn zero_speed_also_degrades() {
        let b = GlobalBudget::new(true);
        b.sync_tasks(1, 8);
        age(&b, 30);
        assert!(!b.observe(0));
        age(&b, 30);
        assert!(b.observe(0));
        assert_eq!(budget(&b), 4);
    }

    #[test]
    fn multi_task_reverts_when_degrade_does_not_help() {
        let b = GlobalBudget::new(true);
        b.sync_tasks(2, 16);
        age(&b, 30);
        assert!(!b.observe(576 * 1024));
        age(&b, 30);
        assert!(b.observe(576 * 1024));
        assert_eq!(budget(&b), 8, "16 连接被限速时先降到 8");

        // 降到 8 后总速率反而掉到 288KB/s：直接试探最低并发（每任务 1 条）。
        age(&b, 30);
        assert!(b.observe(288 * 1024));
        assert_eq!(budget(&b), 2);
        assert_eq!(b.alloc(2), vec![1, 1]);
        // 最低并发也没有提升（144KB/s）：回到实测最好的 16 条并锁定。
        age(&b, 30);
        assert!(b.observe(144 * 1024));
        assert_eq!(budget(&b), 16);
        assert!(!b.info().degraded);

        // 锁定后不再集体下探。
        age(&b, 30);
        assert!(!b.observe(144 * 1024));
        age(&b, 30);
        assert!(!b.observe(144 * 1024));
        assert_eq!(budget(&b), 16);
    }

    #[test]
    fn many_tasks_revert_without_floor_probe() {
        let b = GlobalBudget::new(true);
        b.sync_tasks(4, 32);
        age(&b, 30);
        assert!(!b.observe(1152 * 1024));
        age(&b, 30);
        assert!(b.observe(1152 * 1024));
        assert_eq!(budget(&b), 16);
        // 最低并发是 4 条（每任务 1 条），高于试探上限 3，不值得再探，直接回到 32。
        age(&b, 30);
        assert!(b.observe(576 * 1024));
        assert_eq!(budget(&b), 32);
        assert!(!b.info().degraded);
    }

    #[test]
    fn alloc_splits_budget_evenly_with_min_one() {
        let b = GlobalBudget::new(true);
        b.sync_tasks(2, 16);
        assert_eq!(b.alloc(2), vec![8, 8]);
        age(&b, 30);
        assert!(!b.observe(576 * 1024));
        age(&b, 30);
        assert!(b.observe(576 * 1024));
        assert_eq!(b.alloc(2), vec![4, 4]);

        b.sync_tasks(3, 24);
        assert_eq!(budget(&b), 8);
        assert_eq!(b.alloc(3), vec![3, 3, 2], "余数给前几个任务，每任务至少 1 条");
    }

    #[test]
    fn never_exceeds_user_base() {
        let b = GlobalBudget::new(true);
        b.sync_tasks(1, 4);
        age(&b, 30);
        assert!(!b.observe(0));
        age(&b, 30);
        assert!(b.observe(0));
        assert_eq!(budget(&b), 2);
        // 已到每任务 1 条的下限，不再继续降。
        age(&b, 30);
        assert!(!b.observe(0));
        age(&b, 30);
        assert!(!b.observe(0));
        assert_eq!(budget(&b), 2);
    }

    #[test]
    fn disabled_never_changes_budget() {
        let b = GlobalBudget::new(false);
        b.sync_tasks(1, 8);
        age(&b, 30);
        assert!(!b.observe(0));
        age(&b, 30);
        assert!(!b.observe(0));
        assert_eq!(budget(&b), 8);
        assert!(b.alloc(1).is_empty());
    }

    #[test]
    fn throttles_halve_immediately() {
        let b = GlobalBudget::new(true);
        b.sync_tasks(1, 8);
        age(&b, 30);
        assert!(!b.note_throttle());
        assert!(!b.note_throttle());
        assert!(b.note_throttle());
        assert_eq!(budget(&b), 4);
    }

    #[test]
    fn gate_respects_global_cap() {
        let gate = AdaptiveConn::new(8);
        assert!(gate.apply_global(Some(2), Some("全局并发降至 2 条".to_string())));
        let info = gate.info();
        assert_eq!(info.limit, 2);
        assert!(info.degraded);
        assert_eq!(info.reason.as_deref(), Some("全局并发降至 2 条"));
        gate.apply_global(None, None);
        assert_eq!(gate.info().limit, 8);
        assert!(!gate.info().degraded);
    }
}
