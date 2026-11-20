#!/usr/bin/env python3
"""Recursive SFTP end-to-end checks against a real sshd.

Gated by HELIX_SFTP_E2E=1. Talks to helixd's newline-delimited JSON IPC
directly, so it exercises the daemon and transport without the MCP layer.

Required environment:
  HELIX_SFTP_HOST, HELIX_SFTP_PORT, HELIX_SFTP_USER
  HELIX_TEST_CREDENTIAL_TARGET (daemon built with --features test-credentials)

Optional:
  HELIX_BROKER_ENDPOINT (defaults to the platform endpoint)
  HELIX_SFTP_STRICT_HOST_KEY=1
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import sys
import tempfile
import time
import uuid

FAILURES: list[str] = []
PASSES = 0


def check(name: str, condition: bool, detail: str = "") -> bool:
    global PASSES
    if condition:
        PASSES += 1
        print(f"PASS {name}{' :: ' + detail if detail else ''}")
    else:
        FAILURES.append(name)
        print(f"FAIL {name}{' :: ' + detail if detail else ''}")
    return condition


def default_endpoint() -> str:
    override = os.environ.get("HELIX_BROKER_ENDPOINT")
    if override:
        return override
    if os.name == "nt":
        return r"\\.\pipe\helix-credential-broker-v1"
    return "/tmp/helix-credential-broker-v1.sock"


class Ipc:
    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint

    def rpc(self, request: dict, timeout: float = 10.0) -> dict:
        if os.name == "nt" and ("pipe" in self.endpoint or self.endpoint.startswith("\\\\")):
            return self._rpc_pipe(request, timeout)
        return self._rpc_unix(request, timeout)

    def _read_line(self, read) -> bytes:
        data = b""
        while b"\n" not in data:
            chunk = read(4096)
            if not chunk:
                break
            data += chunk
        line = data.split(b"\n", 1)[0]
        if not line:
            raise RuntimeError("daemon closed the connection without a response")
        return line

    def _rpc_unix(self, request: dict, timeout: float) -> dict:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(timeout)
        try:
            connection.connect(self.endpoint)
            connection.sendall(json.dumps(request).encode("utf-8") + b"\n")
            return json.loads(self._read_line(connection.recv).decode("utf-8"))
        finally:
            connection.close()

    def _rpc_pipe(self, request: dict, timeout: float) -> dict:
        path = self.endpoint
        if "pipe" in path and not path.startswith("\\\\"):
            # Accept a mangled `\.\pipe\name` form; normalize to the canonical
            # `\\.\pipe\name` spelling Windows expects.
            name = path.split("pipe", 1)[1].lstrip("\\/")
            path = "\\\\.\\pipe\\" + name
        handle = open(path, "r+b", buffering=0)  # noqa: SIM115
        try:
            handle.write(json.dumps(request).encode("utf-8") + b"\n")
            deadline = time.time() + timeout
            data = b""
            while b"\n" not in data:
                if time.time() > deadline:
                    raise TimeoutError(f"daemon did not answer {request.get('op')}")
                chunk = os.read(handle.fileno(), 4096)
                if not chunk:
                    break
                data += chunk
            return json.loads(data.split(b"\n", 1)[0].decode("utf-8"))
        finally:
            handle.close()


class Client:
    def __init__(self, endpoint: str) -> None:
        self.ipc = Ipc(endpoint)
        self.host = require_env("HELIX_SFTP_HOST")
        self.port = int(os.environ.get("HELIX_SFTP_PORT", "22"))
        self.user = require_env("HELIX_SFTP_USER")
        self.credential = require_env("HELIX_TEST_CREDENTIAL_TARGET")
        self.strict = os.environ.get("HELIX_SFTP_STRICT_HOST_KEY") == "1"

    def base(self) -> dict:
        return {
            "credential_ref": self.credential,
            "host": self.host,
            "port": self.port,
            "username": self.user,
            "strict_host_key_checking": self.strict,
        }

    def submit(self, request: dict) -> str:
        response = self.ipc.rpc({"op": "submit", "request": request}, 15.0)
        task_id = response.get("taskId")
        if not task_id:
            raise RuntimeError(f"no taskId: {response}")
        return task_id

    def task(self, task_id: str, timeout: float = 0.0) -> dict:
        return self.ipc.rpc(
            {"op": "task_wait", "task_id": task_id, "timeout_seconds": timeout},
            max(5.0, timeout + 5.0),
        )

    def wait(self, task_id: str, timeout: float = 180.0) -> dict:
        started = time.time()
        versions: list[dict] = []
        last_version = 0
        while time.time() - started < timeout:
            response = self.ipc.rpc(
                {
                    "op": "task_watch",
                    "task_id": task_id,
                    "since_version": last_version,
                    "timeout_seconds": 1,
                },
                5.0,
            )
            progress = response.get("progress")
            if progress and progress.get("version", 0) > last_version:
                versions.append(progress)
                last_version = progress["version"]
            if response.get("state") in {"succeeded", "failed", "cancelled"}:
                response["_versions"] = versions
                return response
        raise TimeoutError(f"task {task_id} did not finish")

    def exec(self, command: str) -> dict:
        task_id = self.submit(
            {
                "op": "execute",
                **self.base(),
                "command": command,
                "timeout_seconds": 120,
                "max_output_bytes": 1024 * 1024,
            }
        )
        return self.wait(task_id)

    def transfer(self, direction: str, local: str, remote: str, recursive: bool) -> dict:
        task_id = self.submit(
            {
                "op": direction,
                **self.base(),
                "local_path": local,
                "remote_path": remote,
                "recursive": recursive,
                "timeout_seconds": 300,
            }
        )
        return self.wait(task_id)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def remote_ok(client: Client, command: str) -> tuple[bool, str]:
    task = client.exec(command)
    stdout = (task.get("result") or {}).get("stdout") or ""
    return task.get("state") == "succeeded", stdout


def main() -> int:
    if os.environ.get("HELIX_SFTP_E2E") != "1":
        print("skip: set HELIX_SFTP_E2E=1 to run the recursive SFTP E2E")
        return 0

    client = Client(default_endpoint())
    work = tempfile.mkdtemp(prefix="helix-sftp-e2e-")
    remote = f"/tmp/helix-sftp-e2e-{uuid.uuid4().hex[:8]}"

    try:
        ping = client.ipc.rpc({"op": "ping"})
        check("protocol version is 7", ping.get("protocolVersion") == 7, str(ping.get("protocolVersion")))
        check("task_watch capability", "task_watch_v1" in (ping.get("capabilities") or []))

        ok, _ = remote_ok(client, f"mkdir -p {remote}")
        check("remote workdir created", ok)

        # 1. single file round-trip
        source = os.path.join(work, "single.bin")
        with open(source, "wb") as handle:
            handle.write(os.urandom(2 * 1024 * 1024))
        upload = client.transfer("upload", source, f"{remote}/single.bin", False)
        check("single upload succeeded", upload.get("state") == "succeeded", str(upload.get("result", {}).get("error")))
        back = os.path.join(work, "single-back.bin")
        download = client.transfer("download", back, f"{remote}/single.bin", False)
        check("single download succeeded", download.get("state") == "succeeded")
        check("single round-trip bytes match", os.path.exists(back) and sha256(source) == sha256(back))

        # 2. recursive merge keeps remote-only files
        tree = os.path.join(work, "tree")
        os.makedirs(os.path.join(tree, "nested"), exist_ok=True)
        with open(os.path.join(tree, "a.bin"), "wb") as handle:
            handle.write(os.urandom(1024 * 1024))
        with open(os.path.join(tree, "nested", "b.bin"), "wb") as handle:
            handle.write(os.urandom(2 * 1024 * 1024))
        ok, _ = remote_ok(client, f"mkdir -p {remote}/tree && echo keep > {remote}/tree/keep.txt")
        check("remote merge fixture ready", ok)
        merged = client.transfer("upload", tree, f"{remote}/tree", True)
        check("recursive upload succeeded", merged.get("state") == "succeeded")
        ok, listing = remote_ok(client, f"find {remote}/tree -type f | sort")
        check("recursive tree has all files", ok and "nested/b.bin" in listing and "a.bin" in listing)
        check("recursive merge keeps remote-only file", "keep.txt" in listing, listing.replace("\n", " "))

        # 3. overwrite an existing destination
        first = os.path.join(work, "cover.txt")
        second = os.path.join(work, "cover2.txt")
        with open(first, "w", encoding="utf-8") as handle:
            handle.write("ORIGINAL\n")
        with open(second, "w", encoding="utf-8") as handle:
            handle.write("REPLACED-FINAL\n")
        client.transfer("upload", first, f"{remote}/cover.txt", False)
        overwrite = client.transfer("upload", second, f"{remote}/cover.txt", False)
        check("overwrite existing file succeeded", overwrite.get("state") == "succeeded")
        covered = os.path.join(work, "cover-back.txt")
        client.transfer("download", covered, f"{remote}/cover.txt", False)
        check(
            "overwritten content is the new file",
            os.path.exists(covered) and open(covered, encoding="utf-8").read() == "REPLACED-FINAL\n",
        )

        # 4. cancellation leaves no partial file and keeps landed files intact
        big = os.path.join(work, "big.bin")
        with open(big, "wb") as handle:
            handle.write(b"\x07" * (64 * 1024 * 1024))
        cancel_id = client.submit(
            {
                "op": "upload",
                **client.base(),
                "local_path": big,
                "remote_path": f"{remote}/cancel.bin",
                "recursive": False,
                "timeout_seconds": 300,
            }
        )
        saw_running = False
        for _ in range(60):
            status = client.ipc.rpc({"op": "task_status", "task_id": cancel_id})
            if status.get("state") == "running":
                saw_running = True
                break
            if status.get("state") in {"succeeded", "failed", "cancelled"}:
                break
            time.sleep(0.02)
        client.ipc.rpc({"op": "task_cancel", "task_id": cancel_id})
        cancel_final = client.wait(cancel_id)
        check("cancel observed a running transfer", saw_running)
        check("cancel ends cancelled or already succeeded", cancel_final.get("state") in {"cancelled", "succeeded"})
        ok, parts = remote_ok(client, f"find {remote} -name '*.helix.part.*' -print")
        check("cancel leaves no .helix.part", ok and parts.strip() == "", parts.replace("\n", " "))
        ok, _ = remote_ok(client, f"test -f {remote}/single.bin")
        check("previously landed file intact after cancel", ok)

        # 5. recursive=false on a directory is rejected
        refused = client.transfer("upload", tree, f"{remote}/refused", False)
        check(
            "directory upload without recursive=true is rejected",
            refused.get("state") == "failed" and "recursive" in str(refused.get("result", {}).get("error", "")),
            str(refused.get("result", {}).get("error")),
        )

        # 6. rename failure path cleans the partial file
        ok, _ = remote_ok(client, f"mkdir -p {remote}/target-is-dir")
        check("rename-failure fixture ready", ok)
        blocked = client.transfer("upload", first, f"{remote}/target-is-dir", False)
        check("upload onto an existing directory fails", blocked.get("state") == "failed")
        ok, parts = remote_ok(client, f"find {remote} -name '*.helix.part.*' -print")
        check("rename failure leaves no .helix.part", ok and parts.strip() == "", parts.replace("\n", " "))
        ok, _ = remote_ok(client, f"test -d {remote}/target-is-dir")
        check("rename-failure target directory intact", ok)

        # 7. multi-file progress uses one running total for the whole tree
        progress_tree = os.path.join(work, "progress-tree")
        os.makedirs(progress_tree, exist_ok=True)
        sizes = [3, 5, 2, 7]
        for index, mib in enumerate(sizes):
            with open(os.path.join(progress_tree, f"p{index}.bin"), "wb") as handle:
                handle.write(os.urandom(mib * 1024 * 1024))
        tree_total = sum(sizes) * 1024 * 1024
        progression = client.transfer("upload", progress_tree, f"{remote}/progress-tree", True)
        check("multi-file upload succeeded", progression.get("state") == "succeeded")
        versions = progression.get("_versions") or []
        final_status = client.ipc.rpc({"op": "task_status", "task_id": progression["taskId"]})
        final_progress = final_status.get("progress") or {}
        check(
            "progress total equals the whole tree",
            final_progress.get("total") == tree_total,
            f"total={final_progress.get('total')} expected={tree_total}",
        )
        check(
            "final progress reaches the total",
            final_progress.get("done") == tree_total,
            f"done={final_progress.get('done')}",
        )
        done_series = [entry.get("done", 0) for entry in versions]
        check(
            "progress done never goes backwards",
            all(b >= a for a, b in zip(done_series, done_series[1:])),
            str(done_series),
        )
        check(
            "progress total stays constant",
            len({entry.get("total") for entry in versions}) <= 1,
            str([entry.get("total") for entry in versions]),
        )
    except Exception as error:  # noqa: BLE001 - report and fail the run
        FAILURES.append(f"exception: {error}")
        print(f"EXCEPTION {error!r}")
    finally:
        try:
            client.exec(f"rm -rf {remote}")
        except Exception:  # noqa: BLE001 - cleanup is best effort
            pass
        shutil.rmtree(work, ignore_errors=True)

    total = PASSES + len(FAILURES)
    print(f"\n{total} checks: {PASSES} passed, {len(FAILURES)} failed")
    for failure in FAILURES:
        print(f" - {failure}")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main())
