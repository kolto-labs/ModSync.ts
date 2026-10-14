/** Durable head schema and transitions, ported from Rust editor/easy.rs. */
import { randomUUID } from "node:crypto";
export interface AuthoringRevision { id: string; label: string }
export interface AuthoringHead { format: 1; revisions: AuthoringRevision[]; cursor: number }
export const AUTHORING_HISTORY_LIMIT = 4096;

export function canonicalRevisionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}
function exactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}
export function readAuthoringHead(value: unknown): AuthoringHead {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid authoring history");
  const head = value as Record<string, unknown>;
  if (!exactKeys(head, ["format", "revisions", "cursor"]) || head.format !== 1 || !Array.isArray(head.revisions) || !head.revisions.length || head.revisions.length > AUTHORING_HISTORY_LIMIT || !Number.isInteger(head.cursor) || typeof head.cursor !== "number" || head.cursor < 0 || head.cursor >= head.revisions.length) throw new Error("Invalid authoring history");
  const revisions = head.revisions.map((value: unknown): AuthoringRevision => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid revision identity");
    const revision = value as Record<string, unknown>;
    if (!exactKeys(revision, ["id", "label"]) || typeof revision.id !== "string" || !canonicalRevisionId(revision.id) || typeof revision.label !== "string") throw new Error("Invalid revision identity");
    return { id: revision.id, label: revision.label };
  });
  return { format: 1, revisions, cursor: head.cursor };
}
export function startingAuthoringHead(): AuthoringHead {
  return { format: 1, revisions: [{ id: randomUUID(), label: "Starting guide" }], cursor: 0 };
}

/** Persist new revision first, then this head; publish memory only after both succeed. */
export function appendAuthoringRevision(current: AuthoringHead, label: string): AuthoringHead {
  const head = readAuthoringHead(current);
  if (Buffer.byteLength(label, "utf8") > 4096) throw new Error("Revision label is too long");
  if (head.cursor + 1 >= AUTHORING_HISTORY_LIMIT) throw new Error("Authoring history is full; export a new session");
  return { format: 1, cursor: head.cursor + 1,
    revisions: [...head.revisions.slice(0, head.cursor + 1), { id: randomUUID(), label }] };
}

/** Load/validate destination guide before persisting this head and publishing memory. */
export function seekAuthoringRevision(current: AuthoringHead, cursor: number): AuthoringHead {
  const head = readAuthoringHead(current);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= head.revisions.length) throw new Error("Revision is out of range");
  return { ...head, cursor };
}
