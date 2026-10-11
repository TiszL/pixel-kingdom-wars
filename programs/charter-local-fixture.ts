/** Owned loopback validator support for the actual Charter fixture runners.
 * No retained validator, public RPC, release credential or build operation.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import * as anchor from '@coral-xyz/anchor';
import { type AccountInfo, AddressLookupTableAccount, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }

async function freePortBlock(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((done, fail) => {
      const server = createServer(); server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address(); check(address && typeof address !== 'string', 'Missing allocated port');
        server.close(error => error ? fail(error) : done(address.port));
      });
    });
    // macOS may allocate sequential ephemeral ports above65000. Keep the full
    // valid30-port block; rejecting that valid range can exhaust all20 attempts.
    if (port < 20000 || port > 65_535 - 29) continue;
    const servers: ReturnType<typeof createServer>[] = [], sockets: ReturnType<typeof createSocket>[] = [];
    try {
      for (let candidate = port; candidate < port + 30; candidate++) {
        const server = createServer(); servers.push(server);
        await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(candidate, '127.0.0.1', done); });
        const socket = createSocket('udp4'); sockets.push(socket);
        await new Promise<void>((done, fail) => { socket.once('error', fail); socket.bind(candidate, '127.0.0.1', done); });
      }
      return port;
    } catch { /* bounded selection; never connect to the occupying service */ }
    finally {
      for (const server of servers) if (server.listening) await new Promise<void>(done => server.close(() => done()));
      for (const socket of sockets) { try { socket.close(); } catch { /* failed bind */ } }
    }
  }
  throw new Error('Could not reserve an unused loopback port block');
}

export type CharterGenesisAccount = { address: PublicKey; account: AccountInfo<Buffer> };
export type CharterConstructedGenesis = {
  sourceWorking: string; sourceGenesis: string; sourceSlot: number;
  payer: Keypair; stranger: Keypair; coreAuthority: PublicKey; craftUpgradeAuthority: Keypair;
  accounts: readonly CharterGenesisAccount[];
};
export type CharterFixtureInput = { corePath: string; craftPath: string; coreBinary: Buffer; craftBinary: Buffer; craft: PublicKey;
  idlSha256: string; validatorVersion: string; coreSdkVersion: string; umiVersion: string;
  additionalPrograms?: readonly { id: PublicKey; path: string; binary: Buffer }[]; scope?: string; constructedGenesis?: CharterConstructedGenesis;
  /** Explicit synthetic fixture state, never copied history or provider authority. */
  syntheticGenesisAccounts?: readonly CharterGenesisAccount[];
  /** Existing disposable test actor on a fresh chain; never copied history. */
  syntheticPayer?: Keypair };
export type ExpectedError = { program: PublicKey; code: number; anchorName?: string; instructionIndex?: number };
type Executed = { signature: string; logs: string[]; slot: number; wireBytes: number };
export async function withCharterValidator(input: CharterFixtureInput, label: string,
  cases: (fixture: {
    connection: Connection; payer: Keypair; stranger: Keypair; coreAuthority: PublicKey; programData: PublicKey; working: string;
    execute: (label: string, instruction: TransactionInstruction, signers?: Keypair[], expected?: ExpectedError) => Promise<Executed>;
    executeInstructions: (label: string, instructions: TransactionInstruction[], signers?: Keypair[], expected?: ExpectedError,
      tables?: AddressLookupTableAccount[]) => Promise<Executed>;
    snapshots: (addresses: PublicKey[]) => Promise<unknown[]>;
    rotateCraftUpgradeAuthority: (next: Keypair) => Promise<Executed>;
    record: (label: string) => void;
  }) => Promise<void>) {
  const working = await mkdtemp('/tmp/charter-bootstrap-');
  console.log('Owned ' + label + ' fixture directory: ' + working);
  const seed = input.constructedGenesis;
  check(!(seed && input.syntheticPayer), 'Fresh fixture payer cannot override constructed history');
  const payer = seed ? Keypair.fromSecretKey(seed.payer.secretKey) : input.syntheticPayer ? Keypair.fromSecretKey(input.syntheticPayer.secretKey) : Keypair.generate();
  const stranger = seed ? Keypair.fromSecretKey(seed.stranger.secretKey) : Keypair.generate();
  const coreAuthority = seed?.coreAuthority ?? Keypair.generate().publicKey;
  let craftUpgradeAuthority = seed ? Keypair.fromSecretKey(seed.craftUpgradeAuthority.secretKey) : payer;
  const imported: CharterGenesisAccount[] = [];
  const accountArgs: string[] = [];
  if (input.syntheticGenesisAccounts) {
    check(!seed && input.syntheticGenesisAccounts.length > 0, 'Synthetic genesis cannot claim copied historical state');
    const addresses = new Set<string>();
    const programs = [CORE, input.craft, ...(input.additionalPrograms ?? []).map(program => program.id)];
    for (const [index, row] of input.syntheticGenesisAccounts.entries()) {
      check(!addresses.has(row.address.toBase58()) && !row.account.executable
        && !row.account.owner.equals(LOADER) && Number.isSafeInteger(row.account.lamports) && row.account.lamports > 0
        && programs.some(id => id.equals(row.account.owner))
        && !programs.some(id => id.equals(row.address) || PublicKey.findProgramAddressSync([id.toBuffer()], LOADER)[0].equals(row.address)),
        'Synthetic account must be distinct nonexecutable fixture-program state');
      addresses.add(row.address.toBase58());
      const path = join(working, 'synthetic-account-' + index + '.json');
      await writeFile(path, JSON.stringify({ pubkey: row.address.toBase58(), account: { lamports: row.account.lamports,
        owner: row.account.owner.toBase58(), executable: false, data: [row.account.data.toString('base64'), 'base64'], rentEpoch: 0 } }), { mode: 0o600, flag: 'wx' });
      accountArgs.push('--account', row.address.toBase58(), path);
    }
  }
  if (seed) {
    check(seed.accounts.length > 0 && new Set(seed.accounts.map(row => row.address.toBase58())).size === seed.accounts.length,
      'Constructed genesis requires distinct copied account rows');
    const protectedPrograms = [CORE, input.craft, ...(input.additionalPrograms ?? []).map(program => program.id)];
    for (const [index, row] of seed.accounts.entries()) {
      check(!row.account.executable && !row.account.owner.equals(LOADER)
        && !protectedPrograms.some(program => program.equals(row.address)
          || PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0].equals(row.address)),
        'Copied genesis cannot replace executable/program-data identity checks');
      check(Number.isSafeInteger(row.account.lamports) && row.account.lamports > 0, 'Invalid copied lamports');
      const copied = { address: row.address, account: { ...row.account, data: Buffer.from(row.account.data) } };
      imported.push(copied);
      const rentEpoch = copied.account.rentEpoch ?? 0;
      check(Number.isSafeInteger(rentEpoch) || rentEpoch === Number((1n << 64n) - 1n), 'Unsupported copied rent epoch');
      const path = join(working, 'copied-account-' + index + '.json');
      // web3 represents the u64MAX rent-exempt sentinel as a rounded JS number;
      // write its exact JSON integer for Agave's u64 account parser.
      const encoded = JSON.stringify({ pubkey: copied.address.toBase58(), account: { lamports: copied.account.lamports,
        owner: copied.account.owner.toBase58(), executable: copied.account.executable,
        data: [copied.account.data.toString('base64'), 'base64'], rentEpoch } }).replace('"rentEpoch":18446744073709552000', '"rentEpoch":18446744073709551615');
      await writeFile(path, encoded, { mode: 0o600, flag: 'wx' });
      accountArgs.push('--account', copied.address.toBase58(), path);
    }
  }
  const port = await freePortBlock(), endpoint = `http://127.0.0.1:${port}`;
  const output = createWriteStream(join(working, 'validator.log'), { flags: 'wx', mode: 0o600 });
  const child = spawn('solana-test-validator', [
    '--ledger', join(working, 'ledger'), '--rpc-port', String(port), '--faucet-port', String(port + 3),
    '--gossip-port', String(port + 2), '--dynamic-port-range', `${port + 4}-${port + 29}`,
    '--bind-address', '127.0.0.1', '--mint', Keypair.generate().publicKey.toBase58(), '--limit-ledger-size', '10000',
    '--upgradeable-program', CORE.toBase58(), input.corePath, coreAuthority.toBase58(),
    '--upgradeable-program', input.craft.toBase58(), input.craftPath, craftUpgradeAuthority.publicKey.toBase58(),
    ...(input.additionalPrograms ?? []).flatMap(program => ['--upgradeable-program', program.id.toBase58(), program.path, payer.publicKey.toBase58()]),
    ...accountArgs,
  ], { cwd: working, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let processFailure: Error | undefined, interrupted = false, failure: string | undefined, genesis: string | undefined;
  const abort = new AbortController(), outcomes: string[] = [], transactions: object[] = [], submissions: object[] = [], sentWires = new Set<string>();
  const terminate = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') processFailure ??= error as Error; }
  };
  const fail = (error: Error) => { processFailure ??= error; abort.abort(error); terminate('SIGINT'); };
  child.once('error', fail); child.stdout!.once('error', fail); child.stderr!.once('error', fail);
  const drained = finished(output).catch(fail);
  child.stdout!.pipe(output, { end: false }); child.stderr!.pipe(output, { end: false });
  const closed = new Promise<void>(done => child.once('close', async () => { output.end(); await drained; done(); }));
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    interrupted = true; abort.abort(new Error('Owned fixture interrupted or deadline exceeded')); terminate('SIGINT');
    escalation ??= setTimeout(() => terminate('SIGKILL'), 5000);
  };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const deadline = setTimeout(interrupt, 10 * 60_000);
  const live = () => check(!interrupted && !processFailure && child.exitCode === null && child.signalCode === null,
    'Owned validator exited or fixture interrupted; see validator.log');
  const connection = new Connection(endpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (request, init) => {
      const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
      check(url.origin === endpoint && url.protocol === 'http:' && url.hostname === '127.0.0.1', 'Non-owned RPC refused');
      return fetch(request, { ...init, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
    } });
  const programData = PublicKey.findProgramAddressSync([input.craft.toBuffer()], LOADER)[0];
  async function identity() {
    live();
    const programs = [[CORE, input.coreBinary, coreAuthority], [input.craft, input.craftBinary, craftUpgradeAuthority.publicKey],
      ...(input.additionalPrograms ?? []).map(program => [program.id, program.binary, payer.publicKey])] as [PublicKey, Buffer, PublicKey][];
    for (const [id, binary, authority] of programs) {
      const dataKey = PublicKey.findProgramAddressSync([id.toBuffer()], LOADER)[0];
      const [program, data] = await connection.getMultipleAccountsInfo([id, dataKey], 'confirmed');
      check(program?.executable && program.owner.equals(LOADER) && program.data.length === 36
        && program.data.readUInt32LE(0) === 2 && new PublicKey(program.data.subarray(4)).equals(dataKey), 'Wrong loaded program identity');
      check(data && !data.executable && data.owner.equals(LOADER) && data.data.length >= 45 + binary.length
        && data.data.readUInt32LE(0) === 3 && data.data[12] === 1
        && new PublicKey(data.data.subarray(13, 45)).equals(authority), 'Wrong fresh program upgrade authority');
      check(data.data.subarray(45, 45 + binary.length).equals(binary)
        && data.data.subarray(45 + binary.length).every(byte => byte === 0), 'Runtime program differs from explicit compiled bytes');
    }
    live();
  }
  async function confirmed(signature: string, retransmit?: {
    wire: Buffer; lastValidBlockHeight: number;
    record: (entry: { signature: string; elapsedMs: number; blockHeight: number; finalizedSlot: number; wireSha256: string }) => Promise<void>;
  }) {
    const started = Date.now(), until = started + 30000;
    const originalHash = retransmit ? hash(retransmit.wire) : undefined;
    let retryAt = started + 2000, retries = 0;
    while (Date.now() < until) {
      live();
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return status;
      // Agave2.3.13 banking sanitizes ALT addresses against root_bank; a new
      // confirmed ALT can therefore precede that bank. maxRetries0 drops the
      // initial broadcast from the RPC retry queue. Retry only the identical
      // packet, while absent and unexpired, inside the original30s ceiling.
      // This is transport recovery, never simulation or a fresh signing attempt.
      if (retransmit && !status && retries < 14 && Date.now() >= retryAt) {
        const [blockHeight, finalizedSlot] = await Promise.all([
          connection.getBlockHeight('confirmed'), connection.getSlot('finalized'),
        ]);
        check(blockHeight <= retransmit.lastValidBlockHeight, 'Original submitted blockhash expired: ' + signature);
        if (Date.now() >= until) break;
        live(); check(hash(retransmit.wire) === originalHash, 'Submitted packet changed before transport retry');
        const resent = await connection.sendRawTransaction(retransmit.wire, { skipPreflight: true, maxRetries: 0 });
        retries++;
        await retransmit.record({ signature: resent, elapsedMs: Date.now() - started, blockHeight, finalizedSlot, wireSha256: hash(retransmit.wire) });
        check(resent === signature, 'Exact-wire transport retry returned a different signature');
        retryAt = Date.now() + 2000;
      }
      await sleep(150);
    }
    throw new Error('Transaction did not confirm within30s: ' + signature);
  }
  async function snapshots(addresses: PublicKey[]) {
    const result = await connection.getMultipleAccountsInfoAndContext(addresses, 'confirmed');
    const rows = result.value.map((row, i) => row === null ? null : ({ key: addresses[i]!.toBase58(),
      owner: row.owner.toBase58(), executable: row.executable, lamports: row.lamports, data: row.data.toString('hex') }));
    await writeFile(join(working, 'latest-accounts.json'), JSON.stringify({ slot: result.context.slot, rows }, null, 2), { mode: 0o600 });
    return rows;
  }
  async function execute(name: string, instruction: TransactionInstruction, signers: Keypair[] = [], expected?: ExpectedError) {
    return executeInstructions(name, [instruction], signers, expected);
  }
  async function executeInstructions(name: string, instructions: TransactionInstruction[], signers: Keypair[] = [],
    expected?: ExpectedError, tables?: AddressLookupTableAccount[]) {
    check(instructions.length > 0, 'Cannot execute an empty fixture transaction');
    await identity();
    const until = Date.now() + 5000;
    let wire: Buffer;
    let lifetime: { blockhash: string; lastValidBlockHeight: number } | undefined;
    for (;;) {
      const latest = await connection.getLatestBlockhash('confirmed');
      const keys = [payer, ...signers.filter(key => !key.publicKey.equals(payer.publicKey))];
      if (tables) {
        // Lookup accounts must come from real confirmed create/extend/freeze
        // operations in this owned validator; the caller verifies their keys.
        check(tables.length > 0 && tables.every(table => table.state.authority === undefined
          && table.state.deactivationSlot === (1n << 64n) - 1n), 'Fixture v0 requires active immutable lookup tables');
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey,
          recentBlockhash: latest.blockhash, instructions }).compileToV0Message(tables));
        check(tx.serialize().length <= 1232, 'Unsigned complete v0 packet exceeds the actual Solana packet bound');
        tx.sign(keys); wire = Buffer.from(tx.serialize());
      } else {
        const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
        check(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232,
          'Unsigned complete legacy packet exceeds the actual Solana packet bound');
        tx.sign(...keys); wire = tx.serialize();
      }
      check(wire.length <= 1232, 'Signed fixture packet exceeds the actual Solana packet bound');
      if (!sentWires.has(hash(wire))) { lifetime = latest; break; }
      check(Date.now() < until, 'Fresh blockhash needed to execute the repeated instruction');
      await sleep(150); live();
    }
    sentWires.add(hash(wire));
    check(lifetime, 'Missing submitted blockhash lifetime');
    const submission = { label: name, version: tables ? 0 : 'legacy', wireBytes: wire.length, wireSha256: hash(wire),
      wireBase64: wire.toString('base64'), lifetime, lookupTables: tables?.map(table => table.key.toBase58()) ?? [],
      signature: null as string | null, resubmissions: [] as { signature: string; elapsedMs: number; blockHeight: number; finalizedSlot: number; wireSha256: string }[],
      failureDiagnostics: null as unknown };
    submissions.push(submission);
    const saveSubmissions = () => writeFile(join(working, 'submitted-transactions.json'), JSON.stringify(submissions, null, 2), { mode: 0o600 });
    await saveSubmissions();
    let signature: string;
    let status: Awaited<ReturnType<typeof confirmed>>;
    try {
      signature = await connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 0 });
      submission.signature = signature;
      await saveSubmissions();
      status = await confirmed(signature, { wire: Buffer.from(wire), lastValidBlockHeight: lifetime.lastValidBlockHeight,
        record: async entry => { submission.resubmissions.push(entry); await saveSubmissions(); } });
    } catch (error) {
      // Diagnostic only: never accept simulation or a submitted signature as
      // executed evidence. Preserve the exact signed wire and blockhash, without
      // replacing either or extending the confirmation deadline.
      const diagnosticReads = await Promise.allSettled([
        connection.getSignatureStatuses(submission.signature ? [submission.signature] : [], { searchTransactionHistory: true }),
        connection.getSlot('confirmed'), connection.getBlockHeight('confirmed'),
        connection.simulateTransaction(VersionedTransaction.deserialize(wire),
          { commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false }),
        Promise.all((tables ?? []).map(async table => {
          const observed = await connection.getAddressLookupTable(table.key, { commitment: 'confirmed' });
          return { key: table.key.toBase58(), context: observed.context, state: observed.value ? {
            authority: observed.value.state.authority?.toBase58() ?? null,
            deactivationSlot: observed.value.state.deactivationSlot.toString(), lastExtendedSlot: observed.value.state.lastExtendedSlot,
            addresses: observed.value.state.addresses.map(key => key.toBase58()),
          } : null };
        })),
      ]);
      submission.failureDiagnostics = { acceptance: false, error: error instanceof Error ? error.message : String(error),
        observations: diagnosticReads.map((result, index) => ({
          kind: ['signatureStatus', 'confirmedSlot', 'confirmedBlockHeight', 'exactWireSimulation', 'lookupTables'][index],
          ...(result.status === 'fulfilled' ? { value: result.value } : { error: String(result.reason) }),
        })) };
      await saveSubmissions();
      throw new Error(name + ': ' + (error instanceof Error ? error.message : String(error)) + '; see submitted-transactions.json');
    }
    let receipt = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    for (let i = 0; !receipt && i < 10; i++) { await sleep(150); receipt = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); }
    check(receipt?.meta?.logMessages, 'Missing actual confirmed transaction metadata/logs');
    const logs = receipt.meta.logMessages;
    transactions.push({ label: name, signature, slot: receipt.slot, status, error: receipt.meta.err, logs,
      wireBytes: wire.length, version: tables ? 0 : 'legacy' });
    await writeFile(join(working, 'transactions.json'), JSON.stringify(transactions, null, 2), { mode: 0o600 });
    check(JSON.stringify(status.err) === JSON.stringify(receipt.meta.err), 'Status/transaction error disagree');
    const executionIndex = expected?.instructionIndex ?? instructions.length - 1;
    check(logs.includes(`Program ${instructions[executionIndex]!.programId.toBase58()} invoke [1]`), 'Intended instruction did not execute');
    if (!expected) check(receipt.meta.err === null, name + ': unexpected actual failure ' + JSON.stringify(receipt.meta.err));
    else {
      check(JSON.stringify(receipt.meta.err) === JSON.stringify({ InstructionError: [executionIndex, { Custom: expected.code }] }),
        name + ': expected exact error ' + expected.code + ', got ' + JSON.stringify(receipt.meta.err));
      check(logs.includes(`Program ${expected.program.toBase58()} failed: custom program error: 0x${expected.code.toString(16)}`), name + ': missing exact program failure log');
      if (expected.anchorName) check(anchor.AnchorError.parse(logs)?.error.errorCode.code === expected.anchorName,
        name + ': wrong Anchor failure boundary');
    }
    return { signature, logs, slot: receipt.slot, wireBytes: wire.length };
  }
  async function rotateCraftUpgradeAuthority(next: Keypair) {
    await identity();
    check(!next.publicKey.equals(craftUpgradeAuthority.publicKey), 'Rotation must change the fixture authority');
    const before = await connection.getAccountInfo(programData, 'confirmed'); check(before, 'Missing original ProgramData');
    // Pinned solana-loader-v3-interface3.0.0: bincode SetAuthority enum4;
    // ProgramData(w), current authority(s), new authority(readonly).
    const data = Buffer.alloc(4); data.writeUInt32LE(4);
    const previous = craftUpgradeAuthority.publicKey;
    const result = await execute('rotate-actual-craft-upgrade-authority', new TransactionInstruction({ programId: LOADER, data,
      keys: [{ pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: previous, isSigner: true, isWritable: false }, { pubkey: next.publicKey, isSigner: false, isWritable: false }] }), [craftUpgradeAuthority]);
    const actual = await connection.getAccountInfo(programData, { commitment: 'confirmed', minContextSlot: result.slot });
    const expected = Buffer.from(before.data); next.publicKey.toBuffer().copy(expected, 13);
    check(actual && actual.owner.equals(before.owner) && actual.executable === before.executable && actual.lamports === before.lamports
      && actual.data.equals(expected), 'Confirmed loader rotation changed more than the32 authority bytes');
    // There is no caller-accessible trust setter. Update only after actual loader
    // success and exact ProgramData/ELF comparison, then revalidate every program.
    craftUpgradeAuthority = Keypair.fromSecretKey(Uint8Array.from(next.secretKey));
    await identity();
    await writeFile(join(working, 'craft-authority-rotation.json'), JSON.stringify({ previous: previous.toBase58(),
      next: next.publicKey.toBase58(), signature: result.signature, slot: result.slot,
      beforeSha256: hash(before.data), afterSha256: hash(actual.data), unchangedElfSha256: hash(input.craftBinary),
      changedOffset: 13, changedLength: 32 }, null, 2), { mode: 0o600, flag: 'wx' });
    return result;
  }
  try {
    const until = Date.now() + 60000;
    let ready = false;
    while (Date.now() < until) {
      live();
      try { if (await connection.getSlot('confirmed') > 0) { ready = true; break; } } catch { /* bounded startup */ }
      await sleep(250);
    }
    check(ready, 'Pinned validator did not start within60s; no fallback');
    await identity(); // Defeat the port-allocation race before any local write.
    genesis = await connection.getGenesisHash();
    if (seed) {
      check(genesis !== seed.sourceGenesis, 'Constructed elapsed-state run must have a distinct owned genesis');
      const observed = await connection.getMultipleAccountsInfo(imported.map(row => row.address), 'confirmed');
      for (const [index, original] of imported.entries()) {
        const actual = observed[index];
        check(actual && actual.owner.equals(original.account.owner) && actual.executable === original.account.executable
          && actual.lamports === original.account.lamports && actual.data.equals(original.account.data)
          && (actual.rentEpoch ?? 0) === (original.account.rentEpoch ?? 0), 'Copied genesis changed account ' + original.address.toBase58());
      }
      await writeFile(join(working, 'constructed-genesis.json'), JSON.stringify({ sourceWorking: seed.sourceWorking,
        sourceGenesis: seed.sourceGenesis, runtimeGenesis: genesis, sourceSlot: seed.sourceSlot,
        scope: 'R1 constructed elapsed receipt state; not evidence of natural elapsed time. Program bytes and authority identities are revalidated.',
        accounts: imported.map(row => ({ key: row.address.toBase58(), owner: row.account.owner.toBase58(), lamports: row.account.lamports,
          executable: row.account.executable, rentEpoch: row.account.rentEpoch, dataSha256: hash(row.account.data) })) }, null, 2), { mode: 0o600, flag: 'wx' });
    } else {
      for (const wallet of [payer.publicKey, stranger.publicKey]) {
        await identity();
        check((await confirmed(await connection.requestAirdrop(wallet, 2_000_000_000))).err === null, 'Owned local faucet failed');
      }
    }
    await cases({ connection, payer, stranger, coreAuthority, programData, working, execute, executeInstructions, snapshots, rotateCraftUpgradeAuthority, record: name => outcomes.push(name) });
    await identity();
  } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    clearTimeout(deadline); terminate('SIGINT');
    const force = setTimeout(() => terminate('SIGKILL'), 5000);
    try { await closed; }
    finally {
      clearTimeout(force); if (escalation) clearTimeout(escalation);
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      await writeFile(join(working, 'result.json'), JSON.stringify({ label,
        scope: input.scope ?? 'Local guarded collection bootstrap only; no NFT mint, Charter admission or deployment authority',
        status: failure || interrupted || processFailure ? 'failed' : 'passed', failure: failure ?? processFailure?.message ?? null,
        genesis, endpoint, craftProgram: input.craft.toBase58(), craftUpgradeAuthority: craftUpgradeAuthority.publicKey.toBase58(),
        coreProgram: CORE.toBase58(), coreUpgradeAuthority: coreAuthority.toBase58(),
        coreSha256: hash(input.coreBinary), craftSha256: hash(input.craftBinary), idlSha256: input.idlSha256,
        validatorVersion: input.validatorVersion, coreSdkVersion: input.coreSdkVersion, umiVersion: input.umiVersion,
        additionalPrograms: input.additionalPrograms?.map(program => ({ id: program.id.toBase58(), sha256: hash(program.binary) })),
        outcomes, transactions: transactions.length,
      }, null, 2), { mode: 0o600, flag: 'wx' });
    }
    check(!interrupted && !processFailure, 'Fixture interrupted or owned validator failed');
  }
  console.log(JSON.stringify({ label, outcomes: outcomes.length, transactions: transactions.length, working }));
  return outcomes;
}
