import type { FastifyInstance } from "fastify";
import { resolve } from "node:path";
import { CheckpointError } from "@modsync/core";
import { HttpError, type AppState } from "../state.js";

export function registerCheckpointRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/api/checkpoints", async () => {
    if (!state.settings.kotorDirectory) return [];
    return state.createCheckpointStore().list();
  });

  app.post<{ Params: { session: string; id: string } }>("/api/checkpoints/:session/:id/restore", async (req) => {
    if (state.installRunning) throw new HttpError(409, "Cannot restore while an installation is running");
    if (!state.settings.kotorDirectory) throw new HttpError(400, "kotorDirectory is not set");
    const store = state.createCheckpointStore();
    let session;
    try {
      session = await store.getSession(req.params.session);
    } catch (err) {
      throw new HttpError(404, err instanceof Error ? err.message : String(err));
    }
    if (resolve(session.kotorDirectory) !== resolve(store.kotorDirectory)) {
      throw new HttpError(409, "Checkpoint belongs to a different game directory; select that directory in settings before restoring");
    }
    const target = store;
    let files = 0;
    try {
      await target.restore(req.params.session, req.params.id, (done, total) => {
        files = total;
        if (done === total || done % 50 === 0) {
          state.publish({ type: "log", level: "info", message: `restore ${req.params.id}: ${done}/${total} files` });
        }
      });
    } catch (err) {
      if (err instanceof CheckpointError) throw new HttpError(404, err.message);
      throw err;
    }
    state.logger.info(`restored checkpoint ${req.params.id} of session ${req.params.session} (${files} files)`);
    return { ok: true, files, sessionId: req.params.session, checkpointId: req.params.id };
  });

  app.delete<{ Params: { session: string } }>("/api/checkpoints/:session", async (req) => {
    if (state.installRunning) throw new HttpError(409, "Cannot delete checkpoints while an installation is running");
    if (!state.settings.kotorDirectory) throw new HttpError(400, "kotorDirectory is not set");
    await state.createCheckpointStore().delete(req.params.session);
    return { ok: true };
  });
}
