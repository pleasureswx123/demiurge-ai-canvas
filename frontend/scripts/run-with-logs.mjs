import { mkdirSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const scriptName = process.argv[2];

if (!scriptName) {
  console.error('Usage: node scripts/run-with-logs.mjs <npm-script-name>');
  process.exit(1);
}

const logsDir = join(process.cwd(), 'logs');
mkdirSync(logsDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(logsDir, `${scriptName}-${stamp}.out.log`);
const errPath = join(logsDir, `${scriptName}-${stamp}.err.log`);

const outLog = createWriteStream(outPath, { flags: 'a' });
const errLog = createWriteStream(errPath, { flags: 'a' });

console.log(`[logs] stdout -> ${outPath}`);
console.log(`[logs] stderr -> ${errPath}`);

const child = spawn('npm', ['run', scriptName], {
  cwd: process.cwd(),
  shell: true,
  env: process.env,
});

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  outLog.write(chunk);
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  errLog.write(chunk);
});

child.on('close', (code, signal) => {
  outLog.end();
  errLog.end();

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
