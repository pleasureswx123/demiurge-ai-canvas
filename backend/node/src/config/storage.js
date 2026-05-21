import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveRepoPath } from './paths.js';

function resolveConfiguredPath(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : resolveRepoPath(raw);
}

export const PROJECTS_ROOT = resolveConfiguredPath(process.env.PROJECTS_ROOT, resolveRepoPath('projects'));
export const MATERIAL_LIBRARY_ROOT = resolveConfiguredPath(
  process.env.MATERIAL_LIBRARY_ROOT,
  resolveRepoPath('material-library')
);

export const BUNDLED_FFMPEG_PATH = path.resolve(
  resolveRepoPath(),
  'tools',
  'ffmpeg-dist',
  'ffmpeg-8.1-essentials_build',
  'bin',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
);

export const SAFE_SLUG_RE = /^[a-zA-Z0-9_-]{1,120}$/;
export const SAFE_LIBRARY_FILE_RE = /^[a-zA-Z0-9._-]{1,180}$/;
export const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv']);
export const PREVIEW_TILE_LIMIT = 4;
export const MATERIAL_LIBRARY_CATEGORIES = new Set(['人物', '场景', '物品', '风格', '音效', '其他']);
export const MATERIAL_LIBRARY_INDEX_FILE = 'library_data.json';
export const SEEDANCE_SUBJECTS_INDEX_FILE = 'seedance_subjects.json';
export const SEEDANCE_SUBJECT_STATUSES = new Set(['approved', 'pending', 'rejected']);

export function resolveFfmpegBinary() {
  const configured = String(process.env.FFMPEG_PATH || '').trim();
  if (configured) return configured;
  if (existsSync(BUNDLED_FFMPEG_PATH)) return BUNDLED_FFMPEG_PATH;
  return 'ffmpeg';
}
