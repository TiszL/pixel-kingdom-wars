import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('native JVM and physical-input fixtures match the authoritative source deployment policy', async () => {
  const source = path.resolve(process.env.PKW_NATIVE_SOURCE ?? '.source');
  const canonical = await readFile(path.join(source, 'packages/shared/src/battlefield.parity.json'));
  for (const target of ['renderer/src/test/resources/battlefield.parity.json',
    'app/src/androidTest/assets/battle-reliability/battlefield.parity.json']) {
    assert.deepEqual(await readFile(new URL(`../${target}`, import.meta.url)), canonical,
      `${target} must be refreshed from the source; stale fixtures cannot certify deployment parity`);
  }
});
