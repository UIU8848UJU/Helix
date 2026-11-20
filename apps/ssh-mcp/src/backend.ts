import type { HostConfig, ResolvedSshBackend, SshBackend } from "./types.js";

/** Resolve the configured backend without conflating it with authentication. */
export function resolveSshBackend(host: HostConfig): ResolvedSshBackend {
  const requested: SshBackend = host.sshBackend ?? "auto";
  if (requested === "auto") {
    return host.auth.type === "openssh" ? "openssh" : "libssh2";
  }
  if (requested === "libssh2") {
    if (host.auth.type !== "windows-credential") {
      throw new Error("sshBackend=libssh2 requires windows-credential auth");
    }
    return "libssh2";
  }
  if (host.auth.type === "windows-credential" && !host.identityFile) {
    throw new Error("sshBackend=openssh with windows-credential auth requires identityFile");
  }
  return "openssh";
}

/**
 * Only errors emitted during SSH algorithm negotiation are safe candidates for
 * an OpenSSH fallback. Authentication, authorization, and network failures must
 * remain visible to the caller instead of being retried through another backend.
 */
export function isSshHandshakeCompatibilityError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  return normalized.includes("ssh handshake failed")
    && (normalized.includes("unable to exchange encryption keys")
      || normalized.includes("algorithm unsupported")
      || normalized.includes("no matching"));
}

export async function runWithSshBackend<T>(input: {
  host: HostConfig;
  runLibssh2: () => Promise<T>;
  runOpenSsh: () => Promise<T>;
}): Promise<T> {
  const requested = input.host.sshBackend ?? "auto";
  const selected = resolveSshBackend(input.host);
  if (selected === "openssh") return await input.runOpenSsh();

  try {
    return await input.runLibssh2();
  } catch (error) {
    if (requested === "auto"
      && input.host.identityFile
      && isSshHandshakeCompatibilityError(error)) {
      return await input.runOpenSsh();
    }
    throw error;
  }
}
