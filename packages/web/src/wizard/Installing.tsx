import { useEffect, useRef, useState } from "react";
import { Modal } from "../components/Modal";
import { actions, effectiveSelectedMods, findMod, modName, useAppState } from "../state/store";
import type { UserPrompt } from "../types";

const NO_IMAGES: string[] = [];

export interface InstallRunnerProps {
  phase: "base" | "widescreen";
}

/** Shared body of the Installing and WidescreenInstalling pages. */
export function InstallRunner({ phase }: InstallRunnerProps) {
  const s = useAppState();
  const inst = s.install;
  const started = useRef(false);

  useEffect(() => {
    const alreadyDone = inst.phase === phase && (inst.summary || inst.cancelled || inst.error);
    if (!started.current && !inst.running && !alreadyDone) {
      started.current = true;
      void actions.startInstall(phase);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const order = inst.order.length ? inst.order : effectiveSelectedMods(s, phase).map((m) => m.guid);
  const perMod = inst.perMod;
  const totalSteps = order.reduce((n, g) => n + (perMod[g]?.total ?? 0), 0);
  const doneSteps = order.reduce((n, g) => n + Math.min(perMod[g]?.done ?? 0, perMod[g]?.total ?? 0), 0);
  const overallPct = totalSteps ? Math.round((doneSteps / totalSteps) * 100) : inst.summary ? 100 : 0;
  const currentMod = findMod(s, inst.currentMod);

  return (
    <section className="page page-wide installing">
      <div className="installing-main">
        <h1>
          {inst.running ? "Installing…" : inst.cancelled ? "Installation cancelled" : inst.error ? "Installation failed" : "Installation finished"}
        </h1>
        <div className="overall">
          <div className="row">
            <span className="grow">
              {inst.running && inst.currentModName ? (
                <>
                  Mod {inst.modIndex + 1} of {inst.total}: <strong>{inst.currentModName}</strong>
                </>
              ) : (
                <>
                  {order.length} mod(s), {totalSteps} steps
                </>
              )}
            </span>
            <span className="mono">{overallPct}%</span>
          </div>
          <div className="progress progress-lg">
            <div className="progress-bar" style={{ width: `${overallPct}%` }} />
          </div>
          {inst.currentInstruction && (
            <div className="current-instruction mono small">
              <span className="badge">{inst.currentInstruction.action}</span> {inst.currentInstruction.description}
            </div>
          )}
          {inst.error && <div className="alert alert-error">{inst.error}</div>}
          <div className="row gap">
            {inst.running && (
              <button className="btn btn-danger" onClick={() => actions.cancelInstall()}>
                Cancel installation
              </button>
            )}
            {!inst.running && (inst.cancelled || inst.error) && (
              <button
                className="btn btn-primary"
                onClick={() => {
                  started.current = true;
                  void actions.startInstall(phase);
                }}
              >
                Retry
              </button>
            )}
            <span className="muted small">{inst.checkpointCount} checkpoint(s) created</span>
          </div>
        </div>

        <Slideshow images={currentMod?.images ?? NO_IMAGES} name={currentMod?.name} />

        <div className="mod-progress-list">
          {order.map((g) => {
            const p = perMod[g] ?? { done: 0, total: 0, state: "pending" as const };
            const pct = p.total ? Math.round((Math.min(p.done, p.total) / p.total) * 100) : p.state === "done" ? 100 : 0;
            return (
              <div key={g} className={`mod-progress state-${p.state}`}>
                <span className="mod-progress-name">{modName(s, g)}</span>
                <div className="progress">
                  <div className="progress-bar" style={{ width: `${pct}%` }} />
                </div>
                <span className="mono small">
                  {p.done}/{p.total}
                </span>
                <span className={`pill pill-${p.state}`}>{p.state}</span>
              </div>
            );
          })}
        </div>
      </div>
      <LogPane />
      {inst.pendingPrompt && <PromptModal key={inst.pendingPrompt.id} prompt={inst.pendingPrompt} />}
    </section>
  );
}

function Slideshow({ images, name }: { images: string[]; name?: string }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx(0);
    if (images.length < 2) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % images.length), 4000);
    return () => clearInterval(t);
  }, [images]);
  if (images.length === 0) return null;
  return (
    <div className="slideshow">
      <img src={images[idx % images.length]} alt={name ?? "mod image"} />
      {images.length > 1 && (
        <div className="slideshow-dots">
          {images.map((_, i) => (
            <span key={i} className={i === idx ? "on" : ""} onClick={() => setIdx(i)} />
          ))}
        </div>
      )}
    </div>
  );
}

function LogPane() {
  const log = useAppState().install.log;
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log, follow]);
  return (
    <div className="log-pane">
      <div className="log-header">
        <span>Log</span>
        <label className="check small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
      </div>
      <div className="log-body mono small" ref={ref}>
        {log.map((l) => (
          <div key={l.seq} className={`log-line log-${l.level}`}>
            <span className="log-time">{l.time}</span> <span className="log-level">{l.level}</span> {l.message}
          </div>
        ))}
        {log.length === 0 && <div className="muted">Waiting for output…</div>}
      </div>
    </div>
  );
}

export function PromptModal({ prompt }: { prompt: UserPrompt }) {
  const s = useAppState();
  const defaultChoice = prompt.choices.find((c) => c.isDefault)?.id ?? prompt.choices[0]?.id;
  const [choice, setChoice] = useState<string | undefined>(defaultChoice);
  const title = prompt.title || (prompt.kind === "confirm" ? "Confirm" : "Choose");
  const isChoice = prompt.kind === "choose-folder" || prompt.kind === "choose-option" || prompt.kind === "patcher-namespace";
  return (
    <Modal
      title={title}
      dismissable={false}
      footer={
        prompt.kind === "confirm" ? (
          <>
            <button className="btn" onClick={() => actions.answerPrompt({ accepted: false })}>
              No
            </button>
            <button className="btn btn-primary" onClick={() => actions.answerPrompt({ accepted: true })}>
              Yes
            </button>
          </>
        ) : prompt.kind === "message" ? (
          <button className="btn btn-primary" onClick={() => actions.answerPrompt({ accepted: true })}>
            OK
          </button>
        ) : (
          <>
            {prompt.allowNone && (
              <button className="btn" onClick={() => actions.answerPrompt({ choiceId: undefined })}>
                None of these
              </button>
            )}
            <button className="btn btn-primary" disabled={!choice} onClick={() => actions.answerPrompt({ choiceId: choice })}>
              Continue
            </button>
          </>
        )
      }
    >
      {prompt.modGuid && <div className="muted small">{modName(s, prompt.modGuid)}</div>}
      <p>{prompt.message}</p>
      {isChoice && (
        <div className="choices">
          {prompt.choices.map((c) => (
            <label key={c.id} className={`choice ${choice === c.id ? "selected" : ""}`}>
              <input type="radio" name="prompt-choice" checked={choice === c.id} onChange={() => setChoice(c.id)} />
              <span>
                <strong>{c.label}</strong>
                {c.description && <div className="muted small">{c.description}</div>}
              </span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function Installing() {
  return <InstallRunner phase="base" />;
}
