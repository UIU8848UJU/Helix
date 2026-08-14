use crate::task_pool::CancellationToken;
use crate::{credential::StoredCredential, protocol::BrokerResponse};
use anyhow::{Context, Result, anyhow};
use ssh2::{CheckResult, KnownHostFileKind, Session, Sftp};
use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub struct ConnectOptions<'a> {
    pub host: &'a str,
    pub port: u16,
    pub username: Option<&'a str>,
    pub timeout_seconds: u64,
    pub strict_host_key_checking: bool,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn verify_known_host(session: &Session, host: &str, port: u16, strict: bool) -> Result<()> {
    if !strict {
        return Ok(());
    }
    let known_hosts_path = home_dir()
        .ok_or_else(|| anyhow!("cannot determine home directory for known_hosts"))?
        .join(".ssh")
        .join("known_hosts");
    if !known_hosts_path.exists() {
        return Err(anyhow!(
            "strict host key checking is enabled but {} does not exist",
            known_hosts_path.display()
        ));
    }
    let mut known_hosts = session.known_hosts()?;
    known_hosts
        .read_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
        .with_context(|| format!("failed to read {}", known_hosts_path.display()))?;
    let (key, _) = session
        .host_key()
        .ok_or_else(|| anyhow!("SSH server did not provide a host key"))?;
    match known_hosts.check_port(host, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound => Err(anyhow!("SSH host key is not present in known_hosts")),
        CheckResult::Mismatch => Err(anyhow!("SSH host key mismatch")),
        CheckResult::Failure => Err(anyhow!("failed to check SSH host key")),
    }
}

pub fn connect(options: &ConnectOptions<'_>, credential: &StoredCredential) -> Result<Session> {
    let address = format!("{}:{}", options.host, options.port);
    let socket = (options.host, options.port)
        .to_socket_addrs()
        .with_context(|| format!("failed to resolve {address}"))?
        .next()
        .ok_or_else(|| anyhow!("host did not resolve to an address: {address}"))?;
    let tcp = TcpStream::connect_timeout(
        &socket,
        Duration::from_secs(options.timeout_seconds.min(60)),
    )
    .with_context(|| format!("failed to connect to {address}"))?;

    // Do not pin OS-level read/write timeouts to the first operation. The daemon may reuse this
    // TCP/SSH Session for later commands with a different timeout; libssh2's Session timeout is
    // updated whenever a pooled Session is checked out.
    let mut session = Session::new().context("failed to create SSH session")?;
    session.set_timeout((options.timeout_seconds.saturating_mul(1000)).min(u32::MAX as u64) as u32);
    session.set_tcp_stream(tcp);
    session.handshake().context("SSH handshake failed")?;
    verify_known_host(
        &session,
        options.host,
        options.port,
        options.strict_host_key_checking,
    )?;

    let username = options
        .username
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&credential.username);
    if username.trim().is_empty() {
        return Err(anyhow!(
            "SSH username is missing from both host config and credential"
        ));
    }
    session
        .userauth_password(username, credential.secret.as_str())
        .context("SSH password authentication failed")?;
    if !session.authenticated() {
        return Err(anyhow!("SSH server rejected the credential"));
    }
    Ok(session)
}

fn bounded_text(mut bytes: Vec<u8>, max: usize) -> (String, bool) {
    let truncated = bytes.len() > max;
    if truncated {
        bytes.truncate(max);
    }
    (String::from_utf8_lossy(&bytes).into_owned(), truncated)
}

struct CapturedOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
    timed_out: bool,
}

fn append_with_shared_budget(
    destination: &mut Vec<u8>,
    bytes: &[u8],
    retained: &mut usize,
    budget: usize,
) -> bool {
    let take = bytes.len().min(budget.saturating_sub(*retained));
    destination.extend_from_slice(&bytes[..take]);
    *retained += take;
    take < bytes.len()
}

fn collect_output(
    session: &Session,
    channel: &mut ssh2::Channel,
    max_output_bytes: usize,
    timeout: Duration,
    cancellation: Option<&CancellationToken>,
) -> Result<CapturedOutput> {
    session.set_blocking(false);
    let deadline = Instant::now() + timeout;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut retained = 0;
    let mut truncated = false;
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut stdout_buffer = [0u8; 8192];
    let mut stderr_buffer = [0u8; 8192];

    while !stdout_done || !stderr_done {
        if Instant::now() >= deadline || cancellation.is_some_and(CancellationToken::is_cancelled) {
            session.set_blocking(true);
            return Ok(CapturedOutput {
                stdout,
                stderr,
                truncated,
                timed_out: true,
            });
        }
        let mut made_progress = false;
        if !stdout_done {
            match channel.read(&mut stdout_buffer) {
                Ok(0) => stdout_done = true,
                Ok(count) => {
                    made_progress = true;
                    truncated |= append_with_shared_budget(
                        &mut stdout,
                        &stdout_buffer[..count],
                        &mut retained,
                        max_output_bytes,
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => {
                    session.set_blocking(true);
                    return Err(error).context("failed to read SSH stdout");
                }
            }
        }
        if !stderr_done {
            let mut stderr_stream = channel.stderr();
            match stderr_stream.read(&mut stderr_buffer) {
                Ok(0) => stderr_done = true,
                Ok(count) => {
                    made_progress = true;
                    truncated |= append_with_shared_budget(
                        &mut stderr,
                        &stderr_buffer[..count],
                        &mut retained,
                        max_output_bytes,
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => {
                    session.set_blocking(true);
                    return Err(error).context("failed to read SSH stderr");
                }
            }
        }
        if !made_progress {
            if Instant::now() >= deadline {
                session.set_blocking(true);
                return Ok(CapturedOutput {
                    stdout,
                    stderr,
                    truncated,
                    timed_out: true,
                });
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
    session.set_blocking(true);
    Ok(CapturedOutput {
        stdout,
        stderr,
        truncated,
        timed_out: false,
    })
}

pub fn execute(
    session: &Session,
    command: &str,
    stdin_secret: Option<&Zeroizing<String>>,
    max_output_bytes: usize,
    timeout: Duration,
    cancellation: Option<&CancellationToken>,
) -> Result<BrokerResponse> {
    let started = Instant::now();
    let mut channel = session.channel_session()?;
    channel
        .exec(command)
        .context("failed to execute remote command")?;
    if let Some(secret) = stdin_secret {
        channel.write_all(secret.as_bytes())?;
        channel.write_all(b"\n")?;
        channel.flush()?;
    }
    channel.send_eof()?;

    let captured = collect_output(
        session,
        &mut channel,
        max_output_bytes,
        timeout,
        cancellation,
    )?;
    if captured.timed_out {
        let (stdout, _) = bounded_text(captured.stdout, max_output_bytes);
        let (stderr, _) = bounded_text(captured.stderr, max_output_bytes);
        return Ok(BrokerResponse {
            ok: false,
            exists: None,
            exit_code: None,
            stdout: Some(stdout),
            stderr: Some(stderr),
            timed_out: Some(true),
            truncated: Some(captured.truncated),
            duration_ms: Some(started.elapsed().as_millis()),
            error: Some("SSH command timed out".to_owned()),
        });
    }
    channel.wait_close()?;
    let exit_code = channel.exit_status().unwrap_or(-1);
    let (stdout, _) = bounded_text(captured.stdout, max_output_bytes);
    let (stderr, _) = bounded_text(captured.stderr, max_output_bytes);
    Ok(BrokerResponse {
        ok: exit_code == 0,
        exists: None,
        exit_code: Some(exit_code),
        stdout: Some(stdout),
        stderr: Some(stderr),
        timed_out: Some(false),
        truncated: Some(captured.truncated),
        duration_ms: Some(started.elapsed().as_millis()),
        error: None,
    })
}

pub fn pty_dimensions(cols: Option<u16>, rows: Option<u16>) -> (u16, u16) {
    let cols = cols.filter(|value| *value > 0).unwrap_or(80);
    let rows = rows.filter(|value| *value > 0).unwrap_or(24);
    (cols, rows)
}

/// Run a command under an allocated PTY (xterm). stdout and stderr are merged
/// by the PTY and returned as combined output. A bounded read loop enforces the
/// deadline; on timeout the response reports timed_out=true instead of failing
/// the transport.
pub fn execute_pty(
    session: &Session,
    command: &str,
    cols: Option<u16>,
    rows: Option<u16>,
    input: Option<&str>,
    max_output_bytes: usize,
    timeout: Duration,
) -> Result<BrokerResponse> {
    let started = Instant::now();
    let mut channel = session.channel_session()?;
    let (cols, rows) = pty_dimensions(cols, rows);
    channel.request_pty("xterm", None, Some((cols as u32, rows as u32, 0, 0)))?;
    channel
        .exec(command)
        .context("failed to execute remote command under PTY")?;
    if let Some(input) = input {
        channel.write_all(input.as_bytes())?;
        channel.write_all(b"\n")?;
        channel.flush()?;
    }
    channel.send_eof()?;

    let (stdout, timed_out, truncated) = if timeout.as_secs() > 0 {
        // libssh2 non-blocking mode is session-scoped; restore blocking before
        // returning so the pooled session keeps its default behavior.
        session.set_blocking(false);
        let deadline = Instant::now() + timeout;
        let mut stdout = Vec::new();
        let mut truncated = false;
        let mut timed_out = false;
        let mut buffer = [0u8; 8192];
        loop {
            match channel.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    // Bound memory during the read loop and keep draining so the
                    // remote channel window never fills and the command can exit.
                    let remaining = max_output_bytes.saturating_sub(stdout.len());
                    let take = n.min(remaining);
                    if take > 0 {
                        stdout.extend_from_slice(&buffer[..take]);
                    }
                    if take < n {
                        truncated = true;
                    }
                }
                Err(error) => {
                    if error.kind() != std::io::ErrorKind::WouldBlock {
                        session.set_blocking(true);
                        return Err(error).context("failed to read PTY output");
                    }
                    if Instant::now() >= deadline {
                        timed_out = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        session.set_blocking(true);
        (stdout, timed_out, truncated)
    } else {
        let mut stdout = Vec::new();
        channel.read_to_end(&mut stdout)?;
        let overflowed = stdout.len() > max_output_bytes;
        (stdout, false, overflowed)
    };

    if timed_out {
        let (out, truncated) = bounded_text(stdout, max_output_bytes);
        return Ok(BrokerResponse {
            ok: false,
            exists: None,
            exit_code: None,
            stdout: Some(out),
            stderr: Some(String::new()),
            timed_out: Some(true),
            truncated: Some(truncated),
            duration_ms: Some(started.elapsed().as_millis()),
            error: Some("PTY command timed out".to_string()),
        });
    }

    channel.wait_close()?;
    let exit_code = channel.exit_status().unwrap_or(-1);
    let (out, post_truncated) = bounded_text(stdout, max_output_bytes);
    Ok(BrokerResponse {
        ok: exit_code == 0,
        exists: None,
        exit_code: Some(exit_code),
        stdout: Some(out),
        stderr: Some(String::new()),
        timed_out: Some(false),
        truncated: Some(truncated || post_truncated),
        duration_ms: Some(started.elapsed().as_millis()),
        error: None,
    })
}

fn ensure_remote_dir(sftp: &Sftp, path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path == Path::new("/") {
        return Ok(());
    }
    if sftp.stat(path).is_ok() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        ensure_remote_dir(sftp, parent)?;
    }
    match sftp.mkdir(path, 0o755) {
        Ok(()) => Ok(()),
        Err(_) if sftp.stat(path).is_ok() => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to create {}", path.display())),
    }
}

fn upload_path(sftp: &Sftp, local: &Path, remote: &Path, recursive: bool) -> Result<()> {
    let metadata = fs::metadata(local)
        .with_context(|| format!("cannot read local path {}", local.display()))?;
    if metadata.is_dir() {
        if !recursive {
            return Err(anyhow!(
                "local path is a directory; recursive=true is required"
            ));
        }
        ensure_remote_dir(sftp, remote)?;
        for entry in fs::read_dir(local)? {
            let entry = entry?;
            upload_path(sftp, &entry.path(), &remote.join(entry.file_name()), true)?;
        }
        return Ok(());
    }
    if let Some(parent) = remote.parent() {
        ensure_remote_dir(sftp, parent)?;
    }
    let mut source = File::open(local)?;
    let mut destination = sftp.create(remote)?;
    std::io::copy(&mut source, &mut destination)?;
    Ok(())
}

fn is_remote_dir(stat: &ssh2::FileStat) -> bool {
    stat.perm
        .map(|perm| perm & 0o170000 == 0o040000)
        .unwrap_or(false)
}

fn download_path(sftp: &Sftp, remote: &Path, local: &Path, recursive: bool) -> Result<()> {
    let stat = sftp
        .stat(remote)
        .with_context(|| format!("cannot stat remote path {}", remote.display()))?;
    if is_remote_dir(&stat) {
        if !recursive {
            return Err(anyhow!(
                "remote path is a directory; recursive=true is required"
            ));
        }
        fs::create_dir_all(local)?;
        for (child, _) in sftp.readdir(remote)? {
            let name = child
                .file_name()
                .ok_or_else(|| anyhow!("invalid remote file name"))?;
            if name == std::ffi::OsStr::new(".") || name == std::ffi::OsStr::new("..") {
                continue;
            }
            download_path(sftp, &child, &local.join(name), true)?;
        }
        return Ok(());
    }
    if let Some(parent) = local.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut source = sftp.open(remote)?;
    let mut destination = File::create(local)?;
    std::io::copy(&mut source, &mut destination)?;
    Ok(())
}

pub fn upload(session: &Session, local: &Path, remote: &Path, recursive: bool) -> Result<()> {
    let sftp = session.sftp()?;
    upload_path(&sftp, local, remote, recursive)
}

pub fn download(session: &Session, remote: &Path, local: &Path, recursive: bool) -> Result<()> {
    let sftp = session.sftp()?;
    download_path(&sftp, remote, local, recursive)
}

#[cfg(test)]
mod output_tests {
    use super::*;

    #[test]
    fn shared_budget_is_applied_across_both_streams() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut retained = 0;
        assert!(!append_with_shared_budget(
            &mut stdout,
            &[b'o'; 800],
            &mut retained,
            1024
        ));
        assert!(append_with_shared_budget(
            &mut stderr,
            &[b'e'; 800],
            &mut retained,
            1024
        ));
        assert_eq!(stdout.len() + stderr.len(), 1024);
    }
}
