import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(serviceRoot, '..', '..');

export const NODE_SERVICE_ROOT = serviceRoot;
export const REPO_ROOT = repoRoot;

export function resolveRepoPath(...parts) {
  return path.resolve(repoRoot, ...parts);
}
