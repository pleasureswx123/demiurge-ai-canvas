import path from 'node:path';
import { IMG_EXT, VIDEO_EXT } from '../config/storage.js';
import { safeRequestPathname } from '../utils/http.js';

function encodeAssetRelativeUrlPath(relPath) {
  return String(relPath || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export function buildProjectThumbUrl(slug, relPath, version) {
  const encodedSlug = encodeURIComponent(slug);
  const encodedRel = encodeAssetRelativeUrlPath(relPath);
  const suffix = Number.isFinite(version) ? `?v=${Math.trunc(version)}` : '';
  return `/api/node/project/thumb/${encodedSlug}/${encodedRel}${suffix}`;
}

export function buildProjectMediaUrl(slug, relPath, version) {
  const encodedSlug = encodeURIComponent(slug);
  const encodedRel = encodeAssetRelativeUrlPath(relPath);
  const suffix = Number.isFinite(version) ? `?v=${Math.trunc(version)}` : '';
  return `/api/node/project/media/${encodedSlug}/${encodedRel}${suffix}`;
}

export function normalizeAssetRelativePath(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

export function inferMediaKindFromPath(relPath, fallbackKind = 'image') {
  const ext = path.extname(String(relPath || '')).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMG_EXT.has(ext)) return 'image';
  return fallbackKind;
}

export function rewriteLegacyAssetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  const pathname = safeRequestPathname(value);
  let nextPath = null;
  if (pathname.startsWith('/api/node/') || pathname.startsWith('/api/media/')) {
    return value;
  }
  if (pathname.startsWith('/api/project/')) {
    nextPath = `/api/node${pathname.slice('/api'.length)}`;
  } else if (pathname.startsWith('/api/material-library/')) {
    nextPath = `/api/node${pathname.slice('/api'.length)}`;
  } else if (pathname.startsWith('/api/video-file/')) {
    nextPath = `/api/media${pathname.slice('/api'.length)}`;
  }
  if (!nextPath) return value;
  try {
    const parsed = new URL(value, 'http://127.0.0.1');
    return `${nextPath}${parsed.search}${parsed.hash}`;
  } catch {
    return nextPath;
  }
}

export function normalizeStoredAssetUrls(value) {
  if (typeof value === 'string') return rewriteLegacyAssetUrl(value);
  if (Array.isArray(value)) return value.map((item) => normalizeStoredAssetUrls(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeStoredAssetUrls(item)])
  );
}

export function resolveProjectAssetRefFromNodeSrc(_slug, src, fallbackKind) {
  const pathname = safeRequestPathname(src);
  const mediaPrefixes = ['/api/node/project/media/', '/api/project/media/'];
  for (const mediaPrefix of mediaPrefixes) {
    if (!pathname.startsWith(mediaPrefix)) continue;
    const rest = pathname.slice(mediaPrefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const relPath = normalizeAssetRelativePath(rest.slice(slash + 1));
    return {
      relPath,
      kind: inferMediaKindFromPath(relPath, fallbackKind),
    };
  }
  const videoPrefixes = ['/api/media/video-file/', '/api/video-file/'];
  for (const videoPrefix of videoPrefixes) {
    if (!pathname.startsWith(videoPrefix)) continue;
    const rest = pathname.slice(videoPrefix.length);
    if (!rest) return null;
    const slash = rest.indexOf('/');
    const relPath = normalizeAssetRelativePath(slash > 0 ? rest.slice(slash + 1) : rest);
    return {
      relPath,
      kind: inferMediaKindFromPath(relPath, 'video'),
    };
  }
  return null;
}
