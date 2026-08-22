//! SSH transport adapter for Helix: connection, session pool, exec, PTY, SFTP
//! and sudo over libssh2.

pub mod adapter;
pub mod pool;
pub mod ssh;
pub mod terminal;
