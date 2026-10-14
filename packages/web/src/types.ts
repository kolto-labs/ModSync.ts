/**
 * Domain types for the web UI.
 *
 * `@modsync/core` only exports its built `dist/`, so to stay independent from
 * the build order we re-export straight from the core source tree. The file
 * contains only types and `as const` tables (no Node imports), so both tsc
 * (moduleResolution: Bundler) and Vite resolve it fine.
 */
export * from "../../core/src/model/types";
import type { Guid, Tier, ValidationIssue, InstallSummary, UserPrompt } from "../../core/src/model/types";

/** Directory listing entry (mirrors core `ports/filesystem.ts` DirEntry). */
export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export interface ArchiveListResult {
  path: string;
  entries: Array<{ path: string; size: number; isDirectory: boolean }>;
}

export interface GameDetectResult {
  game: "KOTOR1" | "KOTOR2" | "Unknown";
  isAspyr: boolean;
  executable?: string;
}

export interface SelectionResult {
  selectedGuids: Guid[];
  order: Guid[];
  issues: ValidationIssue[];
}

export type GraphEdgeKind = "dependency" | "restriction" | "installAfter" | "installBefore" | "untested";

export interface GraphNode {
  id: Guid;
  name: string;
  tier?: Tier;
  isSelected?: boolean;
  isWidescreen?: boolean;
  isOption?: boolean;
}

export interface GraphEdge {
  from: Guid;
  to: Guid;
  kind: GraphEdgeKind;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface InstallStatus {
  running: boolean;
  phase?: "base" | "widescreen";
  order?: Guid[];
  currentMod?: Guid;
  summary?: InstallSummary;
  pendingPrompt?: UserPrompt;
}

export type DownloadStatus = "queued" | "downloading" | "finished" | "failed" | "needs-browser";

export interface DownloadItem {
  id: string;
  modGuid: Guid;
  url: string;
  status: DownloadStatus;
  fileName?: string;
  receivedBytes: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  error?: string;
  path?: string;
  reason?: string;
}

export interface MergeConflict {
  guid: Guid;
  field: string;
  existing: unknown;
  incoming: unknown;
}

export interface MergeResult {
  file: import("../../core/src/model/types").InstructionFile;
  added: Guid[];
  updated: Guid[];
  removed: Guid[];
  conflicts: MergeConflict[];
}

export interface HealthResult {
  ok: boolean;
  version: string;
  platform: string;
  isElectron: boolean;
}

export type MarkdownStyle = "reddit" | "deadlystream" | "structured";

declare global {
  interface Window {
    modsync?: {
      pickDirectory(): Promise<string | undefined>;
      pickFile(filters?: Array<{ name: string; extensions: string[] }>): Promise<string | undefined>;
      openExternal(url: string): Promise<void>;
      isElectron: boolean;
    };
  }
}
