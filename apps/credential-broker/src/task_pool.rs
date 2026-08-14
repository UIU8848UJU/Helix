use crate::{
    engine::BrokerEngine,
    protocol::{BrokerRequest, BrokerResponse, DaemonResponse, TaskState},
};
use anyhow::{Context, Result, anyhow};
use std::{
    collections::HashMap,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const JANITOR_INTERVAL: Duration = Duration::from_millis(100);
const DEFAULT_RETAINED_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_RESULT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub(crate) trait TaskExecutor: Send + Sync + 'static {
    fn execute(
        &self,
        request: BrokerRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse>;

    fn pooled_sessions(&self) -> usize {
        0
    }
}

impl TaskExecutor for BrokerEngine {
    fn execute(
        &self,
        request: BrokerRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse> {
        self.handle_with_cancellation(request, cancellation)
    }

    fn pooled_sessions(&self) -> usize {
        self.pooled_sessions()
    }
}

pub(crate) trait Clock: Send + Sync + 'static {
    fn monotonic_ms(&self) -> u128;
    fn wall_ms(&self) -> u128;
}

struct SystemClock {
    origin: Instant,
    wall_origin_ms: u128,
}

impl SystemClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
            wall_origin_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        }
    }
}

impl Clock for SystemClock {
    fn monotonic_ms(&self) -> u128 {
        self.origin.elapsed().as_millis()
    }

    fn wall_ms(&self) -> u128 {
        self.wall_origin_ms + self.monotonic_ms()
    }
}

#[derive(Clone)]
pub(crate) struct TaskRecord {
    state: TaskState,
    result: Option<BrokerResponse>,
    result_bytes: usize,
    cancel_requested: bool,
    cancellation: CancellationToken,
    created_at_ms: u128,
    started_at_ms: Option<u128>,
    finished_at_ms: Option<u128>,
    finished_mono_ms: Option<u128>,
}

struct TaskStore {
    records: HashMap<String, TaskRecord>,
    accepting: bool,
    retained_bytes: usize,
}

enum Work {
    Execute {
        task_id: String,
        request: BrokerRequest,
    },
    Stop,
}

pub(crate) struct TaskPool {
    sender: Mutex<Option<SyncSender<Work>>>,
    store: Arc<(Mutex<TaskStore>, Condvar)>,
    executor: Arc<dyn TaskExecutor>,
    clock: Arc<dyn Clock>,
    workers: usize,
    handles: Mutex<Vec<JoinHandle<()>>>,
    sequence: AtomicU64,
    retention: Duration,
    retained_bytes_limit: usize,
}

impl TaskPool {
    pub(crate) fn new(
        workers: usize,
        queue_capacity: usize,
        retention: Duration,
        engine: Arc<BrokerEngine>,
    ) -> Result<Self> {
        Self::with_components(
            workers,
            queue_capacity,
            retention,
            DEFAULT_RETAINED_BYTES,
            engine,
            Arc::new(SystemClock::new()),
        )
    }

    fn with_components(
        workers: usize,
        queue_capacity: usize,
        retention: Duration,
        retained_bytes_limit: usize,
        executor: Arc<dyn TaskExecutor>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self> {
        let workers = workers.max(1);
        let (sender, receiver) = mpsc::sync_channel::<Work>(queue_capacity.max(1));
        let receiver = Arc::new(Mutex::new(receiver));
        let store = Arc::new((
            Mutex::new(TaskStore {
                records: HashMap::new(),
                accepting: true,
                retained_bytes: 0,
            }),
            Condvar::new(),
        ));
        let mut handles = Vec::with_capacity(workers);
        for index in 0..workers {
            handles.push(spawn_worker(
                index,
                Arc::clone(&receiver),
                Arc::clone(&store),
                Arc::clone(&executor),
                Arc::clone(&clock),
                retention,
                retained_bytes_limit,
                DEFAULT_RESULT_BYTES.min(retained_bytes_limit),
            )?);
        }
        Ok(Self {
            sender: Mutex::new(Some(sender)),
            store,
            executor,
            clock,
            workers,
            handles: Mutex::new(handles),
            sequence: AtomicU64::new(1),
            retention,
            retained_bytes_limit,
        })
    }

    pub(crate) fn submit(&self, request: BrokerRequest) -> Result<String> {
        cleanup_finished(&self.store, self.clock.monotonic_ms(), self.retention);
        let task_id = format!(
            "broker-{}-{}",
            self.clock.wall_ms(),
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let cancellation = CancellationToken::default();
        {
            let mut store = self.store.0.lock().map_err(lock_error)?;
            if !store.accepting {
                return Err(anyhow!("credential broker is shutting down"));
            }
            store.records.insert(
                task_id.clone(),
                TaskRecord {
                    state: TaskState::Queued,
                    result: None,
                    result_bytes: 0,
                    cancel_requested: false,
                    cancellation,
                    created_at_ms: self.clock.wall_ms(),
                    started_at_ms: None,
                    finished_at_ms: None,
                    finished_mono_ms: None,
                },
            );
        }

        let send_result = self
            .sender
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .ok_or_else(|| anyhow!("credential broker is shutting down"))?
            .try_send(Work::Execute {
                task_id: task_id.clone(),
                request,
            });
        match send_result {
            Ok(()) => Ok(task_id),
            Err(TrySendError::Full(_)) => {
                self.store
                    .0
                    .lock()
                    .map_err(lock_error)?
                    .records
                    .remove(&task_id);
                Err(anyhow!("credential broker task queue is full"))
            }
            Err(TrySendError::Disconnected(_)) => {
                self.store
                    .0
                    .lock()
                    .map_err(lock_error)?
                    .records
                    .remove(&task_id);
                Err(anyhow!("credential broker worker pool is unavailable"))
            }
        }
    }

    pub(crate) fn task(&self, task_id: &str) -> Result<TaskRecord> {
        cleanup_finished(&self.store, self.clock.monotonic_ms(), self.retention);
        self.store
            .0
            .lock()
            .map_err(lock_error)?
            .records
            .get(task_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown broker task: {task_id}"))
    }

    pub(crate) fn cancel(&self, task_id: &str) -> Result<TaskRecord> {
        let mut store = self.store.0.lock().map_err(lock_error)?;
        let now_wall = self.clock.wall_ms();
        let now_mono = self.clock.monotonic_ms();
        let task = store
            .records
            .get_mut(task_id)
            .ok_or_else(|| anyhow!("unknown broker task: {task_id}"))?;
        if task.state.is_terminal() {
            return Ok(task.clone());
        }
        task.cancel_requested = true;
        task.cancellation.cancel();
        if task.state == TaskState::Queued {
            task.state = TaskState::Cancelled;
            task.finished_at_ms = Some(now_wall);
            task.finished_mono_ms = Some(now_mono);
        }
        let response = task.clone();
        self.store.1.notify_all();
        Ok(response)
    }

    pub(crate) fn shutdown(&self, deadline: Duration) -> bool {
        let deadline = Instant::now() + deadline;
        {
            let mut store = match self.store.0.lock() {
                Ok(store) => store,
                Err(_) => return false,
            };
            store.accepting = false;
            let wall = self.clock.wall_ms();
            let mono = self.clock.monotonic_ms();
            for task in store.records.values_mut() {
                if task.state == TaskState::Queued {
                    task.cancel_requested = true;
                    task.cancellation.cancel();
                    task.state = TaskState::Cancelled;
                    task.finished_at_ms = Some(wall);
                    task.finished_mono_ms = Some(mono);
                } else if task.state == TaskState::Running {
                    task.cancel_requested = true;
                    task.cancellation.cancel();
                }
            }
        }
        self.store.1.notify_all();

        let mut store = match self.store.0.lock() {
            Ok(store) => store,
            Err(_) => return false,
        };
        while store
            .records
            .values()
            .any(|task| task.state == TaskState::Running)
        {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let result = self.store.1.wait_timeout(store, deadline - now);
            match result {
                Ok((next, _)) => store = next,
                Err(_) => return false,
            }
        }
        let drained = !store
            .records
            .values()
            .any(|task| task.state == TaskState::Running);
        if !drained {
            let wall = self.clock.wall_ms();
            let mono = self.clock.monotonic_ms();
            for task in store.records.values_mut() {
                if task.state == TaskState::Running {
                    task.state = TaskState::Cancelled;
                    task.finished_at_ms = Some(wall);
                    task.finished_mono_ms = Some(mono);
                    task.result = Some(BrokerResponse::failure(
                        "credential broker shutdown deadline elapsed",
                    ));
                    task.result_bytes = task
                        .result
                        .as_ref()
                        .and_then(|result| serde_json::to_vec(result).ok())
                        .map(|bytes| bytes.len())
                        .unwrap_or_default();
                }
            }
            recompute_retained_bytes(&mut store);
        }
        drop(store);

        if let Ok(mut sender) = self.sender.lock() {
            if let Some(sender) = sender.take() {
                for _ in 0..self.workers {
                    // Never let shutdown itself block behind a full work queue.
                    // Dropping the last sender also stops workers once cancelled
                    // queue entries have been drained.
                    let _ = sender.try_send(Work::Stop);
                }
            }
        }
        if drained {
            if let Ok(mut handles) = self.handles.lock() {
                for handle in handles.drain(..) {
                    let _ = handle.join();
                }
            }
        }
        drained
    }

    pub(crate) fn stats_response(&self) -> DaemonResponse {
        let (queued, running, retained_bytes) = self
            .store
            .0
            .lock()
            .map(|store| {
                let queued = store
                    .records
                    .values()
                    .filter(|task| task.state == TaskState::Queued)
                    .count();
                let running = store
                    .records
                    .values()
                    .filter(|task| task.state == TaskState::Running)
                    .count();
                (queued, running, store.retained_bytes)
            })
            .unwrap_or_default();
        DaemonResponse {
            workers: Some(self.workers),
            queued_tasks: Some(queued),
            running_tasks: Some(running),
            pooled_sessions: Some(self.executor.pooled_sessions()),
            retained_result_bytes: Some(retained_bytes),
            retained_result_bytes_limit: Some(self.retained_bytes_limit),
            ..DaemonResponse::success()
        }
    }

    pub(crate) fn task_response(&self, task_id: &str, task: TaskRecord) -> DaemonResponse {
        let mut response = self.stats_response();
        response.task_id = Some(task_id.to_owned());
        response.state = Some(task.state);
        response.result = task.result;
        response.cancel_requested = Some(task.cancel_requested);
        response.created_at_ms = Some(task.created_at_ms);
        response.started_at_ms = task.started_at_ms;
        response.finished_at_ms = task.finished_at_ms;
        response
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_worker(
    index: usize,
    receiver: Arc<Mutex<Receiver<Work>>>,
    store: Arc<(Mutex<TaskStore>, Condvar)>,
    executor: Arc<dyn TaskExecutor>,
    clock: Arc<dyn Clock>,
    retention: Duration,
    retained_bytes_limit: usize,
    result_bytes_limit: usize,
) -> Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("helix-broker-worker-{index}"))
        .spawn(move || {
            loop {
                let work = {
                    let Ok(receiver) = receiver.lock() else {
                        return;
                    };
                    receiver.recv_timeout(JANITOR_INTERVAL)
                };
                let Work::Execute { task_id, request } = (match work {
                    Ok(Work::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                    Err(RecvTimeoutError::Timeout) => {
                        cleanup_finished(&store, clock.monotonic_ms(), retention);
                        continue;
                    }
                    Ok(work) => work,
                }) else {
                    unreachable!()
                };

                let cancellation = {
                    let Ok(mut task_store) = store.0.lock() else {
                        return;
                    };
                    let Some(task) = task_store.records.get_mut(&task_id) else {
                        continue;
                    };
                    if task.state != TaskState::Queued {
                        continue;
                    }
                    task.state = TaskState::Running;
                    task.started_at_ms = Some(clock.wall_ms());
                    task.cancellation.clone()
                };

                let result = executor.execute(request, &cancellation);
                let Ok(mut task_store) = store.0.lock() else {
                    return;
                };
                let Some(task) = task_store.records.get_mut(&task_id) else {
                    continue;
                };
                if task.state != TaskState::Running {
                    continue;
                }
                if cancellation.is_cancelled() {
                    task.state = TaskState::Cancelled;
                    task.result = None;
                    task.result_bytes = 0;
                } else {
                    let mut response = match result {
                        Ok(response) => {
                            task.state = TaskState::Succeeded;
                            response
                        }
                        Err(error) => {
                            task.state = TaskState::Failed;
                            BrokerResponse::failure(format!("{error:#}"))
                        }
                    };
                    bound_response(&mut response, result_bytes_limit);
                    task.result_bytes = serde_json::to_vec(&response)
                        .map(|bytes| bytes.len())
                        .unwrap_or_default();
                    task.result = Some(response);
                }
                task.finished_at_ms = Some(clock.wall_ms());
                task.finished_mono_ms = Some(clock.monotonic_ms());
                recompute_retained_bytes(&mut task_store);
                evict_to_budget(&mut task_store, retained_bytes_limit);
                store.1.notify_all();
            }
        })
        .with_context(|| format!("failed to start credential broker worker thread {index}"))
}

fn bound_response(response: &mut BrokerResponse, limit: usize) {
    let mut remaining = limit;
    let mut truncated = false;
    for text in [
        &mut response.stdout,
        &mut response.stderr,
        &mut response.error,
    ]
    .into_iter()
    .flatten()
    {
        if text.len() > remaining {
            text.truncate(remaining);
            truncated = true;
        }
        remaining = remaining.saturating_sub(text.len());
    }
    if truncated {
        response.truncated = Some(true);
    }
}

fn cleanup_finished(
    store: &Arc<(Mutex<TaskStore>, Condvar)>,
    now_mono_ms: u128,
    retention: Duration,
) {
    let Ok(mut store) = store.0.lock() else {
        return;
    };
    let cutoff = now_mono_ms.saturating_sub(retention.as_millis());
    store.records.retain(|_, task| {
        !task.state.is_terminal()
            || task
                .finished_mono_ms
                .map(|finished| finished >= cutoff)
                .unwrap_or(true)
    });
    recompute_retained_bytes(&mut store);
}

fn recompute_retained_bytes(store: &mut TaskStore) {
    store.retained_bytes = store.records.values().map(|task| task.result_bytes).sum();
}

fn evict_to_budget(store: &mut TaskStore, limit: usize) {
    while store.retained_bytes > limit {
        let oldest = store
            .records
            .iter()
            .filter(|(_, task)| task.state.is_terminal() && task.result_bytes > 0)
            .min_by_key(|(task_id, task)| {
                (
                    task.finished_mono_ms.unwrap_or(u128::MAX),
                    task.created_at_ms,
                    *task_id,
                )
            })
            .map(|(task_id, _)| task_id.clone());
        let Some(task_id) = oldest else {
            break;
        };
        if let Some(task) = store.records.remove(&task_id) {
            store.retained_bytes = store.retained_bytes.saturating_sub(task.result_bytes);
        }
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> anyhow::Error {
    anyhow!("credential broker task state lock was poisoned")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct FakeClock {
        now: AtomicU64,
    }

    impl FakeClock {
        fn new(now: u64) -> Self {
            Self {
                now: AtomicU64::new(now),
            }
        }

        fn advance(&self, millis: u64) {
            self.now.fetch_add(millis, Ordering::AcqRel);
        }
    }

    impl Clock for FakeClock {
        fn monotonic_ms(&self) -> u128 {
            self.now.load(Ordering::Acquire) as u128
        }

        fn wall_ms(&self) -> u128 {
            1_700_000_000_000 + self.monotonic_ms()
        }
    }

    struct BlockingExecutor {
        invocations: AtomicUsize,
        started: (Mutex<usize>, Condvar),
        released: AtomicBool,
    }

    impl BlockingExecutor {
        fn new() -> Self {
            Self {
                invocations: AtomicUsize::new(0),
                started: (Mutex::new(0), Condvar::new()),
                released: AtomicBool::new(false),
            }
        }

        fn wait_started(&self, count: usize) {
            let mut started = self.started.0.lock().unwrap();
            while *started < count {
                started = self.started.1.wait(started).unwrap();
            }
        }

        fn release(&self) {
            self.released.store(true, Ordering::Release);
            self.started.1.notify_all();
        }
    }

    impl TaskExecutor for BlockingExecutor {
        fn execute(
            &self,
            _request: BrokerRequest,
            cancellation: &CancellationToken,
        ) -> Result<BrokerResponse> {
            self.invocations.fetch_add(1, Ordering::AcqRel);
            let mut started = self.started.0.lock().unwrap();
            *started += 1;
            self.started.1.notify_all();
            while !self.released.load(Ordering::Acquire) && !cancellation.is_cancelled() {
                started = self
                    .started
                    .1
                    .wait_timeout(started, Duration::from_millis(10))
                    .unwrap()
                    .0;
            }
            Ok(BrokerResponse::success())
        }
    }

    fn test_pool(
        workers: usize,
        queue: usize,
        budget: usize,
        executor: Arc<dyn TaskExecutor>,
        clock: Arc<dyn Clock>,
    ) -> TaskPool {
        TaskPool::with_components(
            workers,
            queue,
            Duration::from_millis(500),
            budget,
            executor,
            clock,
        )
        .unwrap()
    }

    fn wait_terminal(pool: &TaskPool, task_id: &str) -> TaskRecord {
        for _ in 0..100 {
            let task = pool.task(task_id).unwrap();
            if task.state.is_terminal() {
                return task;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("task did not finish");
    }

    #[test]
    fn queued_cancellation_never_invokes_the_executor() {
        let executor = Arc::new(BlockingExecutor::new());
        let clock = Arc::new(FakeClock::new(0));
        let pool = test_pool(1, 2, 1024, executor.clone(), clock);
        let running = pool.submit(BrokerRequest::Ping).unwrap();
        executor.wait_started(1);
        let queued = pool.submit(BrokerRequest::Ping).unwrap();
        assert_eq!(pool.cancel(&queued).unwrap().state, TaskState::Cancelled);
        executor.release();
        wait_terminal(&pool, &running);
        thread::sleep(Duration::from_millis(20));
        assert_eq!(executor.invocations.load(Ordering::Acquire), 1);
        assert!(pool.shutdown(Duration::from_secs(1)));
    }

    #[test]
    fn running_cancel_is_pending_until_executor_observes_the_token() {
        let executor = Arc::new(BlockingExecutor::new());
        let clock = Arc::new(FakeClock::new(0));
        let pool = test_pool(1, 1, 1024, executor.clone(), clock);
        let id = pool.submit(BrokerRequest::Ping).unwrap();
        executor.wait_started(1);
        let pending = pool.cancel(&id).unwrap();
        assert_eq!(pending.state, TaskState::Running);
        assert!(pending.cancel_requested);
        assert_eq!(wait_terminal(&pool, &id).state, TaskState::Cancelled);
        assert!(pool.shutdown(Duration::from_secs(1)));
    }

    #[test]
    fn concurrent_submit_ids_are_unique() {
        let executor = Arc::new(BlockingExecutor::new());
        executor.release();
        let pool = Arc::new(test_pool(
            4,
            128,
            1024 * 1024,
            executor,
            Arc::new(FakeClock::new(0)),
        ));
        let mut handles = Vec::new();
        for _ in 0..64 {
            let pool = Arc::clone(&pool);
            handles.push(thread::spawn(move || {
                pool.submit(BrokerRequest::Ping).unwrap()
            }));
        }
        let mut ids: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 64);
        assert!(pool.shutdown(Duration::from_secs(1)));
    }

    #[test]
    fn fake_monotonic_clock_drives_background_retention() {
        let executor = Arc::new(BlockingExecutor::new());
        executor.release();
        let clock = Arc::new(FakeClock::new(0));
        let pool = test_pool(1, 1, 1024, executor, clock.clone());
        let id = pool.submit(BrokerRequest::Ping).unwrap();
        wait_terminal(&pool, &id);
        clock.advance(501);
        thread::sleep(JANITOR_INTERVAL * 2);
        assert!(pool.task(&id).is_err());
        assert!(pool.shutdown(Duration::from_secs(1)));
    }

    struct FailingExecutor;

    impl TaskExecutor for FailingExecutor {
        fn execute(
            &self,
            _request: BrokerRequest,
            _cancellation: &CancellationToken,
        ) -> Result<BrokerResponse> {
            Err(anyhow!("synthetic executor failure"))
        }
    }

    #[test]
    fn executor_error_becomes_a_failed_terminal_result() {
        let pool = test_pool(
            1,
            1,
            1024,
            Arc::new(FailingExecutor),
            Arc::new(FakeClock::new(0)),
        );
        let id = pool.submit(BrokerRequest::Ping).unwrap();
        let record = wait_terminal(&pool, &id);
        assert_eq!(record.state, TaskState::Failed);
        assert!(
            record
                .result
                .and_then(|response| response.error)
                .unwrap()
                .contains("synthetic executor failure")
        );
        assert!(pool.shutdown(Duration::from_secs(1)));
    }

    #[test]
    fn queue_full_rolls_back_the_rejected_task_record() {
        let executor = Arc::new(BlockingExecutor::new());
        let pool = test_pool(1, 1, 1024, executor.clone(), Arc::new(FakeClock::new(0)));
        let first = pool.submit(BrokerRequest::Ping).unwrap();
        executor.wait_started(1);
        let second = pool.submit(BrokerRequest::Ping).unwrap();
        let error = pool.submit(BrokerRequest::Ping).unwrap_err();
        assert!(error.to_string().contains("queue is full"));
        assert_eq!(pool.stats_response().queued_tasks, Some(1));
        pool.cancel(&first).unwrap();
        pool.cancel(&second).unwrap();
        assert!(pool.shutdown(Duration::from_secs(1)));
    }

    #[test]
    fn retained_result_bytes_never_exceed_the_global_budget() {
        let pool = test_pool(
            1,
            4,
            1,
            Arc::new(FailingExecutor),
            Arc::new(FakeClock::new(0)),
        );
        let first = pool.submit(BrokerRequest::Ping).unwrap();
        for _ in 0..100 {
            if pool.task(&first).is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            pool.task(&first).is_err(),
            "oversized oldest result must be evicted"
        );
        assert_eq!(pool.stats_response().retained_result_bytes, Some(0));
        assert!(pool.shutdown(Duration::from_secs(1)));
    }
}
