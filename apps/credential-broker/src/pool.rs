use crate::{credential, ssh};
use anyhow::Result;
use ssh2::Session;
use std::{
    collections::HashMap,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionKey {
    credential_ref: String,
    host: String,
    port: u16,
    username: Option<String>,
    strict_host_key_checking: bool,
}

struct IdleSession {
    session: Session,
    last_used: Instant,
}

pub struct SessionPool {
    idle: Mutex<HashMap<SessionKey, Vec<IdleSession>>>,
    idle_ttl: Duration,
    max_idle_per_key: usize,
}

impl SessionPool {
    pub fn new(idle_ttl: Duration, max_idle_per_key: usize) -> Self {
        Self {
            idle: Mutex::new(HashMap::new()),
            idle_ttl,
            max_idle_per_key: max_idle_per_key.max(1),
        }
    }

    pub fn acquire(
        &self,
        credential_ref: &str,
        host: &str,
        port: u16,
        username: Option<&str>,
        timeout_seconds: u64,
        strict_host_key_checking: bool,
    ) -> Result<(SessionKey, Session)> {
        let key = SessionKey {
            credential_ref: credential_ref.to_owned(),
            host: host.to_owned(),
            port,
            username: username.map(str::to_owned),
            strict_host_key_checking,
        };

        if let Some(session) = self.take_idle(&key, timeout_seconds) {
            return Ok((key, session));
        }

        let login = credential::read(credential_ref)?;
        let options = ssh::ConnectOptions {
            host,
            port,
            username,
            timeout_seconds,
            strict_host_key_checking,
        };
        let session = connect_with_retry(&options, &login)?;
        session.set_keepalive(true, 30);
        Ok((key, session))
    }

    fn take_idle(&self, key: &SessionKey, timeout_seconds: u64) -> Option<Session> {
        let mut guard = self.idle.lock().ok()?;
        let sessions = guard.get_mut(key)?;
        while let Some(idle) = sessions.pop() {
            if idle.last_used.elapsed() > self.idle_ttl {
                continue;
            }
            let session = idle.session;
            session.set_timeout(timeout_ms(timeout_seconds));
            if session.authenticated() && session.keepalive_send().is_ok() {
                return Some(session);
            }
        }
        None
    }

    pub fn release(&self, key: SessionKey, session: Session) {
        if !session.authenticated() {
            return;
        }
        let Ok(mut guard) = self.idle.lock() else {
            return;
        };
        let sessions = guard.entry(key).or_default();
        sessions.retain(|entry| entry.last_used.elapsed() <= self.idle_ttl);
        if sessions.len() >= self.max_idle_per_key {
            return;
        }
        sessions.push(IdleSession {
            session,
            last_used: Instant::now(),
        });
    }

    pub fn size(&self) -> usize {
        self.idle
            .lock()
            .map(|guard| guard.values().map(Vec::len).sum())
            .unwrap_or(0)
    }
}

fn timeout_ms(timeout_seconds: u64) -> u32 {
    (timeout_seconds.saturating_mul(1000)).min(u32::MAX as u64) as u32
}

fn retryable_connect_error(error: &anyhow::Error) -> bool {
    let text = format!("{error:#}").to_ascii_lowercase();
    [
        "failed to connect",
        "ssh handshake failed",
        "unable to exchange encryption keys",
        "connection reset",
        "connection aborted",
        "connection refused",
        "timed out",
        "timeout",
        "socket disconnect",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn connect_with_retry(
    options: &ssh::ConnectOptions<'_>,
    credential: &credential::StoredCredential,
) -> Result<Session> {
    const BACKOFF_MS: [u64; 3] = [200, 500, 1000];
    for backoff in BACKOFF_MS
        .into_iter()
        .map(Some)
        .chain(std::iter::once(None))
    {
        match ssh::connect(options, credential) {
            Ok(session) => return Ok(session),
            Err(error) if backoff.is_some() && retryable_connect_error(&error) => {
                thread::sleep(Duration::from_millis(backoff.unwrap()));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("connect retry loop always returns")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_classifier_does_not_retry_bad_passwords() {
        let error = anyhow::anyhow!("SSH password authentication failed");
        assert!(!retryable_connect_error(&error));
    }

    #[test]
    fn retry_classifier_accepts_kex_failures() {
        let error = anyhow::anyhow!("SSH handshake failed: Unable to exchange encryption keys");
        assert!(retryable_connect_error(&error));
    }
}
