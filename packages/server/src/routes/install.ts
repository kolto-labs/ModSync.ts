import type { FastifyInstance } from "fastify";
import type { UserPromptAnswer } from "@modsync/core";
import { HttpError, type AppState } from "../state.js";
import { bodyOf, optionalString, optionalStringArray } from "./util.js";

export function registerInstallRoutes(app: FastifyInstance, state: AppState): void {
  app.post("/api/install", async (req, reply) => {
    const body = bodyOf(req.body);
    const phase = optionalString(body, "phase");
    if (phase !== undefined && phase !== "base" && phase !== "widescreen") throw new HttpError(400, 'phase must be "base" or "widescreen"');
    const modGuids = optionalStringArray(body, "modGuids")?.map((g) => g.toLowerCase());
    const result = state.startInstall({ phase: phase as "base" | "widescreen" | undefined, modGuids });
    reply.code(202);
    return result;
  });

  app.post("/api/install/cancel", async () => ({ ok: true, cancelled: state.cancelInstall() }));

  app.post("/api/install/answer", async (req) => {
    const body = bodyOf(req.body);
    const promptId = optionalString(body, "promptId") ?? state.pendingPrompt?.id;
    if (!promptId) throw new HttpError(400, "promptId is required");
    const answer: UserPromptAnswer = { promptId };
    const choiceId = optionalString(body, "choiceId");
    if (choiceId !== undefined) answer.choiceId = choiceId;
    if (body.accepted !== undefined && typeof body.accepted !== "boolean") throw new HttpError(400, "accepted must be a boolean");
    if (typeof body.accepted === "boolean") answer.accepted = body.accepted;
    state.answerPrompt(answer);
    return { ok: true };
  });

  app.get("/api/install/status", async () => state.installStatus());
}
