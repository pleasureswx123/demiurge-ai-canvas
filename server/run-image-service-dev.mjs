/**
 * Dev-only: runs Python image_generate_service.py and restarts it when
 * server/image_generate_service.py, .env, or .env.local changes.
 * No manual kill of port 8790 — use with: npm run dev / npm run dev:all
 */
import { spawn } from 'node:child_process';
import { watchFile, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const pyScript = path.join(root, 'server', 'image_generate_service.py');

let child = null;

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function stopChild() {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  child = null;
}

function startChild() {
  stopChild();

  const cmd = process.platform === 'win32' ? 'python' : 'python3';
  child = spawn(cmd, [pyScript], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env },
  });

  child.on('exit', (code, sig) => {
    child = null;
    if (sig === 'SIGTERM') return;
    console.error(`[image-api] python exited code=${code ?? '?'} sig=${sig ?? ''}`);
  });

  child.on('error', (err) => {
    console.error('[image-api] spawn failed:', err.message);
  });
}

const scheduleRestart = debounce(() => {
  console.log('\n[image-api] file changed — restarting Python (8790) …\n');
  stopChild();
  setTimeout(startChild, 450);
}, 250);

function watchIfExists(filePath, label) {
  if (!existsSync(filePath)) return;
  watchFile(filePath, { interval: 600 }, () => scheduleRestart());
  console.log(`[image-api] watching ${label}`);
}

console.log('[image-api] starting Python media service (8790), auto-restart on edits…');
watchIfExists(pyScript, 'server/image_generate_service.py');
watchIfExists(path.join(root, '.env'), '.env');
watchIfExists(path.join(root, '.env.local'), '.env.local');

startChild();

function shutdown() {
  stopChild();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
