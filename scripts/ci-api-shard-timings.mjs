#!/usr/bin/env node
// Rebuilds apps/api/test/ci-shard-timings.json, the per-file durations that
// apps/api/test/ciShards.ts packs into duration-balanced CI shards.
//
// Input: raw GitHub job logs of the "API shard i/16" jobs, e.g.
//   gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs > API_shard_1_16.log
// Files run one at a time inside a shard (fileParallelism: false), so a file's
// cost is the gap between its result line and the previous one; the first file
// also carries vitest start-up and global setup. Several runs may be passed; a
// file measured more than once gets the mean, rounded to whole seconds.
//
// Usage: node scripts/ci-api-shard-timings.mjs --source "<runs, commits, date>" <log>...
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--source');
if (at < 0 || !args[at + 1]) throw new Error('usage: --source "<runs, commits, date>" <job log>...');
const source = args[at + 1];
const logs = args.filter((_, i) => i !== at && i !== at + 1);
if (logs.length === 0) throw new Error('no job logs given');

const STEP = '##[group]Run mkdir -p apps/api/.reports';
const RESULT = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+[✓❯×↓]\s+(test\/\S+\.test\.ts)\s+\(/;
const samples = new Map();
for (const log of logs) {
  const lines = readFileSync(log, 'utf8').replace(/^\uFEFF/, '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const start = lines.find(line => line.includes(STEP));
  if (!start) throw new Error(`${log}: no API shard step (${STEP})`);
  let previous = Date.parse(start.slice(0, start.indexOf('Z') + 1));
  const seen = new Set();
  for (const line of lines) {
    const match = RESULT.exec(line);
    if (!match || seen.has(match[2])) continue;
    seen.add(match[2]);
    const now = Date.parse(match[1]);
    samples.set(match[2], [...(samples.get(match[2]) ?? []), (now - previous) / 1000]);
    previous = now;
  }
  if (seen.size === 0) throw new Error(`${log}: no file results`);
}

const seconds = {};
for (const file of [...samples.keys()].sort()) {
  const values = samples.get(file);
  seconds[file] = Math.max(1, Math.round(values.reduce((a, b) => a + b, 0) / values.length));
}
const out = fileURLToPath(new URL('../apps/api/test/ci-shard-timings.json', import.meta.url));
writeFileSync(out, `${JSON.stringify({ source, seconds }, null, 1)}\n`);
console.log(`${Object.keys(seconds).length} files from ${logs.length} logs -> ${out}`);
