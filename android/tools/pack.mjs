import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Schema v1 uses fixed metadata locations. Fixing their values keeps the original immutable
// digest compatible while preventing unhashed path fields from redirecting generated outputs.
export const metadataPaths = { cataloguePath: 'catalogue.json', renderCataloguePath: 'render-catalog.json',
  atlasMetadataPath: 'atlas/meta.json', contractPath: 'contracts.json', kotlinModelsPath: 'kotlin/NativeContracts.kt' };
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') ||
      value.split('/').some((p) => p === '..' || p === '.' || !p) || /[\x00-\x1f:]/.test(value)) {
    throw new Error('Unsafe content path');
  }
  return value;
}
export function manifestVersion(manifest) {
  return sha256(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    sourceCommit: manifest.sourceCommit,
    simVersion: manifest.simVersion,
    files: manifest.files,
  }));
}
export async function regularFile(root, relative) {
  safeRelative(relative);
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('Content must be a regular file with no symlink ancestors');
    }
  }
  return current;
}
export async function verifiedBytes(root, file) {
  const bytes = await readFile(await regularFile(root, file.path));
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Content integrity failed: ${file.path}`);
  return bytes;
}
export async function verifyPack(directory) {
  const root = await realpath(directory);
  const manifestFile = await regularFile(root, 'manifest.json');
  if ((await lstat(manifestFile)).size > 16 * 1024 * 1024) throw new Error('Manifest exceeds supported size');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
      !Number.isSafeInteger(manifest.simVersion) || manifest.simVersion < 1 ||
      !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 20000) {
    throw new Error('Unsupported or malformed contract pack');
  }
  if (manifestVersion(manifest) !== manifest.contentVersion) throw new Error('Manifest digest mismatch');
  const seen = new Set();
  let previous = '';
  let totalSize = 0;
  for (const file of manifest.files) {
    safeRelative(file.path);
    if (seen.has(file.path) || (previous && previous >= file.path)) throw new Error('Unsorted or duplicate content path');
    seen.add(file.path); previous = file.path;
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 ||
        !['core', 'optional'].includes(file.tier)) throw new Error('Invalid content descriptor');
    totalSize += file.size;
    if (totalSize > 2 * 1024 ** 3 || file.size > 512 * 1024 ** 2 || file.path === 'manifest.json') throw new Error('Unsupported content size or reserved manifest path');
    const filename = await regularFile(root, file.path);
    const stat = await lstat(filename);
    const resolved = await realpath(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || !resolved.startsWith(root + path.sep)) throw new Error('Content must be a regular file inside its pack');
    if (stat.size !== file.size || sha256(await readFile(filename)) !== file.sha256) throw new Error(`Content integrity failed: ${file.path}`);
  }
  for (const [key, expected] of Object.entries(metadataPaths)) {
    if (manifest[key] !== expected || !seen.has(expected) || manifest.files.find((file) => file.path === expected).tier !== 'core') {
      throw new Error(`Invalid ${key}: schema v1 requires verified core ${expected}`);
    }
  }
  return manifest;
}

/** Every atlas path a scene section of the render catalogue references must be core: the
 * content store installs core-tier files only, and the renderer reads paintings straight from
 * the catalogue (realm ground v1/v2). The `fantasy` section (globe art) is the one documented
 * exception until the globe renders on device; keep it out of `sections` deliberately. */
/** Record one exported file. Two sections may legitimately publish the same
 * immutable path (the layered-ground revisions share their motion clips); the
 * manifest keeps one entry, core if either section needs it. Different bytes
 * under one path can never be represented and fail the export. */
export function recordPackFile(files, entry) {
  const existing = files.find((file) => file.path === entry.path);
  if (!existing) { files.push(entry); return entry; }
  if (existing.sha256 !== entry.sha256 || existing.size !== entry.size) throw new Error(`Conflicting bytes for pack path ${entry.path}`);
  if (entry.tier === 'core') existing.tier = 'core';
  return existing;
}
export function promoteCatalogueReferences(files, renderCatalogue, sections) {
  const referenced = new Set();
  for (const section of sections) {
    const body = renderCatalogue[section];
    if (body === undefined) continue;
    for (const match of JSON.stringify(body).match(/atlas\/[A-Za-z0-9_\-./@]+/g) ?? []) referenced.add(match);
  }
  const promoted = [];
  for (const file of files) {
    if (!referenced.has(file.path) || file.tier === 'core') continue;
    file.tier = 'core'; promoted.push(file.path);
  }
  return promoted.sort();
}

