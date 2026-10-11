/** C1/F5 tests first. Wallets, child lifecycle and transport below are mocks.
 * No test here creates a key, starts a validator or sends a transaction. */
import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey, SystemInstruction, SystemProgram, type Connection } from '@solana/web3.js';
import { ACCOUNT_SIZE, MINT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, decodeInitializeMint2Instruction, decodeInitializeAccount3Instruction,
  decodeMintToCheckedInstruction, decodeSetAuthorityInstruction, AuthorityType } from '@solana/spl-token';
import { LEAGUES, PHASE_E_LEAGUE_REWARDS } from '../../packages/shared/src/constants';
import {
  leagueFixture, buildLeagueFixturePlan, deriveLeagueFixturePolicy,
  LEAGUE_FIXTURE_ROLES, LEAGUE_FIXTURE_WINDOW_SEC, LEAGUE_FIXTURE_RPC,
  type LeagueFixtureDependencies, type LeagueFixtureActors, type LeagueFixtureAccounts,
} from './leagueFixture';

const LEAGUE_ID = '2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE';
const CORE_ID = 'mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b';
const publicKeys = Object.fromEntries(LEAGUE_FIXTURE_ROLES.map((role, index) => [role,
  new PublicKey(Buffer.alloc(32, index + 1))])) as Record<typeof LEAGUE_FIXTURE_ROLES[number], PublicKey>;
const mockWallet = (publicKey: PublicKey): AnchorProvider['wallet'] => ({
  publicKey,
  signTransaction: async () => { throw new Error('No real signing in fixture unit tests'); },
  signAllTransactions: async () => { throw new Error('No real signing in fixture unit tests'); },
});
const options = { admissionReceipt: 'owner-admitted-exact-fixture-source', programsDirectory: '/owned/composed/programs' };
function harness() {
  const calls: string[] = [];
  const connection = { rpcEndpoint: LEAGUE_FIXTURE_RPC } as Connection;
  const actors = Object.fromEntries(LEAGUE_FIXTURE_ROLES.map(role => [role, mockWallet(publicKeys[role])])) as LeagueFixtureActors;
  const accounts: LeagueFixtureAccounts = {
    mint: new PublicKey(Buffer.alloc(32, 20)), mintWithMintAuthority: new PublicKey(Buffer.alloc(32, 21)),
    mintWithFreezeAuthority: new PublicKey(Buffer.alloc(32, 22)), otherMint: new PublicKey(Buffer.alloc(32, 23)),
    token2022Mint: new PublicKey(Buffer.alloc(32, 24)), noncanonicalClaimantAccount: new PublicKey(Buffer.alloc(32, 25)),
    noncanonicalSweepAccount: new PublicKey(Buffer.alloc(32, 26)),
  };
  const state = { disposeCount: 0, startInput: undefined as unknown, providerEndpoint: LEAGUE_FIXTURE_RPC,
    corruptArtifact: '', provisionFails: false, verifyFails: false, disposeFails: false };
  const dependencies: LeagueFixtureDependencies = {
    readPublicFile: async file => {
      calls.push(`read:${basename(file)}`);
      if (state.corruptArtifact === basename(file)) return Buffer.from('invalid artifact');
      if (file.endsWith('.so')) return Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
      return Buffer.from(JSON.stringify({ address: file.endsWith('shardkeep_league.json') ? LEAGUE_ID : CORE_ID }));
    },
    ensurePortsFree: async () => { calls.push('ports'); },
    generateWallet: role => { calls.push(`wallet:${role}`); return actors[role]; },
    startValidator: async input => {
      calls.push('start'); state.startInput = input;
      return { connection, dispose: async () => { calls.push('dispose'); state.disposeCount++; if (state.disposeFails) throw new Error('mock cleanup failure'); } };
    },
    makeProvider: (providedConnection, wallet) => {
      calls.push('provider'); expect(providedConnection).to.equal(connection); expect(wallet).to.equal(actors.admin);
      return { connection: { ...connection, rpcEndpoint: state.providerEndpoint }, wallet } as AnchorProvider;
    },
    provision: async (_provider, providedActors) => {
      calls.push('provision'); expect(providedActors).to.deep.equal(actors);
      if (state.provisionFails) throw new Error('mock provisioning refused');
      return accounts;
    },
    verify: async () => { calls.push('verify'); if (state.verifyFails) throw new Error('mock fixture validation refused'); },
  };
  return { dependencies, calls, state, actors, accounts, connection };
}
async function rejected(action: () => Promise<unknown>, message: string) {
  let error: unknown;
  try { await action(); } catch (caught) { error = caught; }
  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message).to.include(message);
}

describe('league fixture factory — dependency-injected, no runtime', () => {
  it('validates public artifacts and fixed-port availability before exactly seven wallet generations', async () => {
    const h = harness();
    const handle = await leagueFixture(options, h.dependencies);
    expect(h.calls.filter(call => call.startsWith('read:')).sort()).to.deep.equal([
      'read:shardkeep_core.json', 'read:shardkeep_core.so', 'read:shardkeep_league.json', 'read:shardkeep_league.so',
    ]);
    expect(h.calls.filter(call => call.startsWith('wallet:'))).to.deep.equal(LEAGUE_FIXTURE_ROLES.map(role => `wallet:${role}`));
    expect(h.calls.indexOf('ports')).to.be.lessThan(h.calls.indexOf('wallet:admin'));
    expect(h.calls.indexOf('verify')).to.be.greaterThan(h.calls.indexOf('provision'));
    expect(handle.fixture.actors).to.deep.equal(h.actors);
    expect(handle.fixture.provider.connection.rpcEndpoint).to.equal('http://127.0.0.1:18899');
    expect(handle.fixture.shortWindowSec).to.equal(120);
    expect(handle.fixture.admissionReceipt).to.equal(options.admissionReceipt);
    expect(handle.fixture.mint.toBase58()).to.equal(h.accounts.mint.toBase58());
    const start = h.state.startInput as { admin: PublicKey; leagueProgramId: PublicKey; coreProgramId: PublicKey };
    expect(start.admin.equals(publicKeys.admin)).to.equal(true);
    expect(start.leagueProgramId.toBase58()).to.equal(LEAGUE_ID); expect(start.coreProgramId.toBase58()).to.equal(CORE_ID);
    expect(handle.fixture.otherProgramData.equals(PublicKey.findProgramAddressSync([
      new PublicKey(CORE_ID).toBuffer(),
    ], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0])).to.equal(true);
    await handle.dispose(); await handle.dispose(); expect(h.state.disposeCount).to.equal(1);
  });
  it('rejects blank metadata and relative programs paths without generating wallets or spawning', async () => {
    for (const changed of [{ admissionReceipt: '' }, { admissionReceipt: '   ' }, { programsDirectory: 'programs' }]) {
      const h = harness(); await rejected(() => leagueFixture({ ...options, ...changed }, h.dependencies), 'fixture');
      expect(h.calls).to.deep.equal([]);
    }
  });
  it('rejects missing or invalid ELF and IDL artifacts before wallet generation', async () => {
    for (const file of ['shardkeep_core.so', 'shardkeep_league.so', 'shardkeep_core.json', 'shardkeep_league.json']) {
      const h = harness(); h.state.corruptArtifact = file;
      await rejected(() => leagueFixture(options, h.dependencies), 'artifact');
      expect(h.calls.some(call => call.startsWith('wallet:'))).to.equal(false); expect(h.calls).not.to.include('start');
    }
    const h = harness(); h.dependencies.readPublicFile = async () => { throw new Error('missing artifact'); };
    await rejected(() => leagueFixture(options, h.dependencies), 'artifact');
    expect(h.calls).not.to.include('start');
  });
  it('rejects an occupied local port before generating any actors', async () => {
    const h = harness(); h.dependencies.ensurePortsFree = async () => { throw new Error('fixture port occupied'); };
    await rejected(() => leagueFixture(options, h.dependencies), 'occupied');
    expect(h.calls.some(call => call.startsWith('wallet:'))).to.equal(false);
  });
  it('refuses reused actor addresses before spawning a validator', async () => {
    const h = harness(); h.dependencies.generateWallet = () => h.actors.admin;
    await rejected(() => leagueFixture(options, h.dependencies), 'distinct'); expect(h.calls).not.to.include('start');
  });
  it('refuses a provider redirected away from the exact loopback endpoint and disposes its own validator', async () => {
    for (const endpoint of ['https://api.devnet.solana.com', 'http://127.0.0.1:8899', 'http://localhost:18899']) {
      const h = harness(); h.state.providerEndpoint = endpoint;
      await rejected(() => leagueFixture(options, h.dependencies), '18899');
      expect(h.state.disposeCount).to.equal(1); expect(h.calls).not.to.include('provision');
    }
  });
  it('cleans the acquired validator when provider construction fails', async () => {
    const h = harness(); h.dependencies.makeProvider = () => { throw new Error('provider failure'); };
    await rejected(() => leagueFixture(options, h.dependencies), 'provider failure'); expect(h.state.disposeCount).to.equal(1);
  });
  it('cleans the acquired validator when provisioning or final verification fails', async () => {
    for (const failure of ['provisionFails', 'verifyFails'] as const) {
      const h = harness(); h.state[failure] = true;
      await rejected(() => leagueFixture(options, h.dependencies), 'mock'); expect(h.state.disposeCount).to.equal(1);
    }
  });
  it('preserves setup and cleanup failures together when no handle can be returned', async () => {
    const h = harness(); h.state.provisionFails = true; h.state.disposeFails = true;
    let failure: unknown;
    try { await leagueFixture(options, h.dependencies); } catch (error) { failure = error; }
    expect(failure).to.be.instanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors).to.have.length(2);
    expect(errors[0].message).to.include('mock provisioning refused'); expect(errors[1].message).to.include('mock cleanup failure');
    expect(h.state.disposeCount).to.equal(1);
  });
  it('propagates pre-handle startup failure; lifecycle owns rollback until it returns', async () => {
    const h = harness(); h.dependencies.startValidator = async () => { throw new Error('owned validator failed readiness'); };
    await rejected(() => leagueFixture(options, h.dependencies), 'readiness');
    expect(h.calls).not.to.include('provision'); expect(h.state.disposeCount).to.equal(0);
  });
  it('contains no secret serialization, environment-wallet defaults or extra key factories in source', async () => {
    const source = await readFile(resolve(process.cwd(), 'league-tests/leagueFixture.ts'), 'utf8');
    expect(source).not.to.match(/\.secretKey\b|Keypair\.fromSecretKey|Keypair\.fromSeed|AnchorProvider\.env|process\.env|\bwriteFile\s*\(|\bconsole\./);
    expect(source.match(/Keypair\.generate\(\)/g)).to.have.length(1);
    expect(source).not.to.match(/\bcreateMint\s*\(|\bcreateAccount\s*\(/);
  });
});

describe('league fixture shared policy', () => {
  it('projects policy directly from shared source and keeps the explicit 120-second fixture window separate', () => {
    expect(deriveLeagueFixturePolicy()).to.deep.equal({ maxPlaces: PHASE_E_LEAGUE_REWARDS.v1.skr.maxPlaces,
      claimWindowMaxSec: BigInt(PHASE_E_LEAGUE_REWARDS.v1.skr.claimWindowMaxSec), settlementDelaySec: BigInt(LEAGUES.settlementDelayMs / 1000) });
    expect(LEAGUE_FIXTURE_WINDOW_SEC).to.equal(120);
  });
  it('refuses unsafe, empty, too-small and fractional policy inputs without fallback numbers', () => {
    const valid = { maxPlaces: 500, claimWindowMaxSec: 4838400, settlementDelayMs: 900000 };
    for (const change of [{ maxPlaces: 0 }, { maxPlaces: 7 }, { maxPlaces: 1025 }, { maxPlaces: 8.5 },
      { claimWindowMaxSec: 120 }, { claimWindowMaxSec: Number.MAX_SAFE_INTEGER + 1 },
      { settlementDelayMs: 0 }, { settlementDelayMs: -1 }, { settlementDelayMs: 1001 }]) {
      expect(() => deriveLeagueFixturePolicy({ ...valid, ...change })).to.throw('policy');
    }
  });
});

describe('league fixture transaction plan — public addresses only', () => {
  it('funds all six non-admin actors, including nextAdmin, without a generated account signer', async () => {
    const plan = await buildLeagueFixturePlan(publicKeys, { mint: 82, token: 165 });
    const funding = plan.batches.find(batch => batch.name === 'fund-actors')!;
    expect(funding.instructions).to.have.length(6);
    const transfers = funding.instructions.map(ix => SystemInstruction.decodeTransfer(ix));
    expect(transfers.map(item => item.toPubkey.toBase58())).to.deep.equal(LEAGUE_FIXTURE_ROLES.filter(role => role !== 'admin').map(role => publicKeys[role].toBase58()));
    expect(transfers.every(item => item.fromPubkey.equals(publicKeys.admin) && BigInt(item.lamports) > 0n)).to.equal(true);
    for (const batch of plan.batches) for (const instruction of batch.instructions) {
      expect(instruction.keys.filter(meta => meta.isSigner).every(meta => meta.pubkey.equals(publicKeys.admin))).to.equal(true);
    }
  });
  it('creates five distinct seeded mint accounts with the matching classic or Token-2022 owner', async () => {
    const plan = await buildLeagueFixturePlan(publicKeys, { mint: 82, token: 165 });
    const mintBatches = plan.batches.filter(batch => batch.name.startsWith('create-mint:'));
    expect(mintBatches).to.have.length(5);
    const addresses = new Set<string>();
    for (const batch of mintBatches) {
      const create = SystemInstruction.decodeCreateWithSeed(batch.instructions[0]);
      const tokenProgram = batch.name.endsWith('token2022') ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const initialize = decodeInitializeMint2Instruction(batch.instructions[1], tokenProgram);
      addresses.add(create.newAccountPubkey.toBase58());
      expect(create.basePubkey.equals(publicKeys.admin) && create.fromPubkey.equals(publicKeys.admin)).to.equal(true);
      expect(create.programId.equals(tokenProgram)).to.equal(true); expect(create.space).to.equal(MINT_SIZE);
      expect(initialize.keys.mint.pubkey.equals(create.newAccountPubkey)).to.equal(true);
      expect(initialize.data.mintAuthority.equals(publicKeys.admin)).to.equal(true);
      expect(initialize.data.decimals).to.equal(9);
      if (batch.name.endsWith('good') || batch.name.endsWith('freeze-authority')) expect(initialize.data.freezeAuthority?.equals(publicKeys.admin)).to.equal(true);
      else expect(initialize.data.freezeAuthority).to.equal(null);
    }
    expect(addresses.size).to.equal(5);
  });
  it('creates the required ATA topology but never nextAdmin good-mint ATA', async () => {
    const plan = await buildLeagueFixturePlan(publicKeys, { mint: 82, token: 165 });
    const created = plan.batches.filter(batch => batch.name.startsWith('create-ata:')).map(batch => batch.instructions[0].keys[1].pubkey.toBase58());
    const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true).toBase58();
    const expected = ['funder', 'claimant', 'second', 'stranger'].map(role => ata(plan.accounts.mint, publicKeys[role as keyof typeof publicKeys]));
    expected.push(ata(plan.accounts.otherMint, publicKeys.funder), ata(plan.accounts.otherMint, publicKeys.claimant),
      ata(plan.accounts.mintWithMintAuthority, publicKeys.funder), ata(plan.accounts.mintWithFreezeAuthority, publicKeys.funder));
    expect(created.sort()).to.deep.equal(expected.sort());
    expect(created).not.to.include(ata(plan.accounts.mint, publicKeys.nextAdmin));
  });
  it('mints more than 100000 raw to funder before revoking both good-mint authorities', async () => {
    const plan = await buildLeagueFixturePlan(publicKeys, { mint: 82, token: 165 });
    const finish = plan.batches.find(batch => batch.name === 'fund-and-seal-good-mint')!;
    const mintTo = decodeMintToCheckedInstruction(finish.instructions[0]);
    expect(mintTo.data.amount > 100000n).to.equal(true);
    expect(mintTo.keys.destination.pubkey.equals(getAssociatedTokenAddressSync(plan.accounts.mint, publicKeys.funder, true))).to.equal(true);
    const revocations = finish.instructions.slice(1).map(ix => decodeSetAuthorityInstruction(ix));
    expect(revocations.map(item => item.data.authorityType)).to.deep.equal([AuthorityType.MintTokens, AuthorityType.FreezeAccount]);
    expect(revocations.every(item => item.data.newAuthority === null && item.keys.currentAuthority.pubkey.equals(publicKeys.admin))).to.equal(true);
  });
  it('seals only the mint authority of the freeze-only fixture and retains the mint-only authority', async () => {
    const plan = await buildLeagueFixturePlan(publicKeys, { mint: 82, token: 165 });
    const freeze = plan.batches.find(batch => batch.name === 'seal-freeze-only-mint')!;
    expect(freeze.instructions).to.have.length(1);
    const revoke = decodeSetAuthorityInstruction(freeze.instructions[0]);
    expect(revoke.keys.account.pubkey.equals(plan.accounts.mintWithFreezeAuthority)).to.equal(true);
    expect(revoke.data.authorityType).to.equal(AuthorityType.MintTokens); expect(revoke.data.newAuthority).to.equal(null);
    const allRevocations = plan.batches.flatMap(batch => batch.instructions).filter(ix => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 6);
    expect(allRevocations.some(ix => ix.keys[0].pubkey.equals(plan.accounts.mintWithMintAuthority))).to.equal(false);
  });
  it('creates noncanonical initialized accounts with the good mint and correct owners', async () => {
    const plan = await buildLeagueFixturePlan(publicKeys, { mint: 82, token: 165 });
    const batches = plan.batches.filter(batch => batch.name.startsWith('create-noncanonical:'));
    expect(batches).to.have.length(2);
    for (const batch of batches) {
      const create = SystemInstruction.decodeCreateWithSeed(batch.instructions[0]);
      const init = decodeInitializeAccount3Instruction(batch.instructions[1]);
      const owner = batch.name.endsWith('claimant') ? publicKeys.claimant : publicKeys.funder;
      expect(create.space).to.equal(ACCOUNT_SIZE); expect(create.programId.equals(TOKEN_PROGRAM_ID)).to.equal(true);
      expect(init.keys.mint.pubkey.equals(plan.accounts.mint)).to.equal(true); expect(init.data.owner.equals(owner)).to.equal(true);
      expect(init.keys.account.pubkey.equals(getAssociatedTokenAddressSync(plan.accounts.mint, owner, true))).to.equal(false);
    }
  });
  it('refuses unsafe rent quotes before building setup transactions', async () => {
    for (const rent of [{ mint: 0, token: 165 }, { mint: 82, token: -1 }, { mint: 82.5, token: 165 }, { mint: Number.MAX_SAFE_INTEGER + 1, token: 165 }]) {
      await rejected(() => buildLeagueFixturePlan(publicKeys, rent), 'rent');
    }
  });
  it('contains no league initialization instruction and no mutable external destination', async () => {
    const plan = await buildLeagueFixturePlan(publicKeys, { mint: 82, token: 165 });
    const programs = new Set(plan.batches.flatMap(batch => batch.instructions.map(ix => ix.programId.toBase58())));
    expect(programs.has(LEAGUE_ID)).to.equal(false); expect(programs.has(CORE_ID)).to.equal(false);
    expect(plan.accounts.noncanonicalSweepAccount.equals(plan.accounts.noncanonicalClaimantAccount)).to.equal(false);
  });
});
