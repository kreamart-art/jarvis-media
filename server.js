// JARVIS media drop: Instagram fetches the photo or video of a post from a public link, so JARVIS puts the
// file here for the few minutes that takes. Only JARVIS can put something here (MEDIA_KEY); every file gets
// a link nobody can guess, is wiped by JARVIS once the post is out, and in any case after MAX_AGE_H hours.
// Nothing is listed, nothing is indexed. Zero dependencies.
//
//   POST   /u            (Authorization: Bearer MEDIA_KEY, body = the file)  -> 201 { id, url, bytes, type }
//   DELETE /u/<id>       (Authorization: Bearer MEDIA_KEY)                    -> 204
//   GET    /m/<id>.<ext> (public, Range for video)                            -> the file
//   GET    /health                                                            -> ok
//
// Env: MEDIA_KEY (required: without it nothing can be put here), PORT (3000), DATA_DIR (/tmp/jarvis-media),
// MAX_MB (500 per file), MAX_TOTAL_MB (3000 for all), MAX_AGE_H (24), PUBLIC_URL (else from the request).
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const PORT = Number(process.env.PORT) || 3000;
const DIR = process.env.DATA_DIR || '/tmp/jarvis-media';
const KEY = process.env.MEDIA_KEY || '';
const MAX = (Number(process.env.MAX_MB) || 500) * 1024 * 1024;
const MAX_TOTAL = (Number(process.env.MAX_TOTAL_MB) || 3000) * 1024 * 1024;
const MAX_AGE = (Number(process.env.MAX_AGE_H) || 24) * 3600_000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ID = /^[A-Za-z0-9_-]{32}$/;
const TYPES = { jpg: 'image/jpeg', mp4: 'video/mp4', mov: 'video/quicktime' };
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

await mkdir(DIR, { recursive: true });

/** the key, compared without telling how much of it was right */
const keyHash = createHash('sha256').update(KEY).digest();
function authorized(req) {
  if (KEY.length < 32) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  return timingSafeEqual(createHash('sha256').update(m[1]).digest(), keyHash);
}

/** what a file is, by its first bytes: a JPEG, or an MP4 / MOV (ISO media with an ftyp box) */
function kindOf(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') return head.toString('latin1', 8, 10) === 'qt' ? 'mov' : 'mp4';
  return null;
}

async function used() {
  let total = 0;
  for (const n of await readdir(DIR)) total += (await stat(join(DIR, n)).catch(() => ({ size: 0 }))).size;
  return total;
}

/** files older than MAX_AGE go, and half-written ones after an hour */
async function sweep() {
  const now = Date.now();
  for (const n of await readdir(DIR).catch(() => [])) {
    const p = join(DIR, n);
    const s = await stat(p).catch(() => null);
    if (!s) continue;
    if (now - s.mtimeMs > MAX_AGE || (n.endsWith('.part') && now - s.mtimeMs > 3600_000)) await rm(p, { force: true });
  }
}
setInterval(() => void sweep(), 10 * 60_000).unref();
void sweep();

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

async function upload(req, res) {
  if (!authorized(req)) return send(res, KEY.length < 32 ? 503 : 401, { error: KEY.length < 32 ? 'MEDIA_KEY is not set on the server.' : 'Wrong key.' });
  const declared = Number(req.headers['content-length']);
  if (declared > MAX) return send(res, 413, { error: `Larger than ${MAX / 1048576} MB.` });
  if ((await used()) + (declared || 0) > MAX_TOTAL) return send(res, 507, { error: 'The media drop is full; try again in a while.' });
  const id = randomBytes(24).toString('base64url');
  const part = join(DIR, `${id}.part`);
  let bytes = 0;
  let head = Buffer.alloc(0);
  const count = new Transform({
    transform(chunk, _enc, done) {
      bytes += chunk.length;
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
      done(bytes > MAX ? new Error('too large') : null, chunk);
    },
  });
  try {
    await pipeline(req, count, createWriteStream(part, { mode: 0o600 }));
  } catch {
    await rm(part, { force: true });
    return send(res, bytes > MAX ? 413 : 400, { error: bytes > MAX ? `Larger than ${MAX / 1048576} MB.` : 'The upload broke off.' });
  }
  const ext = kindOf(head);
  if (!ext || !bytes) {
    await rm(part, { force: true });
    return send(res, 415, { error: 'Only JPEG photos and MP4 or MOV videos.' });
  }
  await rename(part, join(DIR, `${id}.${ext}`));
  const origin = PUBLIC_URL || `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
  return send(res, 201, { id, url: `${origin}/m/${id}.${ext}`, bytes, type: TYPES[ext] });
}

async function remove(req, res, id) {
  if (!authorized(req)) return send(res, 401, { error: 'Wrong key.' });
  if (!ID.test(id)) return send(res, 404, { error: 'Not here.' });
  for (const ext of Object.keys(TYPES)) await rm(join(DIR, `${id}.${ext}`), { force: true });
  return send(res, 204);
}

async function serve(req, res, id, ext) {
  const p = join(DIR, `${id}.${ext}`);
  const s = await stat(p).catch(() => null);
  if (!s || Date.now() - s.mtimeMs > MAX_AGE) return send(res, 404, { error: 'Not here.' });
  const headers = { ...BASE_HEADERS, 'Content-Type': TYPES[ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=600', 'Content-Disposition': 'inline' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : s.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : s.size - 1;
    start = Math.max(0, start);
    end = Math.min(s.size - 1, end);
    if (start > end) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${s.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${s.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return void pipeline(createReadStream(p, { start, end }), res).catch(() => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': s.size });
  if (req.method === 'HEAD') return res.end();
  return void pipeline(createReadStream(p), res).catch(() => {});
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/m\/([A-Za-z0-9_-]{32})\.(jpg|mp4|mov)$/.exec(url.pathname);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) return await serve(req, res, m[1], m[2]);
    if (url.pathname === '/u' && req.method === 'POST') return await upload(req, res);
    const d = /^\/u\/([^/]+)$/.exec(url.pathname);
    if (d && req.method === 'DELETE') return await remove(req, res, d[1]);
    if (url.pathname === '/health') {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /\n');
    }
    return send(res, 404, { error: 'Not here.' });
  } catch (e) {
    console.error('[media]', e);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
    else res.destroy();
  }
}).listen(PORT, () => console.log(`[media] on :${PORT}, ${KEY.length >= 32 ? 'key set' : 'NO KEY: uploads are closed'}`));
