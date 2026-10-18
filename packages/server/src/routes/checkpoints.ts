import { resolve as resolvePath } from "node:path";
import type { FastifyInstance } from "fastify";
import {CheckpointError} from "@modsync/core";
import { HttpError, type AppState } from "../state.js";

export function registerCheckpointRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/api/checkpoints", async () => {
    if (!state.settings.kotorDirectory) return [];
    try{return await state.createCheckpointStore().list();}catch(error){if(error instanceof CheckpointError)throw new HttpError(409,error.message);throw error;}
  });

  app.get("/api/checkpoints/capabilities", async () => state.physicalInstallOptIn()
    ? {physicalRestore:true,reason:"CI-only explicit opt-in (MODSYNC_CI_PHYSICAL_INSTALL=1): portable lockfile ownership, not native OS ownership (see docs/PHYSICAL_INSTALL.md)"}
    : {physicalRestore:false,reason:"Independent TypeScript checkpoint restoration is unavailable"});
  app.get<{Params:{session:string}}>("/api/checkpoints/:session/recovery",async(req)=>{
    if(!state.settings.kotorDirectory)throw new HttpError(400,"kotorDirectory is not set");
    try{return await state.createCheckpointStore().inspectRecovery(req.params.session);}catch(error){if(error instanceof CheckpointError)throw new HttpError(409,error.message);throw error;}
  });
  app.post<{ Params: { session: string; id: string } }>("/api/checkpoints/:session/:id/restore", async (req) => {
    if (!state.physicalInstallOptIn()) {
      throw new HttpError(409, "Independent TypeScript physical checkpoint restore is unavailable until paired OS writer ownership and verified quiescence/recovery are implemented");
    }
    if (state.installRunning) throw new HttpError(409, "Cannot restore while an installation is running");
    if (!state.settings.kotorDirectory) throw new HttpError(400, "kotorDirectory is not set");
    try {
      const store = state.createCheckpointStore();
      const recorded = await store.getSession(req.params.session);
      if (resolvePath(recorded.kotorDirectory) !== resolvePath(store.kotorDirectory)) {
        throw new HttpError(409, "Checkpoint belongs to a different game directory; select that directory before restoring");
      }
      await store.restore(req.params.session, req.params.id);
    } catch (error) {
      if (error instanceof CheckpointError) throw new HttpError(409, error.message);
      throw error;
    }
    state.logger.info(`restored checkpoint ${req.params.id} of session ${req.params.session}`);
    return { ok: true, sessionId: req.params.session, checkpointId: req.params.id };
  });

  app.delete<{ Params: { session: string } }>("/api/checkpoints/:session", async (req) => {
    if (state.installRunning) throw new HttpError(409, "Cannot delete checkpoints while installation is running");
    if (!state.settings.kotorDirectory) throw new HttpError(400, "kotorDirectory is not set");
    try{await state.createCheckpointStore().delete(req.params.session);}catch(error){if(error instanceof CheckpointError)throw new HttpError(409,error.message);throw error;}
    return { ok: true };
  });
}
