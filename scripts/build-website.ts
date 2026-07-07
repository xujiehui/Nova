import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const websiteDir = path.join(root, "website");
const outputDir = path.join(root, "dist", "website");
const iconSource = path.join(root, "extensions", "nova-ai", "media", "nova-icon.svg");

async function buildWebsite(): Promise<void> {
  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });

  await cp(websiteDir, outputDir, {
    recursive: true,
    filter: (source) => !source.endsWith(path.join("website", "assets", "nova-preview.html")),
  });

  await mkdir(path.join(outputDir, "assets"), { recursive: true });
  await cp(iconSource, path.join(outputDir, "assets", "nova-icon.svg"));

  const indexPath = path.join(outputDir, "index.html");
  const indexHtml = await readFile(indexPath, "utf8");
  const rewrittenHtml = indexHtml.replaceAll("../extensions/nova-ai/media/nova-icon.svg", "./assets/nova-icon.svg");
  await writeFile(indexPath, rewrittenHtml);
}

await buildWebsite();
