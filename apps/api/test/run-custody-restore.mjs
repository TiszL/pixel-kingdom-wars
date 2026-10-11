/** Disposable local rehearsal. Requires cached PostgreSQL/Redis Docker images.
 * It creates its own containers and never reads deployment credentials. */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

if (process.argv.length !== 2) throw Error('This fixture runner accepts no arguments');
const command = promisify(execFile);
const name = `phase-e-focused-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const owned = [];
let active, interrupted = false;
function stopChild(signal) {
  if (active?.pid) {
    try { process.kill(-active.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
const interrupt = () => { interrupted = true; stopChild('SIGTERM'); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
async function docker(args) {
  if (interrupted) throw Error('Rehearsal interrupted');
  return (await command('docker', args, { timeout: 30_000 })).stdout.trim();
}
async function container(suffix, args) {
  const id = await docker(['run', '--pull=never', '--rm', '-d', '--name', `${name}-${suffix}`, ...args]);
  if (!/^[0-9a-f]{64}$/.test(id)) throw Error('Unexpected Docker container identity');
  owned.push(id);
  return id;
}
async function port(id, target) {
  const binding = await docker(['port', id, target]);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
  if (!match) throw Error('Expected one private loopback binding');
  return match[1];
}
try {
  const pg = await container('pg', ['--cpus', '1', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_USER=shardkeep', '-e', 'POSTGRES_PASSWORD=shardkeep', '-e', 'POSTGRES_DB=postgres',
    '-p', '127.0.0.1::5432', 'postgres:16-alpine']);
  const redis = await container('redis', ['-p', '127.0.0.1::6379', 'redis:7-alpine']);
  const pgPort = await port(pg, '5432/tcp'), redisPort = await port(redis, '6379/tcp');
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    try { await docker(['exec', pg, 'pg_isready', '-U', 'shardkeep', '-d', 'postgres']); ready = true; }
    catch (error) { if (interrupted) throw error; await delay(200); }
  }
  if (!ready) throw Error('Owned PostgreSQL did not become ready');
  if (interrupted) throw Error('Rehearsal interrupted');
  await new Promise((resolve, reject) => {
    active = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'test/custody-restore.vitest.ts', '--maxWorkers=1', '--reporter=verbose'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), detached: true, stdio: 'inherit',
      env: { ...process.env,
        PHASE_E_RESTORE_CONTAINER: `${name}-pg`,
        TEST_DATABASE_URL: `postgres://shardkeep:shardkeep@127.0.0.1:${pgPort}/shardkeep_test`,
        TEST_ADMIN_DATABASE_URL: `postgres://shardkeep:shardkeep@127.0.0.1:${pgPort}/postgres`,
        TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      },
    });
    const deadline = setTimeout(() => { interrupted = true; stopChild('SIGKILL'); }, 360_000);
    active.once('error', error => { clearTimeout(deadline); reject(error); });
    active.once('close', code => {
      clearTimeout(deadline); active = undefined;
      code === 0 && !interrupted ? resolve() : reject(Error(`Fixture failed (${code})`));
    });
  });
} finally {
  stopChild('SIGKILL');
  for (const id of owned.reverse()) {
    await command('docker', ['stop', '--time', '3', id], { timeout: 15_000 });
  }
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
