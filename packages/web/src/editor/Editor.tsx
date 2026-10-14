import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { DirectoryBrowser } from "../components/DirectoryBrowser";
import { Modal } from "../components/Modal";
import { actions, reportError, setState, toast, useAppState } from "../state/store";
import type { Guid, InstructionFile, MarkdownStyle, MergeResult, ModComponent } from "../types";
import { RustInstructionBuilder } from "./RustInstructionBuilder";
import { BrowseSource } from "./BrowseSource";
import { AuthoringSessionPanel } from "./AuthoringSessionPanel";
import { ConfigForm } from "./ConfigForm";
import { ReorderButtons } from "./fields";
import { ModForm } from "./ModForm";
import { blankFile, blankMod, moveItem, newGuid } from "./util";

type Dialog =
  | { kind: "save" }
  | { kind: "export"; style: MarkdownStyle; markdown?: string; busy?: boolean }
  | { kind: "import"; content: string; warnings?: string[]; busy?: boolean }
  | { kind: "merge"; content: string; result?: MergeResult; busy?: boolean }
  | { kind: "guid"; guid: string }
  | { kind: "browse-save" }
  | { kind: "inspect-source" }
  | null;

export function Editor() {
  const s = useAppState();
  const file: InstructionFile = s.draft ?? s.file ?? blankFile();
  const [selected, setSelected] = useState<Guid | "config">(s.selectedModGuid ?? "config");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [savePath, setSavePath] = useState(() => {
    const src = s.fileSource;
    return src && !/^https?:/.test(src) && src !== "uploaded content" ? src : `${s.settings?.modDirectory ?? ""}/build.toml`;
  });
  const dirty = s.draft !== s.file;
  const readOnly = Boolean(file.rustAuthoringGuide);

  useEffect(() => {
    if (!s.draft) actions.setDraft(s.file ?? blankFile());
  }, [s.draft, s.file]);

  const update = (next: InstructionFile) => { if (!readOnly) actions.setDraft(next); };
  const updateMod = (m: ModComponent) => update({ ...file, mods: file.mods.map((x) => (x.guid === m.guid ? m : x)) });
  const current = selected === "config" ? undefined : file.mods.find((m) => m.guid === selected);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return file.mods.map((m, index) => ({ m, index })).filter(({ m }) => !q || m.name.toLowerCase().includes(q));
  }, [file.mods, search]);

  const addMod = () => {
    const m = blankMod();
    update({ ...file, mods: [...file.mods, m] });
    setSelected(m.guid);
  };

  const save = async () => {
    const committed = await actions.commitDraft();
    if (!committed) return;
    try {
      await api.saveFile(savePath);
      setState({ fileSource: savePath });
      toast("success", `Saved to ${savePath}`);
      setDialog(null);
    } catch (err) {
      reportError(err, "Saving failed");
    }
  };

  const runExport = async (style: MarkdownStyle) => {
    setDialog({ kind: "export", style, busy: true });
    try {
      if ((dirty || !s.file) && !await actions.commitDraft()) {
        setDialog({ kind: "export", style });
        return;
      }
      const { markdown } = await api.exportMarkdown(style);
      setDialog({ kind: "export", style, markdown });
    } catch (err) {
      reportError(err, "Export failed");
      setDialog({ kind: "export", style });
    }
  };

  const runImport = async (content: string) => {
    setDialog({ kind: "import", content, busy: true });
    try {
      const res = await api.importMarkdown({ content });
      actions.setDraft(res.file);
      setSelected("config");
      setDialog({ kind: "import", content, warnings: res.warnings });
      toast("success", `Imported ${res.file.mods.length} mods`);
    } catch (err) {
      reportError(err, "Import failed");
      setDialog({ kind: "import", content });
    }
  };

  const runMerge = async (content: string) => {
    setDialog({ kind: "merge", content, busy: true });
    try {
      if ((dirty || !s.file) && !await actions.commitDraft()) {
        setDialog({ kind: "merge", content });
        return;
      }
      const result = await api.mergeFile(content);
      actions.setDraft(result.file);
      setDialog({ kind: "merge", content, result });
    } catch (err) {
      reportError(err, "Merge failed");
      setDialog({ kind: "merge", content });
    }
  };

  const readFileInput = (f: File | undefined, cb: (text: string) => void) => {
    if (f) void f.text().then(cb);
  };

  return (
    <div className="editor">
      <AuthoringSessionPanel />
      <div className="editor-toolbar">
        <strong>Editor</strong>
        {readOnly && <button className="btn btn-sm" onClick={() => setDialog({ kind: "inspect-source" })}>Inspect source files…</button>}
        {dirty && <span className="badge badge-warn">unsaved</span>}
        <div className="grow" />
        <button className="btn btn-sm" disabled={readOnly} onClick={() => { actions.setDraft(blankFile()); setSelected("config"); }}>
          New file
        </button>
        <button className="btn btn-sm btn-primary" disabled={readOnly} onClick={() => setDialog({ kind: "save" })}>
          Save
        </button>
        <button className="btn btn-sm" disabled={readOnly} onClick={() => setDialog({ kind: "export", style: "deadlystream" })}>
          Export markdown
        </button>
        <button className="btn btn-sm" disabled={readOnly} onClick={() => setDialog({ kind: "import", content: "" })}>
          Import markdown
        </button>
        <button className="btn btn-sm" disabled={readOnly} onClick={() => setDialog({ kind: "merge", content: "" })}>
          Merge
        </button>
        <button className="btn btn-sm" onClick={() => setDialog({ kind: "guid", guid: newGuid() })}>
          Generate GUID
        </button>
        <button className="btn btn-sm" onClick={() => setState({ showDag: true })}>
          DAG
        </button>
        <button className="btn btn-sm" onClick={() => actions.setMode("installer")}>
          Back to installer
        </button>
      </div>
      <div className="editor-body">
        <aside className="editor-list">
          <div className={`editor-item ${selected === "config" ? "active" : ""}`} onClick={() => setSelected("config")}>
            <strong>{file.config.name || "Build configuration"}</strong>
            <span className="muted small">{file.config.targetGame} · {file.mods.length} mods</span>
          </div>
          <input placeholder="Filter mods…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {filtered.map(({ m, index }) => (
            <div key={m.guid} className={`editor-item ${selected === m.guid ? "active" : ""}`} onClick={() => setSelected(m.guid)}>
              <span className="grow ellipsis">
                <span className="muted mono small">{index + 1}. </span>
                {m.name || "(unnamed)"}
                <span className="muted small"> · {m.tier}</span>
              </span>
              <fieldset disabled={readOnly} style={{ border: 0, padding: 0 }}><ReorderButtons
                index={index}
                length={file.mods.length}
                onMove={(to) => update({ ...file, mods: moveItem(file.mods, index, to) })}
                onRemove={() => {
                  if (!window.confirm(`Remove "${m.name}"?`)) return;
                  update({ ...file, mods: file.mods.filter((x) => x.guid !== m.guid) });
                  if (selected === m.guid) setSelected("config");
                }}
              /></fieldset>
            </div>
          ))}
          <button className="btn btn-sm" disabled={readOnly} onClick={addMod}>
            + Add mod
          </button>
        </aside>
        <div className="editor-form">
          {readOnly ? <RustInstructionBuilder componentGuid={current?.guid} /> : <>
          {selected === "config" ? (
            <>
              <h2>Build configuration</h2>
              <ConfigForm config={file.config} onChange={(config) => update({ ...file, config })} />
            </>
          ) : current ? (
            <>
              <h2>{current.name || "(unnamed mod)"}</h2>
              <ModForm key={current.guid} mod={current} file={file} onChange={updateMod} />
            </>
          ) : (
            <p className="muted">Select a mod on the left or add one.</p>
          )}
          </>}
        </div>
      </div>

      {dialog?.kind === "inspect-source" && <BrowseSource inspectOnly onInsert={() => {}} onClose={() => setDialog(null)} />}
      {dialog?.kind === "save" && (
        <Modal
          title="Save instruction file"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!savePath} onClick={save}>
                Save
              </button>
            </>
          }
        >
          <p className="muted small">Save the current build to a TOML instruction file on this computer.</p>
          <div className="row">
            <input className="grow mono" value={savePath} onChange={(e) => setSavePath(e.target.value)} placeholder="/path/to/build.toml" />
            <button className="btn" onClick={() => setDialog({ kind: "browse-save" })}>
              Browse
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "browse-save" && (
        <DirectoryBrowser
          title="Choose the folder to save into"
          initialPath={savePath.replace(/\/[^/]*$/, "")}
          onClose={() => setDialog({ kind: "save" })}
          onPick={(dir) => {
            const name = savePath.replace(/^.*\//, "") || "build.toml";
            setSavePath(`${dir.replace(/\/$/, "")}/${name}`);
            setDialog({ kind: "save" });
          }}
        />
      )}
      {dialog?.kind === "export" && (
        <Modal
          title="Export markdown"
          wide
          onClose={() => setDialog(null)}
          footer={
            <>
              <select value={dialog.style} onChange={(e) => setDialog({ ...dialog, style: e.target.value as MarkdownStyle, markdown: undefined })}>
                <option value="deadlystream">DeadlyStream style</option>
                <option value="reddit">Reddit style</option>
                <option value="structured">Structured (round-trippable)</option>
              </select>
              <div className="grow" />
              <button className="btn" disabled={dialog.busy} onClick={() => runExport(dialog.style)}>
                {dialog.busy ? "Generating…" : "Generate"}
              </button>
              <button
                className="btn btn-primary"
                disabled={!dialog.markdown}
                onClick={() => {
                  void navigator.clipboard?.writeText(dialog.markdown ?? "").then(() => toast("success", "Copied to clipboard"));
                }}
              >
                Copy
              </button>
            </>
          }
        >
          <textarea className="mono grow-text" rows={20} readOnly value={dialog.markdown ?? ""} placeholder="Press Generate to render the markdown documentation from the current file." />
        </Modal>
      )}
      {dialog?.kind === "import" && (
        <Modal
          title="Import markdown"
          wide
          onClose={() => setDialog(null)}
          footer={
            <>
              <input type="file" accept=".md,.txt" onChange={(e) => readFileInput(e.target.files?.[0], (t) => setDialog({ kind: "import", content: t }))} />
              <div className="grow" />
              <button className="btn btn-primary" disabled={!dialog.content.trim() || dialog.busy} onClick={() => runImport(dialog.content)}>
                {dialog.busy ? "Importing…" : "Import (replaces the draft)"}
              </button>
            </>
          }
        >
          <p className="muted small">Paste a full.md style build document. The parser reads headings, **Name:**, **Author:**, **Installation Instructions:** and hidden ModSync blocks.</p>
          <textarea className="mono grow-text" rows={14} value={dialog.content} onChange={(e) => setDialog({ ...dialog, content: e.target.value })} />
          {dialog.warnings && (
            <div className="card card-sub">
              <h4>Warnings ({dialog.warnings.length})</h4>
              {dialog.warnings.length === 0 && <p className="muted">None.</p>}
              <ul className="small">
                {dialog.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </Modal>
      )}
      {dialog?.kind === "merge" && (
        <Modal
          title="Merge another instruction file"
          wide
          onClose={() => setDialog(null)}
          footer={
            <>
              <input type="file" accept=".toml,.md,.txt" onChange={(e) => readFileInput(e.target.files?.[0], (t) => setDialog({ kind: "merge", content: t }))} />
              <div className="grow" />
              <button className="btn btn-primary" disabled={!dialog.content.trim() || dialog.busy} onClick={() => runMerge(dialog.content)}>
                {dialog.busy ? "Merging…" : "Merge into draft"}
              </button>
            </>
          }
        >
          <p className="muted small">Mods are matched by GUID, then by normalized name. Existing instructions win unless the incoming mod has instructions and the existing one has none.</p>
          <textarea className="mono grow-text" rows={12} value={dialog.content} onChange={(e) => setDialog({ ...dialog, content: e.target.value })} placeholder="Paste TOML content here or pick a file" />
          {dialog.result && (
            <div className="card card-sub">
              <h4>Merge result</h4>
              <ul className="small">
                <li>{dialog.result.added.length} added</li>
                <li>{dialog.result.updated.length} updated</li>
                <li>{dialog.result.removed.length} removed</li>
                <li>{dialog.result.conflicts.length} conflict(s)</li>
              </ul>
              {dialog.result.conflicts.map((c, i) => (
                <div key={i} className="issue issue-warning small">
                  <span className="mono">{c.guid}</span> · {c.field}: kept "{String(c.existing)}", incoming "{String(c.incoming)}"
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
      {dialog?.kind === "guid" && (
        <Modal
          title="New GUID"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDialog({ kind: "guid", guid: newGuid() })}>
                Another
              </button>
              <button className="btn btn-primary" onClick={() => { void navigator.clipboard?.writeText(dialog.guid); toast("success", "GUID copied"); setDialog(null); }}>
                Copy & close
              </button>
            </>
          }
        >
          <input className="mono" readOnly value={dialog.guid} onFocus={(e) => e.target.select()} />
          <p className="muted small">Braced upper-case form: {`{${dialog.guid.toUpperCase()}}`}</p>
        </Modal>
      )}
    </div>
  );
}
