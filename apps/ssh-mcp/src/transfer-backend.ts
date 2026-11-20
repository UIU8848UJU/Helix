import type { HostConfig } from "./types.js";

/**
 * Resolve which transport carries a file transfer.
 *
 * `auto` reproduces the historical split: password-backed hosts go through the
 * daemon's SFTP, everything else through the external `scp` subprocess.
 */
export function resolveTransferBackend(host: HostConfig): "scp" | "broker" {
  const requested = host.transferBackend ?? "auto";
  if (requested === "broker") return "broker";
  if (requested === "scp") return "scp";
  return host.auth.type === "windows-credential" ? "broker" : "scp";
}
