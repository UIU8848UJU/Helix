# Real-host e2e: ssh-mcp job engine on Ubuntu 22.04 (LINUX-SSH-TARGET)

- date: 2026-08-08
- work_item: REPO-003 (deferred real-host integration on LINUX-SSH-TARGET, now verified)
- target: Ubuntu22.04_developer (192.168.110.128, Ubuntu 22.04.5 LTS, x86_64, node v20.20.1)
- transport under test: ssh-mcp stdio MCP server (build 0.3.0) + local ssh client to 127.0.0.1 (self-SSH with generated ed25519 key)
- workspace: uploaded source of @helix/ssh-mcp + @helix/jobs, npm ci (144 pkgs), npm run build PASS
- config: ~/.config/helix/ssh-mcp.json host alias localhost (openssh auth, identityFile ~/.ssh/id_helix_e2e)

## Functional results (MCP tools/call via stdio driver)

| Tool | Job | Result |
|------|-----|--------|
| job_start | printf hello-e2e; sleep 1; printf done-e2e | ok=true, jobId, state=queued, pid, logPath=/tmp/helix/jobs/<id>/output.log |
| job_status | polled | state=succeeded, exitCode=0, timestamps set, logSizeBytes=19 |
| job_logs | same job | content=hello-e2e + done-e2e, nextCursor=19, eof=true |
| job_start | echo running-long; sleep 60 | ok=true |
| job_cancel | long job, graceSeconds=3 | state=cancelled, exitCode=143 (SIGTERM), finishedAt set |

## Audit evidence

~/.local/state/helix/ssh-mcp/audit.jsonl records 8 calls (job_start x2, job_status x4, job_logs x1, job_cancel x1), all exit=0, ok=True.

## Conclusion

The previously deferred real-host e2e on LINUX-SSH-TARGET is verified: the SSH job engine (detached start, status metadata, incremental logs, process-group cancel) works against a real Ubuntu 22.04 SSH host. This closes the deferred item listed in development/release/handoff.md.

## Network note (unrelated to code)

The environment has no direct outbound internet (ICMP only); all HTTP(S) must go through the local Clash proxy (Windows 127.0.0.1:7890 = VM gateway 192.168.110.1:7890). npm/curl on the VM require http_proxy=http://192.168.110.1:7890 and https_proxy=http://192.168.110.1:7890.

## Resolution: permanent VM proxy (applied 2026-08-08)

- ~/.bashrc: export http_proxy/https_proxy/HTTP_PROXY/HTTPS_PROXY=http://192.168.110.1:7890, no_proxy for local/LAN
- ~/.npmrc: proxy + https-proxy
- ~/.gitconfig: http.proxy + https.proxy
- Verified: curl npm-registry HTTP 200; npm view zod -> 4.4.3; git config present.
- Direct outbound TCP is filtered at the network edge (Windows host also fails for qq/aliyun/google; ICMP only). VM is VMware-NAT behind Windows, so proxy is the only working path. apt proxy configured (/etc/apt/apt.conf.d/95proxies) and verified via apt-get update 2026-08-08. Docker systemd drop-in (http-proxy.conf) written; daemon restart pending because knowledge-runtime containers have restart=no.
