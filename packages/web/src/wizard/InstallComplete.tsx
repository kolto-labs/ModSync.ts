import { useEffect } from "react";
import { formatBytes } from "../components/DownloadsDrawer";
import { actions, modName, useAppState } from "../state/store";
import type { InstallSummary } from "../types";

export function InstallCompletePanel({ phase }: { phase: "base" | "widescreen" }) {
  const s = useAppState();
  const summary: InstallSummary | undefined = phase === "base" ? s.install.baseSummary ?? s.install.summary : s.install.widescreenSummary ?? s.install.summary;

  useEffect(() => {
    if (!summary?.virtualPrediction) void actions.refreshCheckpoints();
  }, [summary?.virtualPrediction]);

  const duration = summary ? Math.max(0, new Date(summary.finishedAt).getTime() - new Date(summary.startedAt).getTime()) : 0;
  const sessions = summary?.checkpointSessionId ? s.checkpoints.filter((c) => c.id === summary.checkpointSessionId) : s.checkpoints.slice(0, 1);
  const touched = summary?.mods.reduce((n, m) => n + m.instructionResults.reduce((k, r) => k + r.touched.length, 0), 0) ?? 0;

  if (summary?.virtualPrediction) {
    const prediction = summary.virtualPrediction;
    return (
      <section className="page page-narrow">
        <h1>{summary.error ? "Virtual prediction stopped" : "Virtual prediction complete"}</h1>
        <p>Instructions ran against a virtual filesystem. No game files were installed or changed.</p>
        {summary.error && <div className="alert alert-error" role="alert">{summary.error}</div>}
        <p>{prediction.results.length} instruction results · {prediction.mutations.length} virtual changes · {(duration / 1000).toFixed(1)}s</p>
        <div className="card">
          <h2>Predicted instructions</h2>
          <table className="table">
            <thead><tr><th>Mod</th><th>Action</th><th>Result</th><th>Paths</th></tr></thead>
            <tbody>{prediction.results.map((result, index) => (
              <tr key={`${result.modGuid}:${result.instructionGuid}:${index}`}>
                <td>{modName(s, result.modGuid)}</td><td>{result.action}</td>
                <td>{result.code}{result.message && <div className="muted small">{result.message}</div>}</td>
                <td>{result.touched.length}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {prediction.verifiedInputs.length > 0 && <div className="card"><h2>Verified archive inputs</h2><ul>{prediction.verifiedInputs.map(name => <li key={name}>{name}</li>)}</ul></div>}
      </section>
    );
  }

  return (
    <section className="page page-narrow">
      <h1>{summary?.error ? "Installation stopped" : phase === "base" ? "Base install complete" : "Widescreen install complete"}</h1>
      {summary?.error && <div className="alert alert-error" role="alert">{summary.error}{summary.recoveryPending && <p>Checkpoint recovery is pending. Inspect the saved session before continuing installation.</p>}</div>}
      {!summary && <div className="alert alert-warn">No install summary is available{s.install.cancelled ? " because the install was cancelled" : ""}.</div>}
      {summary && (
        <>
          <div className="stats">
            <div className="stat stat-ok">
              <span className="stat-label">Installed</span>
              <span className="stat-value">{summary.succeeded}</span>
            </div>
            <div className={`stat ${summary.failed ? "stat-error" : ""}`}>
              <span className="stat-label">Failed</span>
              <span className="stat-value">{summary.failed}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Skipped</span>
              <span className="stat-value">{summary.skipped}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Duration</span>
              <span className="stat-value">{(duration / 1000).toFixed(1)}s</span>
            </div>
            <div className="stat">
              <span className="stat-label">Files touched</span>
              <span className="stat-value">{touched}</span>
            </div>
          </div>
          <div className="card">
            <h3>Per mod</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Mod</th>
                  <th>State</th>
                  <th>Steps</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {summary.mods.map((m) => (
                  <tr key={m.modGuid}>
                    <td>{modName(s, m.modGuid)}</td>
                    <td>
                      <span className={`pill pill-${m.state === "Installed" ? "done" : m.state === "Failed" ? "failed" : "skipped"}`}>{m.state}</span>
                    </td>
                    <td className="small">
                      {m.instructionResults.filter((r) => r.code === "Success").length}/{m.instructionResults.length}
                      {m.instructionResults.some((r) => r.code !== "Success" && r.code !== "Skipped") && (
                        <div className="muted">{m.instructionResults.filter((r) => r.code !== "Success" && r.code !== "Skipped").map((r) => `${r.action}: ${r.code}${r.message ? ` (${r.message})` : ""}`).join("; ")}</div>
                      )}
                    </td>
                    <td className="mono small">{(m.durationMs / 1000).toFixed(1)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="card">
        <div className="row">
          <h3 className="grow">Checkpoints</h3>
          <button className="btn btn-sm" onClick={() => actions.refreshCheckpoints()}>
            Refresh
          </button>
        </div>
        <p className="muted small">Checkpoint restore is unavailable in this TypeScript implementation.</p>
        {sessions.length === 0 && <p className="muted">No checkpoints were recorded.</p>}
        {sessions.map((session) => (
          <div key={session.id}>
            <div className="muted small">
              Session {session.id} · {new Date(session.createdAt).toLocaleString()} · {session.checkpoints.length} checkpoints
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Label</th>
                  <th>Changed</th>
                  <th>Stored</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {session.checkpoints.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">
                      {c.index}
                      {c.isAnchor ? " ⚓" : ""}
                    </td>
                    <td>{c.label}</td>
                    <td>{c.changedCount}</td>
                    <td>{formatBytes(c.storedBytes)}</td>
                    <td>
                      <span className="muted small">Restore unavailable</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

export function BaseInstallComplete() {
  return <InstallCompletePanel phase="base" />;
}
