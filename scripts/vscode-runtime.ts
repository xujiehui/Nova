import fs from "node:fs";
import path from "node:path";

export const rootDir = path.resolve(import.meta.dirname, "..");
export const vscodeDir = path.resolve(process.env.VSCODE_DIR ?? path.join(rootDir, "vendor/vscode"));

export function getLocalNodeBin() {
  const requestedVersion = process.env.NODE_VERSION ?? "24.17.0";
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : process.arch;
  const binPath = path.join(rootDir, ".tooling", `node-v${requestedVersion}-${platform}-${arch}`, "bin");

  return fs.existsSync(path.join(binPath, "node")) ? binPath : undefined;
}

export function getRuntimeEnv() {
  const localNodeBin = getLocalNodeBin();

  return {
    ...process.env,
    PATH: localNodeBin ? `${localNodeBin}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH
  };
}
