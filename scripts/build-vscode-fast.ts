import { spawnSync } from "node:child_process";
import { getRuntimeEnv, vscodeDir } from "./vscode-runtime.js";

const result = spawnSync("npm", ["run", "build-fast"], {
  cwd: vscodeDir,
  env: getRuntimeEnv(),
  stdio: "inherit",
  shell: process.platform === "win32"
});

process.exit(result.status ?? 1);
