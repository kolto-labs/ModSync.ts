/**
 * Extract: unpack every archive matched by the sources into
 * `<archive dir>/<archive name without extension>/` (or `destination`).
 * A dry run lists the archive and registers its entries in the VFS; entries
 * are empty placeholders except small `.ini` files under `tslpatchdata`, whose
 * real content is exposed so `namespaces.ini` can drive the changes ini name.
 */

import { ArchiveError } from "../../archive/common.js";
import { SandboxFileSystem } from "../../fs/sandboxFileSystem.js";
import { VirtualFileSystem } from "../../fs/virtualFileSystem.js";
import { baseName, joinPath, parentPath, PathEscapeError } from "../../fs/paths.js";
import type { Instruction, InstructionResult, ModComponent, ModOption } from "../../model/types.js";
import type { ArchiveReader } from "../../ports/archive.js";
import type { InstallContext } from "../context.js";
import { ActionError, checkCancelled, resolveDestination, resolveSources, runAction } from "./common.js";

/** Largest single tslpatchdata ini whose content a dry run exposes. */
const DRY_RUN_INI_MAX_BYTES = 1024 * 1024;
/** Total ini bytes a dry run may read from one archive. */
const DRY_RUN_INI_TOTAL_BYTES = 16 * 1024 * 1024;

/** True for a `.ini` entry located under a `tslpatchdata` folder (case-insensitive). */
export function isTslpatchdataIni(entryPath: string): boolean {
  const segments = entryPath.split(/[\\/]+/).filter(Boolean);
  const name = segments.pop();
  if (!name || !/\.ini$/i.test(name)) return false;
  return segments.some((segment) => segment.toLowerCase() === "tslpatchdata");
}

/** Strip the archive extension: "Foo v1.2.zip" -> "Foo v1.2", "x.7z.exe" -> "x.7z". */
export function archiveFolderName(archivePath: string): string {
  const name = baseName(archivePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Default extraction folder of an archive. */
export function defaultExtractDir(archivePath: string): string {
  return joinPath(parentPath(archivePath), archiveFolderName(archivePath));
}

export async function executeExtract(
  ctx: InstallContext,
  instruction: Instruction,
  mod: ModComponent,
  option?: ModOption,
): Promise<InstructionResult> {
  return runAction(ctx, instruction, mod, option, async (run) => {
    const sources = await resolveSources(ctx, instruction.source);
    const missing = sources.filter((s) => s.matches.length === 0);
    if (missing.length) {
      throw new ActionError("FileNotFoundPre", `archive not found: ${missing.map((m) => `"${m.raw}"`).join(", ")}`);
    }
    const explicitDest = instruction.destination?.trim() ? await resolveDestination(ctx, instruction.destination) : undefined;
    let count = 0;
    for (const src of sources) {
      for (const archive of src.matches) {
        checkCancelled(ctx);
        const st = await ctx.fs.stat(archive);
        if (!st || st.isDirectory) continue;
        const dest = explicitDest ?? defaultExtractDir(archive);
        let reader: ArchiveReader;
        try {
          reader = await ctx.openArchive(archive, { sevenZipPath: ctx.settings.sevenZipPath });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new ActionError("ArchiveError", `cannot open "${archive}": ${message}`);
        }
        try {
          if (ctx.dryRun) {
            const entries = await reader.list();
            run.touch(dest);
            if (ctx.fs.isVirtual && (ctx.fs instanceof VirtualFileSystem || ctx.fs instanceof SandboxFileSystem)) {
              await ctx.fs.mkdirp(dest);
              const vfs = ctx.fs instanceof SandboxFileSystem ? ctx.fs.base : ctx.fs;
              const files: { path: string; size: number }[] = [];
              const iniFiles: { path: string; bytes: Uint8Array }[] = [];
              let iniBudget = DRY_RUN_INI_TOTAL_BYTES;
              for (const e of entries) if (e.isDirectory) await ctx.fs.mkdirp(joinPath(dest, e.path));
              for (const e of entries) {
                if (e.isDirectory) continue;
                const target = joinPath(dest, e.path);
                if (vfs instanceof VirtualFileSystem && isTslpatchdataIni(e.path) && e.size <= DRY_RUN_INI_MAX_BYTES && e.size <= iniBudget) {
                  checkCancelled(ctx);
                  try {
                    const bytes = await reader.readEntry(e.path);
                    if (bytes.byteLength <= DRY_RUN_INI_MAX_BYTES) {
                      iniBudget -= bytes.byteLength;
                      iniFiles.push({ path: target, bytes });
                      continue;
                    }
                  } catch (readErr) {
                    ctx.logger.debug(`dry run: cannot read "${e.path}" from "${archive}": ${readErr instanceof Error ? readErr.message : String(readErr)}`);
                  }
                }
                files.push({ path: target, size: e.size });
              }
              await ctx.fs.addVirtualFiles(files);
              if (vfs instanceof VirtualFileSystem) {
                for (const ini of iniFiles) {
                  if (ctx.fs instanceof SandboxFileSystem) await ctx.fs.assertPath(ini.path);
                  await vfs.addReadOnlyFile(ini.path, ini.bytes.byteLength, async () => ini.bytes);
                }
              }
              run.touch(...files.map((f) => f.path), ...iniFiles.map((f) => f.path));
            }
            ctx.logger.info(`dry run: would extract "${archive}" (${entries.length} entries) to "${dest}"`);
          } else {
            await ctx.fs.mkdirp(dest);
            const entries = await reader.list();
            // Validate the entire destination set before any archive bytes are written.
            if (ctx.fs instanceof SandboxFileSystem) {
              for (const entry of entries) await ctx.fs.assertPath(joinPath(dest, entry.path));
            }
            let written: string[];
            if (ctx.fs.isVirtual) {
              // An explicitly injected writable VFS must never be bypassed by
              // a native adapter. Dry-run above uses metadata without inflation.
              written = [];
              for (const entry of entries) {
                checkCancelled(ctx);
                const target = joinPath(dest, entry.path);
                if (entry.isDirectory) await ctx.fs.mkdirp(target);
                else { await ctx.fs.writeFile(target, await reader.readEntry(entry.path)); written.push(target); }
              }
            } else {
              written = await reader.extract(dest, undefined, {
                signal: ctx.signal,
                beforeWrite: async (target) => {
                  checkCancelled(ctx);
                  if (ctx.fs instanceof SandboxFileSystem) await ctx.fs.assertPath(target);
                  run.touch(target);
                },
              });
            }
            run.touch(dest, ...written);
            ctx.logger.info(`extracted "${archive}" (${written.length} files) to "${dest}"`);
          }
        } catch (err) {
          if (err instanceof ActionError || err instanceof PathEscapeError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof ArchiveError || /archive|zip|rar|7z/i.test(message)) {
            throw new ActionError("ArchiveError", `extracting "${archive}" failed: ${message}`);
          }
          throw err;
        } finally {
          await reader.close().catch(() => undefined);
        }
        run.note(`${ctx.dryRun ? "listed" : "extracted"} "${baseName(archive)}" -> "${dest}"`);
        count++;
      }
    }
    if (count === 0) throw new ActionError("FileNotFoundPre", "no archive file matched the sources");
  });
}
