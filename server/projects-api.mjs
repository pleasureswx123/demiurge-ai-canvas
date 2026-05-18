/**
 * 本地「工程 / 项目」文件系统 API（运行在 Node，与 deepseek-proxy 同端口 8787）。
 *
 * 目录约定（相对仓库根目录）:
 *   projects/
 *     <slug>/
 *       project_data.json   ← 画布序列化存档
 *       assets/             ← 该工程专属生成素材（由 Python 服务写入）
 *
 * 添加位置：由 server/deepseek-proxy.js 在收到 /api/project* 时转发到本模块。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECTS_ROOT = path.resolve(__dirname, '..', 'projects');
export const MATERIAL_LIBRARY_ROOT = path.resolve(__dirname, '..', 'material-library');
const BUNDLED_FFMPEG_PATH = path.resolve(
  __dirname,
  '..',
  'tools',
  'ffmpeg-dist',
  'ffmpeg-8.1-essentials_build',
  'bin',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
);

const SAFE_SLUG_RE = /^[a-zA-Z0-9_-]{1,120}$/;
const SAFE_LIBRARY_FILE_RE = /^[a-zA-Z0-9._-]{1,180}$/;
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const PREVIEW_TILE_LIMIT = 4;
const MATERIAL_LIBRARY_CATEGORIES = new Set(['人物', '场景', '物品', '风格', '音效', '其他']);
const MATERIAL_LIBRARY_INDEX_FILE = 'library_data.json';
const SEEDANCE_SUBJECTS_INDEX_FILE = 'seedance_subjects.json';
const SEEDANCE_SUBJECT_STATUSES = new Set(['approved', 'pending', 'rejected']);

export function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function mediaMimeForExtension(ext) {
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

function encodeAssetRelativeUrlPath(relPath) {
  return String(relPath || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function buildProjectThumbUrl(slug, relPath, version) {
  const encodedSlug = encodeURIComponent(slug);
  const encodedRel = encodeAssetRelativeUrlPath(relPath);
  const suffix = Number.isFinite(version) ? `?v=${Math.trunc(version)}` : '';
  return `/api/project/thumb/${encodedSlug}/${encodedRel}${suffix}`;
}

function buildProjectMediaUrl(slug, relPath, version) {
  const encodedSlug = encodeURIComponent(slug);
  const encodedRel = encodeAssetRelativeUrlPath(relPath);
  const suffix = Number.isFinite(version) ? `?v=${Math.trunc(version)}` : '';
  return `/api/project/media/${encodedSlug}/${encodedRel}${suffix}`;
}

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

function sendPreviewPlaceholder(res, label = 'NO PREVIEW') {
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

function resolveFfmpegBinary() {
  const configured = String(process.env.FFMPEG_PATH || '').trim();
  if (configured) return configured;
  if (existsSync(BUNDLED_FFMPEG_PATH)) return BUNDLED_FFMPEG_PATH;
  return 'ffmpeg';
}

function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(String(s ?? ''));
  } catch {
    return null;
  }
}

function sanitizeSlug(raw) {
  const s = String(raw ?? '').trim();
  if (!SAFE_SLUG_RE.test(s)) return null;
  const resolved = path.resolve(PROJECTS_ROOT, s);
  const rel = path.relative(PROJECTS_ROOT, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return s;
}

async function ensureProjectsRoot() {
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
}

async function ensureMaterialLibraryRoot() {
  await fs.mkdir(path.join(MATERIAL_LIBRARY_ROOT, 'assets'), { recursive: true });
}

function sanitizeLibraryCategory(rawCategory) {
  const category = String(rawCategory || '').trim();
  return MATERIAL_LIBRARY_CATEGORIES.has(category) ? category : null;
}

function sanitizeLibraryFilename(rawName) {
  const fileName = path.basename(String(rawName || '').trim());
  if (!SAFE_LIBRARY_FILE_RE.test(fileName)) return null;
  return fileName;
}

function normalizeSeedanceFaceReview(rawReview) {
  if (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview)) return null;
  const status = String(rawReview.status || '').trim().toLowerCase();
  if (!status) return null;
  return {
    status,
    assetId: String(rawReview.assetId || rawReview.asset_id || '').trim(),
    assetRef: String(rawReview.assetRef || rawReview.asset_ref || '').trim(),
    assetStatus: String(rawReview.assetStatus || rawReview.asset_status || '').trim(),
    message: String(rawReview.message || '').trim(),
    updatedAt: String(rawReview.updatedAt || rawReview.updated_at || '').trim(),
  };
}

function buildMaterialLibraryAssetUrl(fileName) {
  return `/api/material-library/media/${encodeURIComponent(fileName)}`;
}

async function readMaterialLibraryIndex() {
  const indexPath = path.join(MATERIAL_LIBRARY_ROOT, MATERIAL_LIBRARY_INDEX_FILE);
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function writeMaterialLibraryIndex(items) {
  const indexPath = path.join(MATERIAL_LIBRARY_ROOT, MATERIAL_LIBRARY_INDEX_FILE);
  await fs.writeFile(
    indexPath,
    JSON.stringify({ version: 1, items, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

async function readSeedanceSubjectsIndex() {
  const indexPath = path.join(MATERIAL_LIBRARY_ROOT, SEEDANCE_SUBJECTS_INDEX_FILE);
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function writeSeedanceSubjectsIndex(items) {
  const indexPath = path.join(MATERIAL_LIBRARY_ROOT, SEEDANCE_SUBJECTS_INDEX_FILE);
  await fs.writeFile(
    indexPath,
    JSON.stringify({ version: 1, items, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

function sanitizeSeedanceSubjectStatus(rawStatus) {
  const status = String(rawStatus || '').trim().toLowerCase();
  return SEEDANCE_SUBJECT_STATUSES.has(status) ? status : 'pending';
}

function buildMaterialLibraryResolvableUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  if (/^(https?:|data:)/i.test(value)) return value;
  const fileName = sanitizeLibraryFilename(value);
  return fileName ? buildMaterialLibraryAssetUrl(fileName) : '';
}

function normalizeSeedanceSubjectItem(item, index = 0) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || item.subjectId || `seedance_subject_${index + 1}`).trim();
  const name = String(item.name || item.subjectName || id).trim();
  if (!id || !name) return null;

  const requestFields =
    item.requestFields && typeof item.requestFields === 'object' && !Array.isArray(item.requestFields)
      ? item.requestFields
      : {};

  return {
    id,
    name,
    subjectId: String(item.subjectId || '').trim(),
    status: sanitizeSeedanceSubjectStatus(item.status),
    summary: String(item.summary || item.description || '').trim(),
    prompt: String(item.prompt || item.promptPrefix || '').trim(),
    coverUrl: buildMaterialLibraryResolvableUrl(item.coverPath || item.coverUrl),
    referenceImageUrl: buildMaterialLibraryResolvableUrl(
      item.referenceImagePath || item.referenceImageUrl || item.coverPath || item.coverUrl
    ),
    requestFields,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

function resolveAssetPathCandidate(projectDir, relDecoded) {
  const assetsDir = path.resolve(path.join(projectDir, 'assets'));
  const raw = String(relDecoded ?? '').trim();
  if (!raw) return null;
  const normalized = path.normalize(raw.replace(/\//g, path.sep)).replace(/^[/\\]+/, '');
  const segments = normalized.split(path.sep).filter(Boolean);
  if (segments.some((seg) => seg === '..')) return null;
  const abs = path.resolve(assetsDir, ...segments);
  const rp = path.relative(assetsDir, abs);
  if (!rp || rp.startsWith('..') || path.isAbsolute(rp)) return null;
  return { assetsDir, abs, relativePath: rp.split(path.sep).join('/') };
}

/** 解析 Node 收到的 req.url（可能仅 path、也可能含 query），统一成稳定 pathname */
function safeRequestPathname(rawUrl) {
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

/** 磁盘文件夹名：仅 ASCII，避免 Windows / 终端兼容问题；中文名只存在 project_data.json 的 name 字段 */
export function slugifyDisplayName() {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `proj_${Date.now().toString(36)}_${rnd}`;
}

const DEFAULT_FLOW = () => ({
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 0.85 },
});

export async function handleProjectApi(req, res) {
  const pathname = safeRequestPathname(req.url);

  // CORS（本地 Vite 同源开发一般不需要；保留以防直连端口）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  try {
    await ensureProjectsRoot();
    await ensureMaterialLibraryRoot();

    const url = new URL(String(req.url || '/'), 'http://127.0.0.1');
    // ── GET /api/project/history ────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/project/history') {
      const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true }).catch(() => []);
      const items = [];
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const slug = ent.name;
        if (!sanitizeSlug(slug)) continue;
        const dir = path.join(PROJECTS_ROOT, slug);
        const jsonPath = path.join(dir, 'project_data.json');
        let projectData = null;
        try {
          const raw = await fs.readFile(jsonPath, 'utf8');
          projectData = JSON.parse(raw);
        } catch {
          continue;
        }
        const projectItems = await listGeneratedHistoryItems(dir, slug, projectData);
        items.push(...projectItems);
      }

      items.sort((a, b) => b.sortTimeMs - a.sortTimeMs || String(b.id).localeCompare(String(a.id)));
      sendJson(res, 200, {
        ok: true,
        items,
        counts: {
          image: items.filter((item) => item.kind === 'image').length,
          video: items.filter((item) => item.kind === 'video').length,
        },
      });
      return true;
    }

    // ── GET /api/material-library/list ──────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/material-library/list') {
      const items = await readMaterialLibraryIndex();
      const normalizedItems = items
        .map((item) => {
          const assetPath = sanitizeLibraryFilename(item?.assetPath);
          const coverPath = sanitizeLibraryFilename(item?.coverPath || item?.assetPath);
          if (!assetPath || !coverPath) return null;
          return {
            id: item.id || `material_${assetPath}`,
            name: item.name || assetPath,
            category: sanitizeLibraryCategory(item.category) || '其他',
            kind: item.kind === 'video' ? 'video' : 'image',
            assetPath,
            coverPath,
            assetUrl: buildMaterialLibraryAssetUrl(assetPath),
            coverUrl: buildMaterialLibraryAssetUrl(coverPath),
            width: Number.isFinite(item.width) ? item.width : null,
            height: Number.isFinite(item.height) ? item.height : null,
            duration: Number.isFinite(item.duration) ? item.duration : null,
            seedanceFaceReview: normalizeSeedanceFaceReview(item.seedanceFaceReview),
            createdAt: item.createdAt || null,
          };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      sendJson(res, 200, { ok: true, items: normalizedItems });
      return true;
    }

    // ── GET /api/material-library/subjects ──────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/material-library/subjects') {
      const items = (await readSeedanceSubjectsIndex())
        .map((item, index) => normalizeSeedanceSubjectItem(item, index))
        .filter(Boolean)
        .sort((a, b) => {
          if (a.status === 'approved' && b.status !== 'approved') return -1;
          if (a.status !== 'approved' && b.status === 'approved') return 1;
          return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
        });
      sendJson(res, 200, { ok: true, items });
      return true;
    }

    // ── POST /api/material-library/subject ──────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/material-library/subject') {
      const body = await readBodyJson(req);
      const name = String(body.name || '').trim();
      const assetPath = sanitizeLibraryFilename(body.assetPath);
      const coverPath = sanitizeLibraryFilename(body.coverPath || body.assetPath);
      const referenceImagePath = sanitizeLibraryFilename(
        body.referenceImagePath || body.coverPath || body.assetPath
      );
      if (!name) {
        sendJson(res, 400, { error: '主体名称不能为空' });
        return true;
      }
      if (!assetPath || !coverPath || !referenceImagePath) {
        sendJson(res, 400, { error: '主体素材路径无效' });
        return true;
      }

      const items = await readSeedanceSubjectsIndex();
      const now = new Date().toISOString();
      const subjectId = String(body.subjectId || '').trim();
      const item = {
        id: `subject_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        subjectId,
        status: subjectId ? 'approved' : sanitizeSeedanceSubjectStatus(body.status),
        summary: String(body.summary || '').trim(),
        prompt: String(body.prompt || '').trim(),
        assetPath,
        coverPath,
        referenceImagePath,
        requestFields:
          body.requestFields && typeof body.requestFields === 'object' && !Array.isArray(body.requestFields)
            ? body.requestFields
            : {},
        createdAt: now,
        updatedAt: now,
      };
      items.unshift(item);
      await writeSeedanceSubjectsIndex(items);
      sendJson(res, 200, { ok: true, item: normalizeSeedanceSubjectItem(item, 0) });
      return true;
    }

    // ── PATCH /api/material-library/subject/:id ─────────────────────────────
    if (req.method === 'PATCH' && pathname.startsWith('/api/material-library/subject/')) {
      const itemId = String(
        safeDecodeURIComponent(pathname.slice('/api/material-library/subject/'.length)) || ''
      ).trim();
      if (!itemId) {
        sendJson(res, 400, { error: '主体 ID 无效' });
        return true;
      }
      const body = await readBodyJson(req);
      const items = await readSeedanceSubjectsIndex();
      const index = items.findIndex((item) => String(item?.id || '').trim() === itemId);
      if (index < 0) {
        sendJson(res, 404, { error: '主体不存在' });
        return true;
      }
      const current = items[index];
      const nextSubjectId = body.subjectId == null ? String(current.subjectId || '').trim() : String(body.subjectId || '').trim();
      const nextStatus =
        body.status == null
          ? (nextSubjectId ? 'approved' : sanitizeSeedanceSubjectStatus(current.status))
          : sanitizeSeedanceSubjectStatus(body.status);
      const updated = {
        ...current,
        name: body.name == null ? current.name : String(body.name || '').trim() || current.name,
        subjectId: nextSubjectId,
        status: nextSubjectId ? 'approved' : nextStatus,
        summary: body.summary == null ? current.summary : String(body.summary || '').trim(),
        prompt: body.prompt == null ? current.prompt : String(body.prompt || '').trim(),
        requestFields:
          body.requestFields && typeof body.requestFields === 'object' && !Array.isArray(body.requestFields)
            ? body.requestFields
            : current.requestFields,
        updatedAt: new Date().toISOString(),
      };
      items[index] = updated;
      await writeSeedanceSubjectsIndex(items);
      sendJson(res, 200, { ok: true, item: normalizeSeedanceSubjectItem(updated, index) });
      return true;
    }

    // ── GET /api/material-library/media/:filename ───────────────────────────
    if (req.method === 'GET' && pathname.startsWith('/api/material-library/media/')) {
      const rawName = safeDecodeURIComponent(pathname.slice('/api/material-library/media/'.length));
      const fileName = sanitizeLibraryFilename(rawName);
      if (!fileName) {
        sendJson(res, 400, { error: '文件名无效' });
        return true;
      }
      const abs = path.join(MATERIAL_LIBRARY_ROOT, 'assets', fileName);
      const ext = path.extname(fileName).toLowerCase();
      await fs.access(abs).catch(() => {
        throw new Error('__material_library_not_found__');
      });
      res.writeHead(200, {
        'Content-Type': mediaMimeForExtension(ext),
        'Cache-Control': 'public, max-age=3600',
      });
      createReadStream(abs).pipe(res);
      return true;
    }

    // ── PUT /api/material-library/asset/:filename ───────────────────────────
    if (req.method === 'PUT' && pathname.startsWith('/api/material-library/asset/')) {
      const rawName = safeDecodeURIComponent(pathname.slice('/api/material-library/asset/'.length));
      const fileName = sanitizeLibraryFilename(rawName);
      if (!fileName) {
        sendJson(res, 400, { error: '文件名无效' });
        return true;
      }
      const abs = path.join(MATERIAL_LIBRARY_ROOT, 'assets', fileName);
      await pipeline(req, createWriteStream(abs));
      sendJson(res, 200, { ok: true, fileName, url: buildMaterialLibraryAssetUrl(fileName) });
      return true;
    }

    // ── POST /api/material-library/save ─────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/material-library/save') {
      const body = await readBodyJson(req);
      const name = String(body.name || '').trim();
      const category = sanitizeLibraryCategory(body.category);
      const assetPath = sanitizeLibraryFilename(body.assetPath);
      const coverPath = sanitizeLibraryFilename(body.coverPath || body.assetPath);
      const kind = body.kind === 'video' ? 'video' : 'image';
      if (!name) {
        sendJson(res, 400, { error: '名称不能为空' });
        return true;
      }
      if (!category) {
        sendJson(res, 400, { error: '分类无效' });
        return true;
      }
      if (!assetPath || !coverPath) {
        sendJson(res, 400, { error: '素材路径无效' });
        return true;
      }
      const items = await readMaterialLibraryIndex();
      const createdAt = new Date().toISOString();
      const item = {
        id: `material_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        category,
        kind,
        assetPath,
        coverPath,
        width: Number.isFinite(body.width) ? body.width : null,
        height: Number.isFinite(body.height) ? body.height : null,
        duration: Number.isFinite(body.duration) ? body.duration : null,
        seedanceFaceReview: normalizeSeedanceFaceReview(body.seedanceFaceReview),
        createdAt,
      };
      items.unshift(item);
      await writeMaterialLibraryIndex(items);
      sendJson(res, 200, {
        ok: true,
        item: {
          ...item,
          assetUrl: buildMaterialLibraryAssetUrl(assetPath),
          coverUrl: buildMaterialLibraryAssetUrl(coverPath),
        },
      });
      return true;
    }

    // ── DELETE /api/material-library/item/:id ──────────────────────────────
    if (req.method === 'DELETE' && pathname.startsWith('/api/material-library/item/')) {
      const itemId = String(
        safeDecodeURIComponent(pathname.slice('/api/material-library/item/'.length)) || ''
      ).trim();
      if (!itemId) {
        sendJson(res, 400, { error: '素材 ID 无效' });
        return true;
      }

      const items = await readMaterialLibraryIndex();
      const itemIndex = items.findIndex((item) => String(item?.id || '').trim() === itemId);
      if (itemIndex < 0) {
        sendJson(res, 404, { error: '素材不存在' });
        return true;
      }

      const target = items[itemIndex];
      const nextItems = items.filter((item, index) => index !== itemIndex);
      const referencedFiles = new Set();
      nextItems.forEach((item) => {
        const assetPath = sanitizeLibraryFilename(item?.assetPath);
        const coverPath = sanitizeLibraryFilename(item?.coverPath || item?.assetPath);
        if (assetPath) referencedFiles.add(assetPath);
        if (coverPath) referencedFiles.add(coverPath);
      });

      const filesToDelete = new Set();
      const targetAsset = sanitizeLibraryFilename(target?.assetPath);
      const targetCover = sanitizeLibraryFilename(target?.coverPath || target?.assetPath);
      if (targetAsset && !referencedFiles.has(targetAsset)) filesToDelete.add(targetAsset);
      if (targetCover && !referencedFiles.has(targetCover)) filesToDelete.add(targetCover);

      await Promise.all(
        [...filesToDelete].map((fileName) =>
          fs.rm(path.join(MATERIAL_LIBRARY_ROOT, 'assets', fileName), { force: true }).catch(() => {})
        )
      );
      await writeMaterialLibraryIndex(nextItems);
      sendJson(res, 200, { ok: true, deletedId: itemId });
      return true;
    }

    // ── GET /api/project/list ─────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/project/list') {
      const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true }).catch(() => []);
      const projects = [];
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const slug = ent.name;
        if (!sanitizeSlug(slug)) continue;
        const dir = path.join(PROJECTS_ROOT, slug);
        const jsonPath = path.join(dir, 'project_data.json');
        let name = slug;
        let updatedAt = null;
        let projectData = null;
        try {
          const raw = await fs.readFile(jsonPath, 'utf8');
          projectData = JSON.parse(raw);
          name = projectData.name || slug;
          updatedAt = projectData.updatedAt || null;
        } catch {
          /* empty */
        }
        const stat = await fs.stat(jsonPath).catch(() => null);
        const folderStat = await fs.stat(dir).catch(() => null);
        const mtime =
          updatedAt ||
          (stat ? stat.mtime.toISOString() : folderStat ? folderStat.mtime.toISOString() : new Date().toISOString());

        const nodePreviewTiles = await listLatestNodePreviews(
          dir,
          slug,
          projectData?.flow?.nodes,
          PREVIEW_TILE_LIMIT
        );
        const hasNodeState = Array.isArray(projectData?.flow?.nodes);
        const tiles = nodePreviewTiles.length
          ? nodePreviewTiles
          : hasNodeState
            ? []
            : await listLatestMediaForPreview(dir, PREVIEW_TILE_LIMIT);
        const coverTiles = tiles.map((t) => ({
          url: buildProjectThumbUrl(slug, t.name, t.mtimeMs),
          kind: t.kind,
        }));
        const coverRel = hasNodeState ? null : await findLatestImageAsset(dir);
        let coverUrl = null;
        if (tiles.length) {
          coverUrl = buildProjectThumbUrl(slug, tiles[0].name, tiles[0].mtimeMs);
        } else if (coverRel) {
          coverUrl = `/api/project/cover/${encodeURIComponent(slug)}`;
        }
        projects.push({
          slug,
          name,
          updatedAt: mtime,
          coverUrl,
          coverTiles,
        });
      }
      projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      sendJson(res, 200, { projects });
      return true;
    }

    // ── GET /api/project/media/:slug/<filename> 工程内原始素材直出 ───────────
    if (req.method === 'GET' && pathname.startsWith('/api/project/media/')) {
      const rest = pathname.slice('/api/project/media/'.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) {
        sendJson(res, 400, { error: '路径无效' });
        return true;
      }
      const slugRaw = safeDecodeURIComponent(rest.slice(0, slash));
      const slug = sanitizeSlug(slugRaw);
      const rawSeg = rest.slice(slash + 1);
      const relFromUrl = safeDecodeURIComponent(rawSeg);
      if (!slug || !relFromUrl) {
        sendJson(res, 400, { error: '路径无效' });
        return true;
      }
      const projectDir = path.join(PROJECTS_ROOT, slug);
      const abs = await resolveAssetMediaPath(projectDir, relFromUrl);
      if (!abs) {
        sendJson(res, 404, { error: '文件不存在' });
        return true;
      }
      const ext = path.extname(path.basename(abs)).toLowerCase();
      if (!IMG_EXT.has(ext) && !VIDEO_EXT.has(ext)) {
        sendJson(res, 404, { error: '不支持的类型' });
        return true;
      }
      res.writeHead(200, {
        'Content-Type': mediaMimeForExtension(ext),
        'Cache-Control': 'public, max-age=3600',
      });
      createReadStream(abs).pipe(res);
      return true;
    }

    // ── GET /api/project/thumb/:slug/<filename> 图片直出；视频则返回首帧 JPEG ──
    if (req.method === 'GET' && pathname.startsWith('/api/project/thumb/')) {
      const rest = pathname.slice('/api/project/thumb/'.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) {
        sendJson(res, 400, { error: '路径无效' });
        return true;
      }
      const slugRaw = safeDecodeURIComponent(rest.slice(0, slash));
      const slug = sanitizeSlug(slugRaw);
      const rawSeg = rest.slice(slash + 1);
      const relFromUrl = safeDecodeURIComponent(rawSeg);
      if (!slug || !relFromUrl) {
        sendJson(res, 400, { error: '路径无效' });
        return true;
      }
      const projectDir = path.join(PROJECTS_ROOT, slug);
      const abs = await resolveAssetMediaPath(projectDir, relFromUrl);
      if (!abs) {
        sendJson(res, 404, { error: '文件不存在' });
        return true;
      }
      const baseName = path.basename(abs);
      const ext = path.extname(baseName).toLowerCase();
      if (IMG_EXT.has(ext)) {
        res.writeHead(200, {
          'Content-Type': mediaMimeForExtension(ext),
          'Cache-Control': 'public, max-age=3600',
        });
        createReadStream(abs).pipe(res);
        return true;
      }
      if (VIDEO_EXT.has(ext)) {
        const poster = await ensureVideoPoster(abs, projectDir);
        if (!poster) {
          sendPreviewPlaceholder(res, 'VIDEO');
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
        createReadStream(poster).pipe(res);
        return true;
      }
      sendJson(res, 404, { error: '不支持的类型' });
      return true;
    }

    // ── PUT /api/project/asset/:slug/<相对路径> 将 body 流写入工程 assets ────
    if (req.method === 'PUT' && pathname.startsWith('/api/project/asset/')) {
      const rest = pathname.slice('/api/project/asset/'.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) {
        sendJson(res, 400, { error: '路径无效' });
        return true;
      }
      const slugRaw = safeDecodeURIComponent(rest.slice(0, slash));
      const slug = sanitizeSlug(slugRaw);
      const rawSeg = rest.slice(slash + 1);
      const relFromUrl = safeDecodeURIComponent(rawSeg);
      if (!slug || !relFromUrl) {
        sendJson(res, 400, { error: '路径无效' });
        return true;
      }
      const projectDir = path.join(PROJECTS_ROOT, slug);
      const abs = await resolveWritableAssetPath(projectDir, relFromUrl);
      if (!abs) {
        sendJson(res, 400, { error: '无效路径' });
        return true;
      }
      try {
        await pipeline(req, createWriteStream(abs));
        sendJson(res, 200, { ok: true });
        return true;
      } catch (err) {
        console.error('[projects-api] asset PUT', err);
        try {
          await fs.unlink(abs);
        } catch {
          /* */
        }
        sendJson(res, 500, { error: err?.message || '写入失败' });
        return true;
      }
    }

    // ── POST /api/project/cleanup-assets body: { slug, paths[] } ─────────────
    if (req.method === 'POST' && pathname === '/api/project/cleanup-assets') {
      const body = await readBodyJson(req);
      const slug = sanitizeSlug(body.slug);
      const rawPaths = Array.isArray(body.paths) ? body.paths : [];
      if (!slug) {
        sendJson(res, 400, { error: '无效 slug' });
        return true;
      }

      const uniquePaths = Array.from(
        new Set(
          rawPaths
            .map((item) => String(item ?? '').trim())
            .filter(Boolean)
        )
      ).slice(0, 256);

      const projectDir = path.join(PROJECTS_ROOT, slug);
      let deleted = 0;
      for (const relPath of uniquePaths) {
        const candidate = resolveAssetPathCandidate(projectDir, relPath);
        if (!candidate) continue;
        try {
          await fs.rm(candidate.abs, { force: true });
          deleted += 1;
        } catch {
          /* ignore missing / locked files */
        }
      }

      sendJson(res, 200, { ok: true, deleted, requested: uniquePaths.length });
      return true;
    }

    // ── GET /api/project/cover/:slug ────────────────────────────────────────
    if (req.method === 'GET' && pathname.startsWith('/api/project/cover/')) {
      const slug = sanitizeSlug(safeDecodeURIComponent(pathname.slice('/api/project/cover/'.length)));
      if (!slug) {
        sendJson(res, 400, { error: '无效 slug' });
        return true;
      }
      const assetsDir = path.join(PROJECTS_ROOT, slug, 'assets');
      const abs = await findLatestImageAsset(path.join(PROJECTS_ROOT, slug));
      if (!abs) {
        sendJson(res, 404, { error: '无封面' });
        return true;
      }
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, { 'Content-Type': mediaMimeForExtension(ext) });
      createReadStream(abs).pipe(res);
      return true;
    }

    // ── GET /api/project/load?slug= ───────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/project/load') {
      const slug = sanitizeSlug(url.searchParams.get('slug'));
      if (!slug) {
        sendJson(res, 400, { error: '缺少或非法 slug' });
        return true;
      }
      const jsonPath = path.join(PROJECTS_ROOT, slug, 'project_data.json');
      try {
        const raw = await fs.readFile(jsonPath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, { ok: true, data });
      } catch {
        sendJson(res, 404, { error: '工程不存在或存档损坏' });
      }
      return true;
    }

    // ── POST /api/project/create  body: { name } ──────────────────────────
    if (req.method === 'POST' && pathname === '/api/project/create') {
      const body = await readBodyJson(req);
      const displayName = String(body.name ?? '未命名工程').trim() || '未命名工程';
      const slug = slugifyDisplayName();
      const dir = path.join(PROJECTS_ROOT, slug);
      await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
      const payload = {
        version: 1,
        name: displayName,
        slug,
        updatedAt: new Date().toISOString(),
        flow: DEFAULT_FLOW(),
      };
      await fs.writeFile(path.join(dir, 'project_data.json'), JSON.stringify(payload, null, 2), 'utf8');
      sendJson(res, 200, { ok: true, slug, name: displayName });
      return true;
    }

    // ── PUT /api/project/save  body: { slug, data } ─────────────────────────
    if (req.method === 'PUT' && pathname === '/api/project/save') {
      const body = await readBodyJson(req);
      const slug = sanitizeSlug(body.slug);
      if (!slug) {
        sendJson(res, 400, { error: '无效 slug' });
        return true;
      }
      const dir = path.join(PROJECTS_ROOT, slug);
      await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
      const prevPath = path.join(dir, 'project_data.json');
      let name = slug;
      let prevUpdatedAt = null;
      try {
        const prev = JSON.parse(await fs.readFile(prevPath, 'utf8'));
        name = prev.name || name;
        prevUpdatedAt = typeof prev.updatedAt === 'string' ? prev.updatedAt : null;
      } catch {
        /* */
      }
      const nextUpdatedAt =
        typeof body.data?.updatedAt === 'string' && body.data.updatedAt.trim()
          ? body.data.updatedAt.trim()
          : new Date().toISOString();
      if (prevUpdatedAt && Date.parse(prevUpdatedAt) > Date.parse(nextUpdatedAt)) {
        sendJson(res, 200, { ok: true, skipped: true, reason: 'stale-save' });
        return true;
      }
      const next = {
        ...(typeof body.data === 'object' && body.data ? body.data : {}),
        version: 1,
        slug,
        name: body.data?.name ?? name,
        updatedAt: nextUpdatedAt,
      };
      await fs.writeFile(prevPath, JSON.stringify(next, null, 2), 'utf8');
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ── POST /api/project/rename  body: { slug, newName } ───────────────────
    if (req.method === 'POST' && pathname === '/api/project/rename') {
      const body = await readBodyJson(req);
      const slug = sanitizeSlug(body.slug);
      const nextName = String(body.newName ?? '').trim();
      if (!slug || !nextName) {
        sendJson(res, 400, { error: '参数错误' });
        return true;
      }
      const dir = path.join(PROJECTS_ROOT, slug);
      const jp = path.join(dir, 'project_data.json');
      try {
        const data = JSON.parse(await fs.readFile(jp, 'utf8'));
        data.slug = slug;
        data.name = nextName;
        data.updatedAt = new Date().toISOString();
        await fs.writeFile(jp, JSON.stringify(data, null, 2), 'utf8');
      } catch (err) {
        sendJson(res, 404, { error: err?.message || '工程不存在或存档损坏' });
        return true;
      }
      sendJson(res, 200, { ok: true, slug, name: nextName });
      return true;
    }

    // ── POST /api/project/copy  body: { slug } ──────────────────────────────
    if (req.method === 'POST' && pathname === '/api/project/copy') {
      const body = await readBodyJson(req);
      const slug = sanitizeSlug(body.slug);
      if (!slug) {
        sendJson(res, 400, { error: '无效 slug' });
        return true;
      }
      const src = path.join(PROJECTS_ROOT, slug);
      const data = JSON.parse(await fs.readFile(path.join(src, 'project_data.json'), 'utf8'));
      const newSlug = slugifyDisplayName();
      const dest = path.join(PROJECTS_ROOT, newSlug);
      await cpRecursive(src, dest);
      data.slug = newSlug;
      data.name = `${data.name || '工程'} 副本`;
      data.updatedAt = new Date().toISOString();
      await fs.writeFile(path.join(dest, 'project_data.json'), JSON.stringify(data, null, 2), 'utf8');
      sendJson(res, 200, { ok: true, slug: newSlug });
      return true;
    }

    // ── DELETE /api/project/delete?slug= ───────────────────────────────────
    if (req.method === 'DELETE' && pathname === '/api/project/delete') {
      const slug = sanitizeSlug(url.searchParams.get('slug'));
      if (!slug) {
        sendJson(res, 400, { error: '无效 slug' });
        return true;
      }
      const dir = path.join(PROJECTS_ROOT, slug);
      await fs.rm(dir, { recursive: true, force: true });
      sendJson(res, 200, { ok: true });
      return true;
    }

    // 任意 /api/project 请求都应在此结束，避免 deepseek-proxy 落到通用「Not found」
    if (pathname.startsWith('/api/project')) {
      sendJson(res, 404, {
        error: `不支持的路由: ${req.method} ${pathname}`,
      });
      return true;
    }
  } catch (err) {
    if (err?.message === '__material_library_not_found__') {
      sendJson(res, 404, { error: '素材不存在' });
      return true;
    }
    console.error('[projects-api]', err);
    sendJson(res, 500, { error: err?.message || '服务器错误' });
    return true;
  }

  return false;
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

async function findLatestImageAsset(projectDir) {
  const assets = path.join(projectDir, 'assets');
  let latest = null;
  let latestTime = 0;
  try {
    const names = await fs.readdir(assets);
    for (const n of names) {
      const ext = path.extname(n).toLowerCase();
      if (!IMG_EXT.has(ext)) continue;
      const fp = path.join(assets, n);
      const st = await fs.stat(fp);
      if (st.mtimeMs > latestTime) {
        latestTime = st.mtimeMs;
        latest = fp;
      }
    }
  } catch {
    return null;
  }
  return latest;
}

function parsePreviewTimeMs(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : null;
}

function normalizeAssetRelativePath(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

function inferMediaKindFromPath(relPath, fallbackKind = 'image') {
  const ext = path.extname(String(relPath || '')).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMG_EXT.has(ext)) return 'image';
  return fallbackKind;
}

function resolveProjectAssetRefFromNodeSrc(slug, src, fallbackKind) {
  const pathname = safeRequestPathname(src);
  const mediaPrefix = '/api/project/media/';
  const videoPrefix = '/api/video-file/';
  if (pathname.startsWith(mediaPrefix)) {
    const rest = pathname.slice(mediaPrefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const relPath = normalizeAssetRelativePath(rest.slice(slash + 1));
    return {
      relPath,
      kind: inferMediaKindFromPath(relPath, fallbackKind),
    };
  }
  if (pathname.startsWith(videoPrefix)) {
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
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    const sortTimeMs = parsePreviewTimeMs(candidate.asset?.previewUpdatedAt) ?? st.mtimeMs;
    const tile = {
      name: ref.relPath,
      kind: ref.kind,
      mtimeMs: st.mtimeMs,
      sortTimeMs,
      nodeId: node?.id || null,
    };
    if (!best || tile.sortTimeMs > best.sortTimeMs) {
      best = tile;
    }
  }
  return best;
}

async function listLatestNodePreviews(projectDir, slug, nodes, limit = PREVIEW_TILE_LIMIT) {
  if (!Array.isArray(nodes) || !nodes.length) return [];
  const items = [];
  for (const node of nodes) {
    const tile = await resolveNodePreviewTile(projectDir, slug, node);
    if (tile) items.push(tile);
  }
  items.sort((a, b) => b.sortTimeMs - a.sortTimeMs || b.mtimeMs - a.mtimeMs);
  return items.slice(0, limit);
}

async function listGeneratedHistoryItems(projectDir, slug, projectData) {
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

async function listAssetFilesAsHistoryItems(projectDir, slug, projectName, referencedAssets = new Set()) {
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

/** 按修改时间取最新若干图片/视频（工程 assets，递归；URL 内用 posix 相对路径） */
async function listLatestMediaForPreview(projectDir, limit = PREVIEW_TILE_LIMIT) {
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

/**
 * 视频首帧缓存到 assets/.thumbs/<safeBase>.jpg，优先使用项目内置 ffmpeg。
 * 若失败返回 null（前端对该格显示占位）。
 */
async function ensureVideoPoster(videoAbsPath, projectDir) {
  const thumbsDir = path.join(projectDir, 'assets', '.thumbs');
  await fs.mkdir(thumbsDir, { recursive: true });
  const base = path.basename(videoAbsPath);
  const relKey = path.relative(path.join(projectDir, 'assets'), videoAbsPath).split(path.sep).join('/');
  const hash = createHash('sha1').update(relKey).digest('hex').slice(0, 12);
  const safeKey = `${base.replace(/[^a-zA-Z0-9._-]/g, '_')}_${hash}`;
  const posterPath = path.join(thumbsDir, `${safeKey}.jpg`);
  let need = true;
  try {
    const [vst, pst] = await Promise.all([fs.stat(videoAbsPath), fs.stat(posterPath)]);
    need = vst.mtimeMs > pst.mtimeMs;
  } catch {
    need = true;
  }
  if (!need) return posterPath;
  const r = spawnSync(
    resolveFfmpegBinary(),
    ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0', '-i', videoAbsPath, '-frames:v', '1', '-q:v', '4', posterPath],
    { encoding: 'utf8', timeout: 120_000, windowsHide: true }
  );
  if (r.status !== 0 || r.error) {
    console.error('[projects-api] ffmpeg poster failed:', r.stderr || r.error?.message);
    return null;
  }
  try {
    await fs.access(posterPath);
    return posterPath;
  } catch {
    return null;
  }
}

/** rel 为 assets 目录下的相对路径（可使用 /），禁止跳出 assets */
async function resolveAssetMediaPath(projectDir, relDecoded) {
  const candidate = resolveAssetPathCandidate(projectDir, relDecoded);
  if (!candidate) return null;
  try {
    const st = await fs.stat(candidate.abs);
    if (!st.isFile()) return null;
    return candidate.abs;
  } catch {
    return null;
  }
}

async function resolveWritableAssetPath(projectDir, relDecoded) {
  const candidate = resolveAssetPathCandidate(projectDir, relDecoded);
  if (!candidate) return null;
  await fs.mkdir(path.dirname(candidate.abs), { recursive: true });
  return candidate.abs;
}

async function cpRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const ents = await fs.readdir(src, { withFileTypes: true });
  for (const ent of ents) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await cpRecursive(s, d);
    else await fs.copyFile(s, d);
  }
}
