import { createReadStream } from 'node:fs';

export function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function mediaMimeForExtension(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  return 'application/octet-stream';
}

export function sendMediaFile(req, res, abs, ext, headers = {}) {
  res.writeHead(200, {
    'Content-Type': mediaMimeForExtension(ext),
    'Cache-Control': 'public, max-age=3600',
    ...headers,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(abs).pipe(res);
}

export function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(String(s ?? ''));
  } catch {
    return null;
  }
}

export function safeRequestPathname(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '/'), 'http://127.0.0.1');
    let p = u.pathname || '/';
    p = p.replace(/\/{2,}/g, '/');
    if (!p.startsWith('/')) p = `/${p}`;
    p = p.replace(/\/+$/, '') || '/';
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  } catch {
    return '/';
  }
}

export async function readBodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}
