/** MAJOR-4 tests first. Pure mock transport, no keys, RPC or real signing.
 * These unit tests are outside the default regression glob and run only through the
 * separately admitted league runner. This lane has not executed them. */
import { expect } from "chai";
import { utils, type AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  assertCommittedFailure,
  CommittedFailureEvidenceError,
  type CommittedFailureInput,
} from "./committedFailure";

// Public-address fixtures, never a private key or signing identity factory.
const payer = new PublicKey("Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8");
const target = new PublicKey("2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE");
const watched = new PublicKey("9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q");
const absent = new PublicKey("AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv");
// Invalid mock signature bytes, not produced by a key or used on a network.
const mockSignature = Buffer.alloc(64, 1);
const signature = utils.bytes.bs58.encode(mockSignature);
const expectedError = { InstructionError: [0, { Custom: 6007 }] };
const logs = [
  `Program ${target.toBase58()} invoke [1]`,
  "Program log: AnchorError occurred. Error Code: Paused. Error Number: 6007. Error Message: League payouts are paused.",
  `Program ${target.toBase58()} failed: custom program error: 0x1777`,
];
const account = (lamports: number, data: number[] = []) => ({
  owner: SystemProgram.programId, lamports, executable: false, data: Buffer.from(data), rentEpoch: 0,
});
const cloneAccount = (value: ReturnType<typeof account> | null) => value === null ? null : ({ ...value, data: Buffer.from(value.data) });

function harness() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const state = {
    beforePayer: account(100000), afterPayer: account(99995),
    beforeWatched: account(31, [1, 2, 3]), afterWatched: account(31, [1, 2, 3]),
    beforeAbsent: null as ReturnType<typeof account> | null,
    afterAbsent: null as ReturnType<typeof account> | null,
    confirmedSlot: 40, finalizedSlots: [39, 40], beforeSlot: 41, afterSlot: 44,
    transactionSlot: 43, confirmError: expectedError as unknown, confirmThrow: undefined as unknown, metaError: expectedError as unknown,
    fee: 5, metadataFeeDebit: 5, otherMetadataDebit: 0, logs: [...logs] as string[] | null,
    nullTransactions: 0, missingMeta: false, fetchedSignature: signature, sentSignature: signature,
    signCount: 0, sent: false, snapshotCount: 0, waits: 0,
    changeSignedMessage: false, changeFetchedMessage: false, wrongFetchedProgram: false,
    extraFetchedInstruction: false, message: undefined as ReturnType<Transaction["compileMessage"]> | undefined,
  };
  const rpc = {
    async getSlot(commitment: string) {
      calls.push({ method: "getSlot", args: [commitment] });
      if (commitment === "confirmed") return state.confirmedSlot;
      return state.finalizedSlots.length > 1 ? state.finalizedSlots.shift()! : state.finalizedSlots[0];
    },
    async getMultipleAccountsInfoAndContext(addresses: PublicKey[], config: unknown) {
      calls.push({ method: "getMultipleAccountsInfoAndContext", args: [addresses, config] });
      const before = state.snapshotCount++ === 0;
      const values = addresses.map(address => {
        if (address.equals(payer)) return cloneAccount(before ? state.beforePayer : state.afterPayer);
        if (address.equals(watched)) return cloneAccount(before ? state.beforeWatched : state.afterWatched);
        if (address.equals(absent)) return cloneAccount(before ? state.beforeAbsent : state.afterAbsent);
        throw new Error("Unexpected mock snapshot address");
      });
      return { context: { slot: before ? state.beforeSlot : state.afterSlot }, value: values };
    },
    async getLatestBlockhash(config: unknown) {
      calls.push({ method: "getLatestBlockhash", args: [config] });
      return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1000 };
    },
    async sendRawTransaction(bytes: Uint8Array, config: unknown) {
      calls.push({ method: "sendRawTransaction", args: [bytes, config] });
      state.sent = true; return state.sentSignature;
    },
    async confirmTransaction(strategy: unknown, commitment: unknown) {
      calls.push({ method: "confirmTransaction", args: [strategy, commitment] });
      if (state.confirmThrow !== undefined) throw state.confirmThrow;
      return { context: { slot: 44 }, value: { err: state.confirmError } };
    },
    async getTransaction(sentSignature: string, config: unknown) {
      calls.push({ method: "getTransaction", args: [sentSignature, config] });
      if (state.nullTransactions-- > 0) return null;
      const original = state.message!;
      const message = Object.assign(Object.create(Object.getPrototypeOf(original)), original) as typeof original;
      message.accountKeys = [...original.accountKeys];
      message.instructions = original.instructions.map(ix => ({ ...ix, accounts: [...ix.accounts] }));
      if (state.changeFetchedMessage) message.instructions[0].data = "2";
      if (state.wrongFetchedProgram) message.accountKeys[message.instructions[0].programIdIndex] = SystemProgram.programId;
      if (state.extraFetchedInstruction) message.instructions.push({ ...message.instructions[0] });
      const preBalances = message.accountKeys.map((_, index) => index === 0 ? 100000 : 31);
      const postBalances = [...preBalances]; postBalances[0] -= state.metadataFeeDebit; postBalances[1] -= state.otherMetadataDebit;
      return {
        slot: state.transactionSlot, blockTime: null,
        transaction: { signatures: [state.fetchedSignature], message },
        meta: state.missingMeta ? null : {
          err: state.metaError, fee: state.fee, logMessages: state.logs, preBalances, postBalances,
          innerInstructions: null, preTokenBalances: [], postTokenBalances: [],
        },
      };
    },
  };
  const wallet = {
    publicKey: payer,
    async signTransaction<T>(transaction: T): Promise<T> {
      state.signCount++;
      const tx = transaction as unknown as Transaction;
      if (state.changeSignedMessage) tx.add(new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.from([2]) }));
      state.message = tx.compileMessage();
      tx.addSignature(payer, mockSignature);
      // Deliberate transport double: the unit suite tests custody invocation and
      // evidence, not cryptography. No key or valid signature exists in this mock.
      tx.serialize = () => Buffer.from("mock signed transaction bytes");
      return transaction;
    },
    async signAllTransactions<T>(transactions: T[]): Promise<T[]> { throw new Error("Must not request batch signing"); },
  } as AnchorProvider["wallet"];
  const provider = { connection: rpc, wallet } as unknown as AnchorProvider;
  const instruction = new TransactionInstruction({
    programId: target, keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: watched, isSigner: false, isWritable: true }],
    data: Buffer.from([1, 2, 3]),
  });
  const input: CommittedFailureInput = { provider, instruction, programId: target, expectedCustomError: 6007,
    expectedErrorName: "Paused", watchedAccounts: [watched, absent, watched] };
  const retry = { maxAttempts: 4, delayMs: 0, wait: async (_ms: number) => { state.waits++; } };
  return { calls, state, rpc, input, retry };
}
async function refused(run: () => Promise<unknown>, stage: CommittedFailureEvidenceError["stage"]) {
  let error: unknown;
  try { await run(); } catch (caught) { error = caught; }
  expect(error).to.be.instanceOf(CommittedFailureEvidenceError);
  expect((error as CommittedFailureEvidenceError).stage).to.equal(stage);
}

describe("committed failure evidence — mocked transport only", () => {
  it("signs through the supplied existing wallet, skips preflight, fetches FINALIZED and records fee-only rollback", async () => {
    const h = harness();
    const receipt = await assertCommittedFailure(h.input, h.retry);
    expect(receipt).to.include({ signature, slot: 43, fee: 5n, expectedCustomError: 6007, expectedErrorName: "Paused" });
    expect(receipt.logs).to.deep.equal(logs);
    expect(h.state.signCount).to.equal(1);
    expect(h.calls.find(call => call.method === "sendRawTransaction")!.args[1]).to.deep.equal({ skipPreflight: true, preflightCommitment: "finalized" });
    expect(h.calls.find(call => call.method === "confirmTransaction")!.args).to.deep.equal([
      { signature, blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1000 }, "finalized",
    ]);
    expect(h.calls.filter(call => call.method === "getTransaction").every(call => (call.args[1] as { commitment: string }).commitment === "finalized")).to.equal(true);
    const snapshots = h.calls.filter(call => call.method === "getMultipleAccountsInfoAndContext");
    expect((snapshots[0].args[0] as PublicKey[]).length).to.equal(3);
    expect(snapshots[0].args[1]).to.deep.equal({ commitment: "finalized", minContextSlot: 40 });
    expect(snapshots[1].args[1]).to.deep.equal({ commitment: "finalized", minContextSlot: 43 });
    expect(h.state.waits).to.equal(1);
  });
  it("continues to finalized evidence when web3 status confirmation throws the exact expected custom error", async () => {
    const h = harness(); h.state.confirmThrow = { InstructionError: [0, { Custom: 6007 }] };
    h.state.nullTransactions = 1;
    const receipt = await assertCommittedFailure(h.input, h.retry);
    expect(receipt).to.include({ signature, slot: 43, fee: 5n });
    expect(h.calls.filter(call => call.method === "getTransaction")).to.have.length(2);
    expect(h.state.snapshotCount).to.equal(2);
  });
  it("does not swallow thrown wrong custom errors, transport failures or expiry errors", async () => {
    for (const failure of [{ InstructionError: [0, { Custom: 6017 }] }, new Error("RPC transport failed"), new Error("Block height exceeded")]) {
      const h = harness(); h.state.confirmThrow = failure;
      let caught: unknown;
      try { await assertCommittedFailure(h.input, h.retry); } catch (error) { caught = error; }
      expect(caught).to.equal(failure);
      expect(h.calls.filter(call => call.method === "getTransaction")).to.have.length(0);
    }
  });
  it("still rejects mismatched finalized metadata after an expected confirmation throw", async () => {
    const h = harness(); h.state.confirmThrow = expectedError; h.state.metaError = { InstructionError: [0, { Custom: 6017 }] };
    await refused(() => assertCommittedFailure(h.input, h.retry), "ERROR");
  });
  it("retries missing finalized transaction metadata without a second submission or signature", async () => {
    const h = harness(); h.state.nullTransactions = 2;
    await assertCommittedFailure(h.input, h.retry);
    expect(h.calls.filter(call => call.method === "getTransaction")).to.have.length(3);
    expect(h.calls.filter(call => call.method === "sendRawTransaction")).to.have.length(1);
    expect(h.state.signCount).to.equal(1);
  });
  it("refuses a fee payer in watched state before calling the wallet", async () => {
    const h = harness(); h.input.watchedAccounts = [watched, payer];
    await refused(() => assertCommittedFailure(h.input, h.retry), "INPUT");
    expect(h.state.signCount).to.equal(0); expect(h.state.sent).to.equal(false);
  });
  it("refuses a mismatched target or a second signer before wallet custody is invoked", async () => {
    for (const kind of ["program", "signer"] as const) {
      const h = harness();
      if (kind === "program") h.input.programId = SystemProgram.programId;
      else h.input.instruction.keys.push({ pubkey: absent, isSigner: true, isWritable: false });
      await refused(() => assertCommittedFailure(h.input, h.retry), "INPUT");
      expect(h.state.signCount).to.equal(0);
    }
  });
  it("requires every writable instruction account to be watched, except the separately checked payer", async () => {
    const h = harness(); h.input.watchedAccounts = [absent];
    await refused(() => assertCommittedFailure(h.input, h.retry), "INPUT");
    expect(h.state.signCount).to.equal(0);
  });
  it("refuses empty watched state, unsafe error code, or a missing error name", async () => {
    for (const change of [{ watchedAccounts: [] }, { expectedCustomError: -1 }, { expectedCustomError: 1.5 }, { expectedErrorName: "" }]) {
      const h = harness(); Object.assign(h.input, change);
      await refused(() => assertCommittedFailure(h.input, h.retry), "INPUT");
      expect(h.state.signCount).to.equal(0);
    }
  });
  it("fails closed before signing when the prior confirmed setup cannot reach finality", async () => {
    const h = harness(); h.state.finalizedSlots = [39];
    await refused(() => assertCommittedFailure(h.input, h.retry), "FINALITY");
    expect(h.state.signCount).to.equal(0);
  });
  it("rejects a stale baseline context even if the RPC ignored minContextSlot", async () => {
    const h = harness(); h.state.beforeSlot = 39;
    await refused(() => assertCommittedFailure(h.input, h.retry), "FINALITY");
    expect(h.state.signCount).to.equal(0);
  });
  it("rejects a wallet changing the requested message before broadcast", async () => {
    const h = harness(); h.state.changeSignedMessage = true;
    await refused(() => assertCommittedFailure(h.input, h.retry), "WALLET");
    expect(h.state.sent).to.equal(false);
  });
  it("requires finalized transaction metadata to appear within the bounded retry budget", async () => {
    const h = harness(); h.state.nullTransactions = 100;
    await refused(() => assertCommittedFailure(h.input, h.retry), "FINALITY");
    expect(h.state.signCount).to.equal(1);
  });
  it("rejects an RPC submission signature different from the supplied wallet signature", async () => {
    const h = harness(); h.state.sentSignature = "different-signature";
    await refused(() => assertCommittedFailure(h.input, h.retry), "TRANSACTION");
    expect(h.calls.filter(call => call.method === "getTransaction")).to.have.length(0);
  });
  it("refuses missing transaction meta", async () => {
    const h = harness(); h.state.missingMeta = true;
    await refused(() => assertCommittedFailure(h.input, h.retry), "TRANSACTION");
  });
  it("refuses mismatched fetched signature, message bytes, program or instruction count", async () => {
    for (const change of [{ fetchedSignature: "different-signature" }, { changeFetchedMessage: true }, { wrongFetchedProgram: true }, { extraFetchedInstruction: true }]) {
      const h = harness(); Object.assign(h.state, change);
      await refused(() => assertCommittedFailure(h.input, h.retry), "TRANSACTION");
    }
  });
  it("refuses success, wrong custom code, wrong instruction index and string errors", async () => {
    for (const error of [null, { InstructionError: [0, { Custom: 6017 }] }, { InstructionError: [1, { Custom: 6007 }] }, "AccountNotFound"]) {
      const h = harness(); h.state.confirmError = error; h.state.metaError = error;
      await refused(() => assertCommittedFailure(h.input, h.retry), "ERROR");
    }
  });
  it("requires the confirmation failure to equal the fetched metadata failure", async () => {
    const h = harness(); h.state.confirmError = { InstructionError: [0, { Custom: 6017 }] };
    await refused(() => assertCommittedFailure(h.input, h.retry), "ERROR");
  });
  it("requires parsed Anchor error name and number, not just text containing a number", async () => {
    for (const badLogs of [null, ["custom program error: 0x1777"], [logs[1].replace("Paused", "InvalidProof")], [logs[1].replace("6007", "6017")]]) {
      const h = harness(); h.state.logs = badLogs;
      await refused(() => assertCommittedFailure(h.input, h.retry), "ERROR");
    }
  });
  it("rejects stale finalized after-state and a transaction older than the baseline", async () => {
    for (const change of [{ afterSlot: 42 }, { transactionSlot: 40 }]) {
      const h = harness(); Object.assign(h.state, change);
      await refused(() => assertCommittedFailure(h.input, h.retry), "FINALITY");
    }
  });
  it("requires a positive safe fee and equal metadata and snapshot payer debits", async () => {
    for (const change of [{ fee: 0 }, { fee: Number.MAX_SAFE_INTEGER + 1 }, { fee: 6 }, { metadataFeeDebit: 6 }, { afterPayer: account(99994) }]) {
      const h = harness(); Object.assign(h.state, change);
      await refused(() => assertCommittedFailure(h.input, h.retry), "FEE");
    }
  });
  it("requires all non-payer transaction balance metadata to remain unchanged", async () => {
    const h = harness(); h.state.otherMetadataDebit = 1;
    await refused(() => assertCommittedFailure(h.input, h.retry), "FEE");
  });
  it("rejects any fee payer mutation beyond its fee-only lamport debit", async () => {
    for (const change of [{ data: Buffer.from([9]) }, { owner: target }, { executable: true }]) {
      const h = harness(); Object.assign(h.state.afterPayer, change);
      await refused(() => assertCommittedFailure(h.input, h.retry), "FEE");
    }
  });
  it("rejects watched data, owner, lamports and executable mutations independently", async () => {
    for (const change of [{ data: Buffer.from([1, 2, 4]) }, { owner: target }, { lamports: 30 }, { executable: true }]) {
      const h = harness(); Object.assign(h.state.afterWatched, change);
      await refused(() => assertCommittedFailure(h.input, h.retry), "STATE");
    }
  });
  it("requires failed init accounts to remain absent", async () => {
    const h = harness(); h.state.afterAbsent = account(1);
    await refused(() => assertCommittedFailure(h.input, h.retry), "STATE");
  });
  it("rejects unsafe account lamports rather than rounding u64 balances", async () => {
    const h = harness(); h.state.beforeWatched.lamports = Number.MAX_SAFE_INTEGER + 1;
    await refused(() => assertCommittedFailure(h.input, h.retry), "STATE");
    expect(h.state.signCount).to.equal(0);
  });
});
