import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBrokerExecuteRequest,
  buildBrokerTransferRequest,
  expandHomePath,
  hostAuth,
} from "../src/broker.js";
import type { GlobalSettings, HostConfig } from "../src/types.js";

const settings: GlobalSettings = {
  defaultTimeoutSeconds: 60,
  maxOutputBytes: 1024 * 1024,
  maxConcurrentCommands: 4,
  strictHostKeyChecking: false,
  allowPersistentTerminal: false,
  auditEnabled: false,
};

const keyHost: HostConfig = {
  hostname: "192.168.33.128",
  port: 22,
  username: "xxx",
  identityFile: "~/.ssh/id_ed25519",
  allowedRemotePaths: ["/"],
  auth: { type: "openssh" },
  sudo: { mode: "reviewed-nopasswd", allow: ["^.*$"], approvalTtlSeconds: 300 },
};

describe("key authentication through the daemon", () => {
  it("expands ~ on the client before building the request", () => {
    expect(expandHomePath("~/.ssh/id_ed25519")).toBe(
      path.join(os.homedir(), ".ssh", "id_ed25519"),
    );
    expect(expandHomePath("/absolute/key")).toBe("/absolute/key");
  });

  it("derives auth from the host without reading a credential for a key host", () => {
    expect(hostAuth(keyHost)).toEqual({
      credentialRef: "",
      identityFile: path.join(os.homedir(), ".ssh", "id_ed25519"),
    });
  });

  it("rejects an openssh host without an identity file", () => {
    expect(() => hostAuth({ ...keyHost, identityFile: undefined })).toThrow(/identityFile/);
  });

  it("execute builder includes identity_file and an empty credential for a key host", () => {
    const auth = hostAuth(keyHost);
    const request = buildBrokerExecuteRequest({
      credentialRef: auth.credentialRef,
      identityFile: auth.identityFile,
      host: keyHost,
      command: "true",
      settings,
    });
    expect(request.identity_file).toBe(path.join(os.homedir(), ".ssh", "id_ed25519"));
    expect(request.credential_ref).toBe("");
  });

  it("transfer builder includes identity_file", () => {
    const auth = hostAuth(keyHost);
    const request = buildBrokerTransferRequest({
      credentialRef: auth.credentialRef,
      identityFile: auth.identityFile,
      host: keyHost,
      direction: "upload",
      localPath: "/tmp/a",
      remotePath: "/tmp/b",
      recursive: false,
      settings,
    });
    expect(request.identity_file).toBe(path.join(os.homedir(), ".ssh", "id_ed25519"));
    expect("transferBackend" in request).toBe(false);
    expect("detach" in request).toBe(false);
  });
});
