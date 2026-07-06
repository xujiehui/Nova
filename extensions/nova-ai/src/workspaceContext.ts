import * as path from "node:path";
import * as vscode from "vscode";

const MAX_FILES = 6;
const MAX_FILE_BYTES = 9000;
const SEARCH_GLOB = "**/*.{ts,tsx,js,jsx,json,md,py,go,rs,java,cs,css,scss,html,yml,yaml}";
const EXCLUDE_GLOB = "**/{node_modules,.git,dist,out,build,vendor,.nova}/**";

export type RepositoryContextItem = {
  path: string;
  score: number;
  excerpt: string;
};

export async function collectRepositoryContext(prompt: string, activeFilePath?: string) {
  const keywords = extractKeywords(prompt);

  if (!keywords.length) {
    return [];
  }

  const files = await vscode.workspace.findFiles(SEARCH_GLOB, EXCLUDE_GLOB, 300);
  const scored: RepositoryContextItem[] = [];

  for (const uri of files) {
    const relativePath = vscode.workspace.asRelativePath(uri, false);

    if (relativePath === activeFilePath) {
      continue;
    }

    const excerpt = await readExcerpt(uri, keywords);
    const score = scorePath(relativePath, keywords) + scoreContent(excerpt, keywords);

    if (score <= 0 || !excerpt) {
      continue;
    }

    scored.push({
      path: relativePath,
      score,
      excerpt
    });
  }

  return scored.sort((first, second) => second.score - first.score).slice(0, MAX_FILES);
}

export function formatRepositoryContext(items: RepositoryContextItem[]) {
  if (!items.length) {
    return "";
  }

  return [
    "Relevant repository context:",
    ...items.map((item) => [`File: ${item.path}`, "```", item.excerpt, "```"].join("\n"))
  ].join("\n\n");
}

function extractKeywords(prompt: string) {
  const matches = prompt
    .toLowerCase()
    .match(/[a-z0-9_./-]{3,}/g)
    ?.map((keyword) => keyword.replace(/^\.|\.$/g, ""))
    .filter(Boolean);

  return [...new Set(matches ?? [])].slice(0, 12);
}

function scorePath(relativePath: string, keywords: string[]) {
  const normalizedPath = relativePath.toLowerCase();
  const basename = path.basename(normalizedPath);

  return keywords.reduce((score, keyword) => {
    if (basename.includes(keyword)) {
      return score + 4;
    }

    if (normalizedPath.includes(keyword)) {
      return score + 2;
    }

    return score;
  }, 0);
}

function scoreContent(content: string, keywords: string[]) {
  const normalizedContent = content.toLowerCase();

  return keywords.reduce((score, keyword) => {
    return normalizedContent.includes(keyword) ? score + 1 : score;
  }, 0);
}

async function readExcerpt(uri: vscode.Uri, keywords: string[]) {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString("utf8");

    if (!content.trim()) {
      return "";
    }

    const lowerContent = content.toLowerCase();
    const firstMatch = keywords
      .map((keyword) => lowerContent.indexOf(keyword))
      .filter((index) => index >= 0)
      .sort((first, second) => first - second)[0];

    if (firstMatch === undefined) {
      return content.slice(0, MAX_FILE_BYTES);
    }

    const start = Math.max(0, firstMatch - Math.floor(MAX_FILE_BYTES / 3));
    return content.slice(start, start + MAX_FILE_BYTES);
  } catch {
    return "";
  }
}
