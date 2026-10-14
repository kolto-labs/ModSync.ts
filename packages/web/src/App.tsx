import { useEffect } from "react";
import { DownloadsDrawer } from "./components/DownloadsDrawer";
import { Modal } from "./components/Modal";
import { Editor } from "./editor/Editor";
import { DagView } from "./graph/DagView";
import { actions, setState, useAppState } from "./state/store";
import { PAGE_COMPONENTS, currentPage, goBack, goNext, goTo, nextStepIndex, prevStepIndex, visiblePages } from "./wizard";

export function App() {
  const s = useAppState();

  useEffect(() => {
    void actions.init();
    const onHash = () => setState({ mode: window.location.hash.startsWith("#editor") ? "editor" : "installer" });
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const page = currentPage(s);
  const Page = PAGE_COMPONENTS[page.id];
  const canNext = page.canNext ? page.canNext(s) : true;
  const canBack = page.canBack ? page.canBack(s) : true;
  const hasNext = nextStepIndex(s) !== null;
  const hasPrev = prevStepIndex(s) !== null;
  const pages = visiblePages(s);

  return (
    <div className="app">
      <header className="header">
        <div className="brand" onClick={() => s.mode === "installer" && goTo("Welcome")}>
          <span className="logo">◈</span>
          <span>ModSync</span>
          {s.file?.config.name && <span className="muted header-file ellipsis">— {s.file.config.name}</span>}
        </div>
        <div className="header-actions">
          <span className={`conn conn-${s.connection}`} title={`Server connection: ${s.connection}`} />
          <button className="btn btn-sm" onClick={() => setState({ showDag: true })} disabled={!s.file} title="Dependency graph">
            DAG
          </button>
          <button className="btn btn-sm" onClick={() => setState({ showDownloads: !s.showDownloads })}>
            {s.showDownloads ? "Hide Downloads" : "Show Downloads"}
          </button>
          <label className="check small" title="Hides descriptions and links, and removes full-build-only mods">
            <input type="checkbox" disabled={s.install.running} checked={s.spoilerFree} onChange={(e) => actions.setSpoilerFree(e.target.checked)} /> Spoiler-free
          </label>
          <button className="btn btn-sm" onClick={() => actions.toggleTheme()} title="Toggle theme">
            {s.theme === "dark" ? "☀ Light" : "☾ Dark"}
          </button>
          <div className="segmented">
            <button className={s.mode === "installer" ? "on" : ""} onClick={() => actions.setMode("installer")}>
              Installer
            </button>
            <button className={s.mode === "editor" ? "on" : ""} onClick={() => actions.setMode("editor")}>
              Editor
            </button>
          </div>
        </div>
      </header>

      {!s.ready ? (
        <main className="body center muted">Connecting…</main>
      ) : s.mode === "editor" ? (
        <main className="body">
          <Editor />
        </main>
      ) : (
        <>
          <nav className="progress-strip" aria-label="Wizard progress">
            {pages.map(({ page: p, index }) => (
              <span key={p.id} className={`strip-item ${index === s.step ? "on" : index < s.step ? "done" : ""}`} title={p.title}>
                {p.title}
              </span>
            ))}
          </nav>
          <main className="body">
            <Page key={page.id} />
          </main>
          <footer className="footer">
            <span className="muted small">
              Step {pages.findIndex((p) => p.index === s.step) + 1} of {pages.length} · {page.title}
            </span>
            <div className="grow" />
            <button className="btn" onClick={goBack} disabled={!hasPrev || !canBack}>
              ← Back
            </button>
            {!page.hideNext && (
              <button className="btn btn-primary" onClick={goNext} disabled={!hasNext || !canNext}>
                {page.nextLabel ?? "Next →"}
              </button>
            )}
          </footer>
        </>
      )}

      <DownloadsDrawer />
      {s.showDag && (
        <Modal title="Dependency graph" wide onClose={() => setState({ showDag: false })}>
          <DagView
            selected={s.selectedModGuid}
            onSelect={(guid) => {
              setState({ selectedModGuid: guid, showDag: false });
              if (s.mode === "installer") goTo("ModSelection");
            }}
          />
        </Modal>
      )}
      <div className="toasts">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setState((st) => ({ toasts: st.toasts.filter((x) => x.id !== t.id) }))}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
