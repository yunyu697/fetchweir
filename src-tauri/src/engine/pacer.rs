// 全局令牌桶：按字节预算串行放行，实现全局限速。
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Pacer {
    bps: AtomicU64,
    next_free: Mutex<Instant>,
}

impl Pacer {
    pub fn new(bps: u64) -> Self {
        Self {
            bps: AtomicU64::new(bps),
            next_free: Mutex::new(Instant::now()),
        }
    }

    pub fn set_bps(&self, bps: u64) {
        self.bps.store(bps, Ordering::Relaxed);
    }

    /// 0 表示不限速。
    pub async fn consume(&self, bytes: u64) {
        let bps = self.bps.load(Ordering::Relaxed);
        if bps == 0 || bytes == 0 {
            return;
        }
        let cost = Duration::from_secs_f64(bytes as f64 / bps as f64);
        let wait = {
            let mut next = self.next_free.lock().unwrap();
            let now = Instant::now();
            let start = if *next < now { now } else { *next };
            *next = start + cost;
            start.saturating_duration_since(now)
        };
        if wait > Duration::ZERO {
            tokio::time::sleep(wait).await;
        }
    }
}
