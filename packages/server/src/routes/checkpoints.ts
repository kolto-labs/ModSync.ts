import type { FastifyInstance } from "fastify";
import {CheckpointError} from "@modsync/core";
import { HttpError, type AppState } from "../state.js";

export function registerCheckpointRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/api/checkpoints", async () => {
    if (!state.settings.kotorDirectory) return [];
    try{return await state.createCheckpointStore().list();}catch(error){if(error instanceof CheckpointError)throw new HttpError(409,error.message);throw error;}
  });

  app.get("/api/checkpoints/capabilities", async () => ({physicalRestore:false,reason:"Independent TypeScript checkpoint restoration is unavailable"}));
  app.get<{Params:{session:string}}>("/api/checkpoints/:session/recovery",async(req)=>{
    if(!state.settings.kotorDirectory)throw new HttpError(400,"kotorDirectory is not set");
    try{return await state.createCheckpointStore().inspectRecovery(req.params.session);}catch(error){if(error instanceof CheckpointError)throw new HttpError(409,error.message);throw error;}
  });
  app.post<{ Params: { session: string; id: string } }>("/api/checkpoints/:session/:id/restore", async () => {
    throw new HttpError(409, "Independent TypeScript physical checkpoint restore is unavailable until paired OS writer ownership and verified quiescence/recovery are implemented");
  });

  app.delete<{ Params: { session: string } }>("/api/checkpoints/:session", async (req) => {
    if (state.installRunning) throw new HttpError(409, "Cannot delete checkpoints while installation is running");
    if (!state.settings.kotorDirectory) throw new HttpError(400, "kotorDirectory is not set");
    try{await state.createCheckpointStore().delete(req.params.session);}catch(error){if(error instanceof CheckpointError)throw new HttpError(409,error.message);throw error;}
    return { ok: true };
  });
}
