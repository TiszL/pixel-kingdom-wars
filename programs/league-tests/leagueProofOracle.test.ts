/** C3 oracle contracts authored before the helper. Mock subprocesses only:
 * importing or running these cases never starts OpenSSL, a validator or a key factory. */
import { expect } from 'chai';
import { createKeccakOracle, deriveOracleRecord, readFinalizedTransactionWithRetry, resolveOpenSsl, OPENSSL_ENV, REVIEWED_OPENSSL,
  type OracleInput, type OracleCommand } from './leagueProofOracle';

const EMPTY = 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const input = (): OracleInput => ({ programIdHex: '11'.repeat(32), configHex: '22'.repeat(32),
  weekStart: '345600', leaves: [0, 1, 2].map(index => ({ index, claimantHex: '33'.repeat(32), amount: String(index + 1) })) });
function mock() {
  const calls: Array<{ args: readonly string[]; input: string }> = [];
  let sequence = 0;
  const state = { algorithm: true, badKat: false, failDigest: false, shortDigest: false, badVersion: false };
  const command: OracleCommand = (args, bytes) => {
    calls.push({ args: [...args], input: Buffer.from(bytes ?? []).toString('hex') });
    if (args[0] === 'list') return { status: 0, stdout: Buffer.from(state.algorithm ? '  KECCAK-256 @ default\n' : 'SHA3-256\n'), stderr: Buffer.alloc(0) };
    if (args[0] === 'version') return { status: 0, stdout: Buffer.from(state.badVersion ? 'unknown' : 'OpenSSL 3.6.1 mock'), stderr: Buffer.alloc(0) };
    const kat = (bytes?.length ?? 0) === 0;
    return { status: state.failDigest ? 1 : 0,
      stdout: kat ? Buffer.from(state.badKat ? '00'.repeat(32) : EMPTY, 'hex') : Buffer.alloc(state.shortDigest ? 31 : 32, ++sequence),
      stderr: Buffer.alloc(0) };
  };
  return { calls, state, command };
}

describe('C3 independent oracle evidence step / pure command contracts', () => {
  it('checks algorithm availability and the empty KAT before hashing any public leaf', () => {
    const h = mock(), oracle = createKeccakOracle(h.command);
    const record = deriveOracleRecord(input(), oracle);
    expect(h.calls[0].args).to.deep.equal(['list', '-digest-algorithms']);
    const hashes = h.calls.filter(call => call.args[0] === 'dgst');
    expect(hashes[0].input).to.equal('');
    expect(hashes.every(call => call.args.join(' ') === 'dgst -KECCAK-256 -binary')).to.equal(true);
    expect(record.knownAnswer).to.equal(EMPTY);
    expect(record.total).to.equal('6');
    expect(hashes).to.have.length(6); // KAT + three leaves + two nodes, no duplicate odd node.
  });
  it('refuses an unavailable algorithm without fallback or vector hashing', () => {
    const h = mock(); h.state.algorithm = false;
    expect(() => createKeccakOracle(h.command)).to.throw('KECCAK-256 unavailable');
    expect(h.calls).to.have.length(1);
  });
  it('refuses a wrong empty-input answer before any leaf is hashed', () => {
    const h = mock(); h.state.badKat = true;
    expect(() => createKeccakOracle(h.command)).to.throw('Keccak empty-input known-answer check failed');
    expect(h.calls.filter(call => call.args[0] === 'dgst')).to.have.length(1);
  });
  it('refuses a failed digest subprocess', () => {
    const h = mock(); h.state.failDigest = true;
    expect(() => createKeccakOracle(h.command)).to.throw('OpenSSL digest failed');
  });
  it('refuses non-OpenSSL implementation metadata', () => {
    const h = mock(); h.state.badVersion = true;
    expect(() => createKeccakOracle(h.command)).to.throw('OpenSSL identity unavailable');
  });
  it('refuses a truncated digest without accepting a partial root', () => {
    const h = mock(), oracle = createKeccakOracle(h.command); h.state.shortDigest = true;
    expect(() => deriveOracleRecord(input(), oracle)).to.throw('OpenSSL digest failed');
  });
  it('pins exact byte order, odd-node promotion, sums and proof sides', () => {
    const h = mock(), record = deriveOracleRecord(input(), createKeccakOracle(h.command));
    expect(record.hashes[0].preimageHex).to.equal(`06${'11'.repeat(32)}${'22'.repeat(32)}00460500000000000000${'33'.repeat(32)}0100000000000000`);
    expect(record.hashes[3].preimageHex).to.equal(`07${'01'.repeat(32)}0100000000000000${'02'.repeat(32)}0200000000000000`);
    expect(record.hashes[4].preimageHex).to.equal(`07${'04'.repeat(32)}0300000000000000${'03'.repeat(32)}0300000000000000`);
    expect(record.rootHex).to.equal('05'.repeat(32));
    expect(record.proofs[0]).to.deep.equal([{ hashHex: '02'.repeat(32), sum: '2', isLeft: false }, { hashHex: '03'.repeat(32), sum: '3', isLeft: false }]);
    expect(record.proofs[2]).to.deep.equal([{ hashHex: '04'.repeat(32), sum: '3', isLeft: true }]);
  });
  it('sorts indexes before deriving the ordered commitment without mutating the caller', () => {
    const source = input(); source.leaves.reverse();
    const record = deriveOracleRecord(source, createKeccakOracle(mock().command));
    expect(record.input.leaves.map(leaf => leaf.index)).to.deep.equal([0, 1, 2]);
    expect(source.leaves.map(leaf => leaf.index)).to.deep.equal([2, 1, 0]);
    source.leaves[0].amount = '99'; expect(record.input.leaves[2].amount).to.equal('3');
  });
  for (const field of ['programIdHex', 'configHex'] as const) {
    it(`refuses malformed public ${field} before leaf hashing`, () => {
      const value = input(); value[field] = 'ab'; const h = mock(), oracle = createKeccakOracle(h.command);
      expect(() => deriveOracleRecord(value, oracle)).to.throw('Invalid oracle public input');
      expect(h.calls.filter(call => call.args[0] === 'dgst')).to.have.length(1);
    });
  }
  for (const edit of [
    (v: OracleInput) => { v.leaves = []; },
    (v: OracleInput) => { v.leaves[1].index = 0; },
    (v: OracleInput) => { v.leaves[0].index = -1; },
    (v: OracleInput) => { v.leaves[0].index = 65536; },
    (v: OracleInput) => { v.leaves[0].claimantHex = '00'; },
    (v: OracleInput) => { v.leaves[0].amount = '0'; },
    (v: OracleInput) => { v.leaves[0].amount = '18446744073709551616'; },
    (v: OracleInput) => { v.weekStart = '9223372036854775808'; },
    (v: OracleInput) => { v.weekStart = 'not-a-number'; },
  ]) {
    it(`refuses malformed vector input ${edit.toString()}`, () => {
      const value = input(); edit(value);
      expect(() => deriveOracleRecord(value, createKeccakOracle(mock().command))).to.throw('Invalid oracle public input');
    });
  }
  it('refuses overflow of the committed total', () => {
    const value = input(); value.leaves[0].amount = '18446744073709551615';
    expect(() => deriveOracleRecord(value, createKeccakOracle(mock().command))).to.throw('Oracle sum overflow');
  });
});


// 3b2eb18f / ea9fe4d6: bounded history-lag recovery, a separate named mock step.
// Authored before the retry helper; injected reads/waits perform no RPC/timers.
describe('C3 finalized transaction history retry', () => {
  it('returns an available transaction immediately without waiting', async () => {
    const transaction = { slot: 123, meta: { err: null } };
    let reads = 0; const delays: number[] = [];
    const result = await readFinalizedTransactionWithRetry(async () => { reads++; return transaction; },
      async milliseconds => { delays.push(milliseconds); });
    expect(result).to.equal(transaction);
    expect(reads).to.equal(1);
    expect(delays).to.deep.equal([]);
  });
  it('retries transient null history and returns the same finalized record', async () => {
    const transaction = { slot: 456, meta: { err: null } };
    let reads = 0; const delays: number[] = [];
    const result = await readFinalizedTransactionWithRetry(async () => ++reads < 3 ? null : transaction,
      async milliseconds => { delays.push(milliseconds); });
    expect(result).to.equal(transaction);
    expect(reads).to.equal(3);
    expect(delays).to.deep.equal([200, 200]);
  });
  it('stops after ten retries and leaves persistent absence null for the validator refusal', async () => {
    let reads = 0; const delays: number[] = [];
    const result = await readFinalizedTransactionWithRetry(async () => { reads++; return null; },
      async milliseconds => { delays.push(milliseconds); });
    expect(result).to.equal(null);
    expect(reads).to.equal(11);
    expect(delays).to.deep.equal(Array(10).fill(200));
  });
  it('propagates a provider failure instead of treating it as missing history', async () => {
    const failure = new Error('history provider failed');
    let reads = 0; const delays: number[] = []; let caught: unknown;
    try {
      await readFinalizedTransactionWithRetry(async () => { reads++; throw failure; },
        async milliseconds => { delays.push(milliseconds); });
    } catch (error: unknown) { caught = error; }
    expect(caught).to.equal(failure);
    expect(reads).to.equal(1);
    expect(delays).to.deep.equal([]);
  });
});

// 2026-10-10 (f5061e30): the oracle hard-coded the macOS Homebrew path, so it could never run on a Linux
// CI runner. The reviewed default stays; another host must name its binary explicitly and absolutely,
// and a missing binary is a loud refusal, never a PATH lookup or silent substitute.
describe('C3 OpenSSL selection', () => {
  const files = (...paths: string[]) => (path: string) => paths.includes(path);
  it('uses the reviewed Homebrew OpenSSL when no override is set', () => {
    expect(resolveOpenSsl({}, files(REVIEWED_OPENSSL))).to.equal(REVIEWED_OPENSSL);
  });
  it('prefers an explicit absolute override over the default', () => {
    expect(resolveOpenSsl({ [OPENSSL_ENV]: '/opt/openssl-3.6/bin/openssl' },
      files(REVIEWED_OPENSSL, '/opt/openssl-3.6/bin/openssl'))).to.equal('/opt/openssl-3.6/bin/openssl');
  });
  it('refuses a relative override instead of searching PATH or falling back', () => {
    expect(() => resolveOpenSsl({ [OPENSSL_ENV]: 'openssl' }, files(REVIEWED_OPENSSL, 'openssl'))).to.throw(OPENSSL_ENV);
  });
  it('refuses an override that is not an existing file', () => {
    expect(() => resolveOpenSsl({ [OPENSSL_ENV]: '/missing/openssl' }, files(REVIEWED_OPENSSL))).to.throw(OPENSSL_ENV);
  });
  it('refuses when neither an override nor the reviewed default exists', () => {
    expect(() => resolveOpenSsl({}, files())).to.throw(OPENSSL_ENV);
  });
});
