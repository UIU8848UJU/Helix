#!/usr/bin/env node
/**
 * Install, run and uninstall the staged npm packages in a throwaway prefix.
 *
 * Run `node scripts/package/build-npm-packages.mjs` first so the platform
 * package contains its daemon binary.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const platformPackage = process.platform === "win32"
  ? "helixd-win32-x64"
  : process.arch === "arm64"
    ? "helixd-linux-arm64-gnu"
    : "helixd-linux-x64-gnu";
const daemonName = process.platform === "win32" ? "helixd.exe" : "helixd";

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const run = (label, command, args, options = {}) => {
  const useShell = process.platform === "win32" && command === npm;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: useShell,
    ...options,
  });
  if (result.status !== 0) {
    console.log(`${label} failed (${result.status})`);
    console.log(result.stdout ?? "");
    console.log(result.stderr ?? "");
  }
  return result;
};

for (const directory of ["helix-ssh-mcp", platformPackage]) {
  const binary = path.join(root, "npm", directory, "bin", directory === "helix-ssh-mcp" ? "helix-ssh-mcp.mjs" : daemonName);
  if (!fs.existsSync(binary)) {
    console.error(`missing staged artifact: ${binary}\nrun scripts/package/build-npm-packages.mjs first`);
    process.exit(1);
  }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-npm-test-"));
const prefix = path.join(temp, "prefix");
const tarballs = [];
try {
  for (const directory of ["helix-ssh-mcp", platformPackage]) {
    const packed = run("npm pack", npm, ["pack", "--silent", "--pack-destination", temp], {
      cwd: path.join(root, "npm", directory),
    });
    const name = (packed.stdout ?? "").trim().split(/\r?\n/).pop();
    if (!name || !fs.existsSync(path.join(temp, name))) {
      check(`npm pack ${directory}`, false, name);
      process.exit(1);
    }
    tarballs.push(path.join(temp, name));
    check(`npm pack ${directory}`, true, name);
  }

  const install = run(
    "npm install -g",
    npm,
    ["install", "-g", "--prefix", prefix, "--omit=optional", "--ignore-scripts", ...tarballs],
  );
  check("npm install -g", install.status === 0);

  const installedMain = path.join(prefix, "node_modules", "helix-ssh-mcp");
  const installedPlatform = path.join(prefix, "node_modules", platformPackage);
  check("main package installed", fs.existsSync(installedMain));
  check("platform package installed", fs.existsSync(installedPlatform));

  const binShim = process.platform === "win32"
    ? path.join(prefix, "helix-ssh-mcp.cmd")
    : path.join(prefix, "bin", "helix-ssh-mcp");
  check("bin shim installed", fs.existsSync(binShim), binShim);

  const daemon = path.join(installedPlatform, "bin", daemonName);
  const help = run("daemon --help", daemon, ["--help"]);
  check("packaged daemon runs", fs.existsSync(daemon) && help.status === 0);

  const resolution = run(
    "daemon resolution",
    process.execPath,
    [
      "-e",
      `const p=require('node:path').join(${JSON.stringify(prefix)},'node_modules');console.log(require(require.resolve(${JSON.stringify(platformPackage)},{paths:[p]})))`,
    ],
  );
  check(
    "platform package resolves from node_modules",
    resolution.status === 0 && (resolution.stdout ?? "").includes(daemonName),
    (resolution.stdout ?? "").trim(),
  );

  const smokeScript = path.join(root, "scripts", "package", "smoke-mcp.mjs");
  const smokeResult = run("MCP smoke", process.execPath, [smokeScript, path.join(installedMain, "bin", "helix-ssh-mcp.mjs")]);
  check("installed MCP server handshake", smokeResult.status === 0);

  const uninstall = run(
    "npm uninstall -g",
    npm,
    ["uninstall", "-g", "--prefix", prefix, "helix-ssh-mcp", platformPackage],
  );
  check("npm uninstall -g", uninstall.status === 0);
  check("main package removed", !fs.existsSync(installedMain));
  check("platform package removed", !fs.existsSync(installedPlatform));
  check("bin shim removed", !fs.existsSync(binShim));
} catch (error) {
  check("unexpected error", false, error.message);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "NPM INSTALL/UNINSTALL PASSED" : `NPM PACKAGE TEST FAILED: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
