#!/usr/bin/env node
/**
 * Stage the npm platform packages and the bundled MCP server.
 *
 * Publish order (after `npm login`):
 *   npm publish npm/helixd-win32-x64
 *   npm publish npm/helixd-linux-x64-gnu
 *   npm publish npm/helix-ssh-mcp
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = rootPackage.version;
const esbuild = path.join(root, "node_modules", "esbuild", "bin", "esbuild");

function copy(source, target, mode) {
  if (!fs.existsSync(source)) {
    throw new Error(`missing build output: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  if (mode) fs.chmodSync(target, mode);
  console.log(`staged ${path.relative(root, target)}`);
}

// 1. bundle the MCP server with a node shebang
const bundleDir = path.join(root, "npm", "helix-ssh-mcp", "bin");
fs.mkdirSync(bundleDir, { recursive: true });
execFileSync(
  process.execPath,
  [
    esbuild,
    "apps/ssh-mcp/src/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--log-level=warning",
    `--outfile=${path.join(bundleDir, "helix-ssh-mcp.mjs")}`,
  ],
  { cwd: root, stdio: "inherit" },
);

// 2. stage the daemon binaries that are present locally
const windowsBinary = path.join(root, "target", "release", "helixd.exe");
if (fs.existsSync(windowsBinary)) {
  copy(windowsBinary, path.join(root, "npm", "helixd-win32-x64", "bin", "helixd.exe"));
} else {
  console.warn("skip Windows daemon: target/release/helixd.exe not built");
}

const linuxBinary = path.join(root, "target", "release", "helixd");
if (fs.existsSync(linuxBinary)) {
  copy(linuxBinary, path.join(root, "npm", "helixd-linux-x64-gnu", "bin", "helixd"), 0o755);
} else {
  console.warn("skip Linux daemon: build it on Linux before publishing that package");
}

// 3. keep every staged package on the workspace version
for (const directory of ["helix-ssh-mcp", "helixd-win32-x64", "helixd-linux-x64-gnu"]) {
  const file = path.join(root, "npm", directory, "package.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.version = version;
  if (data.optionalDependencies) {
    for (const name of Object.keys(data.optionalDependencies)) {
      data.optionalDependencies[name] = version;
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

console.log(`npm packages staged for ${version}`);
console.log("next: npm pack --dry-run in each package, then publish platform packages first");
