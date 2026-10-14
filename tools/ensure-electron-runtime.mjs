/** Repair incomplete cached Electron side effects before native desktop tests. */
import { createRequire } from 'node:module';
import { readFile, stat, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(workspace, 'packages/electron/package.json'));
const electronPackage = dirname(require.resolve('electron/package.json'));
const expectedVersion = JSON.parse(await readFile(join(electronPackage, 'package.json'), 'utf8')).version;
const dist = join(electronPackage, 'dist');
const required = ['version', ...(process.platform === 'linux' ? ['electron', 'v8_context_snapshot.bin', 'resources.pak'] : process.platform === 'win32' ? ['electron.exe', 'v8_context_snapshot.bin', 'resources.pak'] : ['Electron.app/Contents/MacOS/Electron'])];
async function verifyRuntime() {
  for (const file of required) {
    const info = await stat(join(dist, file));
    if (!info.isFile() || info.size === 0) throw new Error(`Electron runtime asset is invalid: ${file}`);
  }
  const version = (await readFile(join(dist, 'version'), 'utf8')).trim().replace(/^v/, '');
  if (version !== expectedVersion) throw new Error(`Electron runtime version ${version} differs from ${expectedVersion}`);
}
let complete = true;
try { await verifyRuntime(); } catch { complete = false; }
if (!complete) {
  console.log('Electron cached runtime is incomplete; reinstalling the pinned package runtime.');
  const previous = `${dist}-incomplete-${process.pid}`;
  try { await rename(dist, previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = spawnSync(process.execPath, [join(electronPackage, 'install.js')], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`Electron runtime installation failed (${result.status ?? result.error?.message})`);
  await verifyRuntime();
  await rm(previous, { recursive: true, force: true });
}
console.log('Pinned Electron runtime files verified.');
