/**
 * Instruction file routes: load (path / content / url), get, put (editor),
 * save, markdown import/export and merge.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, resolve as resolvePath } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  generateMarkdownDocs,
  mergeInstructionFiles,
  parseInstructionFileDetailed,
  parseMarkdownBuild,
  serializeInstructionFile,
  type InstructionFile,
  type MarkdownStyle,
} from "@modsync/core";
import { HttpError, type AppState } from "../state.js";
import { bodyOf, fsErrorStatus, isRecord, optionalString, sendJsonNull } from "./util.js";

export interface ParsedDocument {
  file: InstructionFile;
  warnings: string[];
  kind: "toml" | "markdown" | "json";
}

const MARKDOWN_STYLES: MarkdownStyle[] = ["reddit", "deadlystream", "structured"];

function looksLikeMarkdown(text: string): boolean {
  const head = text.slice(0, 4000);
  if (/^\s*#{1,3}\s+\S/m.test(head) && !/^\s*\[\[?\w/m.test(head)) return true;
  return /\*\*Name:\*\*|\*\*Author:\*\*|<!--\s*\[HIDDEN:MOD\]/.test(head);
}

/** Normalize an object coming from JSON (or the editor) through the lenient TOML reader. */
export function normalizeInstructionFile(raw: unknown): ParsedDocument {
  if (!isRecord(raw) || !Array.isArray(raw.mods)) throw new HttpError(400, "Expected an InstructionFile ({ config, mods[] })");
  let text: string;
  try {
    text = serializeInstructionFile({ config: (raw.config ?? {}) as InstructionFile["config"], mods: raw.mods as InstructionFile["mods"] });
  } catch (err) {
    throw new HttpError(400, `Invalid instruction file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseInstructionFileDetailed(text);
  return { ...parsed, kind: "json" };
}

/** Parse TOML, markdown or JSON text, detecting the format from the hint or the content. */
export function parseDocument(text: string, hint?: { extension?: string; sourceUrl?: string }): ParsedDocument {
  const ext = hint?.extension?.toLowerCase();
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  const asMarkdown = (): ParsedDocument => {
    const res = parseMarkdownBuild(text, { sourceUrl: hint?.sourceUrl });
    return { ...res, kind: "markdown" };
  };
  const asJson = (): ParsedDocument => {
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      throw new HttpError(400, `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return normalizeInstructionFile(raw);
  };
  const asToml = (): ParsedDocument => {
    try {
      return { ...parseInstructionFileDetailed(text), kind: "toml" };
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  };
  if (ext === ".md" || ext === ".markdown") return asMarkdown();
  if (ext === ".json") return asJson();
  if (ext === ".toml") return asToml();
  if (trimmed.startsWith("{")) return asJson();
  if (looksLikeMarkdown(trimmed)) return asMarkdown();
  return asToml();
}

async function fetchText(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, `Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new HttpError(400, "Only http(s) URLs can be loaded");
  const res = await fetch(parsed, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!res.ok) throw new HttpError(502, `Fetching ${url} failed with HTTP ${res.status}`);
  return res.text();
}

export async function loadFromDisk(path: string): Promise<{ text: string; abs: string }> {
  const abs = resolvePath(path);
  try {
    return { text: await readFile(abs, "utf8"), abs };
  } catch (err) {
    throw new HttpError(fsErrorStatus(err), `Cannot read "${abs}": ${(err as Error).message}`);
  }
}

export function registerFileRoutes(app: FastifyInstance, state: AppState): void {
  app.post("/api/file/load", async (req) => {
    const body = bodyOf(req.body);
    const path = optionalString(body, "path");
    const content = optionalString(body, "content");
    const url = optionalString(body, "url");
    let doc: ParsedDocument;
    let origin: string | null = null;
    if (path?.trim()) {
      const { text, abs } = await loadFromDisk(path);
      doc = parseDocument(text, { extension: extname(abs) });
      origin = abs;
    } else if (typeof content === "string") {
      doc = parseDocument(content, { extension: optionalString(body, "extension") });
    } else if (url?.trim()) {
      const text = await fetchText(url);
      let ext: string | undefined;
      try {
        ext = extname(new URL(url).pathname);
      } catch {
        ext = undefined;
      }
      doc = parseDocument(text, { extension: ext, sourceUrl: url });
    } else {
      throw new HttpError(400, "Provide one of { path }, { content } or { url }");
    }
    if (doc.kind === "markdown" && !doc.file.config.sourceUrl && origin) doc.file.config.sourceUrl = origin;
    if (state.installRunning) throw new HttpError(409, "Cannot replace the instruction file while an installation is running");
    return state.setFile(doc.file, doc.kind === "toml" ? origin : null, doc.warnings);
  });

  app.get("/api/file", async (_req, reply) => {
    if (!state.file) return sendJsonNull(reply);
    return state.file;
  });

  /** Where the file came from and the parser warnings (not part of the web client contract). */
  app.get("/api/file/info", async () => ({
    loaded: state.file !== null,
    path: state.filePath,
    warnings: state.fileWarnings,
    modCount: state.file?.mods.length ?? 0,
  }));

  app.put("/api/file", async (req) => {
    if (state.installRunning) throw new HttpError(409, "Cannot replace the instruction file while an installation is running");
    const doc = normalizeInstructionFile(req.body);
    return state.setFile(doc.file, state.filePath, doc.warnings);
  });

  app.post("/api/file/save", async (req) => {
    const file = state.requireFile();
    const body = bodyOf(req.body);
    const target = optionalString(body, "path")?.trim() || state.filePath;
    if (!target) throw new HttpError(400, "path is required (the file was not loaded from disk)");
    const abs = resolvePath(target);
    let text: string;
    try {
      text = serializeInstructionFile(file);
    } catch (err) {
      throw new HttpError(400, `Cannot serialize: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text, "utf8");
    } catch (err) {
      throw new HttpError(fsErrorStatus(err), `Cannot write "${abs}": ${(err as Error).message}`);
    }
    state.filePath = abs;
    return { ok: true, path: abs, bytes: Buffer.byteLength(text) };
  });

  app.post("/api/file/import-markdown", async (req) => {
    const body = bodyOf(req.body);
    const path = optionalString(body, "path");
    let text = optionalString(body, "content");
    let sourceUrl = optionalString(body, "sourceUrl");
    if (text === undefined) {
      if (!path?.trim()) throw new HttpError(400, "Provide { content } or { path }");
      const loaded = await loadFromDisk(path);
      text = loaded.text;
      sourceUrl ??= loaded.abs;
    }
    const res = parseMarkdownBuild(text, { sourceUrl });
    return { file: res.file, warnings: res.warnings };
  });

  app.post("/api/file/export-markdown", async (req) => {
    const file = state.requireFile();
    const body = bodyOf(req.body);
    const style = (optionalString(body, "style") ?? "deadlystream") as MarkdownStyle;
    if (!MARKDOWN_STYLES.includes(style)) throw new HttpError(400, `style must be one of ${MARKDOWN_STYLES.join(", ")}`);
    return { markdown: generateMarkdownDocs(file, style), style };
  });

  app.post("/api/file/merge", async (req) => {
    const existing = state.requireFile();
    const body = bodyOf(req.body);
    const path = optionalString(body, "path");
    let text = optionalString(body, "content");
    let ext: string | undefined;
    if (text === undefined) {
      if (!path?.trim()) throw new HttpError(400, "Provide { content } or { path }");
      const loaded = await loadFromDisk(path);
      text = loaded.text;
      ext = extname(loaded.abs);
    }
    const incoming = parseDocument(text, { extension: ext });
    const result = mergeInstructionFiles(existing, incoming.file);
    return { ...result, warnings: incoming.warnings };
  });
}
