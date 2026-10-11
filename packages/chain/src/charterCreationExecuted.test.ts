import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { expect, it } from 'vitest';
import { charterExecutorPda, charterFreezePda } from './charterProtocol';
import { createCharterCreationEvidenceReader, type CharterCreationSavedRecord, type CharterCreationEvidenceTrust,
  type CharterCreationRawAccount, type CharterCreationEvidenceRpc } from './charterCreationEvidence';

// Only the seven saved B6g accounts are executed bytes. Synthetic ProgramData,
// Clock and RPC envelopes test decoder conformance, not new execution/finality.
const captured = JSON.parse(readFileSync(new URL('./test-fixtures/charter-creation-executed.json', import.meta.url), 'utf8')) as {
  source: { genesis: string }; expected: { creationIntentId: string; clanId: string; payer: string;
    metadata: { name: string; uri: string; hash: string }; admissionCommitment: string; permitId: string; createdAt: string };
  accounts: Array<{ label: string; address: string; owner: string; executable: boolean; dataBase64: string; dataSha256: string }>;
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
function fixture() {
  const records = Object.fromEntries(captured.accounts.map(r => [r.label, r]));
  const economy = new PublicKey(records.config!.owner), craft = new PublicKey(records.craftControl!.owner);
  const rows: CharterCreationRawAccount[] = captured.accounts.map(r => {
    const data = Buffer.from(r.dataBase64, 'base64'); expect(hash(data)).toBe(r.dataSha256);
    return { address: new PublicKey(r.address), owner: new PublicKey(r.owner), executable: r.executable, data };
  });
  const authority = new PublicKey(Buffer.alloc(32, 97));
  function program(programId: PublicKey) {
    const pd = PublicKey.findProgramAddressSync([programId.toBuffer()], loader)[0];
    const p = Buffer.alloc(36); p.writeUInt32LE(2); pd.toBuffer().copy(p, 4);
    const d = Buffer.alloc(49); d.writeUInt32LE(3); d.writeBigUInt64LE(1n, 4); d[12] = 1; authority.toBuffer().copy(d, 13); d.fill(7, 45);
    rows.push({ address: programId, owner: loader, executable: true, data: p }, { address: pd, owner: loader, executable: false, data: d });
    return { programId: programId.toBase58(), reviewedDeploymentSlot: 1, reviewedProgramDataSha256: hash(d), upgradeAuthority: authority.toBase58() };
  }
  const trust: CharterCreationEvidenceTrust = { expectedGenesisHash: captured.source.genesis, economy: program(economy), craft: program(craft),
    core: program(new PublicKey(records.asset!.owner)), stateProvenance: 'fresh-reviewed-deployment' };
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(200n); clock.writeBigInt64LE(BigInt(captured.expected.createdAt) + 1n, 32);
  rows.push({ address: SYSVAR_CLOCK_PUBKEY, owner: new PublicKey('Sysvar1111111111111111111111111111111111111'), executable: false, data: clock });
  const pin = (label: string) => records[label]!.address;
  const saved: CharterCreationSavedRecord = { creationIntentId: captured.expected.creationIntentId, clanId: captured.expected.clanId,
    payer: captured.expected.payer, metadata: captured.expected.metadata, admissionCommitment: captured.expected.admissionCommitment,
    issuedPermitIds: [captured.expected.permitId], chain: {
    genesisHash: captured.source.genesis, economyProgram: economy.toBase58(), craftProgram: craft.toBase58(), config: pin('config'),
    craftControl: pin('craftControl'), collection: pin('collection'),
    collectionAuthority: PublicKey.findProgramAddressSync([Buffer.from('charter_collection_authority')], craft)[0].toBase58(),
    charter: pin('charter'), asset: pin('asset'), assetBinding: pin('assetBinding'), creationReceipt: pin('creationReceipt'),
    freezeAuthority: charterFreezePda(craft, captured.expected.clanId).toBase58(), executor: charterExecutorPda(economy, captured.expected.clanId).toBase58(),
  } };
  const rpc: CharterCreationEvidenceRpc = { getGenesisHash: async () => captured.source.genesis, getSlot: async () => 200,
    getMultipleAccountsInfoAndContext: async addresses => ({ context: { slot: 200 }, value: addresses.map(p => rows.find(r => r.address.equals(p)) ?? null) }) };
  return { rows, read: createCharterCreationEvidenceReader(() => rpc, trust, async () => saved) };
}

it('decodes exact previously executed B6g permanent accounts and Core mint bytes', async () => {
  const result = await fixture().read(captured.expected.creationIntentId);
  expect(result).toMatchObject({ creationIntentId: captured.expected.creationIntentId, clanId: captured.expected.clanId,
    payer: captured.expected.payer, permitId: captured.expected.permitId, createdAt: BigInt(captured.expected.createdAt),
    metadataHash: captured.expected.metadata.hash, admissionCommitment: captured.expected.admissionCommitment,
    finalizedMintObserved: true, transactionProofVerified: false, activationAuthorized: false });
  for (const account of captured.accounts) expect(result.source.accounts.find(r => r.address === account.address)?.dataSha256).toBe(account.dataSha256);
});

it('refuses corrupted executed-account discriminators rather than accepting a matching mock-only layout', async () => {
  for (const account of captured.accounts) {
    const f = fixture(), row = f.rows.find(r => r.address.toBase58() === account.address)!;
    row.data[0] = row.data[0]! ^ 1;
    await expect(f.read(captured.expected.creationIntentId)).rejects.toThrow();
  }
});
