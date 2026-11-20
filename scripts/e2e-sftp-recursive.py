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

try:  # Windows consoles default to GBK; never let logging break the run.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001 - best effort
    pass

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
        result = self.wait(task_id)
        result["taskId"] = task_id
        return result


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


def local_sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def task_progress(client: Client, task: dict) -> dict:
    status = client.ipc.rpc({"op": "task_status", "task_id": task["taskId"]})
    return status.get("progress") or {}


def cancel_when_running(client: Client, request: dict) -> tuple[dict, bool]:
    task_id = client.submit(request)
    saw_running = False
    for _ in range(200):
        status = client.ipc.rpc({"op": "task_status", "task_id": task_id})
        if status.get("state") == "running":
            saw_running = True
            break
        if status.get("state") in {"succeeded", "failed", "cancelled"}:
            break
        time.sleep(0.01)
    client.ipc.rpc({"op": "task_cancel", "task_id": task_id})
    final = client.wait(task_id)
    final["taskId"] = task_id
    return final, saw_running


def remote_listing(client: Client, directory: str) -> list[str]:
    ok, listing = remote_ok(client, f"ls -1 {directory} 2>/dev/null | sort")
    return listing.splitlines() if ok else []


def check_samples(client: Client, path: str, expected: set[str], name: str) -> None:
    ok, samples = remote_ok(client, "cat /tmp/helix-samples 2>/dev/null")
    lines = [line.strip() for line in samples.splitlines() if line.strip()]
    foreign = [line for line in lines if line not in expected and line != "MISSING"]
    check(f"{name}: no reader saw a partial or foreign file", ok and not foreign, str(foreign[:5]))
    check(f"{name}: no reader saw the target missing", "MISSING" not in lines)
    seen = {line for line in lines if line in expected}
    if len(seen) >= 2:
        check(f"{name}: sampler observed both old and new content", True)
    else:
        print(f"INCONCLUSIVE {name}: sampler observed only {len(seen)} distinct state(s)")



def main() -> int:
    if os.environ.get("HELIX_SFTP_E2E") != "1":
        if os.environ.get("HELIX_SFTP_E2E_REQUIRE") == "1":
            print("fail: HELIX_SFTP_E2E_REQUIRE=1 but HELIX_SFTP_E2E is not 1")
            return 1
        print("skip: set HELIX_SFTP_E2E=1 to run the recursive SFTP E2E")
        return 0

    started_all = time.time()
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

        uname_task = client.exec("uname -s")
        uname = ((uname_task.get("result") or {}).get("stdout") or "").strip()
        posix_remote = uname in {"Linux", "Darwin"}
        local_symlinks = os.name != "nt"

        # 8. same-size different-content overwrite (deterministic atomic result)
        same_a = os.path.join(work, "same-a.bin")
        same_b = os.path.join(work, "same-b.bin")
        with open(same_a, "wb") as handle:
            handle.write(b"A" * (1024 * 1024))
        with open(same_b, "wb") as handle:
            handle.write(b"B" * (1024 * 1024))
        client.transfer("upload", same_a, f"{remote}/same.bin", False)
        same = client.transfer("upload", same_b, f"{remote}/same.bin", False)
        check("same-size overwrite succeeded", same.get("state") == "succeeded")
        same_back = os.path.join(work, "same-back.bin")
        client.transfer("download", same_back, f"{remote}/same.bin", False)
        check(
            "same-size overwrite leaves B content",
            os.path.exists(same_back) and sha256(same_back) == local_sha(b"B" * (1024 * 1024)),
        )

        # 9. empty file / empty directory
        empty = os.path.join(work, "empty.bin")
        open(empty, "wb").close()
        empty_up = client.transfer("upload", empty, f"{remote}/empty.bin", False)
        empty_back = os.path.join(work, "empty-back.bin")
        empty_down = client.transfer("download", empty_back, f"{remote}/empty.bin", False)
        check("empty file upload succeeded", empty_up.get("state") == "succeeded")
        check(
            "empty file round-trip is empty",
            empty_down.get("state") == "succeeded"
            and os.path.exists(empty_back)
            and os.path.getsize(empty_back) == 0,
        )
        empty_progress = task_progress(client, empty_up)
        check(
            "empty file reports final 0/0 progress",
            empty_progress.get("done") == 0 and empty_progress.get("total") == 0,
            str(empty_progress),
        )

        empty_dir = os.path.join(work, "empty-dir")
        os.makedirs(empty_dir, exist_ok=True)
        empty_dir_up = client.transfer("upload", empty_dir, f"{remote}/empty-dir", True)
        check("empty directory upload succeeded", empty_dir_up.get("state") == "succeeded")
        empty_dir_back = os.path.join(work, "empty-dir-back")
        empty_dir_down = client.transfer("download", empty_dir_back, f"{remote}/empty-dir", True)
        check(
            "empty directory round-trip is empty",
            empty_dir_down.get("state") == "succeeded"
            and os.path.isdir(empty_dir_back)
            and not os.listdir(empty_dir_back),
        )

        # 10. many small files (whole-tree total with per-file offsets)
        many = os.path.join(work, "many")
        os.makedirs(many, exist_ok=True)
        for index in range(120):
            with open(os.path.join(many, f"f{index:03d}.txt"), "wb") as handle:
                handle.write(bytes([index % 251]) * 1024)
        many_task = client.transfer("upload", many, f"{remote}/many", True)
        check("many-small-files upload succeeded", many_task.get("state") == "succeeded")
        many_progress = task_progress(client, many_task)
        check(
            "many-small-files progress total is exact",
            many_progress.get("total") == 120 * 1024
            and many_progress.get("done") == 120 * 1024,
            str(many_progress),
        )
        many_back = os.path.join(work, "many-back")
        many_down = client.transfer("download", many_back, f"{remote}/many", True)
        check(
            "many-small-files round-trip count matches",
            many_down.get("state") == "succeeded"
            and os.path.isdir(many_back)
            and len(os.listdir(many_back)) == 120,
        )

        # 11. unicode / space filenames
        unicode_dir = os.path.join(work, "unicode")
        os.makedirs(unicode_dir, exist_ok=True)
        unicode_names = ["中文 文件.txt", "emoji 😀.txt", "ＡＢＣ全角.txt", "with space.txt"]
        for name in unicode_names:
            with open(os.path.join(unicode_dir, name), "wb") as handle:
                handle.write(name.encode("utf-8"))
        unicode_task = client.transfer("upload", unicode_dir, f"{remote}/unicode", True)
        check("unicode filenames upload succeeded", unicode_task.get("state") == "succeeded")
        remote_names = sorted(remote_listing(client, f"{remote}/unicode"))
        check(
            "unicode filenames round-trip on the remote",
            remote_names == sorted(unicode_names),
            str(remote_names),
        )
        unicode_back = os.path.join(work, "unicode-back")
        unicode_down = client.transfer("download", unicode_back, f"{remote}/unicode", True)
        check(
            "unicode filenames round-trip locally",
            unicode_down.get("state") == "succeeded"
            and sorted(os.listdir(unicode_back)) == sorted(unicode_names),
        )

        # 12. deep nesting
        deep_root = os.path.join(work, "deep")
        current = deep_root
        for depth in range(40):
            current = os.path.join(current, f"d{depth:02d}")
        os.makedirs(current, exist_ok=True)
        with open(os.path.join(current, "leaf.txt"), "wb") as handle:
            handle.write(b"deep-leaf")
        deep_task = client.transfer("upload", deep_root, f"{remote}/deep", True)
        check("deep nesting upload succeeded", deep_task.get("state") == "succeeded")
        deep_back = os.path.join(work, "deep-back")
        deep_down = client.transfer("download", deep_back, f"{remote}/deep", True)
        leaf = deep_back
        for depth in range(40):
            leaf = os.path.join(leaf, f"d{depth:02d}")
        leaf = os.path.join(leaf, "leaf.txt")
        check(
            "deep nesting leaf round-trips",
            deep_down.get("state") == "succeeded"
            and os.path.exists(leaf)
            and open(leaf, "rb").read() == b"deep-leaf",
        )

        # 13. shell metacharacter filenames (Linux only)
        if posix_remote:
            meta_dir = os.path.join(work, "meta")
            os.makedirs(meta_dir, exist_ok=True)
            meta_names = ["a b.txt", "$(id).txt", "semi;colon.txt"]
            if local_symlinks:
                meta_names += ['q"uote.txt', "star*.txt"]
            for name in meta_names:
                with open(os.path.join(meta_dir, name), "wb") as handle:
                    handle.write(name.encode("utf-8"))
            meta_task = client.transfer("upload", meta_dir, f"{remote}/meta", True)
            check("metachar filenames upload succeeded", meta_task.get("state") == "succeeded")
            meta_names_remote = sorted(remote_listing(client, f"{remote}/meta"))
            check(
                "metachar filenames round-trip on the remote",
                meta_names_remote == sorted(meta_names),
                str(meta_names_remote),
            )

        # 14. unwritable parent (Linux, non-root sshd user)
        if posix_remote:
            ok, _ = remote_ok(client, f"mkdir -p {remote}/ro && echo keep > {remote}/ro/keep.txt && chmod 555 {remote}/ro")
            check("unwritable-parent fixture ready", ok)
            blocked_src = os.path.join(work, "blocked.bin")
            with open(blocked_src, "wb") as handle:
                handle.write(b"x" * 1024)
            blocked = client.transfer("upload", blocked_src, f"{remote}/ro/new.bin", False)
            check("upload into unwritable parent fails", blocked.get("state") == "failed")
            ok, keep = remote_ok(client, f"cat {remote}/ro/keep.txt")
            check("unwritable parent keeps existing files", ok and keep.strip() == "keep")
            ok, parts = remote_ok(client, f"find {remote}/ro -name '*.helix.part.*' -print")
            check("unwritable parent leaves no .part", ok and parts.strip() == "")

        # 15. symlink rejection (upload local + download remote)
        if posix_remote:
            ok, _ = remote_ok(
                client,
                f"mkdir -p {remote}/remote-link && echo data > {remote}/remote-link/real.txt && ln -s real.txt {remote}/remote-link/link.txt",
            )
            check("remote symlink fixture ready", ok)
            link_down = client.transfer("download", os.path.join(work, "remote-link-back"), f"{remote}/remote-link", True)
            check(
                "remote symlink download is rejected",
                link_down.get("state") == "failed"
                and "symbolic links" in str(link_down.get("result", {}).get("error", "")),
                str(link_down.get("result", {}).get("error")),
            )
            local_parts = [name for name in os.listdir(work) if ".helix.part." in name]
            check("remote symlink rejection leaves no local .part", not local_parts, str(local_parts))
        if local_symlinks:
            link_dir = os.path.join(work, "linktree")
            os.makedirs(link_dir, exist_ok=True)
            with open(os.path.join(link_dir, "real.txt"), "wb") as handle:
                handle.write(b"real-data")
            os.symlink(os.path.join(link_dir, "real.txt"), os.path.join(link_dir, "link.txt"))
            link_up = client.transfer("upload", link_dir, f"{remote}/linktree", True)
            check(
                "local symlink upload is rejected",
                link_up.get("state") == "failed"
                and "symbolic links" in str(link_up.get("result", {}).get("error", "")),
                str(link_up.get("result", {}).get("error")),
            )
            ok, parts = remote_ok(client, f"find {remote}/linktree -name '*.helix.part.*' -print 2>/dev/null")
            check("local symlink rejection leaves no .part", ok and parts.strip() == "")

        # 16. download tree progress
        dl_tree = os.path.join(work, "dl-tree")
        os.makedirs(dl_tree, exist_ok=True)
        dl_sizes = [3, 5, 4]
        for index, mib in enumerate(dl_sizes):
            with open(os.path.join(dl_tree, f"d{index}.bin"), "wb") as handle:
                handle.write(os.urandom(mib * 1024 * 1024))
        client.transfer("upload", dl_tree, f"{remote}/dl-tree", True)
        dl_total = sum(dl_sizes) * 1024 * 1024
        dl_back = os.path.join(work, "dl-back")
        dl_task = client.transfer("download", dl_back, f"{remote}/dl-tree", True)
        check("download tree succeeded", dl_task.get("state") == "succeeded")
        dl_progress = task_progress(client, dl_task)
        check(
            "download progress total equals the whole tree",
            dl_progress.get("total") == dl_total,
            str(dl_progress),
        )
        check(
            "download progress final reaches total",
            dl_progress.get("done") == dl_total,
        )
        check(
            "downloaded tree bytes match",
            all(
                sha256(os.path.join(dl_tree, f"d{index}.bin"))
                == sha256(os.path.join(dl_back, f"d{index}.bin"))
                for index in range(len(dl_sizes))
            ),
        )

        # 17. download directory without recursive=true
        dl_refused = client.transfer("download", os.path.join(work, "dl-refused"), f"{remote}/dl-tree", False)
        check(
            "download directory without recursive=true is rejected",
            dl_refused.get("state") == "failed"
            and "recursive" in str(dl_refused.get("result", {}).get("error", "")),
            str(dl_refused.get("result", {}).get("error")),
        )

        # 18. cancel a download and preserve the existing local file
        big_remote_src = os.path.join(work, "big-remote.bin")
        with open(big_remote_src, "wb") as handle:
            handle.write(b"\x05" * (64 * 1024 * 1024))
        client.transfer("upload", big_remote_src, f"{remote}/big-remote.bin", False)
        local_target = os.path.join(work, "local-target.bin")
        with open(local_target, "wb") as handle:
            handle.write(b"OLD-INTACT")
        cancelled_down, saw_running = cancel_when_running(
            client,
            {
                "op": "download",
                **client.base(),
                "local_path": local_target,
                "remote_path": f"{remote}/big-remote.bin",
                "recursive": False,
                "timeout_seconds": 300,
            },
        )
        check("download cancel observed a running transfer", saw_running)
        check(
            "download cancel ends cancelled or already succeeded",
            cancelled_down.get("state") in {"cancelled", "succeeded"},
            cancelled_down.get("state"),
        )
        check(
            "download cancel preserves the existing local file",
            open(local_target, "rb").read() == b"OLD-INTACT",
        )
        local_parts = [name for name in os.listdir(work) if ".helix.part." in name]
        check("download cancel leaves no local .part", not local_parts, str(local_parts))

        # 19. cancel then reuse the session
        reuse_exec = client.exec("echo reuse-ok")
        check(
            "session still usable after cancellation",
            reuse_exec.get("state") == "succeeded"
            and "reuse-ok" in ((reuse_exec.get("result") or {}).get("stdout") or ""),
        )
        small_reuse = os.path.join(work, "reuse.bin")
        with open(small_reuse, "wb") as handle:
            handle.write(b"reuse" * 256)
        reuse_up = client.transfer("upload", small_reuse, f"{remote}/reuse.bin", False)
        check("upload after cancellation succeeded", reuse_up.get("state") == "succeeded")

        # 20. concurrent writers to the same target
        writer_a = os.path.join(work, "writer-a.bin")
        writer_b = os.path.join(work, "writer-b.bin")
        with open(writer_a, "wb") as handle:
            handle.write(b"A" * (8 * 1024 * 1024))
        with open(writer_b, "wb") as handle:
            handle.write(b"B" * (8 * 1024 * 1024))
        writer_ids = [
            client.submit(
                {
                    "op": "upload",
                    **client.base(),
                    "local_path": writer_a,
                    "remote_path": f"{remote}/race.bin",
                    "recursive": False,
                    "timeout_seconds": 300,
                }
            ),
            client.submit(
                {
                    "op": "upload",
                    **client.base(),
                    "local_path": writer_b,
                    "remote_path": f"{remote}/race.bin",
                    "recursive": False,
                    "timeout_seconds": 300,
                }
            ),
        ]
        writer_finals = [client.wait(task_id) for task_id in writer_ids]
        check(
            "concurrent writers both succeed",
            all(final.get("state") == "succeeded" for final in writer_finals),
            str([final.get("state") for final in writer_finals]),
        )
        race_back = os.path.join(work, "race-back.bin")
        client.transfer("download", race_back, f"{remote}/race.bin", False)
        race_sha = sha256(race_back)
        check(
            "concurrent writers leave one complete writer",
            race_sha in {local_sha(b"A" * (8 * 1024 * 1024)), local_sha(b"B" * (8 * 1024 * 1024))},
        )
        ok, parts = remote_ok(client, f"find {remote} -name '*.helix.part.*' -print")
        check("concurrent writers leave no .part", ok and parts.strip() == "")

        # 21. concurrent reader during overwrite (Linux: posix-rename server)
        if posix_remote:
            old_payload = b"O" * (64 * 1024 * 1024)
            new_payload = b"N" * (64 * 1024 * 1024)
            old_sha = local_sha(old_payload)
            new_sha = local_sha(new_payload)
            old_path = os.path.join(work, "reader-old.bin")
            new_path = os.path.join(work, "reader-new.bin")
            with open(old_path, "wb") as handle:
                handle.write(old_payload)
            with open(new_path, "wb") as handle:
                handle.write(new_payload)
            client.transfer("upload", old_path, f"{remote}/reader.bin", False)
            sampler = (
                "rm -f /tmp/helix-samples; "
                "( end=$(( $(date +%s) + 6 )); "
                "while [ $(date +%s) -lt $end ]; do "
                f"if [ -f '{remote}/reader.bin' ]; then sha256sum '{remote}/reader.bin' | cut -d' ' -f1; else echo MISSING; fi; "
                "sleep 0.02; done ) > /tmp/helix-samples 2>&1 & echo sampler-started"
            )
            start_task = client.exec(sampler)
            check(
                "concurrent reader sampler started",
                "sampler-started" in ((start_task.get("result") or {}).get("stdout") or ""),
            )
            time.sleep(0.3)
            reader_task = client.transfer("upload", new_path, f"{remote}/reader.bin", False)
            check("concurrent-reader overwrite succeeded", reader_task.get("state") == "succeeded")
            time.sleep(6.2)
            check_samples(client, f"{remote}/reader.bin", {old_sha, new_sha}, "concurrent reader")

        elapsed = time.time() - started_all
        check("expanded E2E under 10 minutes", elapsed < 600, f"{elapsed:.1f}s")

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
