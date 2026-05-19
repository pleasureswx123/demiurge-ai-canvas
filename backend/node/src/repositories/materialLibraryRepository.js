import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MATERIAL_LIBRARY_CATEGORIES,
  MATERIAL_LIBRARY_INDEX_FILE,
  MATERIAL_LIBRARY_ROOT,
  SAFE_LIBRARY_FILE_RE,
  SEEDANCE_SUBJECT_STATUSES,
  SEEDANCE_SUBJECTS_INDEX_FILE,
} from '../config/storage.js';

export async function ensureMaterialLibraryRoot() {
  await fs.mkdir(path.join(MATERIAL_LIBRARY_ROOT, 'assets'), { recursive: true });
}

export function sanitizeLibraryCategory(rawCategory) {
  const category = String(rawCategory || '').trim();
  return MATERIAL_LIBRARY_CATEGORIES.has(category) ? category : null;
}

export function sanitizeLibraryFilename(rawName) {
  const fileName = path.basename(String(rawName || '').trim());
  if (!SAFE_LIBRARY_FILE_RE.test(fileName)) return null;
  return fileName;
}

export function normalizeSeedanceFaceReview(rawReview) {
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

export function buildMaterialLibraryAssetUrl(fileName) {
  return `/api/node/material-library/media/${encodeURIComponent(fileName)}`;
}

export async function readMaterialLibraryIndex() {
  const indexPath = path.join(MATERIAL_LIBRARY_ROOT, MATERIAL_LIBRARY_INDEX_FILE);
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

export async function writeMaterialLibraryIndex(items) {
  const indexPath = path.join(MATERIAL_LIBRARY_ROOT, MATERIAL_LIBRARY_INDEX_FILE);
  await fs.writeFile(
    indexPath,
    JSON.stringify({ version: 1, items, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

export async function readSeedanceSubjectsIndex() {
  const indexPath = path.join(MATERIAL_LIBRARY_ROOT, SEEDANCE_SUBJECTS_INDEX_FILE);
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

export async function writeSeedanceSubjectsIndex(items) {
  const indexPath = path.join(MATERIAL_LIBRARY_ROOT, SEEDANCE_SUBJECTS_INDEX_FILE);
  await fs.writeFile(
    indexPath,
    JSON.stringify({ version: 1, items, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

export function sanitizeSeedanceSubjectStatus(rawStatus) {
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

export function normalizeSeedanceSubjectItem(item, index = 0) {
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
