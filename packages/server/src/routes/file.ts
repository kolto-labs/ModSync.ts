/**
 * Instruction file routes: load (path / content / url), get, put (editor),
 * save, markdown import/export and merge.
 */
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve as resolvePath } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  openArchive,
  Installer,
  applyAuthoringOperations,
  readAuthoringSessionSnapshot,
  readArchivePins,
  verifyArchivePin,
  projectRustAuthoringGuide,
  requireRustAuthoringGuide,
  readAuthoringOperations,
  generateMarkdownDocs,
  mergeInstructionFiles,
  parseInstructionFileDetailed,
  parseMarkdownBuild,
  serializeInstructionFile,
  type InstructionFile,
  type MarkdownStyle,
} from "@modsync/core";
import { safeExportPath } from "../exportPolicy.js";
import { persistWithRustAuthoring, predictWithRustAuthoring } from "../rustAuthoringBridge.js";
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
  if (raw.rustAuthoringGuide !== undefined) return { ...projectRustAuthoringGuide(raw.rustAuthoringGuide), kind: "json" };
  let text: string;
  try {
    text = serializeInstructionFile({ metadata: raw.metadata as InstructionFile["metadata"], config: (raw.config ?? {}) as InstructionFile["config"], mods: raw.mods as InstructionFile["mods"] });
  } catch (err) {
    throw new HttpError(400, `Invalid instruction file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseInstructionFileDetailed(text);
  return { ...parsed, kind: "json" };
}

/** Parse TOML, markdown or JSON text, detecting the format from the hint or the content. */
export function parseDocument(text: string, hint?: { extension?: string; sourceUrl?: string }): ParsedDocument {
  const ext = hint?.extension?.toLowerCase();
  const trimmed = text.replace(/^﻿/, "").trimStart();
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
    if (isRecord(raw) && Array.isArray(raw.thisMod)) return { ...projectRustAuthoringGuide(raw), kind: "json" };
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
    return state.setFile(doc.file, doc.kind === "toml" || doc.file.rustAuthoringGuide ? origin : null, doc.warnings);
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
    if (state.file?.rustAuthoringGuide) throw new HttpError(409, "Apply Rust authoring changes through /api/file/edit to preserve draft provenance");
    const doc = normalizeInstructionFile(req.body);
    return state.setFile(doc.file, state.filePath, doc.warnings);
  });


  app.post("/api/file/edit", async (req) => {
    if (state.installRunning) throw new HttpError(409, "Cannot edit the guide while an installation is running");
    const body = bodyOf(req.body);
    try {
      const guide = requireRustAuthoringGuide(state.requireFile());
      const edited = applyAuthoringOperations(guide, readAuthoringOperations(body.operations));
      const projected = projectRustAuthoringGuide(edited, false);
      return state.setFile(projected.file, state.filePath, projected.warnings);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/file/authoring-capabilities", async () => ({ reader: true, independentPredictionBackend:"typescript-vfs", predictionBackend:(app as FastifyInstance & { rustAuthoringExecutable?: string }).rustAuthoringExecutable ? "rust-cli" : null, persistenceBackend: (app as FastifyInstance & { rustAuthoringExecutable?: string }).rustAuthoringExecutable ? "rust-cli" : null }));
  /** Independent read-only VFS prediction; never the Rust writer backend. */
  app.post("/api/file/authoring-predict-independent", async (req) => {
    const body=bodyOf(req.body),directory=optionalString(body,"directory"),expectedRevision=optionalString(body,"expectedRevision"),modDirectory=optionalString(body,"modDirectory"),kotorDirectory=optionalString(body,"kotorDirectory"),componentGuid=optionalString(body,"componentGuid");
    if(!directory||!expectedRevision||!modDirectory||!kotorDirectory)throw new HttpError(400,"Provide session, revision, mod and game directories");
    if(body.instructionCount!==undefined&&(typeof body.instructionCount!=="number"||!Number.isSafeInteger(body.instructionCount)||body.instructionCount<0))throw new HttpError(400,"Invalid instruction boundary");
    try{
      const snapshot=await readAuthoringSessionSnapshot(directory);
      if(snapshot.revisionId!==expectedRevision)throw new HttpError(409,"Saved session revision changed");
      const installer=new Installer(projectRustAuthoringGuide(snapshot.guide,false).file,{...state.settings,modDirectory,kotorDirectory});
      const summary=await installer.run({dryRun:true,authoringPrediction:{sessionDirectory:snapshot.directory,componentGuid,instructionCount:body.instructionCount as number|undefined}});
      const prediction=summary.virtualPrediction;if(!prediction)throw new HttpError(400,summary.error??"Independent prediction did not produce a virtual result");
      const current=await readAuthoringSessionSnapshot(directory);
      if(current.headSha256!==snapshot.headSha256||current.revisionSha256!==snapshot.revisionSha256)throw new HttpError(409,"Saved session changed during prediction");
      return {backend:"typescript-vfs",revisionId:snapshot.revisionId,prediction};
    }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,error instanceof Error?error.message:String(error));}
  });
  app.post("/api/file/authoring-persist", async (req) => {
    if (state.installRunning) throw new HttpError(409, "Cannot edit a session during installation");
    const executable = (app as FastifyInstance & { rustAuthoringExecutable?: string }).rustAuthoringExecutable;
    if (!executable) throw new HttpError(409, "Rust authoring persistence backend is not configured");
    const body = bodyOf(req.body);
    const directory = optionalString(body, "directory"), expectedRevision = optionalString(body, "expectedRevision");
    if (!directory || !expectedRevision) throw new HttpError(400, "Provide directory and expectedRevision");
    try {
      const command = body.operation === "edit" ? { operation: "edit" as const, label: optionalString(body, "label") ?? "", operations: readAuthoringOperations(body.operations) } : body.operation === "undo" || body.operation === "redo" ? { operation: body.operation as "undo" | "redo" } : null;
      if (!command) throw new HttpError(400, "Unsupported authoring command");
      const result = await persistWithRustAuthoring(executable, directory, expectedRevision, command);
      const snapshot = await readAuthoringSessionSnapshot(directory);
      if (snapshot.revisionId !== result.currentRevision) throw new HttpError(409, "Revision was saved, then changed by another process; reload the session");
      const projected = projectRustAuthoringGuide(snapshot.guide, false);
      state.authoringDirectories.add(snapshot.directory);
      state.setFile(projected.file, null, projected.warnings);
      return { ...result, file: projected.file, head: snapshot.head, session: {directory:snapshot.directory,head:snapshot.head,revisionId:snapshot.revisionId,headSha256:snapshot.headSha256,revisionSha256:snapshot.revisionSha256,readOnly:true} };
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/file/authoring-predict", async (req) => {
    if(state.installRunning)throw new HttpError(409,"Cannot predict during installation");
    const executable=(app as FastifyInstance & {rustAuthoringExecutable?:string}).rustAuthoringExecutable;
    if(!executable)throw new HttpError(409,"Rust prediction backend is not configured");
    const body=bodyOf(req.body),directory=optionalString(body,"directory"),revision=optionalString(body,"expectedRevision"),source=optionalString(body,"sourceDirectory"),game=optionalString(body,"gameDirectory");
    if(!directory||!revision||!source||!game||typeof body.component!=="number"||typeof body.instructions!=="number")throw new HttpError(400,"Provide a saved revision, install roots, and prediction point");
    try { return await predictWithRustAuthoring(executable,directory,revision,source,game,body.component,body.instructions); }
    catch(error){throw new HttpError(400,error instanceof Error?error.message:String(error));}
  });

  app.post("/api/file/authoring-archive",async(req)=>{
    const body=bodyOf(req.body),directory=optionalString(body,"directory"),name=optionalString(body,"name");
    if(!directory||!name||/^\.tmp/i.test(name))throw new HttpError(400,"Choose a saved archive input");
    if(body.cursor!==undefined&&(typeof body.cursor!=="number"||!Number.isInteger(body.cursor)))throw new HttpError(400,"Invalid revision cursor");
    try{
      const snapshot=await readAuthoringSessionSnapshot(directory,body.cursor as number|undefined),pin=readArchivePins(snapshot.guide)[name];
      if(!pin)throw new Error("Archive name is not pinned by this revision");
      await verifyArchivePin(snapshot.directory,pin);
      const physicalPath=join(snapshot.directory,"inputs",pin.sha256),reader=await openArchive(physicalPath,{sevenZipPath:state.settings.sevenZipPath});
      try{const entries=await reader.list();if(entries.length>10000)throw new Error("Archive listing exceeds 10000 entries");await verifyArchivePin(snapshot.directory,pin);const current=await readAuthoringSessionSnapshot(snapshot.directory,body.cursor as number|undefined);if(current.headSha256!==snapshot.headSha256||current.revisionSha256!==snapshot.revisionSha256)throw new Error("Saved session changed; reload before browsing archives");return {path:physicalPath,logicalName:name,revisionId:snapshot.revisionId,sha256:pin.sha256,format:reader.format,entries:entries.map(entry=>({path:entry.path,size:entry.size,isDirectory:entry.isDirectory}))};}finally{await reader.close();}
    }catch(error){throw new HttpError(400,error instanceof Error?error.message:String(error));}
  });

  app.post("/api/file/authoring-inputs", async (req) => {
    const body=bodyOf(req.body),directory=optionalString(body,"directory");
    if(!directory)throw new HttpError(400,"Provide an authoring directory");
    if(body.cursor!==undefined&&(typeof body.cursor!=="number"||!Number.isInteger(body.cursor)))throw new HttpError(400,"Invalid revision cursor");
    try {
      const snapshot=await readAuthoringSessionSnapshot(directory,body.cursor as number|undefined);
      const pins=readArchivePins(snapshot.guide),name=optionalString(body,"verifyName");
      if(name!==undefined){const pin=pins[name];if(!pin)throw new HttpError(400,"Unknown archive input");await verifyArchivePin(snapshot.directory,pin);return {revisionId:snapshot.revisionId,name,verified:true};}
      return {revisionId:snapshot.revisionId,inputs:Object.entries(pins).map(([name,pin])=>({name,...pin,verified:false}))};
    }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,error instanceof Error?error.message:String(error));}
  });

  /** Inspect a persisted Rust session without claiming its exclusive writer lock. */
  app.post("/api/file/authoring-session", async (req) => {
    if (state.installRunning) throw new HttpError(409, "Cannot load a session while installation is running");
    const body = bodyOf(req.body);
    const directory = optionalString(body, "directory");
    if (!directory) throw new HttpError(400, "Provide an authoring directory");
    if (body.cursor !== undefined && (typeof body.cursor !== "number" || !Number.isInteger(body.cursor))) throw new HttpError(400, "Invalid revision cursor");
    try {
      const snapshot = await readAuthoringSessionSnapshot(directory, body.cursor as number | undefined);
      const projected = projectRustAuthoringGuide(snapshot.guide, false);
      state.authoringDirectories.add(snapshot.directory);
      state.setFile(projected.file, null, projected.warnings);
      return { file: projected.file, session: { directory: snapshot.directory, head: snapshot.head, revisionId: snapshot.revisionId, headSha256: snapshot.headSha256, revisionSha256: snapshot.revisionSha256, readOnly: true } };
    } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/file/save", async (req) => {
    const file = state.requireFile();
    const body = bodyOf(req.body);
    const target = optionalString(body, "path")?.trim();
    if (!target) throw new HttpError(400, "path is required (the file was not loaded from disk)");
    const policy = app as FastifyInstance & {exportDirectories:string[];protectedDirectories:string[]};
    const abs = await safeExportPath(resolvePath(target), policy.exportDirectories, [...policy.protectedDirectories,...state.authoringDirectories,state.settings.kotorDirectory,state.settings.modDirectory,state.settings.checkpointDirectory ?? ""]);
    let text: string;
    try {
      if (file.rustAuthoringGuide) {
        if (extname(abs).toLowerCase() !== ".json") throw new Error("Save Rust authoring guides as JSON until other lossless format ports are complete");
        text = JSON.stringify(requireRustAuthoringGuide(file), null, 2) + "\n";
      } else text = serializeInstructionFile(file);
    } catch (err) {
      throw new HttpError(400, `Cannot serialize: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await writeFile(abs, text, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      throw new HttpError(fsErrorStatus(err), `Cannot write "${abs}": ${(err as Error).message}`);
    }
    return { ok: true, path: abs, bytes: Buffer.byteLength(text), backend: "standalone-export" };
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
