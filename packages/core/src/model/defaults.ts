import { newGuid } from "./guid.js";
import type {
  Instruction,
  ActionType,
  MainConfig,
  ModComponent,
  ModOption,
  UserSettings,
  InstructionFile,
} from "./types.js";

export function createInstruction(action: ActionType, partial: Partial<Instruction> = {}): Instruction {
  return {
    guid: newGuid(),
    action,
    source: [],
    overwrite: true,
    dependencies: [],
    restrictions: [],
    ...partial,
  };
}

export function createOption(partial: Partial<ModOption> = {}): ModOption {
  return {
    guid: newGuid(),
    name: "",
    dependencies: [],
    restrictions: [],
    installAfter: [],
    installBefore: [],
    instructions: [],
    isSelected: false,
    ...partial,
  };
}

export function createMod(partial: Partial<ModComponent> = {}): ModComponent {
  return {
    guid: newGuid(),
    name: "",
    authors: [],
    modLink: [],
    category: [],
    tier: "Unknown",
    installationMethod: "Unknown",
    dependencies: [],
    restrictions: [],
    installAfter: [],
    installBefore: [],
    untestedWith: [],
    instructions: [],
    options: [],
    isSelected: false,
    installState: "NotInstalled",
    isDownloaded: false,
    fullBuildOnly: false,
    isWidescreen: false,
    aspyrOnly: false,
    isPatch: false,
    ...partial,
  };
}

export function createMainConfig(partial: Partial<MainConfig> = {}): MainConfig {
  return {
    targetGame: "Unknown",
    compatibilityLevel: "Compatible",
    patcherEngine: "Native",
    spoilerFree: false,
    platform: "PC",
    ...partial,
  };
}

export function createInstructionFile(partial: Partial<InstructionFile> = {}): InstructionFile {
  return { ...partial, config: createMainConfig(partial.config), mods: partial.mods ?? [] };
}

export function createDefaultSettings(partial: Partial<UserSettings> = {}): UserSettings {
  return {
    modDirectory: "",
    kotorDirectory: "",
    patcherEngine: "Native",
    compatibilityLevel: "Compatible",
    spoilerFree: false,
    platform: "PC",
    theme: "dark",
    maxConcurrentDownloads: 3,
    createCheckpoints: true,
    telemetryEnabled: false,
    verboseLogging: false,
    ...partial,
  };
}
