import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadEvent } from "../model/types.js";
import { classifyUrl, fileNameFromUrl, parseNxmUrl, nexusDownloadLinkUrl } from "./hosts.js";
import { DownloadManager, parseContentDispositionFileName, sanitizeFileName } from "./manager.js";

const sha1 = (b: Uint8Array | string) => createHash("sha1").update(b).digest("hex");

const FILE = Buffer.alloc(300_000);
for (let i = 0; i < FILE.length; i++) FILE[i] = (i * 7 + (i >> 8)) & 0xff;
const FILE_SHA1 = sha1(FILE);

interface Seen {
  url: string;
  range?: string;
}

let server: Server;
let base = "";
const seen: Seen[] = [];
let holdCount = 0;
let maxHold = 0;
const holdRelease: Array<() => void> = [];

function serveBuffer(req: IncomingMessage, res: ServerResponse, buf: Buffer, extra: Record<string, string> = {}, slow = false) {
  const range = req.headers.range;
  let start = 0;
  if (range) {
    const m = /bytes=(\d+)-/.exec(range);
    if (m) start = Number(m[1]);
    if (start >= buf.length) {
      res.writeHead(416, { "content-range": `bytes */${buf.length}` });
      return res.end();
    }
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-length": String(buf.length - start),
      "content-range": `bytes ${start}-${buf.length - 1}/${buf.length}`,
      ...extra,
    });
  } else {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(buf.length), ...extra });
  }
  if (!slow) return res.end(buf.subarray(start));
  let pos = start;
  const tick = () => {
    if (res.destroyed) return;
    const end = Math.min(buf.length, pos + 10_000);
    res.write(buf.subarray(pos, end));
    pos = end;
    if (pos >= buf.length) res.end();
    else setTimeout(tick, 15);
  };
  tick();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.push({ url: url.pathname + url.search, range: req.headers.range });
    switch (url.pathname) {
      case "/file.zip":
        return serveBuffer(req, res, FILE);
      case "/cd":
        return serveBuffer(req, res, FILE, { "content-disposition": url.searchParams.get("h") ?? "" });
      case "/slow.zip":
        return serveBuffer(req, res, FILE, {}, true);
      case "/page": {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<html><body>login please</body></html>");
      }
      case "/forbidden": {
        res.writeHead(403, { "content-type": "application/octet-stream" });
        return res.end("no");
      }
      case "/missing": {
        res.writeHead(404);
        return res.end("nope");
      }
      case "/hold.zip": {
        holdCount++;
        maxHold = Math.max(maxHold, holdCount);
        holdRelease.push(() => {
          holdCount--;
          serveBuffer(req, res, Buffer.from("held"));
        });
        return;
      }
      case "/redirect":
        res.writeHead(302, { location: `${base}/cd?h=${encodeURIComponent('attachment; filename="redirected.7z"')}` });
        return res.end();
      default:
        res.writeHead(500);
        return res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "modsync-dl-"));
}

function collect(m: DownloadManager): DownloadEvent[] {
  const events: DownloadEvent[] = [];
  m.on("event", (e) => events.push(e));
  return events;
}

describe("hosts", () => {
  it("classifies urls", () => {
    expect(classifyUrl("https://www.nexusmods.com/kotor/mods/1234?tab=files&file_id=5678")).toEqual({
      host: "nexus",
      game: "kotor",
      modId: 1234,
      fileId: 5678,
      needsBrowser: false,
    });
    expect(classifyUrl("https://www.nexusmods.com/kotor2/mods/99").fileId).toBeUndefined();
    expect(classifyUrl("nxm://kotor/mods/1234/files/5678?key=abc&expires=1")).toMatchObject({
      host: "nexus",
      nxm: true,
      game: "kotor",
      modId: 1234,
      fileId: 5678,
    });
    expect(parseNxmUrl("https://x")).toBeUndefined();
    expect(classifyUrl("https://deadlystream.com/files/file/1313-kotor-1-community-patch/")).toMatchObject({
      host: "deadlystream",
      needsBrowser: true,
    });
    expect(classifyUrl("https://github.com/o/r/releases/download/v1/a.zip")).toEqual({ host: "github", needsBrowser: false });
    expect(classifyUrl("https://mega.nz/file/abc#key")).toMatchObject({ host: "mega", needsBrowser: true });
    expect(classifyUrl("https://example.com/files/mod.7z")).toEqual({ host: "direct", needsBrowser: false });
    expect(classifyUrl("https://example.com/page")).toEqual({ host: "other", needsBrowser: false });
    expect(classifyUrl("ftp://example.com/x.zip").host).toBe("other");
    expect(classifyUrl("not a url").host).toBe("other");
    expect(nexusDownloadLinkUrl("kotor", 1, 2)).toBe("https://api.nexusmods.com/v1/games/kotor/mods/1/files/2/download_link.json");
    expect(fileNameFromUrl("https://h/a/b/My%20Mod.zip?x=1")).toBe("My Mod.zip");
    expect(fileNameFromUrl("https://h/")).toBeUndefined();
  });

  it("parses Content-Disposition per RFC 6266", () => {
    expect(parseContentDispositionFileName('attachment; filename="a b.zip"')).toBe("a b.zip");
    expect(parseContentDispositionFileName("attachment; filename=plain.7z")).toBe("plain.7z");
    expect(parseContentDispositionFileName("attachment; filename=\"fallback.zip\"; filename*=UTF-8''%E2%82%AC%20rates.zip")).toBe(
      "€ rates.zip",
    );
    expect(parseContentDispositionFileName("attachment; filename*=iso-8859-1'en'x.zip")).toBe("x.zip");
    expect(parseContentDispositionFileName('inline; filename="es\\"c.zip"')).toBe('es"c.zip');
    expect(parseContentDispositionFileName("attachment")).toBeUndefined();
    expect(parseContentDispositionFileName(null)).toBeUndefined();
    expect(sanitizeFileName("../../evil/../name:x?.zip")).toBe("name_x_.zip");
    expect(sanitizeFileName("C:\\Users\\me\\mod.rar")).toBe("mod.rar");
    expect(sanitizeFileName("..")).toBe("");
  });
});

describe("DownloadManager", () => {
  it("downloads a file, names it from Content-Disposition, hashes and throttles progress", async () => {
    const dir = await tmp();
    const m = new DownloadManager({ modDirectory: dir, progressIntervalMs: 250 });
    const events = collect(m);
    const item = m.enqueue("mod-1", `${base}/cd?h=${encodeURIComponent("attachment; filename*=UTF-8''My%20Mod.zip")}`);
    expect(item.state).toBe("queued");
    expect(m.list()).toHaveLength(1);
    m.start();
    await m.waitForIdle();
    const done = m.get(item.id)!;
    expect(done.state).toBe("done");
    expect(done.fileName).toBe("My Mod.zip");
    expect(done.sha1).toBe(FILE_SHA1);
    expect(done.receivedBytes).toBe(FILE.length);
    expect(done.totalBytes).toBe(FILE.length);
    expect(FILE.equals(await readFile(join(dir, "My Mod.zip")))).toBe(true);
    expect(await readdir(dir)).toEqual(["My Mod.zip"]); // no .part left behind
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("download-queued");
    expect(types[1]).toBe("download-started");
    expect(types[types.length - 1]).toBe("download-finished");
    const progress = events.filter((e) => e.type === "download-progress");
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress.length).toBeLessThanOrEqual(3); // ~4/s: a local download finishes well under a second
    const last = progress[progress.length - 1];
    expect(last.type === "download-progress" && last.receivedBytes).toBe(FILE.length);
    const fin = events[events.length - 1];
    expect(fin.type === "download-finished" && fin.path).toBe(join(dir, "My Mod.zip"));
  });

  it("falls back to the URL segment, follows redirects and honours an explicit file name", async () => {
    const dir = await tmp();
    const m = new DownloadManager({ modDirectory: dir });
    const a = m.enqueue("g", `${base}/file.zip`);
    const b = m.enqueue("g", `${base}/redirect`);
    const c = m.enqueue("g", `${base}/file.zip`, { fileName: "forced.zip", expectedSha1: FILE_SHA1.toUpperCase() });
    m.start();
    await m.waitForIdle();
    expect(m.get(a.id)!.fileName).toBe("file.zip");
    expect(m.get(b.id)!.fileName).toBe("redirected.7z");
    expect(m.get(c.id)!.fileName).toBe("forced.zip");
    expect(m.list().map((i) => i.state)).toEqual(["done", "done", "done"]);
    expect((await readdir(dir)).sort()).toEqual(["file.zip", "forced.zip", "redirected.7z"]);
  });

  it("resumes an existing .part with a Range request", async () => {
    const dir = await tmp();
    const partial = FILE.subarray(0, 120_000);
    await writeFile(join(dir, "file.zip.part"), partial);
    seen.length = 0;
    const m = new DownloadManager({ modDirectory: dir });
    const events = collect(m);
    const item = m.enqueue("g", `${base}/file.zip`);
    m.start();
    await m.waitForIdle();
    const done = m.get(item.id)!;
    expect(done.state).toBe("done");
    expect(done.sha1).toBe(FILE_SHA1);
    expect(done.totalBytes).toBe(FILE.length);
    expect(FILE.equals(await readFile(join(dir, "file.zip")))).toBe(true);
    expect(seen.find((s) => s.url === "/file.zip")?.range).toBe("bytes=120000-");
    const started = events.find((e) => e.type === "download-started");
    expect(started && started.type === "download-started" && started.totalBytes).toBe(FILE.length);
  });

  it("pause keeps the .part and start resumes it", async () => {
    const dir = await tmp();
    seen.length = 0;
    const m = new DownloadManager({ modDirectory: dir, progressIntervalMs: 0 });
    const item = m.enqueue("g", `${base}/slow.zip`);
    let pausedOnce = false;
    const paused = new Promise<void>((resolve) => {
      m.on("event", (e) => {
        if (pausedOnce || e.type !== "download-progress") return;
        if (e.receivedBytes > 0 && e.receivedBytes < FILE.length) {
          pausedOnce = true;
          m.pause();
          resolve();
        }
      });
    });
    m.start();
    await paused;
    await m.waitForIdle();
    expect(m.get(item.id)!.state).toBe("paused");
    expect(m.isRunning).toBe(false);
    const partSize = (await readFile(join(dir, "slow.zip.part"))).length;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(FILE.length);

    m.start();
    expect(m.get(item.id)!.state).toBe("downloading");
    await m.waitForIdle();
    const done = m.get(item.id)!;
    expect(done.state).toBe("done");
    expect(done.sha1).toBe(FILE_SHA1);
    expect(FILE.equals(await readFile(join(dir, "slow.zip")))).toBe(true);
    const ranges = seen.filter((s) => s.url === "/slow.zip").map((s) => s.range);
    expect(ranges[0]).toBeUndefined();
    expect(ranges[1]).toMatch(/^bytes=\d+-$/);
  });

  it("resumes immediately after pause without overlapping writers", async () => {
    const dir = await tmp();
    const m = new DownloadManager({ modDirectory: dir, progressIntervalMs: 0 });
    const item = m.enqueue("g", `${base}/slow.zip`);
    let restarted = false;
    m.on("event", (event) => {
      if (!restarted && event.type === "download-progress" && event.receivedBytes > 0) {
        restarted = true;
        m.pause();
        m.start();
      }
    });
    m.start();
    await m.waitForIdle();
    expect(m.get(item.id)?.state).toBe("done");
    expect(m.get(item.id)?.sha1).toBe(FILE_SHA1);
  });

  it("keeps same-name concurrent downloads separate", async () => {
    const dir = await tmp();
    const m = new DownloadManager({ modDirectory: dir });
    const first = m.enqueue("a", `${base}/slow.zip`);
    const second = m.enqueue("b", `${base}/slow.zip`);
    m.start();
    await m.waitForIdle();
    const a = m.get(first.id)!;
    const b = m.get(second.id)!;
    expect(a.state).toBe("done");
    expect(b.state).toBe("done");
    expect(a.path).not.toBe(b.path);
    expect(sha1(await readFile(a.path!))).toBe(FILE_SHA1);
    expect(sha1(await readFile(b.path!))).toBe(FILE_SHA1);
  });

  it("flags HTML pages and 401/403 as needs-browser, other errors as failed", async () => {
    const dir = await tmp();
    const m = new DownloadManager({ modDirectory: dir });
    const events = collect(m);
    const page = m.enqueue("g", `${base}/page`);
    const forbidden = m.enqueue("g", `${base}/forbidden`);
    const missing = m.enqueue("g", `${base}/missing`);
    const badHash = m.enqueue("g", `${base}/file.zip`, { expectedSha1: "0".repeat(40) });
    m.start();
    await m.waitForIdle();
    expect(m.get(page.id)!.state).toBe("needs-browser");
    expect(m.get(page.id)!.reason).toMatch(/HTML/);
    expect(m.get(forbidden.id)!.state).toBe("needs-browser");
    expect(m.get(missing.id)!.state).toBe("failed");
    expect(m.get(missing.id)!.error).toMatch(/404/);
    expect(m.get(badHash.id)!.state).toBe("failed");
    expect(m.get(badHash.id)!.error).toMatch(/SHA1 mismatch/);
    expect(await readdir(dir)).toEqual([]);
    const nb = events.filter((e) => e.type === "download-needs-browser");
    expect(nb).toHaveLength(2);
    expect(events.filter((e) => e.type === "download-failed")).toHaveLength(2);
    // retry re-queues
    expect(m.retry(missing.id)).toBe(true);
    await m.waitForIdle();
    expect(m.get(missing.id)!.state).toBe("failed");
  });

  it("handles Nexus, nxm://, DeadlyStream and mega without touching the network", async () => {
    const dir = await tmp();
    const opened: string[] = [];
    const apiCalls: Array<{ url: string; apikey?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.nexusmods.com/")) {
        const h = new Headers(init?.headers);
        apiCalls.push({ url, apikey: h.get("apikey") ?? undefined });
        return new Response(JSON.stringify([{ name: "CDN", short_name: "cdn", URI: `${base}/cd?h=${encodeURIComponent('attachment; filename="nexus.7z"')}` }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(input, init);
    };
    const m = new DownloadManager({ modDirectory: dir, nexusApiKey: "KEY", fetchImpl, openExternal: (u) => void opened.push(u) });
    const events = collect(m);
    const nexus = m.enqueue("g", "https://www.nexusmods.com/kotor/mods/1234?tab=files&file_id=5678");
    const noFile = m.enqueue("g", "https://www.nexusmods.com/kotor/mods/1234");
    const nxm = m.enqueue("g", "nxm://kotor/mods/1234/files/5678?key=k&expires=1");
    const ds = m.enqueue("g", "https://deadlystream.com/files/file/1313-kotor-1-community-patch/");
    const mega = m.enqueue("g", "https://mega.nz/file/abc#def");
    m.start();
    await m.waitForIdle();
    expect(apiCalls).toEqual([{ url: nexusDownloadLinkUrl("kotor", 1234, 5678), apikey: "KEY" }]);
    expect(m.get(nexus.id)!.state).toBe("done");
    expect(m.get(nexus.id)!.fileName).toBe("nexus.7z");
    expect(m.get(nexus.id)!.sha1).toBe(FILE_SHA1);
    expect(m.get(noFile.id)!.state).toBe("needs-browser");
    expect(m.get(nxm.id)!.state).toBe("needs-browser");
    expect(opened).toEqual(["nxm://kotor/mods/1234/files/5678?key=k&expires=1"]);
    expect(m.get(ds.id)!.state).toBe("needs-browser");
    expect(m.get(ds.id)!.reason).toMatch(/logged-in/);
    expect(m.get(mega.id)!.state).toBe("needs-browser");
    expect(events.filter((e) => e.type === "download-needs-browser").map((e) => e.type === "download-needs-browser" && e.url)).toEqual([
      noFile.url,
      nxm.url,
      ds.url,
      mega.url,
    ]);

    // without an api key Nexus needs the browser; without openExternal nxm fails
    const m2 = new DownloadManager({ modDirectory: dir, fetchImpl });
    const n2 = m2.enqueue("g", "https://www.nexusmods.com/kotor/mods/1234?tab=files&file_id=5678");
    const x2 = m2.enqueue("g", "nxm://kotor/mods/1/files/2");
    m2.start();
    await m2.waitForIdle();
    expect(m2.get(n2.id)!.state).toBe("needs-browser");
    expect(m2.get(x2.id)!.state).toBe("failed");
    expect(apiCalls).toHaveLength(1);
  });

  it("limits concurrency", async () => {
    const dir = await tmp();
    holdCount = 0;
    maxHold = 0;
    const m = new DownloadManager({ modDirectory: dir, maxConcurrentDownloads: 2 });
    const ids = [1, 2, 3, 4, 5].map((i) => m.enqueue("g", `${base}/hold.zip`, { fileName: `h${i}.zip` }).id);
    m.start();
    // wait until two requests are being held
    while (holdRelease.length < 2) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 30));
    expect(holdRelease.length).toBe(2);
    expect(m.list().filter((i) => i.state === "downloading")).toHaveLength(2);
    expect(m.list().filter((i) => i.state === "queued")).toHaveLength(3);
    while (m.list().some((i) => i.state !== "done")) {
      if (holdRelease.length) holdRelease.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    await m.waitForIdle();
    expect(maxHold).toBe(2);
    expect(ids.map((id) => m.get(id)!.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect((await readdir(dir)).sort()).toEqual(["h1.zip", "h2.zip", "h3.zip", "h4.zip", "h5.zip"]);
  });
});
