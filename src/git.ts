import { open, lstat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { literalPathspec } from "./args.js";
import type { ChangeGroup, ChangedFile } from "./types.js";

export type GitExec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const READ_ONLY_SUBCOMMANDS = new Set(["rev-parse", "status", "diff", "check-ignore"]);
const DEFAULT_CONTEXT_LIMIT = 60_000;
const UNTRACKED_PREVIEW_LIMIT = 8_192;

function statusLabel(file: ChangedFile): string {
  const rename = file.originalPath ? ` (from ${file.originalPath})` : "";
  return `${file.indexStatus}${file.worktreeStatus} ${file.path}${rename}`;
}

export function parsePorcelainStatus(output: string): ChangedFile[] {
  const records = output.split("\0");
  const files: ChangedFile[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Unexpected Git status output");

    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const file: ChangedFile = { indexStatus, worktreeStatus, path: record.slice(3) };
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      file.originalPath = records[++index];
      if (!file.originalPath) throw new Error("Incomplete rename record in Git status output");
    }
    files.push(file);
  }

  return files;
}

function isSensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.includes("credential") ||
    name.includes("secret") ||
    name.endsWith(".pem") ||
    name.endsWith(".key")
  );
}

async function previewUntrackedFile(repoRoot: string, path: string): Promise<string> {
  if (isSensitivePath(path)) return "[content omitted: potentially sensitive filename]";

  const absolute = resolve(repoRoot, path);
  const repoRelative = relative(repoRoot, absolute);
  if (repoRelative === ".." || repoRelative.startsWith(`..${sep}`)) return "[content omitted: path escapes repository]";

  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return "[content omitted: symbolic link]";
    if (!stat.isFile()) return "[content omitted: not a regular file]";

    const length = Math.min(stat.size, UNTRACKED_PREVIEW_LIMIT);
    const buffer = Buffer.alloc(length);
    const file = await open(absolute, "r");
    try {
      const { bytesRead } = await file.read(buffer, 0, length, 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) return "[content omitted: binary file]";
      const suffix = stat.size > bytesRead ? `\n[truncated after ${bytesRead} bytes]` : "";
      return `${content.toString("utf8")}${suffix}`;
    } finally {
      await file.close();
    }
  } catch (error) {
    return `[content unavailable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function appendBounded(
  parts: string[],
  heading: string,
  content: string,
  state: { used: number; truncated: boolean },
  limit: number,
): void {
  if (!content.trim()) return;
  const prefix = `\n## ${heading}\n`;
  const remaining = Math.max(0, limit - state.used - prefix.length);
  if (remaining === 0) {
    state.truncated = true;
    return;
  }
  const selected = content.length > remaining ? `${content.slice(0, Math.max(0, remaining - 32))}\n[section truncated]` : content;
  if (selected.length < content.length) state.truncated = true;
  parts.push(prefix, selected);
  state.used += prefix.length + selected.length;
}

export class ReadOnlyGit {
  constructor(private readonly exec: GitExec) {}

  private async run(
    subcommand: "rev-parse" | "status" | "diff" | "check-ignore",
    args: string[],
    cwd: string,
  ): Promise<ExecResult> {
    if (!READ_ONLY_SUBCOMMANDS.has(subcommand)) throw new Error(`Refusing non-read-only Git command: ${subcommand}`);
    return this.exec("git", ["--no-pager", subcommand, ...args], { cwd, timeout: 15_000 });
  }

  async findRepositoryRoot(cwd: string): Promise<string> {
    const result = await this.run("rev-parse", ["--show-toplevel"], cwd);
    if (result.code !== 0 || !result.stdout.trim()) throw new Error("Current directory is not inside a Git repository");
    return result.stdout.trim();
  }

  async isIgnoredDirectory(repoRoot: string, path: string): Promise<boolean> {
    if (!path) return false;
    const directoryPath = `${path.replace(/\/+$/, "")}/`;
    const result = await this.run("check-ignore", ["-q", "--no-index", "--", directoryPath], repoRoot);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new Error(result.stderr.trim() || `Unable to inspect Git ignore rules for ${path}`);
  }

  async collectGroup(
    repoRoot: string,
    path?: string,
    contextLimit = DEFAULT_CONTEXT_LIMIT,
    cwd = repoRoot,
    displayPath = path,
    includeIgnored = false,
  ): Promise<ChangeGroup> {
    const pathArguments = path ? ["--", literalPathspec(path)] : [];
    const ignoredArguments = includeIgnored ? ["--ignored=traditional"] : [];
    const status = await this.run(
      "status",
      ["--porcelain=v1", "-z", "--untracked-files=all", ...ignoredArguments, ...pathArguments],
      cwd,
    );
    if (status.code !== 0) throw new Error(status.stderr.trim() || "Unable to inspect Git status");

    const files = parsePorcelainStatus(status.stdout);
    const label = displayPath ? `/${displayPath}` : "All changes";
    if (files.length === 0) return { label, path: displayPath, files, context: "", truncated: false };

    const commonDiffArgs = ["--no-ext-diff", "--no-textconv", "--no-color", "--unified=3"];
    const statArgs = ["--no-ext-diff", "--no-textconv", "--no-color", "--stat"];
    const [stagedStat, unstagedStat, stagedDiff, unstagedDiff] = await Promise.all([
      this.run("diff", ["--cached", ...statArgs, ...pathArguments], cwd),
      this.run("diff", [...statArgs, ...pathArguments], cwd),
      this.run("diff", ["--cached", ...commonDiffArgs, ...pathArguments], cwd),
      this.run("diff", [...commonDiffArgs, ...pathArguments], cwd),
    ]);

    for (const result of [stagedStat, unstagedStat, stagedDiff, unstagedDiff]) {
      if (result.code !== 0) throw new Error(result.stderr.trim() || "Unable to inspect Git diff");
    }

    const untrackedParts: string[] = [];
    for (const file of files.filter((entry) => (
      (entry.indexStatus === "?" && entry.worktreeStatus === "?") ||
      (entry.indexStatus === "!" && entry.worktreeStatus === "!")
    ))) {
      untrackedParts.push(`### ${file.path}\n${await previewUntrackedFile(repoRoot, file.path)}`);
    }

    const statusText = files.map(statusLabel).join("\n");
    const ignoredNotice = includeIgnored
      ? "\n\nIgnored (`!!`) files are included because their containing folder was explicitly requested."
      : "";
    const parts = [`## Changed files\n${statusText}${ignoredNotice}`];
    const state = { used: parts[0].length, truncated: false };
    appendBounded(parts, "Staged statistics", stagedStat.stdout, state, contextLimit);
    appendBounded(parts, "Unstaged statistics", unstagedStat.stdout, state, contextLimit);
    appendBounded(parts, "Staged patch", stagedDiff.stdout, state, contextLimit);
    appendBounded(parts, "Unstaged patch", unstagedDiff.stdout, state, contextLimit);
    appendBounded(
      parts,
      includeIgnored ? "Untracked and explicitly requested ignored file previews" : "Untracked file previews",
      untrackedParts.join("\n\n"),
      state,
      contextLimit,
    );
    if (state.truncated) parts.push("\n## Notice\nGit context was truncated; filenames and statuses above are complete.");

    return { label, path: displayPath, files, context: parts.join(""), truncated: state.truncated };
  }
}
