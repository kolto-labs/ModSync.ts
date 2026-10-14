/**
 * Normalization of the free-form vocabulary found in instruction files and
 * community guides (tiers, categories, installation methods, action names,
 * target games) into the canonical enums of the domain model.
 */
import {
  ACTION_TYPES,
  CATEGORIES,
  type ActionType,
  type Category,
  type InstallationMethod,
  type TargetGame,
  type Tier,
} from "../model/types.js";

function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Normalize a tier label. Numbers win when present ("1 - Essential", "Tier 2",
 * "3 - Optional" -> Suggested); otherwise the keyword decides.
 */
export function normalizeTier(text: string | number | null | undefined): Tier {
  if (text === null || text === undefined) return "Unknown";
  const raw = String(text).trim();
  if (!raw) return "Unknown";
  const num = /(?:^|\b(?:tier)\s*)([1-4])\b/i.exec(raw);
  if (num) {
    switch (num[1]) {
      case "1":
        return "Essential";
      case "2":
        return "Recommended";
      case "3":
        return "Suggested";
      case "4":
        return "Optional";
    }
  }
  const lower = raw.toLowerCase();
  if (lower.includes("essential") || lower.includes("required")) return "Essential";
  if (lower.includes("recommend")) return "Recommended";
  if (lower.includes("suggest")) return "Suggested";
  if (lower.includes("option")) return "Optional";
  return "Unknown";
}

const CATEGORY_ALIASES: Array<[RegExp, Category]> = [
  [/^(patch|patches|compatibilitypatch|compatibility)$/, "Patch"],
  [/^(bugfix|bugfixes|bugfixe|fix|fixes|bug)$/, "Bugfix"],
  [/^(graphics?(improvement|improvements|enhancement)?|visual|visuals|textures?|hd)$/, "Graphics Improvement"],
  [/^(mechanics?(change|changes)?|balance|balancing)$/, "Mechanics Change"],
  [/^(gameplay|gameplaychange|gameplaychanges)$/, "Gameplay"],
  [/^(appearance(change|changes)?|cosmetic|cosmetics|skin|skins|model|models)$/, "Appearance Change"],
  [/^(immersion|immersive)$/, "Immersion"],
  [/^(story|narrative|plot)$/, "Story"],
  [/^(restoredcontent|restoration|restored|restore)$/, "Restored Content"],
  [/^(addedcontent|addition|additions|added|newcontent|content)$/, "Added Content"],
  [/^(ui|interface|userinterface|gui|hud)$/, "UI"],
  [/^(audio|sound|sounds|music|voice|voices)$/, "Audio"],
  [/^(widescreen|resolution)$/, "Widescreen"],
];

/** Map one category token to the canonical set. */
export function normalizeCategory(token: string): Category {
  const key = compact(token);
  if (!key) return "Unknown";
  for (const c of CATEGORIES) {
    if (compact(c) === key) return c;
  }
  for (const [re, cat] of CATEGORY_ALIASES) {
    if (re.test(key)) return cat;
  }
  return "Unknown";
}

/**
 * Split a category string ("Bugfix & Immersion", "Graphics, UI") or array
 * into canonical categories. Duplicates removed; unknown tokens map to
 * "Unknown" (only once).
 */
export function normalizeCategories(text: string | string[] | null | undefined): Category[] {
  if (text === null || text === undefined) return [];
  const tokens = (Array.isArray(text) ? text : [text])
    .flatMap((t) => String(t).split(/\s*(?:&|,|\+|\band\b|;|\||\/)\s*/i))
    .map((t) => t.trim())
    .filter((t) => t && !/^(unknown|n\/?a|none|-)$/i.test(t));
  const out: Category[] = [];
  for (const t of tokens) {
    const c = normalizeCategory(t);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Parse "Bugfix & Immersion / 2 - Recommended" style labels. */
export function parseCategoryAndTier(text: string | null | undefined): { category: Category[]; tier: Tier } {
  if (!text) return { category: [], tier: "Unknown" };
  const raw = text.trim();
  const slash = raw.lastIndexOf("/");
  if (slash >= 0) {
    const left = raw.slice(0, slash).trim();
    const right = raw.slice(slash + 1).trim();
    const tier = normalizeTier(right);
    if (tier !== "Unknown" || !left) {
      return { category: normalizeCategories(left), tier };
    }
  }
  // No separator: maybe "Bugfix - 1 - Essential" or just categories / just a tier.
  const tier = normalizeTier(raw);
  const tierWordless = raw.replace(/\b(tier\s*)?[1-4]\s*-?\s*(essential|recommended|suggested|optional|option|required)\b/gi, "");
  const category = normalizeCategories(tierWordless.replace(/[-/]\s*$/, ""));
  return { category: tier === "Unknown" ? normalizeCategories(raw) : category, tier };
}

/** Normalize the installation method vocabulary of the guides. */
export function normalizeInstallationMethod(text: string | null | undefined): InstallationMethod {
  if (!text) return "Unknown";
  const lower = text.toLowerCase();
  const patcher = /tsl\s*patcher|holo\s*patcher|patcher/.test(lower);
  const loose = /loose|drag|override|manual/.test(lower);
  const exe = /\.exe\b|installer|executable|self[- ]?extract/.test(lower);
  if (/\bmixed\b/.test(lower)) return "Mixed";
  if ([patcher, loose, exe].filter(Boolean).length > 1) return "Mixed";
  if (/holo\s*patcher/.test(lower)) return "HoloPatcher";
  if (patcher) return "TSLPatcher";
  if (loose) return "Loose-File";
  if (exe) return "Executable";
  return "Unknown";
}

const ACTION_ALIASES: Record<string, ActionType> = {
  extract: "Extract",
  unzip: "Extract",
  unpack: "Extract",
  move: "Move",
  moveall: "Move",
  movespecific: "Move",
  copy: "Copy",
  copyall: "Copy",
  copyspecific: "Copy",
  delete: "Delete",
  del: "Delete",
  remove: "Delete",
  rename: "Rename",
  execute: "Execute",
  run: "Execute",
  exec: "Execute",
  patcher: "Patcher",
  patch: "Patcher",
  tslpatcher: "Patcher",
  holopatcher: "Patcher",
  choose: "Choose",
  select: "Choose",
  delduplicate: "DelDuplicate",
  deleteduplicate: "DelDuplicate",
  deldupe: "DelDuplicate",
  createdirectory: "CreateDirectory",
  cleanlist: "CleanList",
  clean: "CleanList",
};

/** Normalize an action name ("extract", "MOVE ALL", "Run", ...). Undefined when unknown. */
export function normalizeActionType(text: string | null | undefined): ActionType | undefined {
  if (!text) return undefined;
  const key = compact(text);
  for (const a of ACTION_TYPES) if (compact(a) === key) return a;
  return ACTION_ALIASES[key];
}

/** Detect the target game from any text ("KOTOR 2", "TSL", "The Sith Lords", "K1"). */
export function normalizeTargetGame(text: string | null | undefined): TargetGame {
  if (!text) return "Unknown";
  const lower = text.toLowerCase();
  if (/kotor\s*(2|ii)\b|k2\b|\btsl\b|sith\s*lords|kotor2/.test(lower)) return "KOTOR2";
  if (/kotor\s*(1|i)\b|k1\b|kotor1|knights of the old republic|\bkotor\b/.test(lower)) return "KOTOR1";
  return "Unknown";
}

/** Human label for a tier in the "N - Name" style used by the guides. */
export function tierLabel(tier: Tier): string {
  switch (tier) {
    case "Essential":
      return "1 - Essential";
    case "Recommended":
      return "2 - Recommended";
    case "Suggested":
      return "3 - Suggested";
    case "Optional":
      return "4 - Optional";
    default:
      return "Unknown";
  }
}
