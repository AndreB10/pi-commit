import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { parsePorcelainStatus, ReadOnlyGit, type GitExec } from "../src/git.js";

function processExec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      code: code ?? 1,
      killed: signal !== null,
    }));
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await processExec("git", args, { cwd });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-commit-git-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "tests@example.com");
  await git(root, "config", "user.name", "Tests");
  await mkdir(join(root, "folder1"));
  await mkdir(join(root, "folder2"));
  await writeFile(join(root, "folder1", "tracked.txt"), "original\n");
  await writeFile(join(root, "folder2", "rename-me.txt"), "rename\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "test(repo): create fixture");
  return root;
}

async function snapshot(root: string) {
  return {
    head: await git(root, "rev-parse", "HEAD"),
    status: await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    staged: await git(root, "diff", "--cached", "--binary"),
    unstaged: await git(root, "diff", "--binary"),
    tracked: await readFile(join(root, "folder1", "tracked.txt"), "utf8"),
    untracked: await readFile(join(root, "folder1", "new file.txt"), "utf8"),
  };
}

describe("porcelain parser", () => {
  it("parses ordinary, untracked, and rename records with spaces", () => {
    expect(parsePorcelainStatus(" M folder/a file.ts\0?? new file.ts\0R  moved.ts\0old.ts\0")).toEqual([
      { indexStatus: " ", worktreeStatus: "M", path: "folder/a file.ts" },
      { indexStatus: "?", worktreeStatus: "?", path: "new file.ts" },
      { indexStatus: "R", worktreeStatus: " ", path: "moved.ts", originalPath: "old.ts" },
    ]);
  });
});

describe("read-only Git inspection", () => {
  it("collects staged, unstaged, renamed, and untracked changes without mutation", async () => {
    const root = await createRepository();
    await writeFile(join(root, "folder1", "tracked.txt"), "modified\n");
    await writeFile(join(root, "folder1", "staged.txt"), "staged\n");
    await writeFile(join(root, "folder1", "new file.txt"), "untracked content\n");
    await writeFile(join(root, ".env"), "TOKEN=do-not-send\n");
    await git(root, "add", "folder1/staged.txt");
    await git(root, "mv", "folder2/rename-me.txt", "folder2/renamed.txt");

    const calls: string[][] = [];
    const recordingExec: GitExec = async (command, args, options) => {
      expect(command).toBe("git");
      calls.push(args);
      return processExec(command, args, options);
    };
    const reader = new ReadOnlyGit(recordingExec);
    const before = await snapshot(root);

    expect(await reader.findRepositoryRoot(join(root, "folder1"))).toBe(root);
    const group = await reader.collectGroup(root);

    expect(group.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      ".env",
      "folder1/new file.txt",
      "folder1/staged.txt",
      "folder1/tracked.txt",
      "folder2/renamed.txt",
    ]));
    expect(group.context).toContain("untracked content");
    expect(group.context).not.toContain("do-not-send");
    expect(group.context).toContain("content omitted: potentially sensitive filename");
    expect(await snapshot(root)).toEqual(before);

    const allowed = new Set(["rev-parse", "status", "diff"]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args[0]).toBe("--no-pager");
      expect(allowed.has(args[1])).toBe(true);
      expect(args).not.toContain("commit");
      expect(args).not.toContain("add");
    }
  });

  it("filters a literal folder from that folder's Git working directory and marks bounded context as truncated", async () => {
    const root = await createRepository();
    await writeFile(join(root, "folder1", "tracked.txt"), `${"large change\n".repeat(200)}`);
    await writeFile(join(root, "folder2", "rename-me.txt"), "other change\n");
    const folderCwd = join(root, "folder1");
    const workingDirectories: Array<string | undefined> = [];
    const reader = new ReadOnlyGit(async (command, args, options) => {
      workingDirectories.push(options?.cwd);
      return processExec(command, args, options);
    });

    const group = await reader.collectGroup(root, "folder1", 300, folderCwd);
    expect(group.files.map((file) => file.path)).toEqual(["folder1/tracked.txt"]);
    expect(group.truncated).toBe(true);
    expect(group.context).toContain("Git context was truncated");
    expect(group.context).not.toContain("folder2/rename-me.txt");
    expect(workingDirectories).toEqual(Array(5).fill(folderCwd));
  });

  it("includes files from an explicitly requested ignored folder without exposing sensitive content", async () => {
    const root = await createRepository();
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-qm", "test(repo): ignore fixture folder");
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "source.ts"), "export const ignored = true;\n");
    await writeFile(join(root, "ignored", ".env"), "TOKEN=do-not-send\n");

    const reader = new ReadOnlyGit(processExec);
    expect(await reader.isIgnoredDirectory(root, "ignored")).toBe(true);
    expect(await reader.isIgnoredDirectory(root, "folder1")).toBe(false);
    expect((await reader.collectGroup(root, "ignored")).files).toEqual([]);

    const group = await reader.collectGroup(
      root,
      "ignored",
      undefined,
      join(root, "ignored"),
      "ignored",
      true,
    );
    expect(group.files).toEqual([
      { indexStatus: "!", worktreeStatus: "!", path: "ignored/.env" },
      { indexStatus: "!", worktreeStatus: "!", path: "ignored/source.ts" },
    ]);
    expect(group.context).toContain("export const ignored = true");
    expect(group.context).toContain("Ignored (`!!`) files are included");
    expect(group.context).toContain("content omitted: potentially sensitive filename");
    expect(group.context).not.toContain("do-not-send");
  });

  it("uses a child repository even when its folder is ignored by the parent repository", async () => {
    const parent = await createRepository();
    await writeFile(join(parent, ".gitignore"), "child-repo/\n");
    await git(parent, "add", ".gitignore");
    await git(parent, "commit", "-qm", "test(repo): ignore child repository");

    const child = join(parent, "child-repo");
    await mkdir(child);
    await git(child, "init", "-q");
    await git(child, "config", "user.email", "tests@example.com");
    await git(child, "config", "user.name", "Tests");
    await writeFile(join(child, "source.ts"), "export const value = 1;\n");
    await git(child, "add", ".");
    await git(child, "commit", "-qm", "test(repo): create child fixture");
    await writeFile(join(child, "source.ts"), "export const value = 2;\n");

    const reader = new ReadOnlyGit(processExec);
    expect(await reader.findRepositoryRoot(child)).toBe(child);
    const group = await reader.collectGroup(child, undefined, undefined, child, "child-repo");
    expect(group.label).toBe("/child-repo");
    expect(group.files).toEqual([{ indexStatus: " ", worktreeStatus: "M", path: "source.ts" }]);
    expect(group.context).toContain("export const value = 2");
  });

  it("supports an unborn repository with untracked files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-commit-unborn-"));
    await git(root, "init", "-q");
    await writeFile(join(root, "new.ts"), "export const value = 1;\n");

    const group = await new ReadOnlyGit(processExec).collectGroup(root);
    expect(group.files).toEqual([{ indexStatus: "?", worktreeStatus: "?", path: "new.ts" }]);
    expect(group.context).toContain("export const value = 1");
  });

  it("reports non-repositories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-commit-no-git-"));
    await expect(new ReadOnlyGit(processExec).findRepositoryRoot(directory)).rejects.toThrow("not inside a Git repository");
  });
});
