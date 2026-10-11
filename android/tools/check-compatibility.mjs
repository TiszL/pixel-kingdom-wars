#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supported = JSON.parse(await readFile(path.join(root, 'native-compatibility.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'client-pack.lock.json'), 'utf8'));
const render = JSON.parse(await readFile(path.join(root, 'app/src/main/assets/native/render-catalog.json'), 'utf8'));
if (!supported.simVersions.includes(lock.simVersion)) throw new Error('New SIM version requires explicit native renderer/fixture review');
if (!supported.catalogueSchemaVersions.includes(lock.schemaVersion)) throw new Error('Unsupported catalogue schema');
if (!supported.rendererContractVersions.includes(render.rendererContractVersion)) throw new Error('Content requires a reviewed native renderer contract');
if(render.archivePresentation) {
  const archive=render.archivePresentation;
  if(archive.version!==1||archive.mode!=='currentWebArchive'||!Number.isSafeInteger(archive.minimumSimVersion)||archive.minimumSimVersion<=0||
    archive.maximumSimVersion!==lock.simVersion||archive.minimumSimVersion>archive.maximumSimVersion)
    throw new Error('Archived event presentation must retain the exact live SIM boundary');
  {
    const legacy=archive.legacyMelee;
    if(legacy?.mode!=='sourceIdleAttack'||!Number.isSafeInteger(legacy.targetAwareSimVersion)||legacy.targetAwareSimVersion<=0||
      !Number.isSafeInteger(legacy.selfDescribingSimVersion)||legacy.selfDescribingSimVersion<=legacy.targetAwareSimVersion||
      legacy.selfDescribingSimVersion>archive.maximumSimVersion||!Number.isFinite(legacy.positionSnapDistance)||legacy.positionSnapDistance<=0||
      !Number.isFinite(legacy.aim?.minimumDeltaSquared)||legacy.aim.minimumDeltaSquared<=0||
      !Number.isFinite(legacy.aim?.retainWithinDegrees)||legacy.aim.retainWithinDegrees<0||legacy.aim.retainWithinDegrees>=180)
      throw new Error('Archived legacy melee presentation is incomplete');
  }
}
console.log(`Supported pinned content: SIM${lock.simVersion}; player parity remains ${supported.releaseReady ? 'declared ready' : 'incomplete'}`);
