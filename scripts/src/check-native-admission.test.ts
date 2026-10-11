import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ADMISSION_FIELDS, assertAdmissionParity, checkNativeAdmission, normalizeAdmission, readContainerAdmission, type ContainerProbe } from './check-native-admission';

const alice = 'A'.repeat(32); const bob = 'B'.repeat(32);
const defaults = { ALPHA_WALLETS: null, ADMIN_WALLETS: null, PLAYTEST_OPEN: null, MULTI_BASE_ENABLED: null };

describe('native companion admission deployment gate', () => {
  it('compares effective sets and flag defaults without treating formatting as an access change', () => {
    expect(() => assertAdmissionParity({ ...defaults, ALPHA_WALLETS: `${alice}, ${bob},${alice}` },
      { ...defaults, ALPHA_WALLETS: ` ${bob}, ${alice}, `, ADMIN_WALLETS: ' ', PLAYTEST_OPEN: 'false', MULTI_BASE_ENABLED: 'false' })).not.toThrow();
    expect(normalizeAdmission(defaults)).toEqual({ ALPHA_WALLETS: null, ADMIN_WALLETS: null, PLAYTEST_OPEN: false, MULTI_BASE_ENABLED: false });
  });

  it('preserves closed empty alpha lists and unset admin surfaces', () => {
    for (const field of ['ALPHA_WALLETS', 'ADMIN_WALLETS']) {
      expect(() => assertAdmissionParity(defaults, { ...defaults, [field]: ', ,' })).toThrow(field);
    }
  });

  it.each(ADMISSION_FIELDS)('blocks admission drift in %s and only reports the field name', (field) => {
    const value = field.endsWith('WALLETS') ? alice : 'true';
    expect(() => assertAdmissionParity(defaults, { ...defaults, [field]: value })).toThrow(`native admission mismatch: ${field}`);
  });

  it('fails closed on malformed or incomplete projections without printing their values', () => {
    for (const invalid of [undefined, [], {}, { ...defaults, EXTRA: 'secret' },
      { ...defaults, ALPHA_WALLETS: 'secret' }, { ...defaults, ADMIN_WALLETS: '0'.repeat(44) },
      { ...defaults, PLAYTEST_OPEN: 'TRUE' }, { ...defaults, MULTI_BASE_ENABLED: '' }]) {
      expect(() => normalizeAdmission(invalid)).toThrow();
      try { normalizeAdmission(invalid); } catch (error) { expect(String(error)).not.toContain('secret'); }
    }
  });

  it('projects exactly four keys inside the container, never a whole environment', () => {
    const run = vi.fn<ContainerProbe>().mockReturnValue(JSON.stringify(defaults));
    expect(readContainerAdmission('main-api-1', run)).toEqual(defaults);
    const [program, args, options] = run.mock.calls[0]!;
    expect(program).toBe('docker');
    expect(args!.slice(0, 4)).toEqual(['exec', 'main-api-1', 'node', '-e']);
    const script = args![4]!;
    // Execute the exact projection with a canary secret to verify the boundary.
    const output = execFileSync(process.execPath, ['-e', script], {
      env: { JWT_SECRET: 'must-never-cross-boundary', ALPHA_WALLETS: alice }, encoding: 'utf8',
    });
    expect(JSON.parse(output)).toEqual({ ...defaults, ALPHA_WALLETS: alice });
    expect(output).not.toContain('must-never-cross-boundary');
    expect(options).toMatchObject({ stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 });
  });

  it('redacts subprocess and malformed-output failures and refuses option injection', () => {
    for (const run of [vi.fn<ContainerProbe>(() => { throw new Error('secret'); }),
      vi.fn<ContainerProbe>().mockReturnValue('secret')]) {
      expect(() => readContainerAdmission('api', run)).toThrow('cannot verify selected container admission settings');
    }
    const run = vi.fn<ContainerProbe>();
    expect(() => readContainerAdmission('--privileged', run)).toThrow('invalid container name');
    expect(run).not.toHaveBeenCalled();
    expect(() => checkNativeAdmission(['--main-container', 'api', '--companion-container', 'api'])).toThrow('distinct');
  });
});
