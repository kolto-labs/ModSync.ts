/**
 * Execute: run a program shipped with a mod. Arguments are split shell-style
 * (double/single quotes, backslash escapes). The working directory is the
 * executable's folder. A dry run only checks that the executable exists.
 * On a non-Windows host a Windows executable (MZ header) runs through wine,
 * with arguments into the game or mod directory rewritten to wine paths; see
 * `planLaunch`; .bat/.cmd scripts run as `wine cmd /c <Z: path>`. Native
 * programs are spawned unchanged. Stdin stays closed unless the instruction's
 * `metadata.stdin` opts in (see `resolveExecuteStdin`).
 */

import { parentPath, toNative } from "../../fs/paths.js";
import type { Instruction, InstructionResult, ModComponent, ModOption } from "../../model/types.js";
import type { InstallContext } from "../context.js";
import { WineUnavailableError, planLaunch, resolveExecuteStdin } from "../windowsExec.js";
import { ActionError, resolveSources, runAction } from "./common.js";

/** Split a command line into arguments: whitespace separated, quotes group, backslash escapes. */
export function splitArguments(line: string | undefined): string[] {
  if (!line) return [];
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let hasToken = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else if (ch === "\\" && quote === '"' && i + 1 < line.length && (line[i + 1] === '"' || line[i + 1] === "\\")) {
        current += line[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length && /[\s"'\\]/.test(line[i + 1])) {
      current += line[++i];
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        out.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) out.push(current);
  return out;
}

export async function executeExecute(
  ctx: InstallContext,
  instruction: Instruction,
  mod: ModComponent,
  option?: ModOption,
): Promise<InstructionResult> {
  return runAction(ctx, instruction, mod, option, async (run) => {
    if (instruction.source.length === 0) throw new ActionError("UnknownError", "Execute instruction has no source");
    const sources = await resolveSources(ctx, [instruction.source[0]]);
    const exe = sources[0].matches.find(Boolean);
    if (!exe) throw new ActionError("FileNotFoundPre", `executable not found: "${instruction.source[0]}"`);
    const st = await ctx.fs.stat(exe);
    if (!st || st.isDirectory) throw new ActionError("FileNotFoundPre", `"${exe}" is not a file`);
    const { args, stdin } = resolveExecuteStdin(instruction.metadata, splitArguments(instruction.arguments));
    ctx.logger.info(`execute: "${exe}" ${args.join(" ")}${ctx.dryRun ? " (dry run, not started)" : ""}`);
    if (ctx.dryRun) {
      run.note(`would run "${exe}" ${args.join(" ")}`.trim());
      return;
    }
    const cwd = parentPath(exe);
    const host = ctx.processHost;
    let launch;
    try {
      launch = await planLaunch(host, toNative(exe), args, [ctx.dirs.kotorDirectory, ctx.dirs.modDirectory], stdin);
    } catch (err) {
      if (err instanceof WineUnavailableError) throw new ActionError("ExecuteError", `cannot run "${exe}": ${err.message}`);
      throw err;
    }
    if (launch.viaWine) ctx.logger.info(`execute: via wine: ${launch.command} ${launch.args.join(" ")}`);
    let outcome;
    try {
      outcome = await host.run(launch.command, launch.args, {
        cwd: toNative(cwd),
        ...(launch.env ? { env: launch.env } : {}),
        ...(launch.stdin !== undefined ? { stdin: launch.stdin } : {}),
        signal: ctx.signal,
        onLine: (line) => ctx.logger.info(`[${mod.name}] ${line}`),
      });
    } catch (err) {
      throw new ActionError("ExecuteError", `cannot start "${exe}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ctx.signal?.aborted) throw new ActionError("UserCancelled", "cancelled while the program was running");
    if (outcome.code !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new ActionError("ExecuteError", `"${exe}" exited with code ${outcome.code ?? outcome.signal}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
    }
    run.touch(cwd);
    run.note(`ran "${exe}" (exit 0)`);
  });
}
