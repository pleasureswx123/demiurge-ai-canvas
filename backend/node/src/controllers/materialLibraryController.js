import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { MATERIAL_LIBRARY_ROOT } from '../config/storage.js';
import {
  buildMaterialLibraryAssetUrl,
  normalizeSeedanceFaceReview,
  normalizeSeedanceSubjectItem,
  readMaterialLibraryIndex,
  readSeedanceSubjectsIndex,
  sanitizeLibraryCategory,
  sanitizeLibraryFilename,
  sanitizeSeedanceSubjectStatus,
  writeMaterialLibraryIndex,
  writeSeedanceSubjectsIndex,
} from '../repositories/materialLibraryRepository.js';
import { readBodyJson, safeDecodeURIComponent, sendJson, sendMediaFile } from '../utils/http.js';

export async function handleMaterialLibraryApi(req, res, pathname) {
  if (!pathname.startsWith('/api/material-library')) return false;

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

  if (req.method === 'POST' && pathname === '/api/material-library/subject') {
    const body = await readBodyJson(req);
    const name = String(body.name || '').trim();
    const assetPath = sanitizeLibraryFilename(body.assetPath);
    const coverPath = sanitizeLibraryFilename(body.coverPath || body.assetPath);
    const referenceImagePath = sanitizeLibraryFilename(body.referenceImagePath || body.coverPath || body.assetPath);
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

  if (req.method === 'PATCH' && pathname.startsWith('/api/material-library/subject/')) {
    const itemId = String(safeDecodeURIComponent(pathname.slice('/api/material-library/subject/'.length)) || '').trim();
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
        ? nextSubjectId
          ? 'approved'
          : sanitizeSeedanceSubjectStatus(current.status)
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

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/material-library/media/')) {
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
    sendMediaFile(req, res, abs, ext);
    return true;
  }

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

  if (req.method === 'DELETE' && pathname.startsWith('/api/material-library/item/')) {
    const itemId = String(safeDecodeURIComponent(pathname.slice('/api/material-library/item/'.length)) || '').trim();
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
    const nextItems = items.filter((_item, index) => index !== itemIndex);
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

  sendJson(res, 404, { error: `不支持的路由: ${req.method} ${pathname}` });
  return true;
}
