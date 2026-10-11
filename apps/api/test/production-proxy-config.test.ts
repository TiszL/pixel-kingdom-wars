/**
 * The production origin is DNS-only: Caddy's socket peer is the real client. A
 * header matcher that trusts CF-Connecting-IP would let any direct caller forge
 * a fresh rate-limit identity. Keep this as a static deployment-contract test,
 * alongside proxy.test.ts's observable Fastify one-hop checks.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const activeDirectives = (file: string): string => readFileSync(file, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .join('\n');

describe('production proxy identity contract', () => {
  it('mounts the audited VPS Caddyfile', () => {
    const compose = activeDirectives(path.join(repoRoot, 'infra/docker-compose.prod.yml'));
    expect(compose).toContain('./Caddyfile.vps:/etc/caddy/Caddyfile:ro');
  });

  it('never trusts a caller-supplied Cloudflare identity and overwrites XFF', () => {
    const caddy = activeDirectives(path.join(repoRoot, 'infra/Caddyfile.vps'));

    expect(caddy).not.toMatch(/CF-Connecting-IP/i);
    expect(caddy).not.toMatch(/^@\S+\s+header\b/im);
    expect(caddy.match(/^header_up X-Forwarded-For \{remote_host\}$/gm)).toHaveLength(1);
    expect(caddy).not.toMatch(/^header_up X-Forwarded-For (?!\{remote_host\}$).+/gm);
  });
});
