import { nodeApi } from './routes';

export const MATERIAL_LIBRARY_CATEGORY_TABS = [
  { id: 'all', label: '全部' },
  { id: '人物', label: '人物' },
  { id: '场景', label: '场景' },
  { id: '物品', label: '物品' },
  { id: '风格', label: '风格' },
  { id: '音效', label: '音效' },
  { id: '其他', label: '其他' },
];

export const MATERIAL_LIBRARY_SELECTABLE_CATEGORIES = MATERIAL_LIBRARY_CATEGORY_TABS.filter(
  (item) => item.id !== 'all'
);

function sanitizeBaseName(name) {
  const base = String(name || 'material').replace(/[/\\]/g, '_');
  const cleaned = base.replace(/[<>:"|?*]/g, '_').trim();
  const withoutExt = cleaned.replace(/\.[^.]+$/, '');
  const asciiSafe = withoutExt
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return (asciiSafe || 'material').slice(0, 120);
}

function pickExtension(originalName, mime, fallbackExt = '.png') {
  const fromName = /\.([a-z0-9]+)$/i.exec(originalName || '');
  if (fromName?.[1]) return `.${fromName[1].toLowerCase()}`;
  const normalizedMime = String(mime || '').toLowerCase();
  if (normalizedMime.includes('jpeg')) return '.jpg';
  if (normalizedMime.includes('png')) return '.png';
  if (normalizedMime.includes('webp')) return '.webp';
  if (normalizedMime.includes('gif')) return '.gif';
  if (normalizedMime.includes('bmp')) return '.bmp';
  if (normalizedMime.includes('svg')) return '.svg';
  if (normalizedMime.includes('mp4')) return '.mp4';
  if (normalizedMime.includes('webm')) return '.webm';
  if (normalizedMime.includes('quicktime')) return '.mov';
  return fallbackExt;
}

function makeUploadFilename(name, mime, fallbackExt) {
  return `${Date.now().toString(36)}_${sanitizeBaseName(name)}${pickExtension(name, mime, fallbackExt)}`;
}

function normalizeSeedanceFaceReview(review) {
  if (!review || typeof review !== 'object') return null;
  const status = String(review.status || '').trim().toLowerCase();
  if (!status) return null;
  return {
    status,
    assetId: String(review.assetId || '').trim(),
    assetRef: String(review.assetRef || '').trim(),
    assetStatus: String(review.assetStatus || '').trim(),
    message: String(review.message || '').trim(),
    updatedAt: String(review.updatedAt || '').trim(),
  };
}

async function parseJsonSafe(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || `HTTP ${response.status}` };
  }
}

export async function fetchMaterialLibraryItems() {
  const response = await fetch(nodeApi('/material-library/list'));
  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    if (response.status === 404 || String(payload.error || '').trim().toLowerCase() === 'not found') {
      return [];
    }
    throw new Error(payload.error || '读取素材库失败');
  }
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function fetchSeedanceSubjects() {
  const response = await fetch(nodeApi('/material-library/subjects'));
  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    if (response.status === 404 || String(payload.error || '').trim().toLowerCase() === 'not found') {
      return [];
    }
    throw new Error(payload.error || '读取主体库失败');
  }
  return Array.isArray(payload.items) ? payload.items : [];
}

async function uploadLibraryBlob(fileName, blob) {
  const response = await fetch(nodeApi(`/material-library/asset/${encodeURIComponent(fileName)}`), {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
  });
  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('素材库接口未生效，请在 backend/node 运行 npm run dev');
    }
    throw new Error(payload.error || '素材上传失败');
  }
  return payload;
}

export async function sourceToBlob(src) {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`素材读取失败：${response.status}`);
  }
  return await response.blob();
}

export async function saveMaterialLibraryItem({ name, category, asset, coverAsset = null }) {
  if (!asset?.src) throw new Error('缺少素材源');
  const assetBlob = await sourceToBlob(asset.src);
  const assetFileName = makeUploadFilename(
    asset.name,
    assetBlob.type,
    asset.kind === 'video' ? '.mp4' : '.png'
  );
  await uploadLibraryBlob(assetFileName, assetBlob);

  let coverPath = assetFileName;
  if (coverAsset?.src && coverAsset.src !== asset.src) {
    const coverBlob = await sourceToBlob(coverAsset.src);
    const coverFileName = makeUploadFilename(coverAsset.name, coverBlob.type, '.png');
    await uploadLibraryBlob(coverFileName, coverBlob);
    coverPath = coverFileName;
  }

  const saveResponse = await fetch(nodeApi('/material-library/save'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      category,
      kind: asset.kind || 'image',
      assetPath: assetFileName,
      coverPath,
      width: Number.isFinite(asset.width) ? asset.width : null,
      height: Number.isFinite(asset.height) ? asset.height : null,
      duration: Number.isFinite(asset.duration) ? asset.duration : null,
      seedanceFaceReview: normalizeSeedanceFaceReview(asset.seedanceFaceReview),
    }),
  });
  const savePayload = await parseJsonSafe(saveResponse);
  if (!saveResponse.ok) {
    if (saveResponse.status === 404) {
      throw new Error('素材库接口未生效，请在 backend/node 运行 npm run dev');
    }
    throw new Error(savePayload.error || '保存到素材库失败');
  }
  return savePayload.item;
}

export async function saveSeedanceSubject({
  name,
  sourceFile,
  subjectId = '',
  summary = '',
  prompt = '',
  requestFields = {},
}) {
  if (!(sourceFile instanceof File)) {
    throw new Error('请选择本地主体图片');
  }
  const fileName = makeUploadFilename(sourceFile.name, sourceFile.type, '.png');
  await uploadLibraryBlob(fileName, sourceFile);
  const response = await fetch(nodeApi('/material-library/subject'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      assetPath: fileName,
      coverPath: fileName,
      referenceImagePath: fileName,
      subjectId,
      summary,
      prompt,
      requestFields,
    }),
  });
  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('主体库接口未生效，请在 backend/node 运行 npm run dev');
    }
    throw new Error(payload.error || '保存主体失败');
  }
  return payload.item;
}

export async function updateSeedanceSubject(id, patch) {
  const response = await fetch(nodeApi(`/material-library/subject/${encodeURIComponent(String(id || ''))}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {}),
  });
  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('主体不存在或已删除');
    }
    throw new Error(payload.error || '更新主体失败');
  }
  return payload.item;
}

export async function deleteMaterialLibraryItem(id) {
  const response = await fetch(nodeApi(`/material-library/item/${encodeURIComponent(String(id || ''))}`), {
    method: 'DELETE',
  });
  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('素材不存在或已删除');
    }
    throw new Error(payload.error || '删除素材失败');
  }
  return payload;
}
