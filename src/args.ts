import { isAbsolute, relative, resolve, sep } from "node:path";

export function parseCommandArguments(input: string): string[] {
  const values: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      started = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        values.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (escaped) throw new Error("Folder arguments cannot end with an escape character");
  if (quote) throw new Error("Folder arguments contain an unmatched quote");
  if (started) values.push(current);
  if (values.some((value) => value.length === 0)) throw new Error("Folder arguments cannot be empty");

  return values;
}

export function normalizeRequestedPaths(arguments_: string[], repoRoot: string): string[] {
  const normalized: string[] = [];

  for (const argument of arguments_) {
    if (argument.includes("\0")) throw new Error("Folder paths cannot contain NUL bytes");
    if (/^[A-Za-z]:[\\/]/.test(argument)) throw new Error(`Folder must be repository-relative: ${argument}`);

    const rootRelative = argument.startsWith("/") ? argument.slice(1) : argument;
    if (isAbsolute(rootRelative)) throw new Error(`Folder must be repository-relative: ${argument}`);

    const absolute = resolve(repoRoot, rootRelative || ".");
    const repoRelative = relative(repoRoot, absolute);
    if (repoRelative === ".." || repoRelative.startsWith(`..${sep}`) || isAbsolute(repoRelative)) {
      throw new Error(`Folder escapes the repository: ${argument}`);
    }

    const gitPath = repoRelative.split(sep).join("/");
    if (!normalized.includes(gitPath)) normalized.push(gitPath);
  }

  for (let left = 0; left < normalized.length; left++) {
    for (let right = left + 1; right < normalized.length; right++) {
      const a = normalized[left];
      const b = normalized[right];
      if (a === "" || b === "" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        throw new Error(`Folder arguments overlap: /${a} and /${b}`);
      }
    }
  }

  return normalized;
}

export function literalPathspec(path: string): string {
  return `:(top,literal)${path}`;
}
