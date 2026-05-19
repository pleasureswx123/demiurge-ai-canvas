import fs from 'node:fs/promises';
import path from 'node:path';
import { IMG_EXT } from '../config/storage.js';

export function resolveAssetPathCandidate(projectDir, relDecoded) {
  const assetsDir = path.resolve(path.join(projectDir, 'assets'));
  const raw = String(relDecoded ?? '').trim();
  if (!raw) return null;
  const normalized = path.normalize(raw.replace(/\//g, path.sep)).replace(/^[/\\]+/, '');
  const segments = normalized.split(path.sep).filter(Boolean);
  if (segments.some((seg) => seg === '..')) return null;
  const abs = path.resolve(assetsDir, ...segments);
  const relativePath = path.relative(assetsDir, abs);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return { assetsDir, abs, relativePath: relativePath.split(path.sep).join('/') };
}

export async function resolveAssetMediaPath(projectDir, relDecoded) {
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

export async function resolveWritableAssetPath(projectDir, relDecoded) {
  const candidate = resolveAssetPathCandidate(projectDir, relDecoded);
  if (!candidate) return null;
  await fs.mkdir(path.dirname(candidate.abs), { recursive: true });
  return candidate.abs;
}

export async function findLatestImageAsset(projectDir) {
  const assets = path.join(projectDir, 'assets');
  let latest = null;
  let latestTime = 0;
  try {
    const names = await fs.readdir(assets);
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      if (!IMG_EXT.has(ext)) continue;
      const filePath = path.join(assets, name);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs;
        latest = filePath;
      }
    }
  } catch {
    return null;
  }
  return latest;
}
