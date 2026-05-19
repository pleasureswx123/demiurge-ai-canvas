import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_ROOT, SAFE_SLUG_RE } from '../config/storage.js';

export function sanitizeSlug(raw) {
  const s = String(raw ?? '').trim();
  if (!SAFE_SLUG_RE.test(s)) return null;
  const resolved = path.resolve(PROJECTS_ROOT, s);
  const rel = path.relative(PROJECTS_ROOT, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return s;
}

export async function ensureProjectsRoot() {
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
}

export function slugifyDisplayName() {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `proj_${Date.now().toString(36)}_${rnd}`;
}

export function createDefaultFlow() {
  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 0.85 },
  };
}

export async function copyDirectoryRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(src, entry.name);
    const destinationPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, destinationPath);
    } else {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}
