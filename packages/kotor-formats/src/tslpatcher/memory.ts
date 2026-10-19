/**
 * TSLPatcher token pools. `StrRef<N>` holds dialog.tlk indices produced by
 * [TLKList]; `2DAMEMORY<N>` holds strings (row indices/labels/cell values from
 * [2DAList], or a GFF field path stored via `!FieldPath`).
 */

export class PatcherTokenError extends Error {
  constructor(
    message: string,
    readonly token: string,
    /** the token is unassigned only because the step that would assign it could not be verified (virtual dry run) */
    readonly unverified = false,
  ) {
    super(message);
    this.name = "PatcherTokenError";
  }
}

export class PatcherMemory {
  readonly strref = new Map<number, number>();
  readonly twoda = new Map<number, string>();
  /** 2DAMEMORY tokens that hold a GFF field path pointer (stored via `!FieldPath`), not a plain string. */
  private readonly fieldPaths = new Set<number>();
  private readonly unverifiedStrRef = new Set<number>();
  private readonly unverifiedTwoda = new Set<number>();

  /** Record that a skipped, unverifiable step would have assigned this token, so a later read is not a hard error. */
  markUnverified(pool: "2damemory" | "strref", token: number): void {
    if (pool === "strref") {
      if (!this.strref.has(token)) this.unverifiedStrRef.add(token);
    } else if (!this.twoda.has(token)) this.unverifiedTwoda.add(token);
  }

  setStrRef(token: number, value: number): void {
    this.strref.set(token, value);
  }
  set2da(token: number, value: string): void {
    this.twoda.set(token, value);
    this.fieldPaths.delete(token);
  }
  /** Store a GFF field path pointer (`2DAMEMORY<N>=!FieldPath`). */
  setFieldPath(token: number, path: string): void {
    this.twoda.set(token, path);
    this.fieldPaths.add(token);
  }
  isFieldPath(token: number): boolean {
    return this.fieldPaths.has(token);
  }
  /** `2DAMEMORY<dest>=2DAMEMORY<source>` without a pointer destination: copy the value and its pointer-ness. */
  copy2da(dest: number, source: number): void {
    const value = this.get2da(source);
    const pointer = this.fieldPaths.has(source);
    this.twoda.set(dest, value);
    if (pointer) this.fieldPaths.add(dest);
    else this.fieldPaths.delete(dest);
  }
  getStrRef(token: number): number {
    const v = this.strref.get(token);
    if (v === undefined) {
      if (this.unverifiedStrRef.has(token)) throw new PatcherTokenError(`StrRef${token} is assigned by an earlier step that could not be verified in this dry run; content patch not verified`, `StrRef${token}`, true);
      throw new PatcherTokenError(`StrRef${token} was never assigned (no matching [TLKList] entry ran)`, `StrRef${token}`);
    }
    return v;
  }
  get2da(token: number): string {
    const v = this.twoda.get(token);
    if (v === undefined) {
      if (this.unverifiedTwoda.has(token)) throw new PatcherTokenError(`2DAMEMORY${token} is assigned by an earlier step that could not be verified in this dry run; content patch not verified`, `2DAMEMORY${token}`, true);
      throw new PatcherTokenError(`2DAMEMORY${token} was never assigned`, `2DAMEMORY${token}`);
    }
    return v;
  }
}

const STRREF_RE = /^strref(\d+)$/i;
const TWODA_RE = /^2damemory(\d+)$/i;

export type TokenRef = { kind: "strref"; token: number } | { kind: "2damemory"; token: number };

/** Recognise a bare token (`StrRef3`, `2DAMEMORY12`); undefined for anything else. */
export function parseToken(value: string): TokenRef | undefined {
  const v = value.trim();
  let m = STRREF_RE.exec(v);
  if (m) return { kind: "strref", token: Number(m[1]) };
  m = TWODA_RE.exec(v);
  if (m) return { kind: "2damemory", token: Number(m[1]) };
  return undefined;
}

export function isToken(value: string): boolean {
  return parseToken(value) !== undefined;
}

/**
 * Substitute a bare token with its memory value; non-token strings are
 * returned unchanged. Throws PatcherTokenError for unassigned tokens.
 */
export function resolveToken(value: string, memory: PatcherMemory): string {
  const t = parseToken(value);
  if (!t) return value;
  return t.kind === "strref" ? String(memory.getStrRef(t.token)) : memory.get2da(t.token);
}

/** Replace `#StrRef3#` / `#2DAMEMORY4#` placeholders inside free text (CompileList style). */
export function substituteTokenPlaceholders(text: string, memory: PatcherMemory): string {
  return text.replace(/#(StrRef\d+|2DAMEMORY\d+)#/gi, (_m, name: string) => resolveToken(name, memory));
}
