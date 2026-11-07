//! 自适应并发：站点限速时自动降低连接数，速率回升后逐个恢复。
//!
//! 只降不升过用户的设定值：`base` 是用户给定（设置页默认分段数 / 单任务覆盖值），
//! 自动策略永远在 `[floor, base]` 内调整。关闭开关时本模块不改变 limit。
//!
//! 阈值依据（实测见 docs/perf/adaptive-conn.md）：
//! - Wikimedia 同源 8 连接仅 288 KB/s（36 KB/s/连接），2 连接 2.47 MB/s（1.2 MB/s/连接）。
//!   因此“每连接低于 96 KB/s”能稳定区分被限速的 8 连接与健康的 2 连接。
//! - 连续 2 个 3 秒窗口（6 秒）都偏低才降档，避免瞬时抖动。
//! - 恢复需要 3 个窗口速率达到峰值的 70%，且距上次降档至少 15 秒，避免来回抖动。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::Notify;

/// 每连接低于该速率视为“站点限制单连接/总带宽”。
pub const PER_CONN_MIN_BPS: u64 = 96 * 1024;
/// 连续偏低窗口数（窗口 = 监控 tick 3 秒）。
pub const LOW_WINDOWS_TO_DEGRADE: u32 = 2;
/// 恢复所需连续良好窗口数。
pub const GOOD_WINDOWS_TO_RECOVER: u32 = 3;
/// 降档后的最低连接数（用户本来就设为 1 时仍保持 1）。
pub const FLOOR: u32 = 2;
/// 起跑阶段不判定，避免首包/握手把速率拉低。
pub const WARMUP: Duration = Duration::from_secs(6);
/// 两次调整之间的最小间隔。
pub const MIN_CHANGE_GAP: Duration = Duration::from_secs(9);
/// 距离上次降档至少这么久才允许恢复。
pub const RECOVER_GAP: Duration = Duration::from_secs(15);
const THROTTLE_WINDOW: Duration = Duration::from_secs(10);
const THROTTLE_HITS: usize = 3;
/// 恢复判定：达到峰值的 70%。
const RECOVER_RATIO: f64 = 0.7;

#[derive(Clone, Debug, Default)]
pub struct ConnInfo {
    pub base: u32,
    pub limit: u32,
    pub degraded: bool,
    pub reason: Option<String>,
}

struct Inner {
    base: u32,
    limit: u32,
    active: u32,
    auto: bool,
    degraded: bool,
    reason: Option<String>,
    low_wins: u32,
    ok_wins: u32,
    peak_bps: u64,
    started: Instant,
    last_change: Instant,
    degraded_at: Option<Instant>,
    throttles: Vec<Instant>,
    /// 本次任务里已经验证过会掉速的档位：不再回到这些值，避免来回抖动。
    bad_limits: Vec<u32>,
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
        if g.active > g.limit {
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
    pub fn new(base: u32, auto: bool) -> Self {
        let base = base.clamp(1, 16);
        Self {
            inner: Mutex::new(Inner {
                base,
                limit: base,
                active: 0,
                auto,
                degraded: false,
                reason: None,
                low_wins: 0,
                ok_wins: 0,
                peak_bps: 0,
                started: Instant::now(),
                last_change: Instant::now(),
                degraded_at: None,
                throttles: Vec::new(),
                bad_limits: Vec::new(),
            }),
            notify: Notify::new(),
        }
    }

    /// 每轮下载开始时复位到用户设定值。
    pub fn begin_run(&self) {
        let mut g = self.inner.lock().unwrap();
        g.limit = g.base;
        g.degraded = false;
        g.reason = None;
        g.low_wins = 0;
        g.ok_wins = 0;
        g.peak_bps = 0;
        g.started = Instant::now();
        g.last_change = Instant::now();
        g.degraded_at = None;
        g.throttles.clear();
        g.bad_limits.clear();
        // 旧一轮可能还有正在退出的分段，active 不强制清零，交给 Drop 归位。
        drop(g);
        self.notify.notify_waiters();
    }

    pub fn info(&self) -> ConnInfo {
        let g = self.inner.lock().unwrap();
        ConnInfo {
            base: g.base,
            limit: g.limit,
            degraded: g.degraded,
            reason: g.reason.clone(),
        }
    }

    pub async fn acquire(&self) -> ConnSlot<'_> {
        loop {
            {
                let mut g = self.inner.lock().unwrap();
                if g.active < g.limit {
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

    /// 采样一次。返回 true 表示档位发生变化（调用方应推送任务快照）。
    pub fn observe(&self, bps: u64) -> bool {
        let now = Instant::now();
        let mut g = self.inner.lock().unwrap();
        let changed = {
            let res = Self::step(&mut g, bps, now);
            res
        };
        if changed {
            drop(g);
            self.notify.notify_waiters();
        }
        changed
    }

    fn step(g: &mut Inner, bps: u64, now: Instant) -> bool {
        if !g.auto {
            return false;
        }
        if bps > g.peak_bps {
            g.peak_bps = bps;
        }
        if now.duration_since(g.started) < WARMUP {
            return false;
        }
        // 刚调整过就再等等，避免连续降档/抖动。
        if now.duration_since(g.last_change) < MIN_CHANGE_GAP {
            return false;
        }

        let floor = g.base.min(FLOOR).max(1);
        let per_conn = if g.limit > 0 {
            bps as f64 / g.limit as f64
        } else {
            0.0
        };
        // 实测里被限速的 8 连接经常整段 0 字节（speed=0），随后才突发一块；
        // 因此“连续窗口零速率”同样视为偏低，否则这种最典型的限速形态反而不会降档。
        let low = bps == 0 || per_conn < PER_CONN_MIN_BPS as f64;

        if low && g.limit > floor {
            g.low_wins += 1;
            g.ok_wins = 0;
            if g.low_wins >= LOW_WINDOWS_TO_DEGRADE {
                let next = (g.limit / 2).max(floor);
                g.bad_limits.push(g.limit);
                g.limit = next;
                g.low_wins = 0;
                g.degraded = true;
                g.degraded_at = Some(now);
                g.last_change = now;
                g.reason = Some(format!(
                    "每连接仅 {} KB/s（持续 {} 秒），连接数自动降至 {}",
                    per_conn as u64 / 1024,
                    (LOW_WINDOWS_TO_DEGRADE * 3),
                    next
                ));
                return true;
            }
            return false;
        }
        if low {
            // 已到最低档：不再降，但也不恢复。
            g.ok_wins = 0;
            return false;
        }

        g.low_wins = 0;
        // 曾导致掉速的档位不再尝试；恢复上限取“最小坏档位 - 1”。
        let cap = g
            .bad_limits
            .iter()
            .copied()
            .min()
            .map(|m| m.saturating_sub(1))
            .unwrap_or(g.base)
            .max(floor);
        if g.limit < cap {
            let can_recover = g
                .degraded_at
                .map(|t| now.duration_since(t) >= RECOVER_GAP)
                .unwrap_or(true);
            let threshold = (g.peak_bps as f64 * RECOVER_RATIO) as u64;
            // 每连接至少达到判定阈值的 2 倍才算真正健康，否则只是站点总带宽没变。
            let healthy = per_conn >= PER_CONN_MIN_BPS as f64 * 2.0;
            let good = healthy && threshold > 0 && bps >= threshold;
            if can_recover && good {
                g.ok_wins += 1;
                if g.ok_wins >= GOOD_WINDOWS_TO_RECOVER {
                    g.limit += 1;
                    g.ok_wins = 0;
                    g.last_change = now;
                    if g.limit >= g.base {
                        g.degraded = false;
                        g.reason = None;
                    } else {
                        g.reason = Some(format!("速率回升，连接数恢复至 {}/{}", g.limit, g.base));
                    }
                    return true;
                }
            } else {
                g.ok_wins = 0;
            }
        }
        false
    }

    /// 收到 429/503 时调用。返回 true 表示因此降了档。
    pub fn note_throttle(&self) -> bool {
        let now = Instant::now();
        let mut g = self.inner.lock().unwrap();
        if !g.auto {
            return false;
        }
        g.throttles.retain(|t| now.duration_since(*t) < THROTTLE_WINDOW);
        g.throttles.push(now);
        let floor = g.base.min(FLOOR).max(1);
        if g.throttles.len() >= THROTTLE_HITS && g.limit > floor {
            let old = g.limit;
            g.bad_limits.push(old);
            g.limit = (old / 2).max(floor);
            g.degraded = true;
            g.degraded_at = Some(now);
            g.last_change = now;
            g.low_wins = 0;
            g.ok_wins = 0;
            g.reason = Some(format!(
                "{} 秒内 {} 次 429/503，连接数自动降至 {}",
                THROTTLE_WINDOW.as_secs(),
                g.throttles.len(),
                g.limit
            ));
            g.throttles.clear();
            drop(g);
            self.notify.notify_waiters();
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把时间戳往前拨，跳过预热与最小间隔，测试里不真的等待。
    fn age(g: &AdaptiveConn, secs: u64) {
        let mut inner = g.inner.lock().unwrap();
        let back = Duration::from_secs(secs);
        inner.started = Instant::now() - back;
        inner.last_change = Instant::now() - back;
        if let Some(t) = inner.degraded_at {
            inner.degraded_at = Some(t - back);
        }
    }

    #[test]
    fn degrades_on_low_per_connection_speed() {
        let gate = AdaptiveConn::new(8, true);
        age(&gate, 30);
        // 8 连接 288 KB/s：每连接 36 KB/s，第一个窗口只累计不降。
        assert!(!gate.observe(288 * 1024));
        age(&gate, 30);
        assert!(gate.observe(288 * 1024));
        assert_eq!(gate.info().limit, 4);
        assert!(gate.info().degraded);

        age(&gate, 30);
        assert!(!gate.observe(288 * 1024));
        age(&gate, 30);
        assert!(gate.observe(288 * 1024));
        assert_eq!(gate.info().limit, 2, "288KB/s / 4 连接仍低于 96KB/s");
    }

    #[test]
    fn healthy_speed_never_degrades() {
        let gate = AdaptiveConn::new(8, true);
        age(&gate, 30);
        for _ in 0..10 {
            assert!(!gate.observe(2_470_000));
            age(&gate, 30);
        }
        assert_eq!(gate.info().limit, 8);
    }

    #[test]
    fn recovers_slowly_after_speed_returns() {
        let gate = AdaptiveConn::new(8, true);
        age(&gate, 30);
        gate.observe(288 * 1024);
        age(&gate, 30);
        gate.observe(288 * 1024);
        age(&gate, 30);
        gate.observe(288 * 1024);
        age(&gate, 30);
        gate.observe(288 * 1024);
        assert_eq!(gate.info().limit, 2);

        // 回升到 2.47MB/s：3 个窗口才恢复 1 档，避免抖动。
        age(&gate, 30);
        assert!(!gate.observe(2_470_000));
        age(&gate, 30);
        assert!(!gate.observe(2_470_000));
        age(&gate, 30);
        assert!(gate.observe(2_470_000));
        assert_eq!(gate.info().limit, 3);
    }

    #[test]
    fn does_not_oscillate_when_speed_plateaus() {
        let gate = AdaptiveConn::new(8, true);
        age(&gate, 30);
        for _ in 0..6 {
            age(&gate, 30);
            gate.observe(288 * 1024);
        }
        assert_eq!(gate.info().limit, 2);
        // 2 连接仍然只有 288 KB/s（每连接 144 KB/s）：不健康，不恢复。
        for _ in 0..6 {
            age(&gate, 10);
            gate.observe(288 * 1024);
        }
        assert_eq!(gate.info().limit, 2);
    }

    #[test]
    fn never_returns_to_a_limit_that_already_dropped() {
        let gate = AdaptiveConn::new(8, true);
        age(&gate, 30);
        for _ in 0..4 {
            age(&gate, 30);
            gate.observe(288 * 1024);
        }
        assert_eq!(gate.info().limit, 2);

        // 速率回升到 2.47 MB/s：恢复到 3（4 已被证明会掉速，不再回去）。
        age(&gate, 30);
        gate.observe(2_470_000);
        age(&gate, 30);
        gate.observe(2_470_000);
        age(&gate, 30);
        assert!(gate.observe(2_470_000));
        assert_eq!(gate.info().limit, 3);

        // 3 连接又掉到 200 KB/s：再次降档，3 进入坏档位。
        age(&gate, 30);
        gate.observe(200 * 1024);
        age(&gate, 30);
        assert!(gate.observe(200 * 1024));
        assert_eq!(gate.info().limit, 2);

        // 之后即使速率再好，也不会回到 3。
        for _ in 0..10 {
            age(&gate, 30);
            gate.observe(2_470_000);
        }
        assert_eq!(gate.info().limit, 2);
    }

    #[test]
    fn manual_setting_is_the_ceiling() {
        let gate = AdaptiveConn::new(2, true);
        age(&gate, 30);
        for _ in 0..6 {
            gate.observe(50 * 1024);
            age(&gate, 30);
        }
        let info = gate.info();
        assert_eq!(info.limit, 2);
        assert_eq!(info.base, 2);
    }

    #[test]
    fn auto_off_keeps_user_value() {
        let gate = AdaptiveConn::new(8, false);
        age(&gate, 30);
        for _ in 0..6 {
            gate.observe(10 * 1024);
            age(&gate, 30);
        }
        assert_eq!(gate.info().limit, 8);
        assert!(!gate.note_throttle());
    }

    #[test]
    fn zero_speed_windows_also_degrade() {
        // Wikimedia 8 连接的典型形态：长时间 0 字节 + 偶发突发。
        let gate = AdaptiveConn::new(8, true);
        age(&gate, 30);
        assert!(!gate.observe(0));
        age(&gate, 30);
        assert!(gate.observe(0));
        assert_eq!(gate.info().limit, 4);
    }

    #[test]
    fn throttles_cause_immediate_degrade() {
        let gate = AdaptiveConn::new(8, true);
        age(&gate, 30);
        assert!(!gate.note_throttle());
        assert!(!gate.note_throttle());
        assert!(gate.note_throttle());
        assert_eq!(gate.info().limit, 4);
        assert!(gate.info().degraded);
    }
}
