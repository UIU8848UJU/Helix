use crate::{
    engine::BrokerEngine,
    ipc_security,
    protocol::{DaemonRequest, DaemonResponse},
    task_pool::TaskPool,
};
use anyhow::{Context, Result, anyhow};
use interprocess::local_socket::{GenericFilePath, ListenerOptions, prelude::*};
use std::{
    io::{BufRead, BufReader, ErrorKind, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
pub const DEFAULT_ENDPOINT: &str = r"\\.\pipe\helix-credential-broker-v1";
#[cfg(not(windows))]
pub const DEFAULT_ENDPOINT: &str = "/tmp/helix-credential-broker-v1.sock";

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_IPC_CONNECTIONS: usize = 64;
const IPC_TIMEOUT: Duration = Duration::from_secs(5);
const IPC_POLL_INTERVAL: Duration = Duration::from_millis(10);

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
    let listener_options = ListenerOptions::new()
        .name(endpoint_name)
        .try_overwrite(true);
    let listener = match ipc_security::secure_listener_options(listener_options)?.create_sync() {
        Ok(listener) => listener,
        Err(_bind_error) if compatible_daemon_is_listening(endpoint) => {
            eprintln!("compatible credential broker already owns {endpoint}");
            return Ok(());
        }
        Err(bind_error) => {
            return Err(bind_error)
                .with_context(|| format!("failed to bind broker IPC endpoint: {endpoint}"));
        }
    };

    let engine = Arc::new(BrokerEngine::new(
        session_idle_seconds,
        max_idle_sessions_per_key,
    ));
    let pool = Arc::new(TaskPool::new(
        workers,
        queue_capacity,
        Duration::from_secs(retention_seconds.max(30)),
        engine,
    )?);
    let shutdown = Arc::new(AtomicBool::new(false));
    let active_connections = Arc::new(AtomicUsize::new(0));

    eprintln!(
        "Helix credential broker daemon listening on {endpoint}; workers={}; queue_capacity={queue_capacity}",
        workers.max(1)
    );

    while !shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok(stream) => {
                if shutdown.load(Ordering::Acquire) {
                    break;
                }
                acquire_connection_slot(&active_connections);
                let pool = Arc::clone(&pool);
                let shutdown = Arc::clone(&shutdown);
                let active_connections = Arc::clone(&active_connections);
                let endpoint = endpoint.to_owned();
                let connection_guard = ConnectionGuard(active_connections);
                thread::Builder::new()
                    .name("helix-broker-ipc".to_owned())
                    .spawn(move || {
                        let _connection_guard = connection_guard;
                        match handle_connection(stream, &pool) {
                            Ok(true) => {
                                shutdown.store(true, Ordering::Release);
                                if let Err(error) = wake_listener(&endpoint) {
                                    eprintln!(
                                        "failed to wake broker listener for shutdown: {error:#}"
                                    );
                                }
                            }
                            Ok(false) => {}
                            Err(error) => eprintln!("broker IPC request failed: {error:#}"),
                        }
                    })
                    .context("failed to start broker IPC handler")?;
            }
            Err(error) => eprintln!("broker IPC accept failed: {error}"),
        }
    }
    if !pool.shutdown(IPC_TIMEOUT) {
        eprintln!(
            "credential broker shutdown deadline elapsed; process exit will stop remaining work"
        );
    }
    Ok(())
}

fn compatible_daemon_is_listening(endpoint: &str) -> bool {
    let result = (|| -> Result<bool> {
        let endpoint_name = endpoint
            .to_fs_name::<GenericFilePath>()
            .with_context(|| format!("invalid broker IPC endpoint: {endpoint}"))?;
        let mut stream = interprocess::local_socket::Stream::connect(endpoint_name)?;
        configure_client_timeouts(&stream)?;
        writeln!(stream, "{{\"op\":\"ping\"}}")?;
        stream.flush()?;
        let response: DaemonResponse =
            serde_json::from_slice(&read_request_line(BufReader::new(stream))?)?;
        Ok(response.ok
            && response.protocol_version == crate::protocol::DAEMON_PROTOCOL_VERSION
            && crate::protocol::DAEMON_CAPABILITIES.iter().all(|required| {
                response
                    .capabilities
                    .iter()
                    .any(|actual| actual == required)
            }))
    })();
    result.unwrap_or(false)
}

struct ConnectionGuard(Arc<AtomicUsize>);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire_connection_slot(active_connections: &AtomicUsize) {
    loop {
        if active_connections
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_IPC_CONNECTIONS).then_some(active + 1)
            })
            .is_ok()
        {
            return;
        }
        // Preserve the already-accepted connection instead of dropping a
        // possible shutdown request. Existing handlers have a bounded read
        // deadline, so capacity becomes available within IPC_TIMEOUT.
        thread::sleep(IPC_POLL_INTERVAL);
    }
}

fn wake_listener(endpoint: &str) -> Result<()> {
    let endpoint_name = endpoint
        .to_fs_name::<GenericFilePath>()
        .with_context(|| format!("invalid broker IPC endpoint: {endpoint}"))?;
    interprocess::local_socket::Stream::connect(endpoint_name)
        .with_context(|| format!("failed to connect to broker daemon: {endpoint}"))?;
    Ok(())
}

pub fn stop_daemon(endpoint: &str) -> Result<()> {
    let endpoint_name = endpoint
        .to_fs_name::<GenericFilePath>()
        .with_context(|| format!("invalid broker IPC endpoint: {endpoint}"))?;
    let mut stream = interprocess::local_socket::Stream::connect(endpoint_name)
        .with_context(|| format!("failed to connect to broker daemon: {endpoint}"))?;
    configure_client_timeouts(&stream)?;
    writeln!(stream, "{{\"op\":\"shutdown\"}}")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let response = read_request_line(&mut reader)?;
    let response: DaemonResponse = serde_json::from_slice(&response)?;
    if !response.ok {
        return Err(anyhow!(
            response
                .error
                .unwrap_or_else(|| "daemon shutdown failed".to_owned())
        ));
    }
    Ok(())
}

fn handle_connection(stream: interprocess::local_socket::Stream, pool: &TaskPool) -> Result<bool> {
    configure_server_read(&stream)?;
    let mut reader = BufReader::new(stream);
    let (response, shutdown) = match read_request_line(&mut reader) {
        Ok(input) => match serde_json::from_slice::<DaemonRequest>(&input) {
            Ok(request) => handle_request(request, pool),
            Err(error) => (
                DaemonResponse::failure(format!("invalid daemon request JSON: {error}")),
                false,
            ),
        },
        Err(error) => (DaemonResponse::failure(format!("{error:#}")), false),
    };
    write_response(reader.into_inner(), &response)?;
    Ok(shutdown)
}

fn write_response(
    mut stream: interprocess::local_socket::Stream,
    response: &DaemonResponse,
) -> Result<()> {
    let mut output = serde_json::to_vec(response)?;
    output.push(b'\n');
    let deadline = Instant::now() + IPC_TIMEOUT;
    let mut written = 0;
    while written < output.len() {
        match stream.write(&output[written..]) {
            Ok(0) => return Err(std::io::Error::from(ErrorKind::WriteZero).into()),
            Ok(count) => written += count,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                if Instant::now() >= deadline {
                    return Err(anyhow!("broker IPC response timed out"));
                }
                #[cfg(windows)]
                thread::sleep(IPC_POLL_INTERVAL);
            }
            Err(error) => return Err(error.into()),
        }
    }
    stream.flush()?;
    Ok(())
}

fn read_request_line(mut reader: impl BufRead) -> Result<Vec<u8>> {
    let mut input = Vec::new();
    let deadline = Instant::now() + IPC_TIMEOUT;
    loop {
        match reader.fill_buf() {
            Ok([]) => {
                #[cfg(not(windows))]
                break;
                #[cfg(windows)]
                {
                    // PIPE_NOWAIT reports an empty read while the peer is still
                    // connected but has not produced another byte yet.
                    if Instant::now() >= deadline {
                        return Err(anyhow!("broker IPC request timed out"));
                    }
                    thread::sleep(IPC_POLL_INTERVAL);
                }
            }
            Ok(available) => {
                let newline = available.iter().position(|byte| *byte == b'\n');
                let consumed = newline.map_or(available.len(), |index| index + 1);
                let payload_len = newline.unwrap_or(available.len());
                input.extend_from_slice(&available[..payload_len]);
                reader.consume(consumed);

                // Allow one possible CR until the following LF is observed, but
                // never retain more than MAX_REQUEST_BYTES + 1 bytes.
                if input.len() > MAX_REQUEST_BYTES + 1
                    || (input.len() == MAX_REQUEST_BYTES + 1 && input.last() != Some(&b'\r'))
                {
                    return Err(anyhow!("broker IPC request exceeds 4 MiB"));
                }
                if newline.is_some() {
                    if input.last() == Some(&b'\r') {
                        input.pop();
                    }
                    break;
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                if Instant::now() >= deadline {
                    return Err(anyhow!("broker IPC request timed out"));
                }
                #[cfg(windows)]
                thread::sleep(IPC_POLL_INTERVAL);
            }
            Err(error) => return Err(error.into()),
        }
    }
    if input.len() > MAX_REQUEST_BYTES {
        return Err(anyhow!("broker IPC request exceeds 4 MiB"));
    }
    Ok(input)
}

#[cfg(not(windows))]
fn configure_server_read(stream: &interprocess::local_socket::Stream) -> Result<()> {
    stream.set_recv_timeout(Some(IPC_TIMEOUT))?;
    stream.set_send_timeout(Some(IPC_TIMEOUT))?;
    Ok(())
}

#[cfg(windows)]
fn configure_server_read(stream: &interprocess::local_socket::Stream) -> Result<()> {
    // The named-pipe backend has no timeout API. Nonblocking reads plus the
    // deadline in read_request_line provide equivalent bounded behavior.
    stream.set_nonblocking(true)?;
    Ok(())
}

#[cfg(not(windows))]
fn configure_client_timeouts(stream: &interprocess::local_socket::Stream) -> Result<()> {
    stream.set_recv_timeout(Some(IPC_TIMEOUT))?;
    stream.set_send_timeout(Some(IPC_TIMEOUT))?;
    Ok(())
}

#[cfg(windows)]
fn configure_client_timeouts(stream: &interprocess::local_socket::Stream) -> Result<()> {
    stream.set_nonblocking(true)?;
    Ok(())
}

fn handle_request(request: DaemonRequest, pool: &TaskPool) -> (DaemonResponse, bool) {
    let response = match request {
        DaemonRequest::Ping => pool.stats_response(),
        DaemonRequest::Submit { request } => match pool.submit(request) {
            Ok(task_id) => match pool.task(&task_id) {
                Ok(task) => pool.task_response(&task_id, task),
                Err(error) => DaemonResponse::failure(format!("{error:#}")),
            },
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn default_endpoint_matches_platform_transport() {
        #[cfg(windows)]
        assert!(DEFAULT_ENDPOINT.starts_with(r"\\.\pipe\"));
        #[cfg(not(windows))]
        assert!(DEFAULT_ENDPOINT.ends_with(".sock"));
    }

    #[test]
    fn request_reader_accepts_the_maximum_payload() {
        let mut input = vec![b'x'; MAX_REQUEST_BYTES];
        input.push(b'\n');
        assert_eq!(
            read_request_line(Cursor::new(input)).unwrap().len(),
            MAX_REQUEST_BYTES
        );
    }

    #[test]
    fn request_reader_rejects_input_beyond_limit_while_reading() {
        let input = vec![b'x'; MAX_REQUEST_BYTES + 1];
        let error = read_request_line(Cursor::new(input)).unwrap_err();
        assert_eq!(error.to_string(), "broker IPC request exceeds 4 MiB");
    }

    #[test]
    fn request_reader_rejects_oversized_line_with_terminator() {
        let mut input = vec![b'x'; MAX_REQUEST_BYTES + 1];
        input.push(b'\n');
        let error = read_request_line(Cursor::new(input)).unwrap_err();
        assert_eq!(error.to_string(), "broker IPC request exceeds 4 MiB");
    }
}
