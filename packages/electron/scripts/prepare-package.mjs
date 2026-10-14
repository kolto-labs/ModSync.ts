// Stage a self-contained desktop application without workspace symlinks.
import console from 'node:console';
import { cp, mkdir, readFile, realpath, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const electronDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(electronDir, '../..');
const output = join(electronDir, 'out', 'app');
const destination = join(electronDir, 'out', 'app-staging');
const notices = new Map();
async function manifest(directory) { return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
async function dependency(directory, name) {
  for (let cursor = directory;; cursor = dirname(cursor)) {
    const candidate = join(cursor, 'node_modules', name);
    try { await stat(join(candidate, 'package.json')); return realpath(candidate); } catch { /* search parents */ }
    if (dirname(cursor) === cursor) throw new Error(`Cannot resolve ${name} from ${directory}; run pnpm install first`);
  }
}
async function stage(source, target, ancestors = new Set()) {
  source = await realpath(source);
  const pkg = await manifest(source);
  const noticeKey = `${pkg.name}@${pkg.version}`;
  if (!notices.has(noticeKey)) {
    const licenses = [];
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isFile() && /licen[sc]e|^copying|^notice/i.test(entry.name)) {
        licenses.push(`${entry.name}\n${await readFile(join(source, entry.name), 'utf8')}`);
      }
    }
    notices.set(noticeKey, [`## ${noticeKey}`, `Declared license: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'not declared')}`, ...licenses].join('\n\n'));
  }
  await mkdir(target, { recursive: true });
  if (source.startsWith(join(workspace, 'packages') + sep)) {
    await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true });
  } else {
    await cp(source, target, { recursive: true, dereference: true, filter: (entry) => entry === source || !relative(source, entry).split(sep).includes('node_modules') });
  }
  await writeFile(join(target, 'package.json'), JSON.stringify({ ...pkg, devDependencies: undefined }, null, 2));
  const next = new Set(ancestors).add(source);
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const resolved = await dependency(source, name);
    // A dependency cycle resolves through the ancestor's node_modules.
    if (!next.has(resolved)) await stage(resolved, join(target, 'node_modules', name), next);
  }
}
// Verify build prerequisites before replacing an existing staging directory.
for (const name of ['electron', 'server', 'core', 'kotor-formats']) {
  await stat(join(workspace, 'packages', name, 'dist', name === 'electron' ? 'main.js' : 'index.js'));
}
const webDir = join(workspace, 'packages', 'web', 'dist');
const html = await readFile(join(webDir, 'index.html'), 'utf8');
const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]).filter((asset) => asset.startsWith('/assets/') || asset.startsWith('assets/') || asset.startsWith('./assets/'));
if (!assets.length) throw new Error('Web bundle has no built assets; run pnpm build first');
for (const asset of assets) await stat(join(webDir, asset.replace(/^\//, '').split(/[?#]/)[0]));
await stat(join(workspace, 'LICENSE'));
await rm(destination, { recursive: true, force: true });
await stage(electronDir, destination);
await cp(join(workspace, 'packages', 'web', 'dist'), join(destination, 'web'), { recursive: true });
await cp(join(workspace, 'LICENSE'), join(destination, 'LICENSE'));
await writeFile(join(destination, 'THIRD-PARTY-NOTICES.txt'), ['ModSync runtime dependency notices', 'Electron and Chromium notices are included alongside the packaged executable.', ...notices.values()].join('\n\n'));
await writeFile(join(destination, 'README.txt'), 'ModSync portable desktop app\n\nLaunch ModSync (Linux), ModSync.exe (Windows), or ModSync.app (macOS).\nKeep the packaged directory intact. Archive support may use external 7z for unsupported formats.\nProject license: GPL-3.0-or-later; see LICENSE and THIRD-PARTY-NOTICES.txt.\n');
await rm(output, { recursive: true, force: true });
await rename(destination, output);
console.log(`Desktop application staged at ${output}`);
