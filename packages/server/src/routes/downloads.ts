/**
 * Downloads: queue the mod links of mods whose archives are not in the mod
 * directory yet, hand URLs to the system browser, accept nxm:// links.
 */
import type { FastifyInstance } from "fastify";
import {
  PathResolver,
  RealFileSystem,
  computeSelection,
  hasWildcard,
  isInsideRoot,
  normalizePath,
  relativeInsideRoot,
  resolveWildcards,
  type Guid,
  type InstructionFile,
  type ModComponent,
  type UserSettings,
} from "@modsync/core";
import { HttpError, type AppState } from "../state.js";
import { bodyOf, optionalStringArray, requireString } from "./util.js";

export interface DownloadNeed {
  modGuid: Guid;
  modName: string;
  /** Patterns (relative to modDirectory) the mod expects. */
  patterns: string[];
  missing: string[];
  links: string[];
  needed: boolean;
}

/**
 * The top-level entries a mod expects inside modDirectory: `expectedFiles`
 * plus the first path segment of every instruction source that points into
 * the mod directory (e.g. `<<modDirectory>>\Foo*\bar` -> `Foo*`).
 */
export function expectedEntries(mod: ModComponent, selectedOptionGuids: Set<Guid>, resolver: PathResolver): string[] {
  const out = new Set<string>();
  for (const f of mod.expectedFiles ?? []) if (f.trim()) out.add(f.trim());
  const instructions = [
    ...mod.instructions,
    ...mod.options.filter((o) => selectedOptionGuids.has(o.guid)).flatMap((o) => o.instructions),
  ];
  const modRoot = resolver.modDirectory;
  for (const instr of instructions) {
    if (instr.action === "Choose" && instr.source.every((s) => !/[\\/<]/.test(s))) continue;
    for (const raw of instr.source) {
      let abs: string;
      try {
        abs = resolver.resolve(raw);
      } catch {
        continue;
      }
      if (!isInsideRoot(modRoot, abs)) continue;
      const rel = relativeInsideRoot(modRoot, abs);
      if (!rel) continue;
      const first = rel.split("/")[0];
      if (first) out.add(first);
    }
  }
  return [...out];
}

export async function computeDownloadNeeds(
  file: InstructionFile,
  settings: UserSettings,
  modGuids?: Guid[],
): Promise<DownloadNeed[]> {
  const fs = new RealFileSystem();
  const resolver = new PathResolver({ modDirectory: settings.modDirectory, kotorDirectory: settings.kotorDirectory || settings.modDirectory });
  const selection = computeSelection(file, settings);
  const wanted = modGuids ? new Set(modGuids) : undefined;
  const mods = wanted ? file.mods.filter((m) => wanted.has(m.guid)) : selection.mods;
  const needs: DownloadNeed[] = [];
  for (const mod of mods) {
    const patterns = expectedEntries(mod, selection.selectedGuids, resolver);
    const missing: string[] = [];
    for (const pattern of patterns) {
      const abs = normalizePath(`${resolver.modDirectory}/${pattern}`);
      let matches: string[];
      try {
        matches = hasWildcard(abs) ? await resolveWildcards(fs, abs) : (await fs.exists(abs)) ? [abs] : [];
      } catch {
        matches = [];
      }
      if (matches.length === 0) missing.push(pattern);
    }
    const needed = patterns.length === 0 ? mod.modLink.length > 0 : missing.length > 0;
    needs.push({ modGuid: mod.guid, modName: mod.name, patterns, missing, links: [...mod.modLink], needed });
  }
  return needs;
}

export function registerDownloadRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/api/downloads", async () => state.listDownloads());

  app.get("/api/downloads/needs", async (req) => {
    const file = state.requireFile();
    const q = (req.query ?? {}) as Record<string, unknown>;
    const guids = typeof q.modGuids === "string" ? q.modGuids.split(",").filter(Boolean) : undefined;
    return computeDownloadNeeds(file, state.settings, guids);
  });

  app.post("/api/downloads/start", async (req) => {
    const file = state.requireFile();
    const body = bodyOf(req.body);
    const modGuids = optionalStringArray(body, "modGuids")?.map((g) => g.toLowerCase());
    const manager = state.getDownloadManager();
    const existing = new Set(
      manager
        .list()
        .filter((d) => d.state !== "failed")
        .map((d) => `${d.modGuid}|${d.url}`),
    );
    const needs = await computeDownloadNeeds(file, state.settings, modGuids);
    const queued: Array<{ id: string; modGuid: Guid; url: string }> = [];
    const skipped: Guid[] = [];
    const noLinks: Guid[] = [];
    for (const need of needs) {
      if (!need.needed) {
        skipped.push(need.modGuid);
        continue;
      }
      if (need.links.length === 0) {
        noLinks.push(need.modGuid);
        continue;
      }
      for (const url of need.links) {
        const key = `${need.modGuid}|${url}`;
        if (existing.has(key)) continue;
        existing.add(key);
        const item = manager.enqueue(need.modGuid, url);
        queued.push({ id: item.id, modGuid: need.modGuid, url });
      }
    }
    manager.start();
    state.logger.info(`downloads: queued ${queued.length}, already present ${skipped.length}, without links ${noLinks.length}`);
    return { ok: true, queued, skipped, noLinks, downloads: state.listDownloads() };
  });

  app.post("/api/downloads/pause", async () => {
    if (state.hasDownloadManager()) state.getDownloadManager().pause();
    return { ok: true };
  });

  app.post("/api/downloads/retry", async (req) => {
    const id = requireString(bodyOf(req.body), "id");
    const manager = state.getDownloadManager();
    if (!manager.retry(id)) throw new HttpError(404, `Unknown or busy download ${id}`);
    manager.start();
    return { ok: true };
  });

  app.post("/api/downloads/open-browser", async (req) => {
    const url = requireString(bodyOf(req.body), "url");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, `Invalid URL: ${url}`);
    }
    if (!["http:", "https:", "nxm:"].includes(parsed.protocol)) throw new HttpError(400, `Refusing to open ${parsed.protocol} URLs`);
    if (!state.electronBridge) return { ok: false, reason: "no-browser", url };
    await state.electronBridge.openExternal(url);
    return { ok: true, url };
  });

  app.post("/api/downloads/nxm", async (req) => {
    const url = requireString(bodyOf(req.body), "url").trim();
    if (!/^nxm:\/\//i.test(url)) throw new HttpError(400, "url must be an nxm:// link");
    const modGuid = typeof bodyOf(req.body).modGuid === "string" ? String(bodyOf(req.body).modGuid) : "";
    const manager = state.getDownloadManager();
    const item = manager.enqueue(modGuid, url);
    manager.start();
    state.logger.info(`downloads: nxm link queued (${item.id})`);
    return { ok: true, id: item.id };
  });
}
