//! Helix core: wire protocol, task runtime, spool storage, transport abstraction
//! and execution policies. This crate never depends on a concrete transport
//! (SSH, Aliyun, SASS) or on OS credential storage.

pub mod protocol;
pub mod sandbox;
pub mod spool;
pub mod task_pool;
pub mod transport;
