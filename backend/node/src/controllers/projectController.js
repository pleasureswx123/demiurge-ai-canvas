import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { IMG_EXT, PREVIEW_TILE_LIMIT, PROJECTS_ROOT, VIDEO_EXT } from '../config/storage.js';
import {
  copyDirectoryRecursive,
  createDefaultFlow,
  sanitizeSlug,
  slugifyDisplayName,
} from '../repositories/projectRepository.js';
import {
  findLatestImageAsset,
  resolveAssetMediaPath,
  resolveAssetPathCandidate,
  resolveWritableAssetPath,
} from '../repositories/projectAssetRepository.js';
import { buildProjectThumbUrl, normalizeStoredAssetUrls } from '../services/assetUrlService.js';
import {
  ensureVideoPoster,
  listGeneratedHistoryItems,
  listLatestMediaForPreview,
  listLatestNodePreviews,
  sendPreviewPlaceholder,
} from '../services/projectPreviewService.js';
import { readBodyJson, safeDecodeURIComponent, sendJson, sendMediaFile } from '../utils/http.js';

export async function handleProjectStorageApi(req, res, pathname) {
  if (!pathname.startsWith('/api/project')) return false;
  const url = new URL(String(req.url || '/'), 'http://127.0.0.1');

  if (req.method === 'GET' && pathname === '/api/project/history') {
    const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true }).catch(() => []);
    const items = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const slug = ent.name;
      if (!sanitizeSlug(slug)) continue;
      const dir = path.join(PROJECTS_ROOT, slug);
      const jsonPath = path.join(dir, 'project_data.json');
      let projectData;
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

      const nodePreviewTiles = await listLatestNodePreviews(dir, slug, projectData?.flow?.nodes, PREVIEW_TILE_LIMIT);
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
        coverUrl = `/api/node/project/cover/${encodeURIComponent(slug)}`;
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

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/project/media/')) {
    const parsed = parseProjectAssetPath(pathname, '/api/project/media/');
    if (!parsed) {
      sendJson(res, 400, { error: '路径无效' });
      return true;
    }
    const { slug, relFromUrl } = parsed;
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
    sendMediaFile(req, res, abs, ext);
    return true;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/project/thumb/')) {
    const parsed = parseProjectAssetPath(pathname, '/api/project/thumb/');
    if (!parsed) {
      sendJson(res, 400, { error: '路径无效' });
      return true;
    }
    const projectDir = path.join(PROJECTS_ROOT, parsed.slug);
    const abs = await resolveAssetMediaPath(projectDir, parsed.relFromUrl);
    if (!abs) {
      sendJson(res, 404, { error: '文件不存在' });
      return true;
    }
    const ext = path.extname(path.basename(abs)).toLowerCase();
    if (IMG_EXT.has(ext)) {
      sendMediaFile(req, res, abs, ext);
      return true;
    }
    if (VIDEO_EXT.has(ext)) {
      const poster = await ensureVideoPoster(abs, projectDir);
      if (!poster) {
        sendPreviewPlaceholder(res, 'VIDEO');
        return true;
      }
      sendMediaFile(req, res, poster, '.jpg', { 'Content-Type': 'image/jpeg' });
      return true;
    }
    sendJson(res, 404, { error: '不支持的类型' });
    return true;
  }

  if (req.method === 'PUT' && pathname.startsWith('/api/project/asset/')) {
    const parsed = parseProjectAssetPath(pathname, '/api/project/asset/');
    if (!parsed) {
      sendJson(res, 400, { error: '路径无效' });
      return true;
    }
    const projectDir = path.join(PROJECTS_ROOT, parsed.slug);
    const abs = await resolveWritableAssetPath(projectDir, parsed.relFromUrl);
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
      await fs.unlink(abs).catch(() => {});
      sendJson(res, 500, { error: err?.message || '写入失败' });
      return true;
    }
  }

  if (req.method === 'POST' && pathname === '/api/project/cleanup-assets') {
    const body = await readBodyJson(req);
    const slug = sanitizeSlug(body.slug);
    const rawPaths = Array.isArray(body.paths) ? body.paths : [];
    if (!slug) {
      sendJson(res, 400, { error: '无效 slug' });
      return true;
    }

    const uniquePaths = Array.from(new Set(rawPaths.map((item) => String(item ?? '').trim()).filter(Boolean))).slice(0, 256);
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

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/project/cover/')) {
    const slug = sanitizeSlug(safeDecodeURIComponent(pathname.slice('/api/project/cover/'.length)));
    if (!slug) {
      sendJson(res, 400, { error: '无效 slug' });
      return true;
    }
    const abs = await findLatestImageAsset(path.join(PROJECTS_ROOT, slug));
    if (!abs) {
      sendJson(res, 404, { error: '无封面' });
      return true;
    }
    const ext = path.extname(abs).toLowerCase();
    sendMediaFile(req, res, abs, ext, { 'Cache-Control': 'no-store' });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/project/load') {
    const slug = sanitizeSlug(url.searchParams.get('slug'));
    if (!slug) {
      sendJson(res, 400, { error: '缺少或非法 slug' });
      return true;
    }
    const jsonPath = path.join(PROJECTS_ROOT, slug, 'project_data.json');
    try {
      const raw = await fs.readFile(jsonPath, 'utf8');
      const data = normalizeStoredAssetUrls(JSON.parse(raw));
      sendJson(res, 200, { ok: true, data });
    } catch {
      sendJson(res, 404, { error: '工程不存在或存档损坏' });
    }
    return true;
  }

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
      flow: createDefaultFlow(),
    };
    await fs.writeFile(path.join(dir, 'project_data.json'), JSON.stringify(payload, null, 2), 'utf8');
    sendJson(res, 200, { ok: true, slug, name: displayName });
    return true;
  }

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

  if (req.method === 'POST' && pathname === '/api/project/rename') {
    const body = await readBodyJson(req);
    const slug = sanitizeSlug(body.slug);
    const nextName = String(body.newName ?? '').trim();
    if (!slug || !nextName) {
      sendJson(res, 400, { error: '参数错误' });
      return true;
    }
    const jsonPath = path.join(PROJECTS_ROOT, slug, 'project_data.json');
    try {
      const data = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
      data.slug = slug;
      data.name = nextName;
      data.updatedAt = new Date().toISOString();
      await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      sendJson(res, 404, { error: err?.message || '工程不存在或存档损坏' });
      return true;
    }
    sendJson(res, 200, { ok: true, slug, name: nextName });
    return true;
  }

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
    await copyDirectoryRecursive(src, dest);
    data.slug = newSlug;
    data.name = `${data.name || '工程'} 副本`;
    data.updatedAt = new Date().toISOString();
    await fs.writeFile(path.join(dest, 'project_data.json'), JSON.stringify(data, null, 2), 'utf8');
    sendJson(res, 200, { ok: true, slug: newSlug });
    return true;
  }

  if (req.method === 'DELETE' && pathname === '/api/project/delete') {
    const slug = sanitizeSlug(url.searchParams.get('slug'));
    if (!slug) {
      sendJson(res, 400, { error: '无效 slug' });
      return true;
    }
    await fs.rm(path.join(PROJECTS_ROOT, slug), { recursive: true, force: true });
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 404, { error: `不支持的路由: ${req.method} ${pathname}` });
  return true;
}

function parseProjectAssetPath(pathname, prefix) {
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const slug = sanitizeSlug(safeDecodeURIComponent(rest.slice(0, slash)));
  const relFromUrl = safeDecodeURIComponent(rest.slice(slash + 1));
  if (!slug || !relFromUrl) return null;
  return { slug, relFromUrl };
}
