/**
 * Selection, ordering, graph and validation.
 */
import type { FastifyInstance } from "fastify";
import { TIERS, applySelection, buildDependencyGraph, selectByTier, validate, type Tier } from "@modsync/core";
import { HttpError, type AppState } from "../state.js";
import { bodyOf, isRecord, optionalString } from "./util.js";

/** Tiers at or above `tier` in the canonical TIERS order (Unknown never included). */
export function tiersUpTo(tier: Tier): Tier[] {
  const idx = TIERS.indexOf(tier);
  if (idx < 0) throw new HttpError(400, `tier must be one of ${TIERS.join(", ")}`);
  return TIERS.slice(0, idx + 1).filter((t) => t !== "Unknown");
}

export function registerModRoutes(app: FastifyInstance, state: AppState): void {
  app.put<{ Params: { guid: string } }>("/api/mods/:guid/selection", async (req) => {
    const file = state.requireFile();
    if (state.installRunning) throw new HttpError(409, "Cannot change the selection while an installation is running");
    if (file.rustAuthoringGuide) throw new HttpError(409, "Apply authoring selections through /api/file/edit to preserve reviewed option decisions");
    const body = bodyOf(req.body);
    if (typeof body.selected !== "boolean") throw new HttpError(400, '"selected" must be a boolean');
    let options: Record<string, boolean> | undefined;
    if (body.options !== undefined && body.options !== null) {
      if (!isRecord(body.options)) throw new HttpError(400, '"options" must be an object of GUID -> boolean');
      options = {};
      for (const [k, v] of Object.entries(body.options)) {
        if (typeof v !== "boolean") throw new HttpError(400, `options.${k} must be a boolean`);
        options[k] = v;
      }
    }
    const guid = req.params.guid.toLowerCase();
    let changed: string[];
    try {
      changed = applySelection(file, guid, body.selected, options);
    } catch (err) {
      throw new HttpError(404, err instanceof Error ? err.message : String(err));
    }
    return { changed, ...state.recomputeSelection() };
  });

  app.post("/api/mods/select-defaults", async (req) => {
    const file = state.requireFile();
    if (state.installRunning) throw new HttpError(409, "Cannot change the selection while an installation is running");
    if (file.rustAuthoringGuide) throw new HttpError(409, "Apply authoring selections through /api/file/edit to preserve reviewed option decisions");
    const body = bodyOf(req.body);
    const tier = (optionalString(body, "tier") ?? "Recommended") as Tier;
    const changed = selectByTier(file, tiersUpTo(tier));
    return { changed, tier, ...state.recomputeSelection() };
  });

  app.post("/api/mods/select-all", async () => {
    const file = state.requireFile();
    if (state.installRunning) throw new HttpError(409, "Cannot change the selection while an installation is running");
    if (file.rustAuthoringGuide) throw new HttpError(409, "Apply authoring selections through /api/file/edit to preserve reviewed option decisions");
    // Include Unknown tier; selecting a tier cutoff is not Select All. Preserve
    // option choices and let the application's normal graph report conflicts.
    const changed = selectByTier(file, [...TIERS]);
    return { changed, ...state.recomputeSelection() };
  });

  app.get("/api/selection", async () => state.recomputeSelection());

  app.get("/api/graph", async () => {
    const graph = buildDependencyGraph(state.requireFile());
    return {
      nodes: graph.nodes.map((n) => ({ ...n, isOption: n.kind === "option" })),
      edges: graph.edges,
      unknown: graph.unknown,
    };
  });

  app.post("/api/validate", async () => {
    const file = state.requireFile();
    const report = await validate(file, state.settings, { logger: state.logger.child("validate") });
    state.logger.info(`validation: ${report.issues.length} issues, ok=${report.ok}`);
    return report;
  });
}
