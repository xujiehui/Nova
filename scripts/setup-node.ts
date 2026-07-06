import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const version = process.env.NODE_VERSION ?? "24.17.0";
const platform = process.platform === "darwin" ? "darwin" : process.platform;
const arch = process.arch === "arm64" ? "arm64" : process.arch;
const name = `node-v${version}-${platform}-${arch}`;
const toolingDir = path.join(rootDir, ".tooling");
const archivePath = path.join(toolingDir, `${name}.tar.gz`);
const installDir = path.join(toolingDir, name);
const url = `https://nodejs.org/dist/v${version}/${name}.tar.gz`;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

fs.mkdirSync(toolingDir, { recursive: true });

if (!fs.existsSync(installDir)) {
  if (!fs.existsSync(archivePath)) {
    run("curl", ["-L", "--fail", url, "-o", archivePath]);
  }

  run("tar", ["-xzf", archivePath, "-C", toolingDir]);
}

const nodePath = path.join(installDir, "bin/node");
const npmPath = path.join(installDir, "bin/npm");

run(nodePath, ["--version"]);
run(npmPath, ["--version"]);

console.log(`Node runtime ready: ${installDir}`);
console.log(`Use: PATH="${path.join(installDir, "bin")}:$PATH" <command>`);
