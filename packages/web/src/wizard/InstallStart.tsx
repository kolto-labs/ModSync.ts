import { useState } from "react";
import { Modal } from "../components/Modal";
import { actions, effectiveSelectedMods, modName, useAppState } from "../state/store";
import { goNext } from "./navigation";

type Stage = 0 | 1 | 2 | 3;

export function InstallStart() {
  const s = useAppState();
  const [stage, setStage] = useState<Stage>(0);
  const mods = effectiveSelectedMods(s, "base");
  const order = s.report?.installOrder ?? s.selection?.order ?? mods.map((m) => m.guid);
  const instructionCount = mods.reduce((n, m) => n + m.instructions.length + m.options.filter((o) => o.isSelected).reduce((k, o) => k + o.instructions.length, 0), 0);
  const withDirections = mods.filter((m) => m.directions || m.usageWarnings);

  const finish = () => {
    setStage(0);
    void actions.startInstall("base");
    goNext();
  };

  return (
    <section className="page page-narrow">
      <h1>Ready to install</h1>
      <div className="stats">
        <div className="stat">
          <span className="stat-label">Mods</span>
          <span className="stat-value">{mods.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Instructions</span>
          <span className="stat-value">{instructionCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Checkpoints</span>
          <span className="stat-value">{s.settings?.createCheckpoints ? "on" : "off"}</span>
        </div>
      </div>
      <div className="card">
        <h3>Install order</h3>
        <ol className="small cols">
          {order.filter((g) => mods.some((m) => m.guid === g)).map((g) => (
            <li key={g}>{modName(s, g)}</li>
          ))}
        </ol>
      </div>
      <dl className="kv">
        <dt>Game directory</dt>
        <dd className="mono">{s.settings?.kotorDirectory}</dd>
        <dt>Mod directory</dt>
        <dd className="mono">{s.settings?.modDirectory}</dd>
        <dt>Patcher</dt>
        <dd>{s.settings?.patcherEngine}</dd>
      </dl>
      <button className="btn btn-primary btn-lg" onClick={() => setStage(1)}>
        Begin installation
      </button>

      {stage === 1 && (
        <Modal
          title="This will modify your game"
          dismissable={false}
          footer={
            <>
              <button className="btn" onClick={() => setStage(0)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => setStage(2)}>
                I understand, continue
              </button>
            </>
          }
        >
          <p>
            ModSync is about to write <strong>{instructionCount} steps</strong> from <strong>{mods.length} mods</strong> into
            <span className="mono"> {s.settings?.kotorDirectory}</span>. Large texture packs can add several gigabytes.
          </p>
          <p>
            {s.settings?.createCheckpoints ? (
              <>Checkpoints are enabled, so each step can be rolled back, but they are not a substitute for a backup of a clean install.</>
            ) : (
              <strong>Checkpoints are disabled: there will be no way to undo. Make a backup of your game folder now if you have not.</strong>
            )}
          </p>
        </Modal>
      )}
      {stage === 2 && (
        <Modal
          title="Read the mod directions"
          dismissable={false}
          wide
          footer={
            <>
              <button className="btn" onClick={() => setStage(0)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => setStage(3)}>
                I have read them
              </button>
            </>
          }
        >
          <p>Some mods come with directions or warnings from their authors. Please read them before continuing.</p>
          {withDirections.length === 0 ? (
            <p className="muted">None of the selected mods has special directions.</p>
          ) : (
            <ul className="small">
              {withDirections.map((m) => (
                <li key={m.guid}>
                  <strong>{m.name}</strong>
                  {m.directions && <div className="muted">{m.directions}</div>}
                  {m.usageWarnings && <div className="alert alert-warn small">{m.usageWarnings}</div>}
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
      {stage === 3 && (
        <Modal
          title="Start the installation?"
          dismissable={false}
          footer={
            <>
              <button className="btn" onClick={() => setStage(0)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={finish}>
                Install {mods.length} mods
              </button>
            </>
          }
        >
          <p>Do not close ModSync or launch the game while the install is running. You can cancel at any time; the current instruction finishes first.</p>
        </Modal>
      )}
    </section>
  );
}
