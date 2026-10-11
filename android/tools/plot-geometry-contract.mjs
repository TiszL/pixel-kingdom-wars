import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export function plotGeometryContract(policy) {
  if (policy?.legacyVersion !== 1 || policy?.currentVersion !== 2 || JSON.stringify(Object.keys(policy.boundsByVersion).sort()) !== '["1","2"]') throw new Error('Unsupported plot policy');
  for (const row of Object.values(policy.boundsByVersion)) if (!Number.isSafeInteger(row.min) || !Number.isSafeInteger(row.max) || row.max <= row.min) throw new Error('Invalid plot bounds');
  return JSON.stringify(policy, null, 2) + '\n';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const source = path.resolve(args[args.indexOf('--source') + 1]);
  if (!args.includes('--source')) throw new Error('Missing --source');
  if (!process.env.PKW_PLOT_TS_LOADER) {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(source, 'scripts/node_modules/tsx/dist/loader.mjs')).href, fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', env: { ...process.env, PKW_PLOT_TS_LOADER: '1' } });
    process.exit(result.status ?? 1);
  }
  const { PLOT_GEOMETRY } = await import(pathToFileURL(path.join(source, 'packages/shared/src/constants.ts')).href);
  const output = path.resolve('network/src/main/resources/plot-geometry.json');
  const bytes = plotGeometryContract(PLOT_GEOMETRY);
  if (args.includes('--check')) { if (await readFile(output, 'utf8') !== bytes) throw new Error('Generated plot geometry drift'); }
  else { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, bytes); }
}
