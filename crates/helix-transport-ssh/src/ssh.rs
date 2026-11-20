use anyhow::{Context, Result, anyhow};
use helix_core::protocol::BrokerResponse;
use helix_core::task_pool::CancellationToken;
use helix_core::transport::ProgressSink;
use helix_credential::credential::StoredCredential;
use ssh2::{CheckResult, KnownHostFileKind, Session, Sftp};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
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
    pub identity_file: Option<&'a str>,
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

pub fn connect(
    options: &ConnectOptions<'_>,
    credential: Option<&StoredCredential>,
) -> Result<Session> {
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

    let username = match (
        options
            .username
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        credential,
    ) {
        (Some(username), _) => username.to_owned(),
        (None, Some(credential)) if !credential.username.trim().is_empty() => {
            credential.username.clone()
        }
        _ => {
            return Err(anyhow!(
                "SSH username is missing from both host config and credential"
            ));
        }
    };
    match (options.identity_file, credential) {
        (Some(path), _) => {
            // Pass the adjacent `.pub` file when present: libssh2 can derive
            // it from the private key only for formats it understands, while
            // OpenSSH-format private keys are easiest to pair with their .pub.
            let public_key = PathBuf::from(format!("{path}.pub"));
            let public_key = public_key.exists().then_some(public_key);
            if let Err(error) = session.userauth_pubkey_file(
                &username,
                public_key.as_deref(),
                Path::new(path),
                None,
            ) {
                return Err(
                    anyhow::Error::new(crate::error::TransportError::Authentication)
                        .context(format!("SSH key authentication failed: {error}")),
                );
            }
        }
        (None, Some(credential)) => {
            if let Err(error) = session.userauth_password(&username, credential.secret.as_str()) {
                return Err(
                    anyhow::Error::new(crate::error::TransportError::Authentication)
                        .context(format!("SSH password authentication failed: {error}")),
                );
            }
        }
        (None, None) => {
            return Err(anyhow!(
                "password authentication requires a stored credential"
            ));
        }
    }
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
    (helix_core::output::decode_remote_output(&bytes), truncated)
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
            ..BrokerResponse::success()
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
        ..BrokerResponse::success()
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
            ..BrokerResponse::success()
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
        ..BrokerResponse::success()
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

const SFTP_CHUNK_SIZE: usize = 256 * 1024;

/// Per-transfer state shared by the copy loop, progress reporting and cleanup.
pub struct TransferContext<'a> {
    pub task_id: &'a str,
    pub cancellation: &'a CancellationToken,
    pub progress: &'a dyn ProgressSink,
    pub deadline: Instant,
}

impl TransferContext<'_> {
    fn check_interrupt(&self) -> Result<()> {
        if self.cancellation.is_cancelled() {
            return Err(crate::error::TransportError::Cancelled.into());
        }
        if Instant::now() >= self.deadline {
            return Err(crate::error::TransportError::Timeout.into());
        }
        Ok(())
    }
}

fn copy_with_progress<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    context: &TransferContext<'_>,
    progress_offset: u64,
    progress_total: Option<u64>,
) -> Result<u64> {
    let mut buffer = vec![0u8; SFTP_CHUNK_SIZE];
    let mut done = 0u64;
    loop {
        context.check_interrupt()?;
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(done),
            Ok(read) => {
                write_all_retrying(writer, &buffer[..read], context)?;
                done += read as u64;
                context
                    .progress
                    .report(progress_offset + done, progress_total);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(error).context("failed to read transfer data"),
        }
    }
}

fn write_all_retrying<W: Write>(
    writer: &mut W,
    mut chunk: &[u8],
    context: &TransferContext<'_>,
) -> Result<()> {
    while !chunk.is_empty() {
        context.check_interrupt()?;
        match writer.write(chunk) {
            Ok(0) => thread::sleep(Duration::from_millis(2)),
            Ok(written) => chunk = &chunk[written..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(error).context("failed to write transfer data"),
        }
    }
    Ok(())
}

fn part_path(target: &Path, task_id: &str) -> PathBuf {
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let sanitized: String = task_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    target.with_file_name(format!("{name}.helix.part.{sanitized}"))
}

fn replace_remote_file(sftp: &Sftp, part: &Path, target: &Path) -> Result<()> {
    // `posix-rename@openssh.com` is the only replace path that works on SFTP
    // v3 servers; libssh2 silently drops the OVERWRITE flag there.
    if sftp.posix_rename(part, target).is_ok() {
        return Ok(());
    }
    let flags =
        Some(ssh2::RenameFlags::OVERWRITE | ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::NATIVE);
    match sftp.rename(part, target, flags) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Only retry when the failure is a generic FX_FAILURE and the
            // target really exists; never delete anything on other errors.
            if sftp.stat(target).is_ok() {
                let _ = sftp.unlink(target);
                if sftp.rename(part, target, flags).is_ok() {
                    return Ok(());
                }
            }
            Err(error).with_context(|| {
                format!(
                    "failed to rename {} to {}",
                    part.display(),
                    target.display()
                )
            })
        }
    }
}

fn replace_local_file(part: &Path, target: &Path) -> Result<()> {
    if target.exists() {
        // Windows cannot rename over an existing file; this makes the local
        // replacement non-atomic there, which is documented behavior.
        let _ = fs::remove_file(target);
    }
    fs::rename(part, target).with_context(|| {
        format!(
            "failed to rename {} to {}",
            part.display(),
            target.display()
        )
    })
}

fn upload_file(
    sftp: &Sftp,
    local: &Path,
    remote: &Path,
    context: &TransferContext<'_>,
    progress_offset: u64,
    progress_total: Option<u64>,
) -> Result<()> {
    let part = part_path(remote, context.task_id);
    let written = (|| -> Result<()> {
        let mut source = File::open(local)
            .with_context(|| format!("cannot read local path {}", local.display()))?;
        let mut destination = sftp.create(&part)?;
        copy_with_progress(
            &mut source,
            &mut destination,
            context,
            progress_offset,
            progress_total,
        )?;
        Ok(())
    })();
    match written.and_then(|()| replace_remote_file(sftp, &part, remote)) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = sftp.unlink(&part);
            Err(error)
        }
    }
}

fn upload_path(
    sftp: &Sftp,
    local: &Path,
    remote: &Path,
    recursive: bool,
    context: &TransferContext<'_>,
    progress_offset: &mut u64,
    progress_total: Option<u64>,
) -> Result<()> {
    context.check_interrupt()?;
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
            upload_path(
                sftp,
                &entry.path(),
                &remote.join(entry.file_name()),
                true,
                context,
                progress_offset,
                progress_total,
            )?;
        }
        return Ok(());
    }
    if let Some(parent) = remote.parent() {
        ensure_remote_dir(sftp, parent)?;
    }
    let size = metadata.len();
    upload_file(
        sftp,
        local,
        remote,
        context,
        *progress_offset,
        progress_total,
    )?;
    *progress_offset += size;
    Ok(())
}

fn is_remote_dir(stat: &ssh2::FileStat) -> bool {
    stat.perm
        .map(|perm| perm & 0o170000 == 0o040000)
        .unwrap_or(false)
}

fn download_file(
    sftp: &Sftp,
    remote: &Path,
    local: &Path,
    context: &TransferContext<'_>,
    progress_offset: u64,
    progress_total: Option<u64>,
) -> Result<()> {
    if let Some(parent) = local.parent() {
        fs::create_dir_all(parent)?;
    }
    let part = part_path(local, context.task_id);
    let written = (|| -> Result<()> {
        let mut source = sftp.open(remote)?;
        let mut destination = File::create(&part)?;
        copy_with_progress(
            &mut source,
            &mut destination,
            context,
            progress_offset,
            progress_total,
        )?;
        Ok(())
    })();
    match written.and_then(|()| replace_local_file(&part, local)) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&part);
            Err(error)
        }
    }
}

fn download_path(
    sftp: &Sftp,
    remote: &Path,
    local: &Path,
    recursive: bool,
    context: &TransferContext<'_>,
    progress_offset: &mut u64,
    progress_total: Option<u64>,
) -> Result<()> {
    context.check_interrupt()?;
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
            download_path(
                sftp,
                &child,
                &local.join(name),
                true,
                context,
                progress_offset,
                progress_total,
            )?;
        }
        return Ok(());
    }
    let size = stat.size.unwrap_or(0);
    download_file(
        sftp,
        remote,
        local,
        context,
        *progress_offset,
        progress_total,
    )?;
    *progress_offset += size;
    Ok(())
}

/// Sum every regular file under `path` without following symlinks.
pub fn local_tree_size(path: &Path) -> io::Result<u64> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if !metadata.is_dir() {
        return Ok(metadata.len());
    }
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        total += local_tree_size(&entry?.path())?;
    }
    Ok(total)
}

fn remote_tree_size(sftp: &Sftp, path: &Path) -> Result<u64> {
    let stat = sftp.lstat(path)?;
    if stat.perm.is_some_and(|perm| perm & 0o170000 == 0o120000) {
        return Ok(0);
    }
    if !is_remote_dir(&stat) {
        return Ok(stat.size.unwrap_or(0));
    }
    let mut total = 0u64;
    for (child, _) in sftp.readdir(path)? {
        let name = child
            .file_name()
            .ok_or_else(|| anyhow!("invalid remote file name"))?;
        if name == std::ffi::OsStr::new(".") || name == std::ffi::OsStr::new("..") {
            continue;
        }
        total += remote_tree_size(sftp, &child)?;
    }
    Ok(total)
}

pub fn upload(
    session: &Session,
    local: &Path,
    remote: &Path,
    recursive: bool,
    context: &TransferContext<'_>,
) -> Result<()> {
    let sftp = session.sftp()?;
    // Compute the tree total exactly once at the entry point so every file
    // reports against the same denominator.
    let total = Some(local_tree_size(local).unwrap_or(0));
    let mut offset = 0u64;
    upload_path(&sftp, local, remote, recursive, context, &mut offset, total)
}

pub fn download(
    session: &Session,
    remote: &Path,
    local: &Path,
    recursive: bool,
    context: &TransferContext<'_>,
) -> Result<()> {
    let sftp = session.sftp()?;
    let total = Some(remote_tree_size(&sftp, remote).unwrap_or(0));
    let mut offset = 0u64;
    download_path(&sftp, remote, local, recursive, context, &mut offset, total)
}

#[cfg(test)]
mod transfer_tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingSink {
        reports: Mutex<Vec<(u64, Option<u64>)>>,
    }

    impl ProgressSink for RecordingSink {
        fn report(&self, done: u64, total: Option<u64>) {
            self.reports.lock().unwrap().push((done, total));
        }
    }

    fn context<'a>(
        sink: &'a RecordingSink,
        cancellation: &'a CancellationToken,
    ) -> TransferContext<'a> {
        TransferContext {
            task_id: "broker-1-1",
            cancellation,
            progress: sink,
            deadline: Instant::now() + Duration::from_secs(5),
        }
    }

    #[test]
    fn copy_reports_progress_per_chunk_and_copies_every_byte() {
        let data = vec![7u8; 600 * 1024];
        let mut reader = &data[..];
        let mut output = Vec::new();
        let sink = RecordingSink::default();
        let cancellation = CancellationToken::default();
        let context = context(&sink, &cancellation);
        let done =
            copy_with_progress(&mut reader, &mut output, &context, 0, Some(600 * 1024)).unwrap();
        assert_eq!(done, 600 * 1024);
        assert_eq!(output.len(), 600 * 1024);
        let reports = sink.reports.lock().unwrap();
        assert!(reports.len() >= 2, "chunks must report incrementally");
        assert_eq!(reports.last().unwrap().0, 600 * 1024);
    }

    struct WouldBlockReader {
        blocks_left: usize,
        payload: Vec<u8>,
        offset: usize,
    }

    impl Read for WouldBlockReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.blocks_left > 0 {
                self.blocks_left -= 1;
                return Err(io::Error::from(io::ErrorKind::WouldBlock));
            }
            if self.offset >= self.payload.len() {
                return Ok(0);
            }
            let remaining = self.payload.len() - self.offset;
            let count = remaining.min(buffer.len());
            buffer[..count].copy_from_slice(&self.payload[self.offset..self.offset + count]);
            self.offset += count;
            Ok(count)
        }
    }

    #[test]
    fn would_block_is_retried_instead_of_truncating() {
        let mut reader = WouldBlockReader {
            blocks_left: 2,
            payload: vec![1u8; 1024],
            offset: 0,
        };
        let mut output = Vec::new();
        let sink = RecordingSink::default();
        let cancellation = CancellationToken::default();
        let context = context(&sink, &cancellation);
        let done = copy_with_progress(&mut reader, &mut output, &context, 0, Some(1024)).unwrap();
        assert_eq!(done, 1024);
        assert_eq!(output.len(), 1024);
    }

    #[test]
    fn cancellation_stops_the_copy() {
        let data = vec![1u8; 1024];
        let mut reader = &data[..];
        let mut output = Vec::new();
        let sink = RecordingSink::default();
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        let context = context(&sink, &cancellation);
        let error =
            copy_with_progress(&mut reader, &mut output, &context, 0, Some(1024)).unwrap_err();
        assert_eq!(
            crate::error::error_code(&error),
            Some(helix_core::coded_error::TRANSFER_CANCELLED)
        );
        assert!(output.is_empty());
    }

    #[test]
    fn timeout_stops_the_copy_before_new_bytes() {
        let data = vec![1u8; 1024];
        let mut reader = &data[..];
        let mut output = Vec::new();
        let sink = RecordingSink::default();
        let cancellation = CancellationToken::default();
        let context = TransferContext {
            task_id: "broker-1-1",
            cancellation: &cancellation,
            progress: &sink,
            deadline: Instant::now(),
        };
        let error =
            copy_with_progress(&mut reader, &mut output, &context, 0, Some(1024)).unwrap_err();
        assert_eq!(
            crate::error::error_code(&error),
            Some(helix_core::coded_error::TRANSFER_TIMEOUT)
        );
    }

    #[test]
    fn part_path_is_unique_per_task_and_stays_beside_the_target() {
        let path = part_path(Path::new("/tmp/report.txt"), "broker-123-7");
        assert_eq!(path, Path::new("/tmp/report.txt.helix.part.broker-123-7"));
        let sanitized = part_path(Path::new("/tmp/report.txt"), "broker/12 3");
        assert_eq!(
            sanitized,
            Path::new("/tmp/report.txt.helix.part.broker_12_3")
        );
    }

    #[test]
    fn local_tree_size_sums_every_regular_file() {
        let root = std::env::temp_dir().join(format!(
            "helix-tree-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("a.bin"), vec![0u8; 3]).unwrap();
        fs::write(root.join("nested/b.bin"), vec![0u8; 5]).unwrap();
        fs::write(root.join("nested/c.bin"), vec![0u8; 7]).unwrap();
        assert_eq!(local_tree_size(&root).unwrap(), 15);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn progress_offset_shifts_a_file_report_into_the_tree() {
        let data = [0u8; 50];
        let mut reader = &data[..];
        let mut output = Vec::new();
        let sink = RecordingSink::default();
        let cancellation = CancellationToken::default();
        let context = context(&sink, &cancellation);
        copy_with_progress(&mut reader, &mut output, &context, 100, Some(200)).unwrap();
        let reports = sink.reports.lock().unwrap();
        assert_eq!(reports.last().unwrap(), &(150, Some(200)));
    }
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

    #[test]
    fn bounded_text_repairs_an_oem_damaged_utf8_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0x3F];
        bytes.extend_from_slice("名称".as_bytes());
        let (text, truncated) = bounded_text(bytes, 1024);
        assert!(!truncated);
        assert!(text.contains("名称"), "text: {text:?}");
        assert!(!text.starts_with('\u{FFFD}'), "text: {text:?}");
    }

    #[test]
    fn bounded_text_still_decodes_a_genuine_gbk_stream() {
        let (text, truncated) = bounded_text(vec![0xC3, 0xFB, 0xB3, 0xC6], 1024);
        assert!(!truncated);
        assert_eq!(text, "名称");
    }
}
