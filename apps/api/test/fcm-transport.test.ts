import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { fcmMessage, makeFcmTransport, nativePushPayload, type NativePushTarget } from '../src/notifications/fcm';
import { loadConfig } from '../src/config';

vi.mock('firebase-admin/app', () => ({ cert: vi.fn(() => 'test-credential'), initializeApp: vi.fn(() => 'test-app') }));
vi.mock('firebase-admin/messaging', () => ({ getMessaging: vi.fn(() => ({ send: vi.fn(async () => 'test-id') })) }));
const baseEnv = { DATABASE_URL: 'postgres://x:y@localhost:5433/example', JWT_SECRET: 'test-secret-test-secret-test-secret!', WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
const target: NativePushTarget = {
  id: randomUUID(), wallet: 'server-only-wallet', token: 'test-token', bindingId: randomUUID(),
  packageName: 'gg.pixelkingdomwars.twa.debug', enabledAt: new Date(),
};
const options = { ttl: 3600, urgency: 'normal', topic: 'mail', timeout: 5000 } as const;
const payload = { kind: 'mail', tag: 'mail', title: 'NEW MAIL', body: 'Read your report', url: '/?screen=mail' } as const;
afterEach(() => vi.clearAllMocks());

describe('official FCM transport without provider actions', () => {
  it('requires a deliberate complete flag and an absolute credential path, independently of VAPID', () => {
    expect(loadConfig(baseEnv).FCM_NOTIFICATIONS_ENABLED).toBe('false');
    expect(() => loadConfig({ ...baseEnv, FCM_NOTIFICATIONS_ENABLED: 'TRUE' })).toThrow(/FCM_NOTIFICATIONS_ENABLED/);
    expect(() => loadConfig({ ...baseEnv, FCM_NOTIFICATIONS_ENABLED: 'true' })).toThrow(/FCM_SERVICE_ACCOUNT_FILE/);
    expect(() => loadConfig({ ...baseEnv, FCM_SERVICE_ACCOUNT_FILE: '{"private_key":"never inline"}' })).toThrow(/absolute/);
    expect(loadConfig({ ...baseEnv, FCM_NOTIFICATIONS_ENABLED: 'true', FCM_SERVICE_ACCOUNT_FILE: '/run/secrets/fcm.json', MINE_FULL_NOTIFICATIONS_ENABLED: 'true' }))
      .toMatchObject({ FCM_NOTIFICATIONS_ENABLED: 'true', PUSH_NOTIFICATIONS_ENABLED: 'false', MINE_FULL_NOTIFICATIONS_ENABLED: 'true' });
  });

  it('does not load credentials or initialize Firebase while dark, even with a bogus configured path', () => {
    expect(makeFcmTransport({ FCM_NOTIFICATIONS_ENABLED: 'false', FCM_SERVICE_ACCOUNT_FILE: '/does-not-exist/fcm.json' })).toBeNull();
    expect(cert).not.toHaveBeenCalled(); expect(initializeApp).not.toHaveBeenCalled(); expect(getMessaging).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable, non-file or broadly readable credentials without exposing their content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkw-fcm-test-'));
    try {
      const file = join(dir, 'test.json');
      writeFileSync(file, 'FAKE_SECRET_MUST_NOT_LEAK', { mode: 0o600 });
      for (const path of [dir, join(dir, 'missing.json'), file]) {
        let message = '';
        try { makeFcmTransport({ FCM_NOTIFICATIONS_ENABLED: 'true', FCM_SERVICE_ACCOUNT_FILE: path }); } catch (e) { message = (e as Error).message; }
        expect(message).toMatch(/valid owner-readable/); expect(message).not.toContain('FAKE_SECRET');
      }
      writeFileSync(file, '{}'); chmodSync(file, 0o644);
      expect(() => makeFcmTransport({ FCM_NOTIFICATIONS_ENABLED: 'true', FCM_SERVICE_ACCOUNT_FILE: file })).toThrow(/0600/);
      expect(initializeApp).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('passes only data strings, the original token/package and TTL to the SDK; no wallet or auto-display object', async () => {
    const eventId = randomUUID();
    const data = nativePushPayload(target, payload, eventId);
    expect(fcmMessage(target, data, options)).toEqual({
      token: target.token, data: { version: '1', bindingId: target.bindingId, eventId, kind: 'mail', title: 'NEW MAIL', body: 'Read your report', url: '/?screen=mail' },
      android: { restrictedPackageName: target.packageName, priority: 'normal', ttl: 3_600_000 },
    });
    const dir = mkdtempSync(join(tmpdir(), 'pkw-fcm-test-'));
    try {
      const file = join(dir, 'test.json'); writeFileSync(file, '{}', { mode: 0o600 });
      const transport = makeFcmTransport({ FCM_NOTIFICATIONS_ENABLED: 'true', FCM_SERVICE_ACCOUNT_FILE: file });
      await transport!(target, data, options);
      expect(cert).toHaveBeenCalledWith({});
      expect(getMessaging).toHaveBeenCalledWith('test-app');
      const send = vi.mocked(getMessaging).mock.results[0]!.value.send;
      expect(send).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledWith(fcmMessage(target, data, options));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('bounds display text without splitting a surrogate pair and retains canonical navigation', () => {
    const data = nativePushPayload(target, { ...payload, title: 'x'.repeat(119) + '🛡', body: 'y'.repeat(499) + '🛡' }, randomUUID());
    expect(data.title).toBe('x'.repeat(119)); expect(data.body).toBe('y'.repeat(499)); expect(data.url).toBe('/?screen=mail');
  });
});
