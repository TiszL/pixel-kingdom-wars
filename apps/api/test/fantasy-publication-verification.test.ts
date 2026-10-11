import { AwsClient } from 'aws4fetch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { r2Putter } from '../src/game/deedR2';

const config = { endpoint: 'http://127.0.0.1:19090', accessKeyId: 'local-test',
  secretAccessKey: 'local-test', bucket: 'local-test', publicBaseUrl: 'http://127.0.0.1:19090/local-test' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('fantasy publication order', () => {
  it('requires exact read-back after upload before acknowledging publication', async () => {
    vi.stubEnv('FANTASY_WORLD_ENABLED', 'true');
    const doc = JSON.stringify({ name: 'Land Deed', attributes: [{ trait_type: 'Realm', value: 'Crownlands' }] });
    const calls: string[] = [];
    vi.spyOn(AwsClient.prototype, 'fetch').mockImplementation(async (_url, init) => {
      calls.push(init?.method ?? 'GET');
      return new Response(init?.method === 'PUT' ? '' : doc, { status: 200 });
    });
    await r2Putter(config)('deed/asset/test.json', doc);
    expect(calls).toEqual(['PUT', 'GET']);
  });
  it('verifies picture bytes before allowing a matching fantasy document', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const fetch = vi.spyOn(AwsClient.prototype, 'fetch').mockImplementation(async (_url, init) => new Response(init?.method === 'PUT' ? null : png));
    await r2Putter(config)('deed/asset/test.png', Buffer.from(png), 'image/png');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not acknowledge stale or corrupted JSON even after a successful PUT', async () => {
    vi.stubEnv('FANTASY_WORLD_ENABLED', 'true');
    vi.spyOn(AwsClient.prototype, 'fetch').mockImplementation(async (_url, init) =>
      new Response(init?.method === 'PUT' ? '' : '{"old":"Earth"}', { status: 200 }));
    await expect(r2Putter(config)('deed/asset/test.json', '{"new":"Crownlands"}'))
      .rejects.toThrow('URI version remains unchanged');
  });
});
