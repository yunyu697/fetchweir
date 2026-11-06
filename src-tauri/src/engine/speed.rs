// 速度计：滑动指数平均，停滞后自动归零。
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Inner {
    last_bytes: u64,
    last_at: Instant,
    ema: f64,
}

pub struct SpeedMeter {
    inner: Mutex<Inner>,
}

impl SpeedMeter {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                last_bytes: 0,
                last_at: Instant::now(),
                ema: 0.0,
            }),
        }
    }

    pub fn reset(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.last_bytes = 0;
        inner.last_at = Instant::now();
        inner.ema = 0.0;
    }

    /// 传入累计已下载字节数。
    pub fn update(&self, total_bytes: u64) {
        let mut inner = self.inner.lock().unwrap();
        let now = Instant::now();
        let elapsed = now.duration_since(inner.last_at);
        if elapsed < Duration::from_millis(150) {
            return;
        }
        let delta = total_bytes.saturating_sub(inner.last_bytes) as f64;
        let instant = delta / elapsed.as_secs_f64();
        inner.ema = if inner.ema <= 0.0 {
            instant
        } else {
            inner.ema * 0.7 + instant * 0.3
        };
        inner.last_bytes = total_bytes;
        inner.last_at = now;
    }

    pub fn bps(&self) -> u64 {
        let inner = self.inner.lock().unwrap();
        // 1 秒没有新数据视为 0，避免暂停后残留速度
        if inner.last_at.elapsed() > Duration::from_secs(1) {
            return 0;
        }
        inner.ema.max(0.0) as u64
    }
}
