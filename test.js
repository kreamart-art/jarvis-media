// node test.js: the media drop against itself, on a temp folder and a free port.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = 'k'.repeat(40);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(3000, 3)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
let fails = 0;
const ok = (n, c, x = '') => (c || fails++, console.log(c ? 'PASS' : 'FAIL', n, c ? '' : x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(env) {
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const port = 39000 + Math.floor(Math.random() * 2000);
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  return { base: `http://127.0.0.1:${port}`, stop: () => (p.kill(), rmSync(dir, { recursive: true, force: true })) };
}
const put = (base, body, key = KEY) => fetch(`${base}/u`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body });

const a = await start({ MEDIA_KEY: KEY, MAX_MB: '1' });
ok('no key, no upload', (await put(a.base, JPEG, 'x'.repeat(40))).status === 401 && (await fetch(`${a.base}/u`, { method: 'POST', body: JPEG })).status === 401);
let r = await put(a.base, JPEG);
const j = await r.json();
ok('a JPEG goes up', r.status === 201 && /\/m\/[A-Za-z0-9_-]{32}\.jpg$/.test(j.url) && j.bytes === JPEG.length && j.type === 'image/jpeg', JSON.stringify(j));
const path = new URL(j.url).pathname;
r = await fetch(a.base + path);
ok('and comes back as it was', r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && Buffer.from(await r.arrayBuffer()).equals(JPEG) && r.headers.get('x-robots-tag')?.includes('noindex'));
r = await fetch(a.base + path, { headers: { range: 'bytes=0-3' } });
ok('a range', r.status === 206 && (await r.arrayBuffer()).byteLength === 4 && r.headers.get('content-range') === `bytes 0-3/${JPEG.length}`);
r = await put(a.base, MP4);
const v = await r.json();
ok('an MP4 goes up', r.status === 201 && v.url.endsWith('.mp4') && v.type === 'video/mp4');
ok('a PNG is refused', (await put(a.base, PNG)).status === 415);
ok('too large is refused', (await put(a.base, Buffer.concat([JPEG, Buffer.alloc(1.2 * 1024 * 1024)]))).status === 413);
ok('nothing to guess or list', (await fetch(`${a.base}/m/`)).status === 404 && (await fetch(`${a.base}/m/../server.js`)).status === 404 && (await fetch(`${a.base}/m/${'a'.repeat(32)}.jpg`)).status === 404);
ok('delete needs the key', (await fetch(`${a.base}/u/${j.id}`, { method: 'DELETE' })).status === 401);
ok('deleted', (await fetch(`${a.base}/u/${j.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${KEY}` } })).status === 204 && (await fetch(a.base + path)).status === 404);
a.stop();

const b = await start({});
ok('no MEDIA_KEY on the server: closed', (await put(b.base, JPEG, '')).status === 503 && (await put(b.base, JPEG)).status === 503);
b.stop();

const c = await start({ MEDIA_KEY: KEY, MAX_AGE_H: '0.0002' });
const x = await (await put(c.base, JPEG)).json();
await sleep(1200);
ok('expired after its time', (await fetch(x.url.replace(/^https?:\/\/[^/]+/, c.base))).status === 404);
c.stop();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
