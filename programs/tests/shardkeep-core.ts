import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { ShardkeepCore } from "../target/types/shardkeep_core";
import { u64Le } from "./merkle";

const ENTRY_LAMPORTS = 200_000_000; // 0.2 SOL -> 80M / 70M / 50M, no dust
const BUILDER_LAMPORTS = [150_000_000, 333_333_333]; // index 1 leaves 1 lamport dust
const EXPANSION_LAMPORTS = 250_000_000;
const SPLITS = [4000, 3500, 2500];

async function expectFail(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the transaction to fail, but it succeeded");
}

function anchorCode(err: unknown): string | undefined {
  return (err as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code;
}

function errText(err: unknown): string {
  const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
  return [e?.message ?? "", ...(e?.logs ?? []), ...(e?.transactionLogs ?? [])].join("\n");
}

describe("shardkeep-core", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.shardkeepCore as Program<ShardkeepCore>;
  const connection = provider.connection;
  const admin = provider.wallet.publicKey;
  const upgradeableLoader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    upgradeableLoader
  );

  const keepMint = Keypair.generate().publicKey;
  const treasuryLiquidity = Keypair.generate().publicKey;
  const treasuryDev = Keypair.generate().publicKey;
  const treasuryOps = Keypair.generate().publicKey;

  const player1 = Keypair.generate();
  const player2 = Keypair.generate();
  const attacker = Keypair.generate();

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const playerPda = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("player"), wallet.toBuffer()],
      program.programId
    )[0];
  const epochRootPda = (epoch: bigint) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("root"), u64Le(epoch)],
      program.programId
    )[0];

  const initArgs = (splits: number[]) => ({
    keepMint,
    treasuryLiquidity,
    treasuryDev,
    treasuryOps,
    splits,
    prices: {
      entryLamports: new BN(ENTRY_LAMPORTS),
      builderLamports: [new BN(BUILDER_LAMPORTS[0]), new BN(BUILDER_LAMPORTS[1])],
      expansionLamports: new BN(EXPANSION_LAMPORTS),
    },
  });

  const initializeAccounts = (adminKey: PublicKey) => ({
    admin: adminKey,
    program: program.programId,
    programData,
    config: configPda,
    systemProgram: SystemProgram.programId,
  });

  const paymentAccounts = (wallet: PublicKey, reference: PublicKey, overrides = {}) => ({
    config: configPda,
    playerWallet: wallet,
    player: playerPda(wallet),
    treasuryLiquidity,
    treasuryDev,
    treasuryOps,
    reference,
    systemProgram: SystemProgram.programId,
    ...overrides,
  });

  const treasuryBalances = async () =>
    Promise.all(
      [treasuryLiquidity, treasuryDev, treasuryOps].map((t) => connection.getBalance(t))
    );

  async function fund(to: PublicKey, lamports: number) {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin, toPubkey: to, lamports })
    );
    await provider.sendAndConfirm(tx);
  }

  before(async () => {
    await fund(player1.publicKey, 2_000_000_000);
    await fund(player2.publicKey, 2_000_000_000);
    await fund(attacker.publicKey, 2_000_000_000);
  });

  it("rejects initialization from a signer who is not the program upgrade authority", async () => {
    const err = await expectFail(
      program.methods
        .initialize(initArgs(SPLITS))
        .accountsPartial(initializeAccounts(attacker.publicKey))
        .signers([attacker])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("Unauthorized");
    expect(await connection.getAccountInfo(configPda)).to.be.null;
  });

  it("rejects initialize with splits that do not sum to 10000 bps", async () => {
    const err = await expectFail(
      program.methods
        .initialize(initArgs([4000, 3500, 2400]))
        .accountsPartial(initializeAccounts(admin))
        .rpc()
    );
    expect(anchorCode(err)).to.equal("InvalidSplits");
  });

  it("initializes config", async () => {
    await program.methods
      .initialize(initArgs(SPLITS))
      .accountsPartial(initializeAccounts(admin))
      .rpc();

    const config = await program.account.config.fetch(configPda);
    expect(config.admin.equals(admin)).to.be.true;
    expect(config.pendingAdmin).to.be.null;
    expect(config.keepMint.equals(keepMint)).to.be.true;
    expect(config.treasuryLiquidity.equals(treasuryLiquidity)).to.be.true;
    expect(config.splits).to.deep.equal(SPLITS);
    expect(config.paused).to.be.false;
    expect(config.prices.entryLamports.toNumber()).to.equal(ENTRY_LAMPORTS);
  });

  it("pay_entry splits 0.2 SOL exactly 80M/70M/50M, creates Player, emits event", async () => {
    const reference = Keypair.generate().publicKey;
    const before = await treasuryBalances();

    // skipPreflight: a fresh local validator intermittently reports "Blockhash
    // not found" during preflight before it has produced enough blocks; skipping
    // it makes this balance/event/PDA assertion deterministic (the tx still lands).
    const sig = await program.methods
      .payEntry()
      .accountsPartial(paymentAccounts(player1.publicKey, reference))
      .signers([player1])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    const after = await treasuryBalances();
    expect(after[0] - before[0]).to.equal(80_000_000);
    expect(after[1] - before[1]).to.equal(70_000_000);
    expect(after[2] - before[2]).to.equal(50_000_000);

    const player = await program.account.player.fetch(playerPda(player1.publicKey));
    expect(player.wallet.equals(player1.publicKey)).to.be.true;
    expect(player.buildersPurchased).to.equal(0);
    expect(player.expansionsPurchased).to.equal(0);
    expect(player.openedAt.toNumber()).to.be.greaterThan(0);

    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const parser = new anchor.EventParser(program.programId, program.coder);
    const events = [...parser.parseLogs(tx!.meta!.logMessages!)];
    const pay = events.find((e) => e.name.toLowerCase() === "paymentmade");
    expect(pay, "PaymentMade event missing").to.not.be.undefined;
    expect((pay!.data.wallet as PublicKey).equals(player1.publicKey)).to.be.true;
    expect(pay!.data.kind).to.equal(0);
    expect((pay!.data.lamports as BN).toNumber()).to.equal(ENTRY_LAMPORTS);
    expect((pay!.data.reference as PublicKey).equals(reference)).to.be.true;
  });

  it("rejects a second pay_entry from the same wallet (Player already exists)", async () => {
    const err = await expectFail(
      program.methods
        .payEntry()
        .accountsPartial(paymentAccounts(player1.publicKey, Keypair.generate().publicKey))
        .signers([player1])
        .rpc()
    );
    expect(errText(err)).to.match(/already in use/i);
  });

  it("rejects treasury account substitution", async () => {
    const err = await expectFail(
      program.methods
        .payEntry()
        .accountsPartial(
          paymentAccounts(player2.publicKey, Keypair.generate().publicKey, {
            treasuryOps: attacker.publicKey,
          })
        )
        .signers([player2])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("InvalidTreasury");
  });

  it("buy_builder(0) splits 150M exactly 60M/52.5M/37.5M", async () => {
    const before = await treasuryBalances();
    await program.methods
      .buyBuilder(0)
      .accountsPartial(paymentAccounts(player1.publicKey, Keypair.generate().publicKey))
      .signers([player1])
      .rpc();
    const after = await treasuryBalances();
    expect(after[0] - before[0]).to.equal(60_000_000);
    expect(after[1] - before[1]).to.equal(52_500_000);
    expect(after[2] - before[2]).to.equal(37_500_000);

    const player = await program.account.player.fetch(playerPda(player1.publicKey));
    expect(player.buildersPurchased).to.equal(1);
  });

  it("rejects out-of-order buy_builder", async () => {
    const err = await expectFail(
      program.methods
        .buyBuilder(0) // builders_purchased is now 1
        .accountsPartial(paymentAccounts(player1.publicKey, Keypair.generate().publicKey))
        .signers([player1])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("OutOfOrderPurchase");
  });

  it("buy_builder(1) routes the 1-lamport rounding dust to the liquidity leg", async () => {
    // 333_333_333: dev = floor(*0.35) = 116_666_666, ops = floor(*0.25) = 83_333_333,
    // liquidity = remainder = 133_333_334 (one more than floor(*0.40) = 133_333_333).
    const before = await treasuryBalances();
    await program.methods
      .buyBuilder(1)
      .accountsPartial(paymentAccounts(player1.publicKey, Keypair.generate().publicKey))
      .signers([player1])
      .rpc();
    const after = await treasuryBalances();
    expect(after[0] - before[0]).to.equal(133_333_334);
    expect(after[1] - before[1]).to.equal(116_666_666);
    expect(after[2] - before[2]).to.equal(83_333_333);
    expect(
      after[0] + after[1] + after[2] - (before[0] + before[1] + before[2])
    ).to.equal(BUILDER_LAMPORTS[1]);
  });

  it("rejects a third builder purchase (limit 2)", async () => {
    const err = await expectFail(
      program.methods
        .buyBuilder(2)
        .accountsPartial(paymentAccounts(player1.publicKey, Keypair.generate().publicKey))
        .signers([player1])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("PurchaseLimitReached");
  });

  it("enforces sequential buy_expansion and the limit of 2", async () => {
    const outOfOrder = await expectFail(
      program.methods
        .buyExpansion(1)
        .accountsPartial(paymentAccounts(player1.publicKey, Keypair.generate().publicKey))
        .signers([player1])
        .rpc()
    );
    expect(anchorCode(outOfOrder)).to.equal("OutOfOrderPurchase");

    const before = await treasuryBalances();
    await program.methods
      .buyExpansion(0)
      .accountsPartial(paymentAccounts(player1.publicKey, Keypair.generate().publicKey))
      .signers([player1])
      .rpc();
    const after = await treasuryBalances();
    expect(after[0] - before[0]).to.equal(100_000_000);
    expect(after[1] - before[1]).to.equal(87_500_000);
    expect(after[2] - before[2]).to.equal(62_500_000);

    await program.methods
      .buyExpansion(1)
      .accountsPartial(paymentAccounts(player1.publicKey, Keypair.generate().publicKey))
      .signers([player1])
      .rpc();

    const limit = await expectFail(
      program.methods
        .buyExpansion(2)
        .accountsPartial(paymentAccounts(player1.publicKey, Keypair.generate().publicKey))
        .signers([player1])
        .rpc()
    );
    expect(anchorCode(limit)).to.equal("PurchaseLimitReached");

    const player = await program.account.player.fetch(playerPda(player1.publicKey));
    expect(player.buildersPurchased).to.equal(2);
    expect(player.expansionsPurchased).to.equal(2);
  });

  const buySinkAccounts = (wallet: PublicKey, reference: PublicKey, overrides = {}) => ({
    config: configPda,
    playerWallet: wallet,
    treasuryLiquidity,
    treasuryDev,
    treasuryOps,
    reference,
    systemProgram: SystemProgram.programId,
    ...overrides,
  });

  const KIND_ENERGY = 3;
  const KIND_SHIELD = 4;
  const KIND_MINE = 5;
  const SINK_LAMPORTS = 100_000_000; // 0.1 SOL -> 40M / 35M / 25M, no dust

  it("buy_sink(energy) splits the amount 40/35/25 and emits PaymentMade kind=3", async () => {
    const reference = Keypair.generate().publicKey;
    const before = await treasuryBalances();
    // skipPreflight: a fresh local validator intermittently reports "Blockhash
    // not found" during preflight SIMULATION before it has produced enough
    // blocks; skipping preflight (the tx still lands + confirms) makes this
    // balance/event assertion deterministic instead of warmup-flaky.
    const sig = await program.methods
      .buySink(KIND_ENERGY, new BN(SINK_LAMPORTS))
      .accountsPartial(buySinkAccounts(player1.publicKey, reference))
      .signers([player1])
      .rpc({ commitment: "confirmed", skipPreflight: true });
    const after = await treasuryBalances();
    expect(after[0] - before[0]).to.equal(40_000_000);
    expect(after[1] - before[1]).to.equal(35_000_000);
    expect(after[2] - before[2]).to.equal(25_000_000);

    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const parser = new anchor.EventParser(program.programId, program.coder);
    const events = [...parser.parseLogs(tx!.meta!.logMessages!)];
    const pay = events.find((e) => e.name.toLowerCase() === "paymentmade");
    expect(pay, "PaymentMade event missing").to.not.be.undefined;
    expect(pay!.data.kind).to.equal(KIND_ENERGY);
    expect((pay!.data.lamports as BN).toNumber()).to.equal(SINK_LAMPORTS);
    expect((pay!.data.reference as PublicKey).equals(reference)).to.be.true;
  });

  it("buy_sink is REPEATABLE — no on-chain counter or Player PDA (kind=4 shield twice)", async () => {
    // player2 has a Player PDA (paid entry in the pause test); player-with-no-PDA
    // must ALSO be able to buy a sink — prove no PDA is required by using attacker,
    // which never paid entry.
    await program.methods
      .buySink(KIND_SHIELD, new BN(SINK_LAMPORTS))
      .accountsPartial(buySinkAccounts(attacker.publicKey, Keypair.generate().publicKey))
      .signers([attacker])
      .rpc();
    await program.methods
      .buySink(KIND_SHIELD, new BN(SINK_LAMPORTS))
      .accountsPartial(buySinkAccounts(attacker.publicKey, Keypair.generate().publicKey))
      .signers([attacker])
      .rpc();
  });

  it("rejects buy_sink for reserved kinds 0-2 (entry/builder/expansion)", async () => {
    for (const badKind of [0, 1, 2]) {
      const err = await expectFail(
        program.methods
          .buySink(badKind, new BN(SINK_LAMPORTS))
          .accountsPartial(buySinkAccounts(player1.publicKey, Keypair.generate().publicKey))
          .signers([player1])
          .rpc()
      );
      expect(anchorCode(err), `kind ${badKind}`).to.equal("InvalidPaymentKind");
    }
  });

  it("accepts any sink kind >= 3 (mine=5 and a future kind route through unchanged)", async () => {
    for (const kind of [KIND_MINE, 9]) {
      const before = await treasuryBalances();
      await program.methods
        .buySink(kind, new BN(SINK_LAMPORTS))
        .accountsPartial(buySinkAccounts(player1.publicKey, Keypair.generate().publicKey))
        .signers([player1])
        .rpc({ skipPreflight: true });
      const after = await treasuryBalances();
      expect(after[0] - before[0], `kind ${kind}`).to.equal(40_000_000);
    }
  });

  it("rejects buy_sink with a zero amount", async () => {
    const err = await expectFail(
      program.methods
        .buySink(KIND_ENERGY, new BN(0))
        .accountsPartial(buySinkAccounts(player1.publicKey, Keypair.generate().publicKey))
        .signers([player1])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("InvalidAmount");
  });

  it("rejects buy_sink treasury substitution", async () => {
    const err = await expectFail(
      program.methods
        .buySink(KIND_ENERGY, new BN(SINK_LAMPORTS))
        .accountsPartial(
          buySinkAccounts(player1.publicKey, Keypair.generate().publicKey, {
            treasuryDev: attacker.publicKey,
          })
        )
        .signers([player1])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("InvalidTreasury");
  });

  it("rejects set_paused from a non-admin", async () => {
    const err = await expectFail(
      program.methods
        .setPaused(true)
        .accountsPartial({ config: configPda, admin: attacker.publicKey })
        .signers([attacker])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("Unauthorized");
  });

  it("paused blocks payments; unpausing restores them", async () => {
    await program.methods
      .setPaused(true)
      .accountsPartial({ config: configPda, admin })
      .rpc();

    const err = await expectFail(
      program.methods
        .payEntry()
        .accountsPartial(paymentAccounts(player2.publicKey, Keypair.generate().publicKey))
        .signers([player2])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("Paused");

    // The SOL sink is behind the same pause switch.
    const sinkErr = await expectFail(
      program.methods
        .buySink(KIND_ENERGY, new BN(SINK_LAMPORTS))
        .accountsPartial(buySinkAccounts(player2.publicKey, Keypair.generate().publicKey))
        .signers([player2])
        .rpc()
    );
    expect(anchorCode(sinkErr)).to.equal("Paused");

    await program.methods
      .setPaused(false)
      .accountsPartial({ config: configPda, admin })
      .rpc();

    await program.methods
      .payEntry()
      .accountsPartial(paymentAccounts(player2.publicKey, Keypair.generate().publicKey))
      .signers([player2])
      .rpc();
    const player = await program.account.player.fetch(playerPda(player2.publicKey));
    expect(player.wallet.equals(player2.publicKey)).to.be.true;
  });

  it("post_root stores an immutable EpochRoot", async () => {
    const epoch = 1n;
    const root = Array.from({ length: 32 }, (_, i) => i + 1);
    await program.methods
      .postRoot(new BN(epoch.toString()), root, new BN("123456789012345"))
      .accountsPartial({
        config: configPda,
        admin,
        epochRoot: epochRootPda(epoch),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const posted = await program.account.epochRoot.fetch(epochRootPda(epoch));
    expect(posted.epoch.toNumber()).to.equal(1);
    expect(posted.root).to.deep.equal(root);
    expect(posted.totalBalance.toString()).to.equal("123456789012345");
    expect(posted.postedAt.toNumber()).to.be.greaterThan(0);
  });

  it("post_root initializes a canonical PDA that was prefunded", async () => {
    const epoch = 3n;
    const epochPda = epochRootPda(epoch);
    const prefundLamports = Math.max(
      1_000_000,
      await connection.getMinimumBalanceForRentExemption(0),
    );
    const prefundSignature = await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin,
      toPubkey: epochPda,
      lamports: prefundLamports,
    })));
    // AnchorProvider defaults to `processed`; the assertion below deliberately
    // reads `confirmed`, so wait for that stronger commitment instead of racing
    // the validator's next slot. The test is about prefunded canonical PDAs, not
    // about processed-vs-confirmed propagation timing.
    await connection.confirmTransaction(prefundSignature, "confirmed");
    const prefunded = await connection.getAccountInfo(epochPda, "confirmed");
    expect(prefunded?.owner.equals(SystemProgram.programId)).to.be.true;
    expect(prefunded?.data.length).to.equal(0);

    const root = Array.from({ length: 32 }, () => 3);
    await program.methods
      .postRoot(new BN(epoch.toString()), root, new BN(99))
      .accountsPartial({
        config: configPda,
        admin,
        epochRoot: epochPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const posted = await program.account.epochRoot.fetch(epochPda);
    expect(posted.epoch.toString()).to.equal(epoch.toString());
    expect(posted.root).to.deep.equal(root);
    expect(posted.totalBalance.toString()).to.equal("99");
  });

  it("rejects post_root from a non-admin", async () => {
    const err = await expectFail(
      program.methods
        .postRoot(new BN(2), Array.from({ length: 32 }, () => 7), new BN(1))
        .accountsPartial({
          config: configPda,
          admin: attacker.publicKey,
          epochRoot: epochRootPda(2n),
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("Unauthorized");
  });

  it("rejects posting the same epoch twice", async () => {
    const err = await expectFail(
      program.methods
        .postRoot(new BN(1), Array.from({ length: 32 }, () => 9), new BN(2))
        .accountsPartial({
          config: configPda,
          admin,
          epochRoot: epochRootPda(1n),
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    expect(errText(err)).to.match(/already in use/i);
  });

  it("two-step admin transfer: propose, reject impostor, accept, old admin locked out", async () => {
    const newAdmin = Keypair.generate();

    await program.methods
      .proposeAdmin(newAdmin.publicKey)
      .accountsPartial({ config: configPda, admin })
      .rpc();

    const impostor = await expectFail(
      program.methods
        .acceptAdmin()
        .accountsPartial({ config: configPda, newAdmin: attacker.publicKey })
        .signers([attacker])
        .rpc()
    );
    expect(anchorCode(impostor)).to.equal("Unauthorized");

    await program.methods
      .acceptAdmin()
      .accountsPartial({ config: configPda, newAdmin: newAdmin.publicKey })
      .signers([newAdmin])
      .rpc();

    const config = await program.account.config.fetch(configPda);
    expect(config.admin.equals(newAdmin.publicKey)).to.be.true;
    expect(config.pendingAdmin).to.be.null;

    const oldAdmin = await expectFail(
      program.methods
        .setPaused(true)
        .accountsPartial({ config: configPda, admin })
        .rpc()
    );
    expect(anchorCode(oldAdmin)).to.equal("Unauthorized");

    await program.methods
      .setPaused(false)
      .accountsPartial({ config: configPda, admin: newAdmin.publicKey })
      .signers([newAdmin])
      .rpc();
  });
});
