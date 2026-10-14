import { describe, expect, it } from "vitest";
import { answerPromptInteractively, parseChoices } from "./install.js";
import type { UserPrompt } from "@modsync/core";
const confirm: UserPrompt = { id: "prompt", instructionGuid: "instruction", kind: "confirm", title: "Run program?", message: "", choices: [] };
const options = (answer: string) => ({ yes: true, choices: new Map([["instruction", answer]]), ask: async () => "", out: () => undefined });
describe("CLI scripted prompt answers", () => {
  it("rejects empty scripted identifiers and answers", () => {
    for (const value of [" =yes", "instruction=", "instruction=  "]) expect(() => parseChoices([value])).toThrow();
  });
  it("accepts explicit yes and no confirmation answers", async () => {
    expect(await answerPromptInteractively(confirm, options("yes"))).toEqual({ promptId: "prompt", accepted: true });
    expect(await answerPromptInteractively(confirm, options("false"))).toEqual({ promptId: "prompt", accepted: false });
  });
  it("rejects mistyped confirmation answers instead of executing", async () => {
    await expect(answerPromptInteractively(confirm, options("yse"))).rejects.toThrow("confirmation answer must be yes or no");
  });
});
