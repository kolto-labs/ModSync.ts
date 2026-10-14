import { useState } from "react";
import type { Instruction, InstructionFile } from "../types";
import { ACTION_TYPES, PLATFORMS } from "../types";
import { BrowseSource } from "./BrowseSource";
import { CheckField, Field, GuidPicker, ReorderButtons, SelectField, TextArea, TextField } from "./fields";
import { blankInstruction, moveItem } from "./util";

const ACTION_HELP: Record<Instruction["action"], string> = {
  Unset: "Choose an action before installing this instruction.",
  Run: "Run a program; arguments are passed on the command line.",
  Extract: "Extract archives (sources) into <archive dir>/<archive name>/ or into destination.",
  Move: "Move each source file/folder into the destination folder.",
  Copy: "Copy each source file/folder into the destination folder.",
  Delete: "Delete the source files (wildcards allowed).",
  Rename: "Rename the single source file; destination is the new name.",
  Execute: "Run a program; arguments are passed on the command line.",
  Patcher: "Run TSLPatcher/HoloPatcher on the tslpatchdata source; destination = game dir; arguments = namespace index or ini name.",
  Choose: "Ask the user to choose between option GUIDs or folders listed in source.",
  DelDuplicate: "Inside the source folders, delete files with extension `arguments` when a same-named file with another extension exists.",
  CreateDirectory: "Project an empty folder at destination with empty sources/arguments. Independent TS live execution requires directory rollback ownership and is currently refused.",
  CleanList: "source[0] is a CSV; delete listed files from destination for selected mods.",
};

export function InstructionForm({ instruction, file, onChange }: { instruction: Instruction; file: InstructionFile; onChange: (i: Instruction) => void }) {
  const [browse, setBrowse] = useState(false);
  const set = <K extends keyof Instruction>(k: K, v: Instruction[K]) => onChange({ ...instruction, [k]: v });
  const sources = instruction.source;
  return (
    <div className="instruction-form">
      <div className="grid-2">
        <SelectField label="Action" value={instruction.action} options={ACTION_TYPES} onChange={(v) => v && set("action", v)} />
        <TextField label="GUID" value={instruction.guid} onChange={(v) => set("guid", v)} mono />
      </div>
      <p className="muted small">{ACTION_HELP[instruction.action]}</p>
      <Field label="Source" hint="one path per line; wildcards and <<modDirectory>> / <<kotorDirectory>> placeholders">
        <div className="source-list">
          {sources.map((src, i) => (
            <div key={i} className="row">
              <input className="grow mono" value={src} onChange={(e) => set("source", sources.map((x, j) => (j === i ? e.target.value : x)))} />
              <ReorderButtons index={i} length={sources.length} onMove={(to) => set("source", moveItem(sources, i, to))} onRemove={() => set("source", sources.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div className="row gap">
            <button className="btn btn-sm" onClick={() => set("source", [...sources, ""])}>
              + Add source
            </button>
            <button className="btn btn-sm" onClick={() => setBrowse(true)}>
              Browse Source…
            </button>
            {instruction.action === "Choose" && (
              <select
                className="btn-sm"
                value=""
                onChange={(e) => {
                  if (e.target.value) set("source", [...sources, e.target.value]);
                }}
              >
                <option value="">+ option GUID…</option>
                {file.mods.flatMap((m) => m.options.map((o) => ({ guid: o.guid, label: `${m.name} / ${o.name}` }))).map((o) => (
                  <option key={o.guid} value={o.guid}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </Field>
      <div className="grid-2">
        <TextField label="Destination" value={instruction.destination} onChange={(v) => set("destination", v || undefined)} mono placeholder="<<kotorDirectory>>/Override" />
        <TextField label="Arguments" value={instruction.arguments} onChange={(v) => set("arguments", v || undefined)} mono hint="Execute args / Patcher namespace / DelDuplicate extension" />
        <SelectField label="Platform" value={instruction.platform} options={PLATFORMS} allowEmpty onChange={(v) => set("platform", v)} hint="only run on this platform" />
        <div className="field">
          <label>Flags</label>
          <CheckField label="Overwrite existing files" value={instruction.overwrite} onChange={(v) => set("overwrite", v)} />
        </div>
      </div>
      <TextArea label="Description" value={instruction.description} onChange={(v) => set("description", v || undefined)} rows={2} />
      <div className="grid-2">
        <GuidPicker label="Dependencies" value={instruction.dependencies} onChange={(v) => set("dependencies", v)} file={file} hint="must be selected" />
        <GuidPicker label="Restrictions" value={instruction.restrictions} onChange={(v) => set("restrictions", v)} file={file} hint="must not be selected" />
      </div>
      {browse && (
        <BrowseSource
          onClose={() => setBrowse(false)}
          onInsert={(paths) => {
            set("source", [...sources.filter(Boolean), ...paths]);
            setBrowse(false);
          }}
        />
      )}
    </div>
  );
}

/** Instruction list with add/remove/reorder and an inline form for the open one. */
export function InstructionList({ instructions, file, onChange }: { instructions: Instruction[]; file: InstructionFile; onChange: (list: Instruction[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="instruction-list">
      {instructions.map((ins, i) => (
        <div key={ins.guid} className={`instruction-item ${open === ins.guid ? "open" : ""}`}>
          <div className="instruction-head" onClick={() => setOpen(open === ins.guid ? null : ins.guid)}>
            <span className="mono muted small">{i + 1}.</span>
            <span className="badge">{ins.action}</span>
            <span className="grow ellipsis mono small">{ins.source.join(", ") || "(no source)"}{ins.destination ? ` → ${ins.destination}` : ""}</span>
            <ReorderButtons index={i} length={instructions.length} onMove={(to) => onChange(moveItem(instructions, i, to))} onRemove={() => onChange(instructions.filter((_, j) => j !== i))} />
          </div>
          {open === ins.guid && <InstructionForm instruction={ins} file={file} onChange={(n) => onChange(instructions.map((x) => (x.guid === ins.guid ? n : x)))} />}
        </div>
      ))}
      <div className="row gap">
        {(["Extract", "Move", "Patcher"] as const).map((a) => (
          <button
            key={a}
            className="btn btn-sm"
            onClick={() => {
              const n = blankInstruction(a);
              onChange([...instructions, n]);
              setOpen(n.guid);
            }}
          >
            + {a}
          </button>
        ))}
        <select
          className="btn-sm"
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            const n = blankInstruction(e.target.value as Instruction["action"]);
            onChange([...instructions, n]);
            setOpen(n.guid);
          }}
        >
          <option value="">+ other…</option>
          {ACTION_TYPES.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
