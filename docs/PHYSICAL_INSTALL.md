# CI-only physical install

By default the TypeScript installer refuses to write to a real directory. Only
virtual dry runs are allowed. That is intentional: a physical install needs OS
level writer ownership, verified recovery and quiescence, and those are not
finished (see `packages/core/native/README.md`).

This document describes the explicit, documented opt-in that lets an ephemeral
CI job perform a real install on a plain directory without the native addon.
It is not a replacement for native ownership and must not be used on a
player's live game directory.

## Opting in

Either of:

- CLI flag: `install <guide> --ci-physical-install ...` (also accepted by
  `checkpoints list` and `checkpoints restore`)
- Environment: `MODSYNC_CI_PHYSICAL_INSTALL=1` (exactly `1`)

Without the opt-in, `install` and `checkpoints restore` keep refusing with the
original errors. The opt-in is ignored for `--dry-run` and rejected by
`Installer.run` when combined with `dryRun`. Library callers pass
`run({ physical: { ownership: "portable-lockfile" } })`, and pass the same
value as `physicalRestore` to `CheckpointStore`.

The web GUI server (`packages/server`) honours only the environment variable,
never a request parameter: with `MODSYNC_CI_PHYSICAL_INSTALL=1` in the server
process, `POST /api/install` runs with the same `physical` opt-in as the CLI,
its checkpoint store is built with `physicalRestore`, `GET
/api/checkpoints/capabilities` reports `physicalRestore: true`, and `POST
/api/checkpoints/:session/:id/restore` performs the verified physical restore
(refused while an install is running or for a session recorded for a different
game directory). Without the variable the server keeps refusing exactly as
before.

Example for `tools/modsync-ci/ports.py`:

```
node packages/cli/dist/main.js install <converted> --kotor G --mods A --all --phase base --ci-physical-install
node packages/cli/dist/main.js install <converted> --kotor G --mods A --all --phase widescreen --ci-physical-install
```

or set `MODSYNC_CI_PHYSICAL_INSTALL=1` in the subprocess environment.

## What the portable lock is

Before a session starts, the installer creates one sibling lockfile per root
(mod directory and KOTOR directory) in the root's parent directory, named
`.modsync-portable-lock-<hash>`. Files are created with `O_CREAT|O_EXCL|O_NOFOLLOW`,
acquired in byte order of canonical path (no ordering deadlock), and released
(unlinked after an identity and token check) when the run ends, including on
failure. Restore locks the KOTOR directory the same way.

Guarantees:

- A second ModSync process using this scheme refuses to start (`PortableLockError`).
- Locks are released on every normal exit path.

Non-guarantees:

- It is advisory. It does not stop other programs, a user, or a game from
  writing in the directories.
- It does not defend against a hostile replacement of an ancestor directory.
- It does not provide quiescence of external processes.
- A stale lock (after a crash or SIGKILL) is never stolen. The error names the
  lockfile; delete it manually after confirming no ModSync process is running.
- Because the lockfiles live in the parent of each root, the parent must be
  writable.

## Gates that stay closed

- `CreateDirectory`: empty directories are not tracked by file-only
  checkpoints, so there is no rollback. Still refused.
- Canonical authored guides (`rustAuthoringGuide`): still refused for real runs.
- Patcher and Execute steps run, but their touched files cannot be predicted,
  so they are not captured before the step. A failed patcher step leaves
  recovery pending and cannot be rolled back from checkpoints; a restore past a
  patcher step that touched files outside predicted paths is refused ("never
  captured").
- `Execute` on a non-Windows host runs a Windows executable (MZ header) through
  `wine` (`wine64` as a fallback), inside `xvfb-run` when no display is set and
  it is installed. Arguments that point into the game or mod directory are
  rewritten to wine `Z:` paths; `WINEPREFIX` is inherited and `WINEDEBUG`
  defaults to `-all`. A missing wine fails the step with a clear error. ELF
  binaries and scripts, and every program on Windows, are spawned directly. The
  touched-path bookkeeping above is unchanged, and none of this has run against
  a real wine in the unit tests (they stub the process host).

## Failure protocol

Checkpoints are taken before each instruction. If step N fails:

1. `checkpoints restore` to the snapshot taken just before step N (the only
   target an unfinished mutation may roll back to). The restore is verified by
   hashing the disk against the snapshot; on mismatch the intent stays pending.
2. Fix the cause.
3. Replay from step N in guide order.

Never fix a failed step by installing it after later steps; install order is
load-bearing.
