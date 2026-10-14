/**
 * Wildcard resolution against a FileSystemPort.
 *
 * Only `*` and `?` are wildcards (plus `**` for "any depth"); brackets,
 * braces and parentheses are common in mod folder names ("[K1] Foo (v1.2)")
 * and are treated literally. `*` never crosses a `/`. Matching is
 * case-insensitive. Only the directory tree below the longest wildcard-free
 * prefix is listed, and only as deep as the pattern needs.
 */

import picomatch from "picomatch";

import type { DirEntry, FileSystemPort } from "../ports/filesystem.js";
import { comparePaths, hasWildcard, normalizePath, rootOf } from "./paths.js";

const PICOMATCH_OPTIONS: picomatch.PicomatchOptions = {
  nocase: true,
  dot: true,
  nobrace: true,
  noextglob: true,
  nobracket: true,
};

/** Escape everything picomatch could misread except `*` and `?`. */
function escapeLiteral(pattern: string): string {
  return pattern.replace(/[\\()[\]{}!+@|]/g, (c) => "\\" + c);
}

/**
 * Split an absolute pattern into the longest leading directory without
 * wildcards and the remaining pattern (empty when there is no wildcard).
 *   "/mods/Foo/*.zip"      -> { dir: "/mods/Foo", rest: "*.zip" }
 *   "/mods/**\/x/*.tpc"    -> { dir: "/mods",     rest: "**\/x/*.tpc" }
 *   "/mods/Foo"            -> { dir: "/mods/Foo", rest: "" }
 */
export function splitWildcardPrefix(pattern: string): { dir: string; rest: string } {
  const norm = normalizePath(pattern);
  const root = rootOf(norm);
  const body = norm.slice(root.length);
  const segments = body === "" ? [] : body.split("/");
  const firstWild = segments.findIndex((s) => hasWildcard(s));
  if (firstWild === -1) return { dir: norm, rest: "" };
  const dir = root + segments.slice(0, firstWild).join("/");
  return { dir: dir.length > root.length ? dir : root, rest: segments.slice(firstWild).join("/") };
}

/**
 * Expand a wildcard pattern into the absolute, case-resolved paths that
 * match (files and directories). A pattern without wildcards resolves to
 * `[path]` when it exists (with on-disk casing) or `[]`.
 */
export async function resolveWildcards(fs: FileSystemPort, absolutePattern: string): Promise<string[]> {
  const { dir, rest } = splitWildcardPrefix(absolutePattern);
  if (rest === "") {
    const resolved = await fs.resolveCase(dir);
    return resolved === undefined ? [] : [resolved];
  }
  const base = await fs.resolveCase(dir);
  if (base === undefined) return [];
  const baseStat = await fs.stat(base);
  if (!baseStat?.isDirectory) return [];

  const restSegments = rest.split("/");
  const maxDepth = restSegments.includes("**") ? Number.POSITIVE_INFINITY : restSegments.length;
  const isMatch = picomatch(escapeLiteral(rest), PICOMATCH_OPTIONS);

  const matches: string[] = [];
  const visited = new Set<string>();
  const visit = async (d: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    if (fs.realpath) {
      let canonical: string;
      try { canonical = await fs.realpath(d); } catch { return; }
      if (visited.has(canonical)) return;
      visited.add(canonical);
    }
    let entries: DirEntry[];
    try {
      entries = await fs.readDir(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
      if (isMatch(rel)) matches.push(entry.path);
      if (entry.isDirectory && depth < maxDepth) await visit(entry.path, rel, depth + 1);
    }
  };
  await visit(base, "", 1);
  return matches.sort(comparePaths);
}
