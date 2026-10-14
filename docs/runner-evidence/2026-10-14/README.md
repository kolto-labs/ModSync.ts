# Linux runner evidence, 2026-10-14

CLI receipts come from successful GitHub Actions run
[38509235033](https://github.com/bodencrouch/ModSync.ts/actions/runs/38509235033).
`provenance.json` records its implementation identity. `corpus-audit.json`
contains counts and source hashes; raw imported prose and per-component audit
details remain in the session artifacts. `derived-results.json` and
`synthetic-results.json` retain file proofs and verification outcomes while
omitting bulky instruction logs, checkpoint listings and local mapping paths.

These fixtures establish synthetic installation mechanics and rollback, not
original mod installation, external patcher execution or gameplay.

`gui-results-local.json` and `gui-local/` record the final isolated-profile
local native Electron proof, with four successful install/rollback lanes and
graceful code-0 exits. They are explicitly local evidence, not a successful
GitHub GUI run. `checks.json` records the final 413-test aggregate check.
Two additional native instances also ran concurrently with distinct profiles
and graceful exits; raw receipts remain at `/tmp/modsync-concurrent-profile-Cbco4m`.
