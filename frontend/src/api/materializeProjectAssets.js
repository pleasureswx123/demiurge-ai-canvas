/**
 * 将画布节点中的 blob:/data: 素材写入 projects/<slug>/assets，并把 src 换成可持久访问的工程素材 URL。
 */
import { mediaApi, nodeApi } from './routes';

function sanitizeBaseName(name) {
  const base = String(name || 'asset').replace(/[/\\]/g, '_');
  const cleaned = base.replace(/[<>:"|?*]/g, '_').trim();
  const withoutExt = cleaned.replace(/\.[^.]+$/, '');
  return (withoutExt || 'asset').slice(0, 120);
}

function pickExtension(originalName, mime, kind) {
  const fromName = /\.([a-z0-9]+)$/i.exec(originalName || '');
  if (fromName?.[1]) return `.${fromName[1].toLowerCase()}`;
  const m = String(mime || '').toLowerCase();
  if (kind === 'video') {
    if (m.includes('webm')) return '.webm';
    if (m.includes('quicktime')) return '.mov';
    return '.mp4';
  }
  if (m.includes('jpeg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  return kind === 'video' ? '.mp4' : '.png';
}

function makeStoredFilename(originalName, mime, kind) {
  const base = sanitizeBaseName(originalName);
  const ext = pickExtension(originalName, mime, kind);
  return `${Date.now().toString(36)}_${base}${ext}`;
}

/**
 * @param {string} slug
 * @param {unknown[]} nodes React Flow 节点（会被就地修改）
 * @returns {Promise<boolean>} 是否替换了任意 URL
 */
export async function materializeEphemeralAssetUrls(slug, nodes) {
  if (!slug || !Array.isArray(nodes)) return false;
  const urlMap = new Map();
  let changed = false;

  const patchObject = async (obj, kind) => {
    if (!obj || typeof obj !== 'object' || typeof obj.src !== 'string') return;
    const src = obj.src.trim();
    if (!src.startsWith('blob:') && !src.startsWith('data:')) return;
    if (urlMap.has(src)) {
      obj.src = urlMap.get(src);
      changed = true;
      return;
    }
    const res = await fetch(src);
    if (!res.ok) throw new Error(`读取素材失败 HTTP ${res.status}`);
    const blob = await res.blob();
    const fn = makeStoredFilename(obj.name, blob.type, kind);
    const putUrl = nodeApi(`/project/asset/${encodeURIComponent(slug)}/${encodeURIComponent(fn)}`);
    const put = await fetch(putUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    });
    if (!put.ok) {
      const err = await put.json().catch(() => ({}));
      throw new Error(err.error || `写入工程素材失败 (${put.status})`);
    }
    const next =
      kind === 'image'
        ? nodeApi(`/project/media/${encodeURIComponent(slug)}/${encodeURIComponent(fn)}`)
        : mediaApi(`/video-file/${encodeURIComponent(slug)}/${encodeURIComponent(fn)}`);
    urlMap.set(src, next);
    obj.src = next;
    obj.name = fn;
    changed = true;
  };

  for (const node of nodes) {
    const d = node?.data;
    if (!d) continue;
    if (node.type === 'AIImageNode') {
      await patchObject(d.imageAsset, 'image');
      await patchObject(d.capturedFrame, 'image');
    } else if (node.type === 'AIVideoNode') {
      await patchObject(d.capturedClip, 'video');
      await patchObject(d.generatedVideo, 'video');
    }
  }

  return changed;
}
