/** Rust draft/review.rs algorithms over serialized Rust component records.
 * Uses the bounded direct Rust canonicalization port by default, refusing
 * unsupported input forms. TS lenient intake must never form review identities.
 */
import { createHash } from "node:crypto";
import { canonicalizeRustDraftComponent } from "./draftCanonical.js";
export type DraftComponentRecord = Record<string, unknown>;
export type DraftCanonicalizer = (component: DraftComponentRecord) => DraftComponentRecord;
export interface DraftResolution {
  expectedIdentity: string; gapDecisions: string[]; conditionDecisions: string[];
  rejectedDecisions: string[]; reviewNote: string;
}
export interface DraftDiagnostics {
  ComponentGuid: string; DraftInstructionCount: number; UnparsedGaps: string[];
  ConditionalDrafts: string[]; RejectedDrafts: number;
}
const rustTrim = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const own = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);
function object(value: unknown, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const asciiEqual = (a: string, b: string): boolean => asciiLower(a) === asciiLower(b);
const order = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
/** Serialize maps in serde_json's key order, including numeric-looking map keys. */
function serdeJson(value: unknown): string {
  if (typeof value === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("Malformed Unicode cannot form a Rust draft identity");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(serdeJson).join(',') + ']';
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort(order).map((k) => JSON.stringify(k) + ':' + serdeJson(record[k])).join(',') + '}';
  }
  throw new Error("Unsupported JSON number/value for Rust draft identity");
}
export function draftIdentity(component: DraftComponentRecord, canonicalize: DraftCanonicalizer = canonicalizeRustDraftComponent): string {
  const stripped = structuredClone(component);
  function strip(value: DraftComponentRecord, depth: number): void {
    if (depth > 64) throw new Error("Draft option nesting exceeds 64 levels");
    delete value.DraftReview;
    if (Array.isArray(value.Options)) for (const option of value.Options) strip(object(option, "Component must be an object"), depth + 1);
  }
  strip(stripped, 0);
  const canonical = structuredClone(canonicalize(stripped));
  delete canonical.IsSelected;
  return createHash("sha256").update(serdeJson(canonical)).digest("hex");
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((s) => typeof s === "string"); }
export function readDraftDiagnostics(value: unknown): DraftDiagnostics {
  const r = object(value, "Invalid draft diagnostics");
  if (typeof r.ComponentGuid !== "string" || typeof r.DraftInstructionCount !== "number" || !Number.isSafeInteger(r.DraftInstructionCount) || r.DraftInstructionCount < 0 || !strings(r.UnparsedGaps) || !strings(r.ConditionalDrafts) || typeof r.RejectedDrafts !== "number" || !Number.isSafeInteger(r.RejectedDrafts) || r.RejectedDrafts < 0) throw new Error("Invalid draft diagnostics");
  return { ComponentGuid: r.ComponentGuid, DraftInstructionCount: r.DraftInstructionCount,
    UnparsedGaps: [...r.UnparsedGaps], ConditionalDrafts: [...r.ConditionalDrafts], RejectedDrafts: r.RejectedDrafts };
}
export function readDraftResolution(value: unknown): DraftResolution {
  const r = object(value, "Invalid draft resolution");
  const keys = ['expectedIdentity','gapDecisions','conditionDecisions','rejectedDecisions','reviewNote'];
  if (Object.keys(r).length !== keys.length || !keys.every((key) => own(r,key)) || typeof r.expectedIdentity !== "string" || !strings(r.gapDecisions) || !strings(r.conditionDecisions) || !strings(r.rejectedDecisions) || typeof r.reviewNote !== "string") throw new Error("Invalid draft resolution");
  return { expectedIdentity:r.expectedIdentity, gapDecisions:[...r.gapDecisions], conditionDecisions:[...r.conditionDecisions], rejectedDecisions:[...r.rejectedDecisions], reviewNote:r.reviewNote };
}
function originalDiagnostics(component: DraftComponentRecord): DraftDiagnostics {
  const review = object(component.DraftReview, "No draft provenance");
  const original = readDraftDiagnostics(own(review,'OriginalResult') ? review.OriginalResult : review.Result);
  if (typeof component.Guid !== "string" || !asciiEqual(original.ComponentGuid,component.Guid)) throw new Error("Draft provenance belongs to a different component");
  return original;
}
function decisionNotes(notes: string[], expected: number, kind: string): void {
  if (notes.length !== expected) throw new Error(`Every original ${kind} needs exactly one decision`);
  for (const note of notes) if (!rustTrim(note) || Buffer.byteLength(note,'utf8') > 16384) throw new Error(`Each ${kind} decision must contain 1 to 16384 bytes`);
}
function validateDecisions(original: DraftDiagnostics, resolution: DraftResolution): void {
  if (original.UnparsedGaps.length + original.ConditionalDrafts.length + original.RejectedDrafts > 4096) throw new Error("Draft diagnostic count exceeds the review bound");
  decisionNotes(resolution.gapDecisions,original.UnparsedGaps.length,'gap');
  decisionNotes(resolution.conditionDecisions,original.ConditionalDrafts.length,'condition');
  decisionNotes(resolution.rejectedDecisions,original.RejectedDrafts,'rejected instruction');
  if (!rustTrim(resolution.reviewNote) || Buffer.byteLength(resolution.reviewNote,'utf8') > 16384) throw new Error("A bounded final review note is required");
}
/** Mutate only a transaction's private component clone, then validate the entire guide. */
export function resolveDraft(component: DraftComponentRecord, value: DraftResolution, canonicalize: DraftCanonicalizer = canonicalizeRustDraftComponent): void {
  const resolution = readDraftResolution(value);
  if (draftIdentity(component,canonicalize) !== resolution.expectedIdentity) throw new Error("Draft changed since the resolution was prepared");
  const original = originalDiagnostics(component);
  validateDecisions(original,resolution);
  const review = object(component.DraftReview, "Invalid draft review object");
  review.OriginalResult = original;
  review.Result = { ComponentGuid:component.Guid, DraftInstructionCount:Array.isArray(component.Instructions) ? component.Instructions.length : 0,
    UnparsedGaps:[], ConditionalDrafts:[], RejectedDrafts:0 };
  review.Resolution = resolution;
  review.ReviewedIdentity = resolution.expectedIdentity;
  review.RequiresReview = false;
}
export function draftReceiptMatches(component: DraftComponentRecord, reviewValue: unknown, canonicalize: DraftCanonicalizer = canonicalizeRustDraftComponent): boolean {
  try {
    const review = object(reviewValue,"Invalid draft review object");
    if (!own(review,'ReviewedIdentity')) return !own(review,'Resolution') && !own(review,'OriginalResult');
    if (typeof review.ReviewedIdentity !== "string" || draftIdentity(component,canonicalize) !== review.ReviewedIdentity) return false;
    if (!own(review,'Resolution')) return !own(review,'OriginalResult');
    const resolution = readDraftResolution(review.Resolution), original = originalDiagnostics(component);
    if (resolution.expectedIdentity !== review.ReviewedIdentity || !own(review,'OriginalResult')) return false;
    validateDecisions(original,resolution);
    return true;
  } catch { return false; }
}
/** Never let replacement discard provenance or carry approval onto changed instructions. */
export function invalidateDraftReview(before: DraftComponentRecord, after: DraftComponentRecord, canonicalize: DraftCanonicalizer = canonicalizeRustDraftComponent): void {
  if (own(before,'DraftReview') && (draftIdentity(before,canonicalize) !== draftIdentity(after,canonicalize) || !own(after,'DraftReview') || serdeJson(before.DraftReview) !== serdeJson(after.DraftReview))) {
    const retained = structuredClone(object(before.DraftReview,"Invalid draft review object"));
    retained.RequiresReview = true;
    after.DraftReview = retained;
  }
}

export const DRAFT_REVIEW_FLAG = 'DRAFT INSTRUCTIONS: parsed from guide prose by the natural-language importer. Review before installing - never auto-trusted.';
export function requiresDraftReview(component: DraftComponentRecord, canonicalize: DraftCanonicalizer = canonicalizeRustDraftComponent): boolean {
  if (own(component,'DraftReview')) {
    try {
      const review=object(component.DraftReview,'Invalid draft review object');
      if (review.RequiresReview !== false || !draftReceiptMatches(component,review,canonicalize)) return true;
      const result=readDraftDiagnostics(review.Result);
      return typeof component.Guid !== 'string' || !asciiEqual(result.ComponentGuid,component.Guid) || !!result.UnparsedGaps.length || !!result.ConditionalDrafts.length || result.RejectedDrafts !== 0;
    } catch { return true; }
  }
  return typeof component.InstallationWarning === 'string' && component.InstallationWarning.includes(DRAFT_REVIEW_FLAG);
}
export function markDraftReviewed(component: DraftComponentRecord, canonicalize: DraftCanonicalizer = canonicalizeRustDraftComponent): void {
  const identity=draftIdentity(component,canonicalize);
  const review=object(component.DraftReview,'Component has no generated draft review record');
  if (own(review,'Resolution') && !draftReceiptMatches(component,review,canonicalize)) throw new Error('Changed resolved drafts require a new explicit resolution');
  const result=readDraftDiagnostics(review.Result);
  if (typeof component.Guid !== 'string' || !asciiEqual(result.ComponentGuid,component.Guid)) throw new Error('Draft diagnostics belong to a different component');
  if (result.UnparsedGaps.length || result.ConditionalDrafts.length || result.RejectedDrafts !== 0) throw new Error('Resolve unparsed, conditional, or rejected instructions before accepting this draft');
  review.ReviewedIdentity=identity;review.RequiresReview=false;
}
/** Validate every component regardless of current selection; metadata dictionaries are not components. */
export function validateDraftReviewRecords(value: unknown): void {
  function visit(componentValue: unknown,depth: number): void {
    if (depth>64) throw new Error('Review component nesting exceeds 64');
    const c=object(componentValue,'Component must be an object');
    if (own(c,'DraftReview')) {
      const review=object(c.DraftReview,'DraftReview must be an object');
      if (typeof review.RequiresReview !== 'boolean') throw new Error('DraftReview.RequiresReview must be a boolean');
      const result=readDraftDiagnostics(review.Result);
      if (typeof c.Guid !== 'string' || !asciiEqual(result.ComponentGuid,c.Guid)) throw new Error('DraftReview diagnostics belong to a different component');
      if (!review.RequiresReview && (result.UnparsedGaps.length || result.ConditionalDrafts.length || result.RejectedDrafts !== 0)) throw new Error('Reviewed draft still contains unresolved diagnostics');
    }
    if (Array.isArray(c.Options)) for(const option of c.Options) visit(option,depth+1);
  }
  if(Array.isArray(value)) for(const c of value) visit(c,0);
  else if(value!==null && typeof value==='object') {
    const v=value as Record<string,unknown>;
    if(own(v,'Guid')) visit(v,0);
    else { const components=own(v,'thisMod') ? v.thisMod : v.Components;
      if(Array.isArray(components)) for(const c of components) visit(c,0);
    }
  }
}

/** Port of editor transaction invalidate_reviews after each edit operation. */
export function invalidateDraftReviewTree(
  before: readonly DraftComponentRecord[], original: readonly DraftComponentRecord[],
  after: DraftComponentRecord[], explicitlyResolved: string | undefined,
  canonicalize: DraftCanonicalizer = canonicalizeRustDraftComponent,
): void {
  function find(items: readonly DraftComponentRecord[], guid: string, depth=0): DraftComponentRecord | undefined {
    if(depth>64) throw new Error('Draft option nesting exceeds 64 levels');
    for(const item of items) {
      if(typeof item.Guid==='string' && asciiEqual(item.Guid,guid)) return item;
      if(Array.isArray(item.Options)) {
        const found=find(item.Options.map((v)=>object(v,'Component must be an object')),guid,depth+1);
        if(found) return found;
      }
    }
    return undefined;
  }
  function visit(items: DraftComponentRecord[],depth: number): void {
    if(depth>64) throw new Error('Draft option nesting exceeds 64 levels');
    for(const item of items) {
      if(typeof item.Guid!=='string') throw new Error('Component needs a Guid');
      if(explicitlyResolved===undefined || !asciiEqual(explicitlyResolved,item.Guid)) {
        const previous=find(before,item.Guid);
        const retained=previous && own(previous,'DraftReview') ? previous : find(original,item.Guid);
        if(retained) invalidateDraftReview(retained,item,canonicalize);
      }
      if(Array.isArray(item.Options)) visit(item.Options.map((v)=>object(v,'Component must be an object')),depth+1);
    }
  }
  visit(after,0);
}
