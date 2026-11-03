import { useMemo, useState } from "react";
import { Markdown, renderInline } from "../components/Markdown";
import { actions, modName, setState, useAppState, type AppState } from "../state/store";
import type { Guid, ModComponent, ModOption, Tier } from "../types";
import { TIERS } from "../types";

export interface ModSelectionProps {
  phase: "base" | "widescreen";
}

function visibleMods(s: AppState, phase: "base" | "widescreen"): ModComponent[] {
  if (!s.file) return [];
  return s.file.mods.filter((m) => {
    if (phase === "base" ? m.isWidescreen : !m.isWidescreen) return false;
    if (s.spoilerFree && m.fullBuildOnly) return false;
    return true;
  });
}

/** Why a mod can't be ticked right now (undefined = it can). */
function disabledReason(s: AppState, m: ModComponent): string | undefined {
  if (m.aspyrOnly && s.settings?.platform !== "Mobile") return "Only for the Aspyr build (choose the Aspyr platform on the notice page)";
  if (!m.isSelected && (s.settings?.compatibilityLevel ?? "Compatible") === "Compatible") {
    const selected = new Set(s.file?.mods.filter((x) => x.isSelected).map((x) => x.guid));
    const partner = m.untestedWith.find((u) => selected.has(u)) ?? s.file?.mods.find((x) => x.isSelected && x.untestedWith.includes(m.guid))?.guid;
    if (partner) return `Untested together with ${modName(s, partner)}. Set the compatibility level to "Untested" to allow it.`;
  }
  return undefined;
}

export function ModSelection({ phase }: ModSelectionProps) {
  const s = useAppState();
  const [search, setSearch] = useState("");
  const [current, setCurrent] = useState<Guid | undefined>(undefined);
  const mods = visibleMods(s, phase);
  const selectedGuid = s.selectedModGuid && mods.some((m) => m.guid === s.selectedModGuid) ? s.selectedModGuid : current ?? mods[0]?.guid;
  const currentMod = mods.find((m) => m.guid === selectedGuid);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return mods;
    return mods.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.authors.some((a) => a.toLowerCase().includes(q)) ||
        m.category.some((c) => c.toLowerCase().includes(q)) ||
        (!s.spoilerFree && (m.description ?? "").toLowerCase().includes(q)),
    );
  }, [mods, search, s.spoilerFree]);

  const groups = TIERS.map((tier) => ({ tier, mods: filtered.filter((m) => m.tier === tier) })).filter((g) => g.mods.length > 0);
  const selectedCount = mods.filter((m) => m.isSelected && !disabledReason(s, m)).length;
  const issues = s.selection?.issues ?? [];

  const select = (guid: Guid) => {
    setCurrent(guid);
    setState({ selectedModGuid: guid });
  };

  return (
    <section className="page page-wide selection">
      <div className="selection-list">
        <div className="selection-toolbar">
          <input className="grow" placeholder="Search mods…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn btn-sm" onClick={() => actions.selectAll()}>
            Select All
          </button>
          {phase === "base" && (
            <button className="btn btn-sm" title="Select every Essential mod" onClick={() => actions.selectDefaults("Essential")}>
              Select essentials
            </button>
          )}
          <select
            className="btn-sm"
            value=""
            title="Select all mods up to a tier"
            onChange={(e) => {
              if (e.target.value) void actions.selectDefaults(e.target.value as Tier);
            }}
          >
            <option value="">Select up to tier…</option>
            {TIERS.filter((t) => t !== "Unknown").map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="muted small">
          {selectedCount} of {mods.length} selected
        </div>
        <div className="mod-groups">
          {groups.map((g) => (
            <div key={g.tier} className="mod-group">
              <div className="mod-group-title">{g.tier}</div>
              {g.mods.map((m) => {
                const reason = disabledReason(s, m);
                return (
                  <div
                    key={m.guid}
                    className={`mod-row ${m.guid === selectedGuid ? "active" : ""} ${reason ? "disabled" : ""}`}
                    onClick={() => select(m.guid)}
                    title={reason}
                  >
                    <input
                      type="checkbox"
                      checked={m.isSelected}
                      disabled={Boolean(reason) && !m.isSelected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => actions.setModSelected(m.guid, e.target.checked)}
                      aria-label={`Select ${m.name}`}
                    />
                    <span className="mod-row-name">{m.name}</span>
                    <span className="mod-row-badges">
                      {m.isPatch && <span className="badge">patch</span>}
                      {m.aspyrOnly && <span className="badge badge-warn">Aspyr</span>}
                      {m.fullBuildOnly && <span className="badge badge-warn">full build</span>}
                      {m.isWidescreen && <span className="badge">widescreen</span>}
                      {m.dependencies.length > 0 && <span className="badge badge-dep" title="Has dependencies">dep</span>}
                      {m.restrictions.length > 0 && <span className="badge badge-res" title="Has restrictions">res</span>}
                      {m.isDownloaded && <span className="badge badge-ok" title="Archive found">✓</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {groups.length === 0 && <div className="muted">No mods match.</div>}
        </div>
        {issues.length > 0 && (
          <div className="selection-issues">
            {issues.map((i, idx) => (
              <div key={idx} className={`issue issue-${i.severity}`} onClick={() => i.modGuid && select(i.modGuid)}>
                {i.message}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="selection-detail">
        {currentMod ? <ModDetail mod={currentMod} onJump={select} /> : <p className="muted">Pick a mod to see its details.</p>}
      </div>
    </section>
  );
}

function GuidBadges({ label, guids, kind, onJump }: { label: string; guids: Guid[]; kind: string; onJump: (g: Guid) => void }) {
  const s = useAppState();
  if (guids.length === 0) return null;
  return (
    <div className="badge-row">
      <span className="muted small">{label}:</span>
      {guids.map((g) => (
        <button key={g} className={`badge badge-${kind} badge-btn`} onClick={() => onJump(g)} title={g}>
          {modName(s, g)}
        </button>
      ))}
    </div>
  );
}

export function ModDetail({ mod, onJump }: { mod: ModComponent; onJump: (g: Guid) => void }) {
  const s = useAppState();
  const hide = s.spoilerFree;
  const reason = disabledReason(s, mod);

  const toggleOption = (o: ModOption, checked: boolean) => {
    const patch: Record<Guid, boolean> = { [o.guid]: checked };
    if (checked && o.exclusiveGroup) {
      for (const other of mod.options) if (other.guid !== o.guid && other.exclusiveGroup === o.exclusiveGroup) patch[other.guid] = false;
    }
    void actions.setModSelected(mod.guid, mod.isSelected, patch);
  };

  return (
    <div className="mod-detail">
      <div className="mod-detail-header">
        <label className="check check-lg">
          <input type="checkbox" checked={mod.isSelected} disabled={Boolean(reason) && !mod.isSelected} onChange={(e) => actions.setModSelected(mod.guid, e.target.checked)} />
          <h2>{mod.name}</h2>
        </label>
        <div className="badge-row">
          <span className={`badge badge-tier-${mod.tier.toLowerCase()}`}>{mod.tier}</span>
          {mod.category.map((c) => (
            <span key={c} className="badge">
              {c}
            </span>
          ))}
          <span className="badge">{mod.installationMethod}</span>
        </div>
      </div>
      {reason && <div className="alert alert-warn">{reason}</div>}
      <dl className="kv">
        {mod.authors.length > 0 && (
          <>
            <dt>Authors</dt>
            <dd>{mod.authors.join(", ")}</dd>
          </>
        )}
        {mod.language && (
          <>
            <dt>Non-English</dt>
            <dd>{mod.language}</dd>
          </>
        )}
        {!hide && mod.modLink.length > 0 && (
          <>
            <dt>Links</dt>
            <dd>
              {mod.modLink.map((l) => (
                <div key={l}>
                  <a href={l} target="_blank" rel="noreferrer noopener" onClick={(e) => { e.preventDefault(); void actions.openExternal(l); }}>
                    {l}
                  </a>
                </div>
              ))}
            </dd>
          </>
        )}
        {mod.expectedFiles && mod.expectedFiles.length > 0 && (
          <>
            <dt>Expected files</dt>
            <dd className="mono small">{mod.expectedFiles.join(", ")}</dd>
          </>
        )}
      </dl>
      {hide ? (
        <p className="muted">Description hidden in spoiler-free mode.</p>
      ) : (
        mod.description && <div className="mod-description">{renderInline(mod.description)}</div>
      )}
      {mod.directions && (
        <div className="card card-sub">
          <h4>Directions</h4>
          <Markdown source={mod.directions} hideLinks={hide} />
        </div>
      )}
      {mod.usageWarnings && <div className="alert alert-warn">{renderInline(mod.usageWarnings)}</div>}
      <GuidBadges label="Requires" guids={mod.dependencies} kind="dep" onJump={onJump} />
      <GuidBadges label="Conflicts with" guids={mod.restrictions} kind="res" onJump={onJump} />
      <GuidBadges label="Install after" guids={mod.installAfter} kind="order" onJump={onJump} />
      <GuidBadges label="Install before" guids={mod.installBefore} kind="order" onJump={onJump} />
      <GuidBadges label="Untested with" guids={mod.untestedWith} kind="untested" onJump={onJump} />
      {mod.options.length > 0 && (
        <div className="card card-sub">
          <h4>Options</h4>
          {mod.options.map((o) => (
            <div key={o.guid} className="option">
              <label className="check">
                <input type={o.exclusiveGroup ? "radio" : "checkbox"} name={o.exclusiveGroup ? `${mod.guid}-${o.exclusiveGroup}` : undefined} checked={o.isSelected} disabled={!mod.isSelected} onChange={(e) => toggleOption(o, o.exclusiveGroup ? true : e.target.checked)} />
                <span>
                  <strong>{o.name}</strong>
                  {o.exclusiveGroup && <span className="badge small">group: {o.exclusiveGroup}</span>}
                </span>
              </label>
              {!hide && o.description && <div className="muted small option-desc">{renderInline(o.description)}</div>}
              {o.directions && <Markdown className="small" source={o.directions} hideLinks={hide} />}
              <GuidBadges label="Requires" guids={o.dependencies} kind="dep" onJump={onJump} />
              <GuidBadges label="Conflicts with" guids={o.restrictions} kind="res" onJump={onJump} />
            </div>
          ))}
        </div>
      )}
      <details className="small">
        <summary className="muted">{mod.instructions.length} instruction(s)</summary>
        <ol className="mono small">
          {mod.instructions.map((i) => (
            <li key={i.guid}>
              <strong>{i.action}</strong> {i.source.join(", ")}
              {i.destination ? ` → ${i.destination}` : ""}
              {i.platform ? ` [${i.platform}]` : ""}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

export function BaseModSelection() {
  return <ModSelection phase="base" />;
}
