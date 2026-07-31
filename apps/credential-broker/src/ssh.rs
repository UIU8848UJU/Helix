use crate::{credential::StoredCredential, protocol::BrokerResponse};
use anyhow::{anyhow, Context, Result};
use ssh2::{CheckResult, KnownHostFileKind, Session, Sftp};
use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
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
    tcp.set_read_timeout(Some(Duration::from_secs(options.timeout_seconds)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(options.timeout_seconds)))?;

    let mut session = Session::new().context("failed to create SSH session")?;
    session.set_timeout(
        (options.timeout_seconds.saturating_mul(1000)).min(u32::MAX as u64) as u32,
    );
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

pub fn execute(
    session: &Session,
    command: &str,
    stdin_secret: Option<&Zeroizing<String>>,
    max_output_bytes: usize,
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

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    channel.read_to_end(&mut stdout)?;
    let mut stderr_stream = channel.stderr();
    stderr_stream.read_to_end(&mut stderr)?;
    channel.wait_close()?;
    let exit_code = channel.exit_status().unwrap_or(-1);
    let (stdout, stdout_truncated) = bounded_text(stdout, max_output_bytes);
    let (stderr, stderr_truncated) = bounded_text(stderr, max_output_bytes);
    Ok(BrokerResponse {
        ok: exit_code == 0,
        exists: None,
        exit_code: Some(exit_code),
        stdout: Some(stdout),
        stderr: Some(stderr),
        timed_out: Some(false),
        truncated: Some(stdout_truncated || stderr_truncated),
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
        Err(error) => {
            Err(error).with_context(|| format!("failed to create {}", path.display()))
        }
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
            upload_path(
                sftp,
                &entry.path(),
                &remote.join(entry.file_name()),
                true,
            )?;
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
            if name == std::ffi::OsStr::new(".")
                || name == std::ffi::OsStr::new("..")
            {
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
