import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One-shot verification entry: benchmark, stress, then max/limit tests.
//   node tests/run-all.mjs
const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = ["bench.mjs", "stress.mjs", "max.mjs"];
let failed = false;
for (const script of scripts) {
  console.log(`\n===== ${script} =====`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, script)], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("exit", resolve);
  });
  if (code === 0) {
    console.log(`${script} PASSED`);
  } else {
    failed = true;
    console.log(`${script} FAILED (exit ${code})`);
  }
}
console.log(`\n== verification ${failed ? "FAILED" : "PASSED"} ==`);
process.exit(failed ? 1 : 0);