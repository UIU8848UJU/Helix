#!/usr/bin/env node
/**
 * Install, run and uninstall the staged npm packages in a throwaway prefix.
 *
 * Run `node scripts/package/build-npm-packages.mjs` first so the platform
 * package contains its daemon binary.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDaemon(endpoint, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection(endpoint);
      let data = "";
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write('{"op":"ping"}\n'));
      socket.on("data", (chunk) => {
        data += chunk;
        if (!data.includes("\n")) return;
        clearTimeout(timer);
        socket.destroy();
        try { resolve(JSON.parse(data.split("\n", 1)[0]).ok === true); } catch { resolve(false); }
      });
      socket.on("error", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

async function waitExit(child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return true;
    await sleep(50);
  }
  return child.exitCode !== null;
}

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
let daemonProcess;
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

  // Global prefixes differ: Windows uses <prefix>/node_modules, Unix uses
  // <prefix>/lib/node_modules. npm may also nest the platform package under the
  // main package when it is resolved as an optional dependency.
  const installedModules = process.platform === "win32"
    ? path.join(prefix, "node_modules")
    : path.join(prefix, "lib", "node_modules");
  const installedMain = path.join(installedModules, "helix-ssh-mcp");
  const platformCandidates = [
    path.join(installedModules, platformPackage),
    path.join(installedMain, "node_modules", platformPackage),
  ];
  const installedPlatform = platformCandidates.find((candidate) => fs.existsSync(candidate));
  check("main package installed", fs.existsSync(installedMain));
  check("platform package installed", Boolean(installedPlatform), installedPlatform ?? platformCandidates.join(" | "));

  const packagedGuide = path.join(installedMain, "docs", "HELIX_AI_GUIDE.md");
  check("operations guide packaged", fs.existsSync(packagedGuide) && fs.statSync(packagedGuide).size > 1000);

  const binShim = process.platform === "win32"
    ? path.join(prefix, "helix-ssh-mcp.cmd")
    : path.join(prefix, "bin", "helix-ssh-mcp");
  check("bin shim installed", fs.existsSync(binShim), binShim);

  const daemon = path.join(installedPlatform ?? installedModules, "bin", daemonName);
  const help = run("daemon --help", daemon, ["--help"]);
  check("packaged daemon runs", fs.existsSync(daemon) && help.status === 0);

  const resolution = run(
    "daemon resolution",
    process.execPath,
    [
      "-e",
      `const p=${JSON.stringify(installedModules)};console.log(require(require.resolve(${JSON.stringify(platformPackage)},{paths:[p]})))`,
    ],
  );
  check(
    "platform package resolves from node_modules",
    resolution.status === 0 && (resolution.stdout ?? "").includes(daemonName),
    (resolution.stdout ?? "").trim(),
  );

  // `install` creates config/guide and registers Claude without touching the
  // real client: a fake `claude` on PATH records the arguments instead.
  const fakeBin = path.join(temp, "fakebin");
  fs.mkdirSync(fakeBin, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(fakeBin, "claude.cmd"), '@echo %*>>"%CLAUDE_LOG%"\r\n@exit /b 0\r\n');
  } else {
    const fakeClaude = path.join(fakeBin, "claude");
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CLAUDE_LOG"\nexit 0\n');
    fs.chmodSync(fakeClaude, 0o755);
  }
  const installRoot = path.join(temp, "install");
  const installConfig = path.join(installRoot, "ssh-mcp.json");
  const installGuide = path.join(installRoot, "HELIX_AI_GUIDE.md");
  const claudeLog = path.join(temp, "claude.log");
  const installResult = run(
    "install CLI",
    process.execPath,
    [path.join(installedMain, "bin", "helix-ssh-mcp.mjs"), "install"],
    {
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        HELIX_SSH_CONFIG: installConfig,
        HELIX_AI_GUIDE: installGuide,
        CLAUDE_LOG: claudeLog,
      },
    },
  );
  const installOutput = `${installResult.stdout ?? ""}${installResult.stderr ?? ""}`;
  const claudeCalls = fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, "utf8") : "";
  check("install CLI exits 0", installResult.status === 0, installOutput);
  check("install CLI creates config", fs.existsSync(installConfig), installOutput);
  check("install CLI writes the guide", fs.existsSync(installGuide) && fs.statSync(installGuide).size > 1000, installOutput);
  check("install CLI registers user-scope MCP", claudeCalls.includes("mcp add helix-ssh --scope user"), claudeCalls);
  check("install CLI passes the guide path", claudeCalls.includes(`HELIX_AI_GUIDE=${installGuide}`), claudeCalls);

  const smokeScript = path.join(root, "scripts", "package", "smoke-mcp.mjs");
  const smokeResult = run("MCP smoke", process.execPath, [smokeScript, path.join(installedMain, "bin", "helix-ssh-mcp.mjs")]);
  check("installed MCP server handshake", smokeResult.status === 0);

  // stop the daemon through the packaged CLI before removing files
  const endpoint = process.platform === "win32"
    ? String.raw`\\.\pipe\helix-npm-test-${process.pid}`
    : path.join(temp, "broker.sock");
  const cliConfig = path.join(temp, "ssh-mcp.json");
  fs.writeFileSync(cliConfig, JSON.stringify({ version: 1, settings: {}, hosts: {} }));
  daemonProcess = spawn(daemon, ["serve-daemon", "--endpoint", endpoint, "--workers", "1"], {
    env: { ...process.env, HELIX_SSH_CONFIG: cliConfig },
    stdio: "ignore",
  });
  check("daemon started for uninstall test", await waitForDaemon(endpoint), endpoint);

  const cliEnv = { ...process.env, HELIX_BROKER_ENDPOINT: endpoint, HELIX_SSH_CONFIG: cliConfig };
  const uninstallCli = run(
    "uninstall CLI",
    process.execPath,
    [path.join(installedMain, "bin", "helix-ssh-mcp.mjs"), "uninstall"],
    { env: cliEnv },
  );
  const cliOutput = `${uninstallCli.stdout ?? ""}${uninstallCli.stderr ?? ""}`;
  check("uninstall CLI exits 0", uninstallCli.status === 0, cliOutput);
  check("uninstall CLI stops the daemon", cliOutput.includes("daemon: stopped"), cliOutput);
  check("uninstall CLI names the platform package", cliOutput.includes(platformPackage), cliOutput);
  check("daemon process exited after CLI uninstall", await waitExit(daemonProcess), String(daemonProcess.exitCode));

  fs.writeFileSync(cliConfig, JSON.stringify({ version: 1, settings: {}, hosts: {} }));
  const purge = run(
    "uninstall --purge",
    process.execPath,
    [path.join(installedMain, "bin", "helix-ssh-mcp.mjs"), "uninstall", "--purge"],
    { env: cliEnv },
  );
  check("uninstall --purge exits 0", purge.status === 0, `${purge.stdout ?? ""}${purge.stderr ?? ""}`);
  check("uninstall --purge removes config", !fs.existsSync(cliConfig));

  const purgeGuide = run(
    "uninstall --purge (guide)",
    process.execPath,
    [path.join(installedMain, "bin", "helix-ssh-mcp.mjs"), "uninstall", "--purge"],
    { env: { ...cliEnv, HELIX_SSH_CONFIG: installConfig, HELIX_AI_GUIDE: installGuide } },
  );
  check("uninstall --purge removes guide", !fs.existsSync(installGuide), `${purgeGuide.stdout ?? ""}${purgeGuide.stderr ?? ""}`);

  try { fs.rmSync(endpoint, { force: true }); } catch { /* pipe or socket already gone */ }

  const uninstall = run(
    "npm uninstall -g",
    npm,
    ["uninstall", "-g", "--prefix", prefix, "helix-ssh-mcp", platformPackage],
  );
  check("npm uninstall -g", uninstall.status === 0);
  check("main package removed", !fs.existsSync(installedMain));
  check("platform package removed", !installedPlatform || !fs.existsSync(installedPlatform));
  check("bin shim removed", !fs.existsSync(binShim));
} catch (error) {
  check("unexpected error", false, error.message);
} finally {
  try { daemonProcess?.kill(); } catch { /* ignore */ }
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "NPM INSTALL/UNINSTALL PASSED" : `NPM PACKAGE TEST FAILED: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
