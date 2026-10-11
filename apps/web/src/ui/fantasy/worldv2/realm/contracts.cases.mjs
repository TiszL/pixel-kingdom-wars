// contracts.mjs realm tables (stage B, D-170: Elderwood, Thornwake and Solana Reach join the five). A realm with a pack
// must enter like the others: its display name (map.mjs shows the raw id otherwise: 'seeker-reach' instead of Solana
// Reach), its deed count (qc-pack D2 fails the pack without it) and the HUD accent the globe uses (ui.test.mjs). These
// tests read the packs on disk, so a new pack whose contract entry is missing or wrong fails here, not in the owner's view.
import { PACK_ROOT } from './test-pack.support.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { DEED_COUNTS, REALM_NAMES, REALMS_WITH_MAPS, DEED_PX } from './contracts.mjs';
const sharp = createRequire(new URL('../../../../../../../scripts/package.json', import.meta.url).pathname)('sharp');
const PACK = PACK_ROOT + 'realm/';
const index = JSON.parse(readFileSync(PACK + 'index.json', 'utf8'));

test('every realm in pack/realm/index.json has its name and deed count in the contract, equal to its pack', async () => {
  const ids = index.realms.map(r => r.id);
  assert.ok(ids.length >= 8, `the index lists ${ids.length} realms (all eight have packs since catch-up A)`);
  for (const id of ['elderwood', 'thornwake', 'seeker-reach']) assert.ok(ids.includes(id), `${id} has a pack`);
  for (const r of index.realms) {
    assert.equal(REALM_NAMES[r.id], r.name, `${r.id}: REALM_NAMES = the pack index name`);
    assert.equal(DEED_COUNTS[r.id], r.deeds, `${r.id}: DEED_COUNTS = the pack index deeds`);
    const meta = JSON.parse(readFileSync(`${PACK}${r.id}/realm.json`, 'utf8'));
    assert.equal(DEED_COUNTS[r.id], meta.grid.deeds, `${r.id}: DEED_COUNTS = realm.json grid.deeds`);
    // D2 at the source: the deeds this realm owns in deeds.png (1 px per deed, 255 = this realm)
    const f = `${PACK}${r.id}/deeds.png`; if (!existsSync(f)) continue;
    const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true });
    let own = 0; for (let i = 0; i < data.length; i += info.channels) if (data[i] === DEED_PX.thisRealm) own++;
    assert.equal(own, DEED_COUNTS[r.id], `${r.id}: deeds.png owns ${own} deeds`);
  }
  // no stale entry: every contract realm has a pack
  for (const id of Object.keys(DEED_COUNTS)) assert.ok(ids.includes(id), `${id}: DEED_COUNTS names a realm with no pack`);
  for (const id of Object.keys(REALM_NAMES)) assert.ok(ids.includes(id), `${id}: REALM_NAMES names a realm with no pack`);
});

test('the Solana Reach realm id keeps its display name (the owner\'s special realm, D-170)', () => {
  assert.equal(REALM_NAMES['seeker-reach'], 'Solana Reach');
  assert.equal(DEED_COUNTS['seeker-reach'], 5585);
});

test('REALMS_WITH_MAPS lists exactly the realms that have a pack (all eight since stage B)', () => {
  const ids = new Set(index.realms.map(r => r.id));
  for (const id of REALMS_WITH_MAPS) assert.ok(ids.has(id), `${id} is listed but has no pack`);
  // a packed realm left out gets no bases from PACK's base-atlas.mjs (it builds only listed realms)
  for (const id of ids) assert.ok(REALMS_WITH_MAPS.includes(id), `${id} has a pack but is not in REALMS_WITH_MAPS`);
});
