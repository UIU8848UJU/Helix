use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

/// Threshold above which a task result is spilled to a spool file instead of
/// being returned inline over IPC.
pub const DEFAULT_SPOOL_THRESHOLD_BYTES: usize = 64 * 1024;

pub const SPOOL_STDOUT_SUFFIX: &str = ".out.log";
pub const SPOOL_STDERR_SUFFIX: &str = ".err.log";

pub fn stdout_ref(task_id: &str) -> String {
    format!("spool://{task_id}/stdout")
}

pub fn stderr_ref(task_id: &str) -> String {
    format!("spool://{task_id}/stderr")
}

pub fn runtime_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return Ok(PathBuf::from(local).join("Helix").join("runtime"));
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return Ok(PathBuf::from(profile)
                .join("AppData")
                .join("Local")
                .join("Helix")
                .join("runtime"));
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
            return Ok(PathBuf::from(runtime).join("helix"));
        }
        if let Ok(uid) = std::env::var("UID") {
            return Ok(PathBuf::from("/tmp").join(format!("helix-{uid}")));
        }
        return Ok(PathBuf::from("/tmp").join("helix"));
    }
    Err(anyhow!("cannot determine the Helix runtime directory"))
}

/// Disk-backed store for large task outputs. Spool files are kept under
/// `<runtime>/spool` and are cleaned up together with their task records.
#[derive(Debug)]
pub struct SpoolManager {
    root: PathBuf,
}

impl SpoolManager {
    pub fn at_default_root() -> Result<Self> {
        let root = runtime_dir()?.join("spool");
        fs::create_dir_all(&root)
            .with_context(|| format!("failed to create spool directory {}", root.display()))?;
        Ok(Self { root })
    }

    pub fn at(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)
            .with_context(|| format!("failed to create spool directory {}", root.display()))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Spills a completed task result to disk when its combined output exceeds
    /// `threshold`. Inline streams are replaced with spool references plus the
    /// full byte sizes; small results keep their inline form.
    pub fn maybe_spill(
        &self,
        task_id: &str,
        stdout: String,
        stderr: String,
        threshold: usize,
    ) -> Result<Option<BrokerSpoolRefs>> {
        if stdout.len() + stderr.len() <= threshold {
            return Ok(None);
        }
        let stdout_size = stdout.len();
        let stderr_size = stderr.len();
        let stdout_ref = if stdout.is_empty() {
            None
        } else {
            self.write_file(task_id, SPOOL_STDOUT_SUFFIX, stdout.as_bytes())?;
            Some(stdout_ref(task_id))
        };
        let stderr_ref = if stderr.is_empty() {
            None
        } else {
            self.write_file(task_id, SPOOL_STDERR_SUFFIX, stderr.as_bytes())?;
            Some(stderr_ref(task_id))
        };
        Ok(Some(BrokerSpoolRefs {
            stdout_ref,
            stderr_ref,
            stdout_size,
            stderr_size,
        }))
    }

    fn write_file(&self, task_id: &str, suffix: &str, bytes: &[u8]) -> Result<()> {
        validate_task_id(task_id)?;
        let path = self.root.join(format!("{task_id}{suffix}"));
        let mut file = fs::File::create(&path)
            .with_context(|| format!("failed to create spool file {}", path.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("failed to write spool file {}", path.display()))?;
        Ok(())
    }

    pub fn read(&self, result_ref: &str, cursor: usize, max_bytes: usize) -> Result<SpoolRead> {
        let data = self.read_ref(result_ref)?;
        let cursor = cursor.min(data.len());
        let end = cursor.saturating_add(max_bytes).min(data.len());
        let content = String::from_utf8_lossy(&data[cursor..end]).into_owned();
        Ok(SpoolRead {
            content,
            next_cursor: end,
            eof: end >= data.len(),
            size: data.len(),
        })
    }

    pub fn tail(&self, result_ref: &str, max_bytes: usize) -> Result<SpoolTail> {
        let data = self.read_ref(result_ref)?;
        let start = data.len().saturating_sub(max_bytes);
        Ok(SpoolTail {
            content: String::from_utf8_lossy(&data[start..]).into_owned(),
            size: data.len(),
            start,
        })
    }

    pub fn search(
        &self,
        result_ref: &str,
        pattern: &str,
        regex: bool,
        before: usize,
        after: usize,
        max_matches: usize,
    ) -> Result<Vec<SpoolMatch>> {
        let data = self.read_ref(result_ref)?;
        let text = String::from_utf8_lossy(&data);
        search_text(&text, pattern, regex, before, after, max_matches)
    }

    pub fn cleanup_task(&self, task_id: &str) {
        if validate_task_id(task_id).is_err() {
            return;
        }
        let _ = fs::remove_file(self.root.join(format!("{task_id}{SPOOL_STDOUT_SUFFIX}")));
        let _ = fs::remove_file(self.root.join(format!("{task_id}{SPOOL_STDERR_SUFFIX}")));
    }

    fn read_ref(&self, result_ref: &str) -> Result<Vec<u8>> {
        let (task_id, stream) = parse_result_ref(result_ref)?;
        let suffix = match stream {
            SpoolStream::Stdout => SPOOL_STDOUT_SUFFIX,
            SpoolStream::Stderr => SPOOL_STDERR_SUFFIX,
        };
        let path = self.root.join(format!("{task_id}{suffix}"));
        if !path.starts_with(&self.root) {
            return Err(anyhow!("spool reference escapes the spool directory"));
        }
        fs::read(&path).with_context(|| format!("failed to read spool file {}", path.display()))
    }
}

/// Line-wise search over already-materialized text. Shared by spool files and
/// terminal clean logs so both expose the same match semantics.
pub fn search_text(
    text: &str,
    pattern: &str,
    regex: bool,
    before: usize,
    after: usize,
    max_matches: usize,
) -> Result<Vec<SpoolMatch>> {
        if pattern.is_empty() {
            return Err(anyhow!("spool search pattern must not be empty"));
        }
        let matcher: Box<dyn Fn(&str) -> bool> = if regex {
            let compiled = regex::Regex::new(pattern)
                .map_err(|error| anyhow!("invalid spool search regex: {error}"))?;
            Box::new(move |line| compiled.is_match(line))
        } else {
            let needle = pattern.to_lowercase();
            Box::new(move |line| line.to_lowercase().contains(&needle))
        };
        let lines: Vec<&str> = text.lines().collect();
        let mut matches = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if !matcher(line) {
                continue;
            }
            let before_lines = if before > 0 {
                let start = index.saturating_sub(before);
                Some(lines[start..index].iter().map(|s| (*s).to_owned()).collect())
            } else {
                None
            };
            let after_lines = if after > 0 {
                let end = (index + 1 + after).min(lines.len());
                Some(lines[index + 1..end].iter().map(|s| (*s).to_owned()).collect())
            } else {
                None
            };
            matches.push(SpoolMatch {
                line: index + 1,
                text: (*line).to_owned(),
                before: before_lines,
                after: after_lines,
            });
            if matches.len() >= max_matches.max(1) {
                break;
            }
        }
        Ok(matches)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerSpoolRefs {
    pub stdout_ref: Option<String>,
    pub stderr_ref: Option<String>,
    pub stdout_size: usize,
    pub stderr_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolRead {
    pub content: String,
    pub next_cursor: usize,
    pub eof: bool,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolTail {
    pub content: String,
    pub size: usize,
    pub start: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolMatch {
    pub line: usize,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpoolStream {
    Stdout,
    Stderr,
}

fn parse_result_ref(result_ref: &str) -> Result<(String, SpoolStream)> {
    let rest = result_ref
        .strip_prefix("spool://")
        .ok_or_else(|| anyhow!("invalid spool reference: {result_ref}"))?;
    let (task_id, stream) = rest
        .rsplit_once('/')
        .ok_or_else(|| anyhow!("invalid spool reference: {result_ref}"))?;
    validate_task_id(task_id)?;
    let stream = match stream {
        "stdout" => SpoolStream::Stdout,
        "stderr" => SpoolStream::Stderr,
        _ => return Err(anyhow!("invalid spool stream in reference: {result_ref}")),
    };
    Ok((task_id.to_owned(), stream))
}

fn validate_task_id(task_id: &str) -> Result<()> {
    if task_id.is_empty()
        || task_id.len() > 128
        || !task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(anyhow!("invalid task id in spool reference"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_spool() -> (TestTempDir, SpoolManager) {
        let dir = TestTempDir::new();
        let spool = SpoolManager::at(dir.path().join("spool")).unwrap();
        (dir, spool)
    }

    #[test]
    fn small_result_stays_inline() {
        let (_dir, spool) = temp_spool();
        let refs = spool
            .maybe_spill("broker-1-1", "hello".into(), String::new(), 64)
            .unwrap();
        assert!(refs.is_none());
    }

    #[test]
    fn large_result_spills_with_refs_and_sizes() {
        let (_dir, spool) = temp_spool();
        let stdout = "x".repeat(1000);
        let stderr = "err".repeat(100);
        let refs = spool
            .maybe_spill("broker-1-2", stdout.clone(), stderr.clone(), 64)
            .unwrap()
            .unwrap();
        assert_eq!(refs.stdout_ref, Some("spool://broker-1-2/stdout".into()));
        assert_eq!(refs.stderr_ref, Some("spool://broker-1-2/stderr".into()));
        assert_eq!(refs.stdout_size, 1000);
        assert_eq!(refs.stderr_size, 300);

        let read = spool.read("spool://broker-1-2/stdout", 0, 100).unwrap();
        assert_eq!(read.content.len(), 100);
        assert_eq!(read.next_cursor, 100);
        assert!(!read.eof);

        let read = spool.read("spool://broker-1-2/stdout", 900, 10_000).unwrap();
        assert_eq!(read.content.len(), 100);
        assert!(read.eof);
        assert_eq!(read.size, 1000);

        let tail = spool.tail("spool://broker-1-2/stderr", 50).unwrap();
        assert_eq!(tail.content.len(), 50);
        assert_eq!(tail.size, 300);
    }

    #[test]
    fn search_finds_substring_and_regex_with_context() {
        let (_dir, spool) = temp_spool();
        let lines = ["ok", "error: boom", "more", "panic: fail", "end"].join("\n");
        spool
            .maybe_spill("broker-1-3", lines, String::new(), 1)
            .unwrap();

        let substring = spool
            .search("spool://broker-1-3/stdout", "ERROR", false, 1, 1, 20)
            .unwrap();
        assert_eq!(substring.len(), 1);
        assert_eq!(substring[0].line, 2);
        assert_eq!(substring[0].before.as_ref().unwrap().len(), 1);
        assert_eq!(substring[0].after.as_ref().unwrap().len(), 1);

        let regex = spool
            .search("spool://broker-1-3/stdout", "error|panic", true, 0, 0, 20)
            .unwrap();
        assert_eq!(regex.len(), 2);
    }

    #[test]
    fn malicious_ref_is_rejected() {
        let (_dir, spool) = temp_spool();
        assert!(spool.read("spool://../secret/stdout", 0, 10).is_err());
        assert!(spool.read("spool://broker-1/x", 0, 10).is_err());
        assert!(spool.read("https://elsewhere/stdout", 0, 10).is_err());
    }

    #[test]
    fn cleanup_removes_spool_files() {
        let (_dir, spool) = temp_spool();
        spool
            .maybe_spill("broker-1-4", "y".repeat(200), String::new(), 64)
            .unwrap();
        assert!(spool.read("spool://broker-1-4/stdout", 0, 10).is_ok());
        spool.cleanup_task("broker-1-4");
        assert!(spool.read("spool://broker-1-4/stdout", 0, 10).is_err());
    }
}

#[cfg(test)]
struct TestTempDir(std::path::PathBuf);

#[cfg(test)]
impl TestTempDir {
    fn new() -> Self {
        let unique = format!(
            "helix-spool-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

#[cfg(test)]
impl Drop for TestTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

