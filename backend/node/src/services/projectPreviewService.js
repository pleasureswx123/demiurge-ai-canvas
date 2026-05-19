import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { IMG_EXT, PREVIEW_TILE_LIMIT, VIDEO_EXT, resolveFfmpegBinary } from '../config/storage.js';
import { resolveAssetMediaPath } from '../repositories/projectAssetRepository.js';
import { buildProjectMediaUrl, buildProjectThumbUrl, resolveProjectAssetRefFromNodeSrc } from './assetUrlService.js';

function isLikelyAiGeneratedAssetPath(relPath, kind) {
  const base = path.basename(String(relPath || '')).toLowerCase();
  if (!base) return false;
  if (kind === 'video') {
    return (
      /^video_\d{8}[_-]\d{6}/.test(base) ||
      base.includes('grok-video') ||
      /(^|[_-])video_\d{10,}/.test(base)
    );
  }
  return (
    /^img_\d{8}[_-]\d{6}/.test(base) ||
    /^vectorengine_\d{8}[_-]\d{6}/.test(base) ||
    /^gptimage2_\d{8}[_-]\d{6}/.test(base)
  );
}

export function sendPreviewPlaceholder(res, label = 'NO PREVIEW') {
  const text = String(label || 'NO PREVIEW').slice(0, 24).toUpperCase();
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="${text}">
  <rect width="640" height="360" fill="#262626"/>
  <rect x="1" y="1" width="638" height="358" rx="22" ry="22" fill="none" stroke="rgba(255,255,255,0.08)"/>
  <circle cx="320" cy="156" r="38" fill="rgba(255,255,255,0.08)"/>
  <polygon points="308,136 308,176 340,156" fill="rgba(255,255,255,0.55)"/>
  <text x="320" y="232" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-family="Arial, sans-serif" font-size="22">${text}</text>
</svg>`;
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(svg);
}

function parsePreviewTimeMs(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : null;
}

async function resolveNodePreviewTile(projectDir, slug, node) {
  const data = node?.data;
  if (!data || typeof data !== 'object') return null;
  const candidates = [
    { asset: data.imageAsset, kind: 'image' },
    { asset: data.capturedFrame, kind: 'image' },
    { asset: data.generatedVideo, kind: 'video' },
    { asset: data.capturedClip, kind: 'video' },
  ];
  let best = null;
  for (const candidate of candidates) {
    const src = typeof candidate.asset?.src === 'string' ? candidate.asset.src.trim() : '';
    if (!src || src.startsWith('blob:') || src.startsWith('data:')) continue;
    const ref = resolveProjectAssetRefFromNodeSrc(slug, src, candidate.kind);
    if (!ref?.relPath) continue;
    const abs = await resolveAssetMediaPath(projectDir, ref.relPath);
    if (!abs) continue;
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) continue;
    const tile = {
      name: ref.relPath,
      kind: ref.kind,
      mtimeMs: stat.mtimeMs,
      sortTimeMs: parsePreviewTimeMs(candidate.asset?.previewUpdatedAt) ?? stat.mtimeMs,
      nodeId: node?.id || null,
    };
    if (!best || tile.sortTimeMs > best.sortTimeMs) {
      best = tile;
    }
  }
  return best;
}

export async function listLatestNodePreviews(projectDir, slug, nodes, limit = PREVIEW_TILE_LIMIT) {
  if (!Array.isArray(nodes) || !nodes.length) return [];
  const items = [];
  for (const node of nodes) {
    const tile = await resolveNodePreviewTile(projectDir, slug, node);
    if (tile) items.push(tile);
  }
  items.sort((a, b) => b.sortTimeMs - a.sortTimeMs || b.mtimeMs - a.mtimeMs);
  return items.slice(0, limit);
}

export async function listGeneratedHistoryItems(projectDir, slug, projectData) {
  const nodes = Array.isArray(projectData?.flow?.nodes) ? projectData.flow.nodes : [];
  const projectName = String(projectData?.name || slug);
  const historyItems = [];
  const referencedAssets = new Set();

  for (const node of nodes) {
    const data = node?.data;
    if (!data || typeof data !== 'object') continue;

    let asset = null;
    let kind = null;

    if (node?.type === 'AIImageNode' && data.imageMode === 'generated') {
      asset = data.imageAsset || data.capturedFrame || null;
      kind = 'image';
    } else if (node?.type === 'AIVideoNode' && data.videoMode === 'generated') {
      asset = data.generatedVideo || null;
      kind = 'video';
    }

    const src = typeof asset?.src === 'string' ? asset.src.trim() : '';
    if (!asset || !kind || !src || src.startsWith('blob:') || src.startsWith('data:')) continue;

    const ref = resolveProjectAssetRefFromNodeSrc(slug, src, kind);
    if (!ref?.relPath) continue;
    referencedAssets.add(`${ref.kind}:${ref.relPath}`);

    const abs = await resolveAssetMediaPath(projectDir, ref.relPath);
    if (!abs) continue;

    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) continue;

    const sortTimeMs =
      parsePreviewTimeMs(asset?.previewUpdatedAt) ??
      parsePreviewTimeMs(projectData?.updatedAt) ??
      stat.mtimeMs;
    const date = new Date(sortTimeMs);
    const dateLabel = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '未知日期';

    historyItems.push({
      id: `${slug}:${node?.id || ref.relPath}`,
      nodeId: node?.id || null,
      projectSlug: slug,
      projectName,
      kind,
      name: String(asset?.name || ref.relPath),
      assetUrl: src,
      thumbUrl: buildProjectThumbUrl(slug, ref.relPath, stat.mtimeMs),
      createdAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
      dateLabel,
      sortTimeMs,
      width: Number.isFinite(asset?.width) ? asset.width : null,
      height: Number.isFinite(asset?.height) ? asset.height : null,
      duration: Number.isFinite(asset?.duration) ? asset.duration : null,
    });
  }

  historyItems.sort((a, b) => b.sortTimeMs - a.sortTimeMs);
  return historyItems;
}

export async function listAssetFilesAsHistoryItems(projectDir, slug, projectName, referencedAssets = new Set()) {
  const assetsRoot = path.join(projectDir, 'assets');
  const historyItems = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (!ent.name || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }

      const ext = path.extname(ent.name).toLowerCase();
      if (!IMG_EXT.has(ext) && !VIDEO_EXT.has(ext)) continue;

      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const relPath = path.relative(assetsRoot, full).split(path.sep).join('/');
      const kind = VIDEO_EXT.has(ext) ? 'video' : 'image';
      if (referencedAssets.has(`${kind}:${relPath}`)) continue;
      if (!isLikelyAiGeneratedAssetPath(relPath, kind)) continue;

      const date = new Date(stat.mtimeMs);
      const dateLabel = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '未知日期';
      historyItems.push({
        id: `${slug}:asset:${relPath}`,
        nodeId: null,
        projectSlug: slug,
        projectName,
        kind,
        name: path.basename(relPath),
        assetUrl: buildProjectMediaUrl(slug, relPath, stat.mtimeMs),
        thumbUrl: buildProjectThumbUrl(slug, relPath, stat.mtimeMs),
        createdAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
        dateLabel,
        sortTimeMs: stat.mtimeMs,
        width: null,
        height: null,
        duration: null,
        source: 'asset',
      });
    }
  }

  try {
    await fs.access(assetsRoot);
  } catch {
    return historyItems;
  }
  await walk(assetsRoot);
  return historyItems;
}

export async function listLatestMediaForPreview(projectDir, limit = PREVIEW_TILE_LIMIT) {
  const assetsRoot = path.join(projectDir, 'assets');
  const items = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.name || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (!IMG_EXT.has(ext) && !VIDEO_EXT.has(ext)) continue;
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const rel = path.relative(assetsRoot, full);
      const relPosix = rel.split(path.sep).join('/');
      items.push({
        name: relPosix,
        mtimeMs: st.mtimeMs,
        kind: VIDEO_EXT.has(ext) ? 'video' : 'image',
      });
    }
  }

  try {
    await fs.access(assetsRoot);
  } catch {
    return [];
  }
  await walk(assetsRoot);
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items.slice(0, limit);
}

export async function ensureVideoPoster(videoAbsPath, projectDir) {
  const thumbsDir = path.join(projectDir, 'assets', '.thumbs');
  await fs.mkdir(thumbsDir, { recursive: true });
  const base = path.basename(videoAbsPath);
  const relKey = path.relative(path.join(projectDir, 'assets'), videoAbsPath).split(path.sep).join('/');
  const hash = createHash('sha1').update(relKey).digest('hex').slice(0, 12);
  const safeKey = `${base.replace(/[^a-zA-Z0-9._-]/g, '_')}_${hash}`;
  const posterPath = path.join(thumbsDir, `${safeKey}.jpg`);
  let need;
  try {
    const [videoStat, posterStat] = await Promise.all([fs.stat(videoAbsPath), fs.stat(posterPath)]);
    need = videoStat.mtimeMs > posterStat.mtimeMs;
  } catch {
    need = true;
  }
  if (!need) return posterPath;
  const result = spawnSync(
    resolveFfmpegBinary(),
    ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0', '-i', videoAbsPath, '-frames:v', '1', '-q:v', '4', posterPath],
    { encoding: 'utf8', timeout: 120_000, windowsHide: true }
  );
  if (result.status !== 0 || result.error) {
    console.error('[projects-api] ffmpeg poster failed:', result.stderr || result.error?.message);
    return null;
  }
  try {
    await fs.access(posterPath);
    return posterPath;
  } catch {
    return null;
  }
}
