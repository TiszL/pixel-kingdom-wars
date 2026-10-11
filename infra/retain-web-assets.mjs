/** Preserve exact public build bytes for old clients before deploy's --delete.
 * No API/config/key files enter these snapshots. Same SHA with different bytes
 * is a release error, never permission to replace an immutable generation. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const PUBLIC = /^(assets|atlas|audio|brand|icons)\/[A-Za-z0-9_@./+ -]+$/;
const SHELL = ['version.json', 'asset-pack.json', 'index.html', 'sw.js', 'manifest.webmanifest'];

function readRegular(root, name) {
  if (name.split('/').some(part => !part || part === '.' || part === '..')) throw Error(`Unsafe asset path: ${name}`);
  let current = root;
  for (const part of ['', ...name.split('/')]) {
    if (part) current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw Error(`Symlink in public build: ${name}`);
  }
  if (!fs.statSync(current).isFile()) throw Error(`Not a regular asset: ${name}`);
  return fs.readFileSync(current);
}

function plan(source, allowEmpty) {
  if (allowEmpty && (!fs.existsSync(source)
    || fs.readdirSync(source).every(name => ['_releases', '_assets'].includes(name)))) return null;
  const version = JSON.parse(readRegular(source, 'version.json'));
  const manifest = JSON.parse(readRegular(source, 'asset-pack.json'));
  if (!SHA.test(version.gitSha) || manifest.build !== version.gitSha
    || ![1, 2].includes(manifest.schema) || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw Error('Public version.json and asset-pack.json must identify the same full SHA');
  }
  const entries = new Map();
  for (const file of manifest.files) {
    const name = typeof file.path === 'string' && file.path.startsWith('/') ? file.path.slice(1) : '';
    if (!PUBLIC.test(name) || entries.has(name) || !HASH.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw Error(`Invalid public inventory: ${file.path}`);
    const bytes = readRegular(source, name);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw Error(`Asset checksum mismatch: ${name}`);
    entries.set(name, { path: name, bytes: bytes.length, sha256: file.sha256 });
  }
  for (const name of SHELL) {
    const bytes = readRegular(source, name);
    entries.set(name, { path: name, bytes: bytes.length, sha256: digest(bytes) });
  }
  const files = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { source, build: version.gitSha, files, receipt: JSON.stringify({ schema: 1, build: version.gitSha, files }, null, 2) + '\n' };
}

function sameFile(root, file) {
  const bytes = readRegular(root, file.path);
  if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw Error(`Immutable asset differs: ${file.path}`);
}

function ensureParent(root, name) {
  let parent = root;
  for (const part of name.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    if (!fs.existsSync(parent)) { fs.mkdirSync(parent); fs.chmodSync(parent, 0o755); }
    if (fs.lstatSync(parent).isSymbolicLink()) throw Error('Retention directory cannot be a symlink');
  }
}

function writeFile(root, file, source) {
  // Verify again when copying: a changed source cannot pass an earlier audit.
  const bytes = readRegular(source, file.path);
  if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw Error(`Asset changed during retention: ${file.path}`);
  const target = path.join(root, file.path);
  ensureParent(root, file.path);
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o444 });
  fs.chmodSync(target, 0o444); // deploy may use umask 077; Caddy still needs read access.
}

function verifySnapshot(item, target) {
  const receipt = readRegular(target, 'retention.json');
  if (receipt.toString() !== item.receipt) throw Error(`Immutable build already exists with different bytes: ${item.build}`);
  if (readRegular(target, 'retention.sha256').toString().trim() !== digest(receipt)) throw Error('Retention receipt checksum mismatch');
  for (const file of item.files) sameFile(target, file);
}

function validTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw Error('A verified UTC build timestamp is required');
  return value;
}

export function retainedBuildTime(webRoot, build, proposed) {
  if (!SHA.test(build)) throw Error('A full build SHA is required');
  const root = path.resolve(webRoot), snapshot = path.join(root, '_releases', build);
  if (fs.existsSync(snapshot)) {
    const item = plan(snapshot, false);
    if (item.build !== build) throw Error('Retained build identity differs');
    verifySnapshot(item, snapshot);
    return validTime(JSON.parse(readRegular(snapshot, 'version.json')).builtAt);
  }
  // Bootstrap an existing same-SHA deployment before snapshots were introduced.
  if (fs.existsSync(path.join(root, 'version.json'))) {
    const version = JSON.parse(readRegular(root, 'version.json'));
    if (version.gitSha === build) {
      plan(root, false);
      return validTime(version.builtAt);
    }
  }
  return validTime(proposed);
}

function publishChunk(chunks, file, source, lock) {
  const stage = path.join(lock, randomUUID());
  fs.mkdirSync(stage);
  try {
    writeFile(stage, file, source);
    sameFile(stage, file);
    ensureParent(chunks, file.path);
    // link is an atomic create-only publication on this same filesystem. Unlike
    // rename it cannot replace an existing immutable path, even during a race.
    fs.linkSync(path.join(stage, file.path), path.join(chunks, file.path));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

export function retainWebAssets(previousRoot, candidateRoot, webRoot) {
  // Both packs must pass before any snapshot/static publication takes place.
  const plans = [plan(path.resolve(previousRoot), true), plan(path.resolve(candidateRoot), false)].filter(Boolean);
  const builds = new Map(), assetPaths = new Map();
  for (const item of plans) {
    if (builds.has(item.build) && builds.get(item.build) !== item.receipt) throw Error('One SHA cannot identify two different public builds');
    builds.set(item.build, item.receipt);
    for (const file of item.files.filter(file => file.path.startsWith('assets/'))) {
      if (assetPaths.has(file.path) && assetPaths.get(file.path) !== file.sha256) throw Error(`Content-hashed chunk path reused: ${file.path}`);
      assetPaths.set(file.path, file.sha256);
    }
  }
  const root = path.resolve(webRoot);
  for (const directory of [root, path.join(root, '_releases'), path.join(root, '_assets')]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Retention roots cannot be symlinks');
    fs.chmodSync(directory, 0o755);
  }
  const releases = path.join(root, '_releases');
  const chunks = path.join(root, '_assets');
  const lock = path.join(releases, '.lock');
  fs.mkdirSync(lock); // Fail closed if another publication is in progress.
  try {
    for (const item of plans) {
      const target = path.join(releases, item.build);
      if (fs.existsSync(target)) verifySnapshot(item, target);
      for (const file of item.files.filter(file => file.path.startsWith('assets/'))) {
        if (fs.existsSync(path.join(chunks, file.path))) sameFile(chunks, file);
      }
    }
    for (const item of plans) {
      const target = path.join(releases, item.build);
      if (!fs.existsSync(target)) {
        const stage = path.join(releases, `.stage-${randomUUID()}`);
        fs.mkdirSync(stage, { mode: 0o755 });
        fs.chmodSync(stage, 0o755);
        try {
          for (const file of item.files) writeFile(stage, file, item.source);
          fs.writeFileSync(path.join(stage, 'retention.json'), item.receipt, { flag: 'wx', mode: 0o444 });
          fs.writeFileSync(path.join(stage, 'retention.sha256'), digest(item.receipt) + '\n', { flag: 'wx', mode: 0o444 });
          fs.chmodSync(path.join(stage, 'retention.json'), 0o444);
          fs.chmodSync(path.join(stage, 'retention.sha256'), 0o444);
          fs.renameSync(stage, target);
        } finally { fs.rmSync(stage, { recursive: true, force: true }); }
      }
      for (const file of item.files.filter(file => file.path.startsWith('assets/'))) {
        if (!fs.existsSync(path.join(chunks, file.path))) publishChunk(chunks, file, item.source, lock);
      }
    }
    return plans.map(item => ({ build: item.build, files: item.files.length }));
  } finally { fs.rmdirSync(lock); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--build-time') {
    console.log(retainedBuildTime(args[1], args[2], args[3]));
  } else {
    const [previous, candidate, root] = args;
    if (!previous || !candidate || !root) throw Error('Usage: node infra/retain-web-assets.mjs <previous-dist> <candidate-dist> <published-root>');
    console.log(JSON.stringify(retainWebAssets(previous, candidate, root)));
  }
}
