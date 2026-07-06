import { spawnSync } from "node:child_process";
import path from "node:path";
import { getRuntimeEnv, vscodeDir } from "./vscode-runtime.js";

const script = process.platform === "win32" ? path.join("scripts", "code.bat") : path.join("scripts", "code.sh");
const args = process.argv.slice(2);
const result = spawnSync(path.join(vscodeDir, script), args, {
  cwd: vscodeDir,
  env: getRuntimeEnv(),
  stdio: "inherit",
  shell: process.platform === "win32"
});

process.exit(result.status ?? 1);
