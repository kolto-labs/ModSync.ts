# Synthetic K1 and TSL runner verification

The source corpus is `kolto-labs/mod-builds` at
`21b2f0499d28ecd4ee2092701dee5792ba5da4b9`, using `content/k1/full.md` and
`content/k2/full.md`. The tools read canonical Git blobs, record their SHA-256
values, and retain the imported guides and component mappings as artifacts.

| Platform | CLI workflow | Native GUI workflow |
| --- | --- | --- |
| Linux | `simulate-cli-linux.yml` | `simulate-gui-linux.yml` |
| Windows | `simulate-cli-windows.yml` | `simulate-gui-windows.yml` |
| macOS | `simulate-cli-macos.yml` | `simulate-gui-macos.yml` |

These workflows run only on manual dispatch. Each CLI job covers both game
targets by default. Each GUI job launches the actual Electron application and
clicks its renderer against the authenticated in-process server. Screenshots,
traces, command logs, component receipts, source/runtime identities, hashes and
rollback evidence are uploaded even when a later step fails on hosted runners.
Linux workflows also accept `runner=session` for an already provisioned ephemeral
self-hosted runner with the `modsync-session` label. This lane retains the same
strict assertions and saves evidence in the runner workspace; its upload step is
skipped because this session cannot reach GitHub artifact storage.

The tools keep three proof lanes separate:

1. Actual source-guide import and parser coverage, including missing instructions
   and unverified generated actions. The GUI also demonstrates missing-assets
   validation for the original guide.
2. A derived synthetic guide with a recorded mapping for every imported component.
   Payloads and paths are original fixtures. Auxiliary extraction/receipt actions
   are labeled, and unsupported source actions are recorded rather than claimed
   to have run. The installer verifies order, every expected file, checkpoints,
   zero-write dry runs and restoration to the original synthetic baseline.
3. A small independent action fixture covering archives, copies, moves, deletion,
   renaming, folder choices, selected options and base/widescreen phase routing.

Run locally after building:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm simulation:cli --corpus ../mod-builds --output /tmp/modsync-cli-proof
corepack pnpm simulation:gui --corpus ../mod-builds --output /tmp/modsync-gui-proof
```

The corpus checkout must match the pin. Output fixture directories must be fresh.
Native GUI execution needs a usable desktop session; Linux runners provide Xvfb.
The supplied paths are examples; use fresh platform-appropriate directories on
Windows or macOS.

The controlled fixtures need no copyrighted game files or downloaded mods.
They do not prove the original modbuilds were installed, binary widescreen changes,
external patcher/executable effects, resource compatibility or actual gameplay.
Native source compilation is not bundled: supported precompiled scripts can be
installed, while missing compilation inputs or unresolved substitutions fail.

The continuation also hardens installer/checkpoint failure handling, download
concurrency, native TLK codecs, path containment, editor/wizard state and desktop
shutdown. Large-guide native click-throughs exposed and fixed renderer update
loops that the small fixture did not exercise. Aggregate checks remain required
before rerunning the platform workflows after source changes.

## Runner results from 2026-10-14

The Linux CLI workflow passed on an ephemeral GitHub Actions runner:
[run 38509235033](https://github.com/bodencrouch/ModSync.ts/actions/runs/38509235033).
Its source-mapped lane verified 197 K1 components and 154 TSL components, with
394 and 308 instructions respectively, zero-write dry runs and exact baseline
restoration. Curated receipts are in [runner-evidence/2026-10-14](runner-evidence/2026-10-14).
The complete output remains in the session runner workspace.

Hosted jobs were dispatched for all platforms, but GitHub rejected allocation
because account payments failed or the spending limit needs increasing. Windows
and macOS execution remains unverified until hosted runners can start. The
workflows and upload steps remain ready for those platforms.
