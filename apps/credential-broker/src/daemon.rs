use crate::{
    engine::BrokerEngine,
    protocol::{BrokerRequest, BrokerResponse, DaemonRequest, DaemonResponse, TaskState},
};
use anyhow::{anyhow, Context, Result};
use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
pub const DEFAULT_ENDPOINT: &str = r"\\.\pipe\helix-credential-broker-v1";
#[cfg(not(windows))]
pub const DEFAULT_ENDPOINT: &str = "/tmp/helix-credential-broker-v1.sock";

#[derive(Clone)]
struct TaskRecord {
    state: TaskState,
    result: Option<BrokerResponse>,
    cancel_requested: bool,
    created_at_ms: u128,
    started_at_ms: Option<u128>,
    finished_at_ms: Option<u128>,
}

struct QueuedTask {
    task_id: String,
    request: BrokerRequest,
}

pub struct TaskPool {
    sender: SyncSender<QueuedTask>,
    tasks: Arc<Mutex<HashMap<String, TaskRecord>>>,
    engine: Arc<BrokerEngine>,
    workers: usize,
    queued: Arc<AtomicUsize>,
    running: Arc<AtomicUsize>,
    sequence: AtomicU64,
    retention: Duration,
}

impl TaskPool {
    pub fn new(
        workers: usize,
        queue_capacity: usize,
        retention: Duration,
        engine: Arc<BrokerEngine>,
    ) -> Self {
        let workers = workers.max(1);
        let queue_capacity = queue_capacity.max(workers);
        let (sender, receiver) = mpsc::sync_channel::<QueuedTask>(queue_capacity);
        let receiver = Arc::new(Mutex::new(receiver));
        let tasks = Arc::new(Mutex::new(HashMap::<String, TaskRecord>::new()));
        let queued = Arc::new(AtomicUsize::new(0));
        let running = Arc::new(AtomicUsize::new(0));

        for index in 0..workers {
            spawn_worker(
                index,
                Arc::clone(&receiver),
                Arc::clone(&tasks),
                Arc::clone(&engine),
                Arc::clone(&queued),
                Arc::clone(&running),
            );
        }

        Self {
            sender,
            tasks,
            engine,
            workers,
            queued,
            running,
            sequence: AtomicU64::new(1),
            retention,
        }
    }

    pub fn submit(&self, request: BrokerRequest) -> Result<String> {
        self.cleanup_finished();
        let task_id = format!(
            "broker-{}-{}",
            now_ms(),
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        self.tasks.lock().map_err(lock_error)?.insert(
            task_id.clone(),
            TaskRecord {
                state: TaskState::Queued,
                result: None,
                cancel_requested: false,
                created_at_ms: now_ms(),
                started_at_ms: None,
                finished_at_ms: None,
            },
        );

        self.queued.fetch_add(1, Ordering::Relaxed);
        match self.sender.try_send(QueuedTask {
            task_id: task_id.clone(),
            request,
        }) {
            Ok(()) => Ok(task_id),
            Err(TrySendError::Full(_)) => {
                self.queued.fetch_sub(1, Ordering::Relaxed);
                self.tasks.lock().map_err(lock_error)?.remove(&task_id);
                Err(anyhow!("credential broker task queue is full"))
            }
            Err(TrySendError::Disconnected(_)) => {
                self.queued.fetch_sub(1, Ordering::Relaxed);
                self.tasks.lock().map_err(lock_error)?.remove(&task_id);
                Err(anyhow!("credential broker worker pool is unavailable"))
            }
        }
    }

    fn task(&self, task_id: &str) -> Result<TaskRecord> {
        self.cleanup_finished();
        self.tasks
            .lock()
            .map_err(lock_error)?
            .get(task_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown broker task: {task_id}"))
    }

    fn cancel(&self, task_id: &str) -> Result<TaskRecord> {
        let mut tasks = self.tasks.lock().map_err(lock_error)?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| anyhow!("unknown broker task: {task_id}"))?;
        task.cancel_requested = true;
        if task.state == TaskState::Queued {
            task.state = TaskState::Cancelled;
            task.finished_at_ms = Some(now_ms());
        }
        Ok(task.clone())
    }

    fn cleanup_finished(&self) {
        let cutoff = now_ms().saturating_sub(self.retention.as_millis());
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.retain(|_, task| {
                !task.state.is_terminal()
                    || task.finished_at_ms.map(|finished| finished >= cutoff).unwrap_or(true)
            });
        }
    }

    fn stats_response(&self) -> DaemonResponse {
        DaemonResponse {
            workers: Some(self.workers),
            queued_tasks: Some(self.queued.load(Ordering::Relaxed)),
            running_tasks: Some(self.running.load(Ordering::Relaxed)),
            pooled_sessions: Some(self.engine.pooled_sessions()),
            ..DaemonResponse::success()
        }
    }

    fn task_response(&self, task_id: &str, task: TaskRecord) -> DaemonResponse {
        DaemonResponse {
            task_id: Some(task_id.to_owned()),
            state: Some(task.state),
            result: task.result,
            cancel_requested: Some(task.cancel_requested),
            created_at_ms: Some(task.created_at_ms),
            started_at_ms: task.started_at_ms,
            finished_at_ms: task.finished_at_ms,
            workers: Some(self.workers),
            queued_tasks: Some(self.queued.load(Ordering::Relaxed)),
            running_tasks: Some(self.running.load(Ordering::Relaxed)),
            pooled_sessions: Some(self.engine.pooled_sessions()),
            ..DaemonResponse::success()
        }
    }
}

fn spawn_worker(
    index: usize,
    receiver: Arc<Mutex<Receiver<QueuedTask>>>,
    tasks: Arc<Mutex<HashMap<String, TaskRecord>>>,
    engine: Arc<BrokerEngine>,
    queued: Arc<AtomicUsize>,
    running: Arc<AtomicUsize>,
) {
    thread::Builder::new()
        .name(format!("helix-broker-worker-{index}"))
        .spawn(move || loop {
            let queued_task = {
                let Ok(receiver) = receiver.lock() else {
                    return;
                };
                match receiver.recv() {
                    Ok(task) => task,
                    Err(_) => return,
                }
            };
            queued.fetch_sub(1, Ordering::Relaxed);

            let should_run = if let Ok(mut task_map) = tasks.lock() {
                if let Some(task) = task_map.get_mut(&queued_task.task_id) {
                    if task.state == TaskState::Cancelled {
                        false
                    } else {
                        task.state = TaskState::Running;
                        task.started_at_ms = Some(now_ms());
                        true
                    }
                } else {
                    false
                }
            } else {
                false
            };
            if !should_run {
                continue;
            }

            running.fetch_add(1, Ordering::Relaxed);
            let result = engine.handle(queued_task.request);
            running.fetch_sub(1, Ordering::Relaxed);

            if let Ok(mut task_map) = tasks.lock() {
                if let Some(task) = task_map.get_mut(&queued_task.task_id) {
                    match result {
                        Ok(response) => {
                            task.state = TaskState::Succeeded;
                            task.result = Some(response);
                        }
                        Err(error) => {
                            task.state = TaskState::Failed;
                            task.result = Some(BrokerResponse::failure(format!("{error:#}")));
                        }
                    }
                    task.finished_at_ms = Some(now_ms());
                }
            }
        })
        .expect("failed to start credential broker worker thread");
}

pub fn serve_daemon(
    endpoint: &str,
    workers: usize,
    queue_capacity: usize,
    retention_seconds: u64,
    session_idle_seconds: u64,
    max_idle_sessions_per_key: usize,
) -> Result<()> {
    let endpoint_name = endpoint
        .to_fs_name::<GenericFilePath>()
        .with_context(|| format!("invalid broker IPC endpoint: {endpoint}"))?;
    let listener = ListenerOptions::new()
        .name(endpoint_name)
        .try_overwrite(true)
        .create_sync()
        .with_context(|| format!("failed to bind broker IPC endpoint: {endpoint}"))?;

    let engine = Arc::new(BrokerEngine::new(
        session_idle_seconds,
        max_idle_sessions_per_key,
    ));
    let pool = TaskPool::new(
        workers,
        queue_capacity,
        Duration::from_secs(retention_seconds.max(30)),
        engine,
    );

    eprintln!(
        "Helix credential broker daemon listening on {endpoint}; workers={}; queue_capacity={queue_capacity}",
        workers.max(1)
    );

    for connection in listener.incoming() {
        match connection {
            Ok(stream) => match handle_connection(stream, &pool) {
                Ok(true) => break,
                Ok(false) => {}
                Err(error) => eprintln!("broker IPC request failed: {error:#}"),
            },
            Err(error) => eprintln!("broker IPC accept failed: {error}"),
        }
    }
    Ok(())
}

pub fn stop_daemon(endpoint: &str) -> Result<()> {
    let endpoint_name = endpoint
        .to_fs_name::<GenericFilePath>()
        .with_context(|| format!("invalid broker IPC endpoint: {endpoint}"))?;
    let mut stream = interprocess::local_socket::Stream::connect(endpoint_name)
        .with_context(|| format!("failed to connect to broker daemon: {endpoint}"))?;
    writeln!(stream, "{{\"op\":\"shutdown\"}}")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader.read_line(&mut response)?;
    let response: DaemonResponse = serde_json::from_str(response.trim())?;
    if !response.ok {
        return Err(anyhow!(response.error.unwrap_or_else(|| "daemon shutdown failed".to_owned())));
    }
    Ok(())
}

fn handle_connection(
    stream: interprocess::local_socket::Stream,
    pool: &TaskPool,
) -> Result<bool> {
    let mut reader = BufReader::new(stream);
    let mut input = String::new();
    reader.read_line(&mut input)?;
    if input.len() > 4 * 1024 * 1024 {
        return Err(anyhow!("broker IPC request exceeds 4 MiB"));
    }
    let (response, shutdown) = match serde_json::from_str::<DaemonRequest>(input.trim()) {
        Ok(request) => handle_request(request, pool),
        Err(error) => (
            DaemonResponse::failure(format!("invalid daemon request JSON: {error}")),
            false,
        ),
    };
    let mut stream = reader.into_inner();
    writeln!(stream, "{}", serde_json::to_string(&response)?)?;
    stream.flush()?;
    Ok(shutdown)
}

fn handle_request(request: DaemonRequest, pool: &TaskPool) -> (DaemonResponse, bool) {
    let response = match request {
        DaemonRequest::Ping => pool.stats_response(),
        DaemonRequest::Submit { request } => match pool.submit(request) {
            Ok(task_id) => {
                let task = pool.task(&task_id).expect("newly submitted task must exist");
                pool.task_response(&task_id, task)
            }
            Err(error) => DaemonResponse::failure(format!("{error:#}")),
        },
        DaemonRequest::TaskStatus { task_id } => match pool.task(&task_id) {
            Ok(task) => pool.task_response(&task_id, task),
            Err(error) => DaemonResponse::failure(format!("{error:#}")),
        },
        DaemonRequest::TaskCancel { task_id } => match pool.cancel(&task_id) {
            Ok(task) => pool.task_response(&task_id, task),
            Err(error) => DaemonResponse::failure(format!("{error:#}")),
        },
        DaemonRequest::Shutdown => return (pool.stats_response(), true),
    };
    (response, false)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> anyhow::Error {
    anyhow!("credential broker task state lock was poisoned")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_task_state_is_detected() {
        assert!(!TaskState::Queued.is_terminal());
        assert!(!TaskState::Running.is_terminal());
        assert!(TaskState::Succeeded.is_terminal());
        assert!(TaskState::Failed.is_terminal());
        assert!(TaskState::Cancelled.is_terminal());
    }

    #[test]
    fn default_endpoint_matches_platform_transport() {
        #[cfg(windows)]
        assert!(DEFAULT_ENDPOINT.starts_with(r"\\.\pipe\"));
        #[cfg(not(windows))]
        assert!(DEFAULT_ENDPOINT.ends_with(".sock"));
    }
}
