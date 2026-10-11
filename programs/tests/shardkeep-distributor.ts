import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { ShardkeepDistributor } from "../target/types/shardkeep_distributor";
import { MerkleTree, hashLeaf } from "./merkle";

const DECIMALS = 9;
const MINTED = 2_000n * 10n ** 9n; // more than the sum of all leaves -> clawback remainder
const AMOUNTS = [100n, 200n, 300n, 400n, 500n].map((n) => n * 10n ** 9n);

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

describe("shardkeep-distributor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.shardkeepDistributor as Program<ShardkeepDistributor>;
  const connection = provider.connection;
  const admin = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const upgradeableLoader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    upgradeableLoader
  );

  const claimants = AMOUNTS.map(() => Keypair.generate());
  const attacker = Keypair.generate();
  const atas: PublicKey[] = [];

  let mint: PublicKey;
  let distributorPda: PublicKey;
  let vaultAuthority: PublicKey;
  let vault: PublicKey;

  const treeFor = (version: bigint) =>
    new MerkleTree(claimants.map((c, i) => hashLeaf(c.publicKey, AMOUNTS[i], version)));
  const tree1 = treeFor(1n);

  const claimStatusPda = (claimant: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), distributorPda.toBuffer(), claimant.toBuffer()],
      program.programId
    )[0];

  const claimAccounts = (i: number) => ({
    claimant: claimants[i].publicKey,
    distributor: distributorPda,
    claimStatus: claimStatusPda(claimants[i].publicKey),
    vaultAuthority,
    vault,
    claimantTokenAccount: atas[i],
    mint,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  const now = () => Math.floor(Date.now() / 1000);

  before(async () => {
    mint = await createMint(connection, payer, admin, null, DECIMALS);
    [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      program.programId
    );
    [distributorPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("distributor"), mint.toBuffer()],
      program.programId
    );
    vault = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

    // SOL for ClaimStatus rent; an ATA per claimant.
    const fundTx = new Transaction();
    for (const c of [...claimants, attacker]) {
      fundTx.add(
        SystemProgram.transfer({
          fromPubkey: admin,
          toPubkey: c.publicKey,
          lamports: 100_000_000,
        })
      );
    }
    await provider.sendAndConfirm(fundTx);
    for (const c of claimants) {
      atas.push(await createAssociatedTokenAccount(connection, payer, mint, c.publicKey));
    }
  });

  it("rejects initialization from a signer who is not the program upgrade authority", async () => {
    const attackerMint = await createMint(connection, payer, admin, null, DECIMALS);
    const [attackerDistributor] = PublicKey.findProgramAddressSync(
      [Buffer.from("distributor"), attackerMint.toBuffer()],
      program.programId
    );
    const attackerVault = getAssociatedTokenAddressSync(attackerMint, vaultAuthority, true);

    const err = await expectFail(
      program.methods
        .initializeDistributor(
          Array.from(tree1.root),
          new BN(now() + 86_400),
          new BN(now() + 172_800)
        )
        .accountsPartial({
          admin: attacker.publicKey,
          program: program.programId,
          programData,
          mint: attackerMint,
          distributor: attackerDistributor,
          vaultAuthority,
          vault: attackerVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("Unauthorized");
    expect(await connection.getAccountInfo(attackerDistributor)).to.be.null;
  });

  it("initializes the distributor and vault", async () => {
    await program.methods
      .initializeDistributor(
        Array.from(tree1.root),
        new BN(now() + 86_400),
        new BN(now() + 172_800)
      )
      .accountsPartial({
        admin,
        program: program.programId,
        programData,
        mint,
        distributor: distributorPda,
        vaultAuthority,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await mintTo(connection, payer, mint, vault, payer, MINTED);

    const d = await program.account.distributor.fetch(distributorPda);
    expect(d.admin.equals(admin)).to.be.true;
    expect(d.mint.equals(mint)).to.be.true;
    expect(d.vault.equals(vault)).to.be.true;
    expect(Buffer.from(d.root).equals(tree1.root)).to.be.true;
    expect(d.version.toNumber()).to.equal(1);
    expect(d.totalClaimed.toNumber()).to.equal(0);
  });

  it("rejects initialize with claim_end_ts >= clawback_after_ts", async () => {
    // distributor PDA for this mint already exists, so use validation-first
    // ordering via a fresh mint to hit the window check.
    const mint2 = await createMint(connection, payer, admin, null, DECIMALS);
    const [dist2] = PublicKey.findProgramAddressSync(
      [Buffer.from("distributor"), mint2.toBuffer()],
      program.programId
    );
    const vault2 = getAssociatedTokenAddressSync(mint2, vaultAuthority, true);
    const err = await expectFail(
      program.methods
        .initializeDistributor(Array.from(tree1.root), new BN(now() + 100), new BN(now() + 100))
        .accountsPartial({
          admin,
          program: program.programId,
          programData,
          mint: mint2,
          distributor: dist2,
          vaultAuthority,
          vault: vault2,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    expect(anchorCode(err)).to.equal("InvalidWindow");
  });

  it("pays out a valid claim", async () => {
    await program.methods
      .claim(new BN(AMOUNTS[0].toString()), tree1.proofArg(0))
      .accountsPartial(claimAccounts(0))
      .signers([claimants[0]])
      .rpc();

    expect((await getAccount(connection, atas[0])).amount).to.equal(AMOUNTS[0]);
    const d = await program.account.distributor.fetch(distributorPda);
    expect(d.totalClaimed.toString()).to.equal(AMOUNTS[0].toString());

    const status = await program.account.claimStatus.fetch(
      claimStatusPda(claimants[0].publicKey)
    );
    expect(status.claimant.equals(claimants[0].publicKey)).to.be.true;
    expect(status.amount.toString()).to.equal(AMOUNTS[0].toString());
  });

  it("rejects a double claim (ClaimStatus already exists)", async () => {
    const err = await expectFail(
      program.methods
        .claim(new BN(AMOUNTS[0].toString()), tree1.proofArg(0))
        .accountsPartial(claimAccounts(0))
        .signers([claimants[0]])
        .rpc()
    );
    expect(errText(err)).to.match(/already in use/i);
  });

  it("rejects a forged proof (tampered amount)", async () => {
    const err = await expectFail(
      program.methods
        .claim(new BN((AMOUNTS[1] + 1n).toString()), tree1.proofArg(1))
        .accountsPartial(claimAccounts(1))
        .signers([claimants[1]])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("InvalidProof");
  });

  it("rejects a node-as-leaf proof (64-byte second-preimage trick)", async () => {
    // Truncating the proof makes the program start the path at an internal
    // node. Domain separation (0x00-prefixed 81-byte leaf preimages vs
    // 0x01-prefixed 65-byte node preimages) guarantees the recomputed leaf can
    // never collide with an interior node, so this must fail.
    const truncated = tree1.proofArg(2).slice(1);
    const err = await expectFail(
      program.methods
        .claim(new BN(AMOUNTS[2].toString()), truncated)
        .accountsPartial(claimAccounts(2))
        .signers([claimants[2]])
        .rpc()
    );
    expect(anchorCode(err)).to.equal("InvalidProof");
  });

  it("set_root bumps the version and invalidates stale proofs", async () => {
    const nonAdmin = await expectFail(
      program.methods
        .setRoot(Array.from(tree1.root), new BN(now() + 86_400), new BN(now() + 172_800))
        .accountsPartial({ admin: attacker.publicKey, distributor: distributorPda })
        .signers([attacker])
        .rpc()
    );
    expect(anchorCode(nonAdmin)).to.equal("Unauthorized");

    const tree2 = treeFor(2n);
    await program.methods
      .setRoot(Array.from(tree2.root), new BN(now() + 86_400), new BN(now() + 172_800))
      .accountsPartial({ admin, distributor: distributorPda })
      .rpc();

    const d = await program.account.distributor.fetch(distributorPda);
    expect(d.version.toNumber()).to.equal(2);

    // A version-1 proof can no longer replay against the new snapshot.
    const stale = await expectFail(
      program.methods
        .claim(new BN(AMOUNTS[3].toString()), tree1.proofArg(3))
        .accountsPartial(claimAccounts(3))
        .signers([claimants[3]])
        .rpc()
    );
    expect(anchorCode(stale)).to.equal("InvalidProof");

    // The matching version-2 proof works.
    await program.methods
      .claim(new BN(AMOUNTS[3].toString()), tree2.proofArg(3))
      .accountsPartial(claimAccounts(3))
      .signers([claimants[3]])
      .rpc();
    expect((await getAccount(connection, atas[3])).amount).to.equal(AMOUNTS[3]);
  });

  it("rejects claims after the window closes and clawback before its time", async () => {
    // version becomes 3; window already closed, clawback still in the future.
    const tree3 = treeFor(3n);
    await program.methods
      .setRoot(Array.from(tree3.root), new BN(now() - 60), new BN(now() + 3_600))
      .accountsPartial({ admin, distributor: distributorPda })
      .rpc();

    const lateClaim = await expectFail(
      program.methods
        .claim(new BN(AMOUNTS[4].toString()), tree3.proofArg(4))
        .accountsPartial(claimAccounts(4))
        .signers([claimants[4]])
        .rpc()
    );
    expect(anchorCode(lateClaim)).to.equal("ClaimWindowClosed");

    const adminAta = await createAssociatedTokenAccount(connection, payer, mint, admin);
    const earlyClawback = await expectFail(
      program.methods
        .clawback()
        .accountsPartial({
          admin,
          distributor: distributorPda,
          vaultAuthority,
          vault,
          destination: adminAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc()
    );
    expect(anchorCode(earlyClawback)).to.equal("ClawbackTooEarly");
  });

  it("claws back the remaining vault balance after the clawback time", async () => {
    const tree4 = treeFor(4n);
    await program.methods
      .setRoot(Array.from(tree4.root), new BN(now() - 7_200), new BN(now() - 3_600))
      .accountsPartial({ admin, distributor: distributorPda })
      .rpc();

    const adminAta = getAssociatedTokenAddressSync(mint, admin);

    const nonAdmin = await expectFail(
      program.methods
        .clawback()
        .accountsPartial({
          admin: attacker.publicKey,
          distributor: distributorPda,
          vaultAuthority,
          vault,
          destination: adminAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc()
    );
    expect(anchorCode(nonAdmin)).to.equal("Unauthorized");

    await program.methods
      .clawback()
      .accountsPartial({
        admin,
        distributor: distributorPda,
        vaultAuthority,
        vault,
        destination: adminAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const claimed = AMOUNTS[0] + AMOUNTS[3];
    expect((await getAccount(connection, vault)).amount).to.equal(0n);
    expect((await getAccount(connection, adminAta)).amount).to.equal(MINTED - claimed);

    const d = await program.account.distributor.fetch(distributorPda);
    expect(d.totalClaimed.toString()).to.equal(claimed.toString());
  });
});
