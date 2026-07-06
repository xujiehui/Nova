import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRuntimeEnv, vscodeDir } from "./vscode-runtime.js";

const durationMs = Number(process.env.SMOKE_DURATION_MS ?? 20000);
const logPath = path.join(os.tmpdir(), "nova-vscode-smoke.log");
const script = process.platform === "win32" ? path.join("scripts", "code.bat") : path.join("scripts", "code.sh");
const args = [
  "--disable-gpu",
  "--user-data-dir",
  path.join(os.tmpdir(), "nova-vscode-user"),
  "--extensions-dir",
  path.join(os.tmpdir(), "nova-vscode-ext")
];
const userDataDir = args[args.indexOf("--user-data-dir") + 1];

const log = fs.createWriteStream(logPath, { flags: "w" });
const child = spawn(path.join(vscodeDir, script), args, {
  cwd: vscodeDir,
  env: getRuntimeEnv(),
  detached: process.platform !== "win32",
  shell: process.platform === "win32"
});

child.stdout.pipe(log);
child.stderr.pipe(log);

const exitCode = await new Promise<number | null>((resolve) => {
  const timer = setTimeout(() => {
    stopChild();
    resolve(null);
  }, durationMs);

  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

child.stdout.destroy();
child.stderr.destroy();
log.end();
cleanupElectronChildren();
const output = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
process.stdout.write(output.split("\n").slice(0, 120).join("\n"));

if (exitCode && exitCode !== 0) {
  console.error(`\nVS Code smoke start exited early with code ${exitCode}. Log: ${logPath}`);
  process.exit(exitCode);
}

if (!output.includes("code-oss-dev@") && !output.includes("electron")) {
  console.error(`\nVS Code smoke start did not reach the Electron launch script. Log: ${logPath}`);
  process.exit(1);
}

console.log(`\nVS Code smoke start reached Electron launch path. Log: ${logPath}`);

function stopChild() {
  if (child.pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill();
    } else {
      process.kill(-child.pid);
    }
  } catch {
    child.kill();
  }
}

function cleanupElectronChildren() {
  if (process.platform === "win32") {
    return;
  }

  spawnSync("pkill", ["-f", userDataDir], {
    stdio: "ignore"
  });
}
