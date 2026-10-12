//! Aggregate timings/counters only: no accounts, IDs, URLs, cursors or content.
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Default)]
pub struct Metrics {
    counters: Mutex<BTreeMap<&'static str, u64>>,
    phases: Mutex<BTreeMap<&'static str, u64>>,
}
tokio::task_local! { static CURRENT: Arc<Metrics>; }
thread_local! { static BLOCKING: RefCell<Option<Arc<Metrics>>> = const { RefCell::new(None) }; }
pub(crate) fn current() -> Option<Arc<Metrics>> {
    CURRENT
        .try_with(Arc::clone)
        .ok()
        .or_else(|| BLOCKING.with(|slot| slot.borrow().clone()))
}
pub(crate) fn count(key: &'static str, amount: u64) {
    if let Some(metrics) = current() {
        metrics.add(key, amount);
    }
}
impl Metrics {
    pub(crate) fn add(&self, key: &'static str, amount: u64) {
        if let Ok(mut counters) = self.counters.lock() {
            *counters.entry(key).or_default() += amount;
        }
    }
    pub fn snapshot(&self) -> Value {
        json!({"counters":self.counters.lock().map(|v|v.clone()).unwrap_or_default(),
            "phaseMicros":self.phases.lock().map(|v|v.clone()).unwrap_or_default()})
    }
}
pub(crate) struct Phase {
    metrics: Option<Arc<Metrics>>,
    name: &'static str,
    start: Instant,
}
impl Drop for Phase {
    fn drop(&mut self) {
        if let Some(metrics) = &self.metrics
            && let Ok(mut phases) = metrics.phases.lock()
        {
            *phases.entry(self.name).or_default() += self.start.elapsed().as_micros() as u64;
        }
    }
}
pub(crate) fn phase(name: &'static str) -> Phase {
    Phase {
        metrics: current(),
        name,
        start: Instant::now(),
    }
}
pub(crate) fn blocking<T>(metrics: Option<Arc<Metrics>>, work: impl FnOnce() -> T) -> T {
    struct Reset(Option<Arc<Metrics>>);
    impl Drop for Reset {
        fn drop(&mut self) {
            BLOCKING.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(BLOCKING.with(|slot| slot.replace(metrics)));
    work()
}
pub async fn capture<T>(work: impl std::future::Future<Output = T>) -> (T, Value) {
    let metrics = Arc::new(Metrics::default());
    let start = Instant::now();
    let output = CURRENT.scope(metrics.clone(), work).await;
    let mut report = metrics.snapshot();
    report["wallMicros"] = (start.elapsed().as_micros() as u64).into();
    (output, report)
}
