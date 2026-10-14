/**
 * InstallContext: everything an action needs to run. The validator builds
 * one over a VirtualFileSystem with `dryRun: true`; the installer builds one
 * over the real disk.
 */

import { openArchive } from "../archive/index.js";
import { PathResolver } from "../fs/paths.js";
import { VirtualFileSystem } from "../fs/virtualFileSystem.js";
import { SandboxFileSystem } from "../fs/sandboxFileSystem.js";
import { RealFileSystem } from "../fs/realFileSystem.js";
import { NullLogger } from "../logging/logger.js";
import type { Directories, Logger, TelemetrySink, UserPrompt, UserPromptAnswer, UserSettings } from "../model/types.js";
import type { FileSystemPort } from "../ports/filesystem.js";
import { createPatcher, type PatcherPort } from "./patcherPort.js";
import type { SelectionSet } from "./selection.js";

export type PromptHandler = (prompt: UserPrompt) => Promise<UserPromptAnswer>;

export interface InstallContext {
  fs: FileSystemPort;
  resolver: PathResolver;
  dirs: Directories;
  settings: UserSettings;
  selection: SelectionSet;
  logger: Logger;
  prompt: PromptHandler;
  dryRun: boolean;
  openArchive: typeof openArchive;
  patcher: PatcherPort;
  telemetry?: TelemetrySink;
  signal?: AbortSignal;
}

export interface CreateInstallContextOptions {
  settings: UserSettings;
  selection: SelectionSet;
  fs?: FileSystemPort;
  logger?: Logger;
  prompt?: PromptHandler;
  dryRun?: boolean;
  openArchive?: typeof openArchive;
  patcher?: PatcherPort;
  telemetry?: TelemetrySink;
  signal?: AbortSignal;
}

/**
 * Answer a prompt without asking anyone: the default choice, else the first
 * one, else "none" (confirm prompts are accepted).
 */
export const autoAnswerPrompt: PromptHandler = async (prompt) => {
  const choice = prompt.choices.find((c) => c.isDefault) ?? prompt.choices[0];
  return { promptId: prompt.id, choiceId: choice?.id, accepted: true };
};

export function createInstallContext(opts: CreateInstallContextOptions): InstallContext {
  const logger = opts.logger ?? NullLogger;
  const dirs: Directories = { modDirectory: opts.settings.modDirectory, kotorDirectory: opts.settings.kotorDirectory };
  const base = opts.fs ?? new RealFileSystem();
  const fs = opts.dryRun && !base.isVirtual ? new VirtualFileSystem(base) : base;
  return {
    fs: new SandboxFileSystem(fs, dirs),
    resolver: new PathResolver(dirs),
    dirs,
    settings: opts.settings,
    selection: opts.selection,
    logger,
    prompt: opts.prompt ?? autoAnswerPrompt,
    dryRun: opts.dryRun ?? false,
    openArchive: opts.openArchive ?? openArchive,
    patcher: opts.patcher ?? createPatcher(opts.settings, logger),
    telemetry: opts.telemetry,
    signal: opts.signal,
  };
}
