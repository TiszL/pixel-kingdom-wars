//! Phase E / S3 spike: baseline for the planned vault program under the production pins
//! (anchor-lang 0.32.1, anchor-spl 0.32.1 `token_interface`, solana-keccak-hasher 2.2.1).
//! NOT DEPLOYABLE (program id = System Program). See docs/phase-e/SPIKES.md.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use solana_keccak_hasher as keccak;

// S3b import-path probe. anchor-lang 0.32.1 re-exports solana-instructions-sysvar 2.x under a
// `#[deprecated(since = "2.2.0", note = "Use solana-instructions-sysvar crate instead")] pub use`,
// so this path compiles only with `#[allow(deprecated)]` on the `use`.
#[allow(deprecated)]
use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;

declare_id!("11111111111111111111111111111111");

pub const LEAF_PREFIX: u8 = 0x02;
pub const NODE_PREFIX: u8 = 0x04;
pub const CONFIG_SEED: &[u8] = b"config";
/// anchor-lang 0.32.1 does not re-export `ed25519_program`; pin the id by value.
pub const ED25519_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
/// Ed25519 precompile header: num_signatures u8, padding u8, then one 14-byte offsets block.
pub const ED25519_HEADER_LEN: usize = 2;
pub const ED25519_OFFSETS_LEN: usize = 14;

#[program]
pub mod spike_economy_core {
    use super::*;

    /// Merkle-sum claim: leaf = keccak(0x02 || wallet || cum_keep || cum_renown || cum_days || seq).
    pub fn claim_mining(
        ctx: Context<ClaimMining>,
        sequence: u64,
        cumulative_keep: u64,
        cumulative_renown: u64,
        cumulative_days: u64,
        proof: Vec<ProofNode>,
    ) -> Result<()> {
        let leaf = leaf_hash(
            &ctx.accounts.miner.key(),
            cumulative_keep,
            cumulative_renown,
            cumulative_days,
            sequence,
        );
        let root = &ctx.accounts.allocation_root;
        require!(
            verify_merkle_sum(leaf, cumulative_keep, &proof, root.root, root.total_keep),
            SpikeError::InvalidProof
        );
        let claim = &mut ctx.accounts.miner_claim;
        require!(sequence > claim.sequence, SpikeError::StaleSequence);
        let delta = cumulative_keep
            .checked_sub(claim.claimed_keep)
            .ok_or(SpikeError::Arithmetic)?;
        claim.sequence = sequence;
        claim.claimed_keep = cumulative_keep;
        claim.claimed_renown = cumulative_renown;
        claim.claimed_days = cumulative_days;

        let seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[ctx.accounts.config.bump]]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.keep_mint.to_account_info(),
                    to: ctx.accounts.miner_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                seeds,
            ),
            delta,
            ctx.accounts.keep_mint.decimals,
        )?;
        Ok(())
    }

    /// Ed25519 precompile introspection: the tx must carry an Ed25519 program instruction at
    /// `ix_index` signed by `expected_signer` over `expected_message`. The runtime already verified
    /// the signature; this instruction only proves it is the one we care about.
    pub fn verify_ed25519_attestation(
        ctx: Context<VerifyAttestation>,
        ix_index: u8,
        expected_signer: Pubkey,
        expected_message: Vec<u8>,
    ) -> Result<()> {
        // load_instruction_at_checked also checks the sysvar account id (UnsupportedSysvar otherwise).
        let ix = load_instruction_at_checked(
            ix_index as usize,
            &ctx.accounts.instructions_sysvar.to_account_info(),
        )?;
        require_keys_eq!(ix.program_id, ED25519_PROGRAM_ID, SpikeError::NotEd25519Program);
        require!(ix.accounts.is_empty(), SpikeError::Ed25519UnexpectedAccounts);
        let d = ix.data.as_slice();
        require!(
            d.len() >= ED25519_HEADER_LEN + ED25519_OFFSETS_LEN,
            SpikeError::Ed25519Malformed
        );
        require!(d[0] == 1, SpikeError::Ed25519NumSignatures);
        require!(d[1] == 0, SpikeError::Ed25519Padding);
        let u16_at = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]);
        let signature_offset = u16_at(2) as usize;
        let signature_instruction_index = u16_at(4);
        let public_key_offset = u16_at(6) as usize;
        let public_key_instruction_index = u16_at(8);
        let message_data_offset = u16_at(10) as usize;
        let message_data_size = u16_at(12) as usize;
        let message_instruction_index = u16_at(14);
        // All three references must point at THIS instruction (u16::MAX), never at another one.
        require!(
            signature_instruction_index == u16::MAX
                && public_key_instruction_index == u16::MAX
                && message_instruction_index == u16::MAX,
            SpikeError::Ed25519CrossInstructionRef
        );
        let _signature = d
            .get(signature_offset..signature_offset + 64)
            .ok_or(SpikeError::Ed25519Malformed)?;
        let public_key = d
            .get(public_key_offset..public_key_offset + 32)
            .ok_or(SpikeError::Ed25519Malformed)?;
        let message = d
            .get(message_data_offset..message_data_offset + message_data_size)
            .ok_or(SpikeError::Ed25519Malformed)?;
        require!(public_key == expected_signer.as_ref(), SpikeError::Ed25519WrongSigner);
        require!(message == expected_message.as_slice(), SpikeError::Ed25519WrongMessage);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Pure Merkle-sum verification (host-testable).
// ---------------------------------------------------------------------------------------------

/// One proof step: the sibling's (hash, sum) and whether the sibling is the LEFT child.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub sum: u64,
    pub is_left: bool,
}

pub fn leaf_hash(
    wallet: &Pubkey,
    cumulative_keep: u64,
    cumulative_renown: u64,
    cumulative_days: u64,
    sequence: u64,
) -> [u8; 32] {
    keccak::hashv(&[
        &[LEAF_PREFIX],
        wallet.as_ref(),
        &cumulative_keep.to_le_bytes(),
        &cumulative_renown.to_le_bytes(),
        &cumulative_days.to_le_bytes(),
        &sequence.to_le_bytes(),
    ])
    .0
}

pub fn node_hash(left: &[u8; 32], left_sum: u64, right: &[u8; 32], right_sum: u64) -> [u8; 32] {
    keccak::hashv(&[
        &[NODE_PREFIX],
        left,
        &left_sum.to_le_bytes(),
        right,
        &right_sum.to_le_bytes(),
    ])
    .0
}

/// Walk `proof` from the leaf to the root, summing as we go. Returns false on overflow.
pub fn verify_merkle_sum(
    leaf_hash: [u8; 32],
    leaf_sum: u64,
    proof: &[ProofNode],
    root: [u8; 32],
    total: u64,
) -> bool {
    let (mut hash, mut sum) = (leaf_hash, leaf_sum);
    for step in proof {
        let Some(next_sum) = sum.checked_add(step.sum) else {
            return false;
        };
        hash = if step.is_left {
            node_hash(&step.hash, step.sum, &hash, sum)
        } else {
            node_hash(&hash, sum, &step.hash, step.sum)
        };
        sum = next_sum;
    }
    hash == root && sum == total
}

// ---------------------------------------------------------------------------------------------
// Accounts (sized to the E1 estimates so INIT_SPACE gives real numbers for the rent table).
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClaimMining<'info> {
    #[account(mut)]
    pub miner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, EconomyConfig>,
    #[account(
        seeds = [b"root", config.key().as_ref(), &allocation_root.epoch.to_le_bytes()],
        bump = allocation_root.bump,
    )]
    pub allocation_root: Account<'info, AllocationRoot>,
    #[account(mut, seeds = [b"claim", miner.key().as_ref()], bump = miner_claim.bump)]
    pub miner_claim: Account<'info, MinerClaim>,
    #[account(address = config.keep_mint)]
    pub keep_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = keep_mint, token::authority = config)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = keep_mint, token::authority = miner)]
    pub miner_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyAttestation<'info> {
    /// CHECK: id is validated inside load_instruction_at_checked.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct EconomyConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub keep_mint: Pubkey,
    pub vault: Pubkey,
    pub root_publisher: Pubkey,
    pub attestation_signer: Pubkey,
    pub emission_per_day: u64,
    pub renown_per_day: u64,
    pub max_claim_per_tx: u64,
    pub permit_price: u64,
    pub charter_price: u64,
    pub epoch_length: u64,
    pub current_epoch: u64,
    pub paused_at: i64,
    pub reserved: [u8; 63],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AllocationRoot {
    pub epoch: u64,
    pub published_at: i64,
    pub kind: u8,
    pub root: [u8; 32],
    pub total_keep: u64,
    pub total_renown: u64,
    pub leaf_count: u32,
    pub total_days: u64,
    pub bump: u8,
    pub frozen: bool,
}

#[account]
#[derive(InitSpace)]
pub struct MinerClaim {
    pub wallet: Pubkey,
    pub sequence: u64,
    pub claimed_keep: u64,
    pub claimed_renown: u64,
    pub claimed_days: u64,
    pub bump: u8,
    pub flags: u8,
    pub reserved: [u8; 16],
}

#[account]
#[derive(InitSpace)]
pub struct RenownRecord {
    pub wallet: Pubkey,
    pub renown: u64,
    pub last_epoch: u64,
    pub streak_days: u64,
    pub updated_at: i64,
    pub bump: u8,
    pub tier: u8,
    pub reserved: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct PermitReceipt {
    pub kind: u8,
    pub wallet: Pubkey,
    pub paid: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClanCharter {
    pub asset: Pubkey,
    pub leader: Pubkey,
    pub collection: Pubkey,
    pub founded_at: i64,
    pub bump: u8,
    pub frozen: bool,
    pub member_count: u64,
    pub treasury_keep: u64,
    pub tier: u8,
    pub reserved: [u8; 32],
}

#[error_code]
pub enum SpikeError {
    InvalidProof,
    StaleSequence,
    Arithmetic,
    NotEd25519Program,
    Ed25519UnexpectedAccounts,
    Ed25519Malformed,
    Ed25519NumSignatures,
    Ed25519Padding,
    Ed25519CrossInstructionRef,
    Ed25519WrongSigner,
    Ed25519WrongMessage,
}

// ---------------------------------------------------------------------------------------------
// Host tests: `cargo test -p spike-economy-core`
// ---------------------------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    const DEPTH: usize = 14;

    struct Leaf {
        wallet: Pubkey,
        keep: u64,
        renown: u64,
        days: u64,
        seq: u64,
    }

    fn make_leaf(i: u64) -> Leaf {
        // Deterministic, distinct wallets and values; no randomness.
        let mut w = [0u8; 32];
        w[..8].copy_from_slice(&i.to_le_bytes());
        w[31] = 0xAA;
        Leaf {
            wallet: Pubkey::new_from_array(w),
            keep: 1_000 + i * 7,
            renown: i % 13,
            days: i % 30,
            seq: i + 1,
        }
    }

    /// Returns (levels, root_hash, root_sum). levels[0] is the leaf level; each entry (hash, sum).
    fn build_tree(leaves: &[Leaf]) -> (Vec<Vec<([u8; 32], u64)>>, [u8; 32], u64) {
        let mut levels: Vec<Vec<([u8; 32], u64)>> = vec![leaves
            .iter()
            .map(|l| (leaf_hash(&l.wallet, l.keep, l.renown, l.days, l.seq), l.keep))
            .collect()];
        while levels.last().unwrap().len() > 1 {
            let prev = levels.last().unwrap();
            let next: Vec<([u8; 32], u64)> = prev
                .chunks(2)
                .map(|pair| {
                    let (lh, ls) = pair[0];
                    let (rh, rs) = pair[1];
                    (node_hash(&lh, ls, &rh, rs), ls + rs)
                })
                .collect();
            levels.push(next);
        }
        let (root, total) = levels.last().unwrap()[0];
        (levels, root, total)
    }

    fn proof_for(levels: &[Vec<([u8; 32], u64)>], mut index: usize) -> Vec<ProofNode> {
        let mut proof = Vec::with_capacity(levels.len() - 1);
        for level in &levels[..levels.len() - 1] {
            let sibling = index ^ 1;
            let (hash, sum) = level[sibling];
            proof.push(ProofNode { hash, sum, is_left: sibling < index });
            index /= 2;
        }
        proof
    }

    #[test]
    fn depth_14_merkle_sum_proofs_verify_and_tampering_fails() {
        let n = 1usize << DEPTH;
        let leaves: Vec<Leaf> = (0..n as u64).map(make_leaf).collect();
        let (levels, root, total) = build_tree(&leaves);
        assert_eq!(levels.len(), DEPTH + 1);
        let expected_total: u64 = leaves.iter().map(|l| l.keep).sum();
        assert_eq!(total, expected_total);

        for &i in &[0usize, 1, 2, 4095, 8191, 8192, n - 2, n - 1] {
            let l = &leaves[i];
            let leaf = leaf_hash(&l.wallet, l.keep, l.renown, l.days, l.seq);
            let proof = proof_for(&levels, i);
            assert_eq!(proof.len(), DEPTH);
            assert!(verify_merkle_sum(leaf, l.keep, &proof, root, total), "leaf {i} must verify");

            // Inflating the claimed amount changes the leaf hash AND the running sum: must fail.
            let inflated = leaf_hash(&l.wallet, l.keep + 1, l.renown, l.days, l.seq);
            assert!(!verify_merkle_sum(inflated, l.keep + 1, &proof, root, total));
            // Keeping the leaf hash but lying about the leaf sum must fail (sum binding).
            assert!(!verify_merkle_sum(leaf, l.keep + 1, &proof, root, total));
            // Wrong total must fail.
            assert!(!verify_merkle_sum(leaf, l.keep, &proof, root, total + 1));
            // Truncated proof must fail.
            assert!(!verify_merkle_sum(leaf, l.keep, &proof[..DEPTH - 1], root, total));
            // Flipping one side flag must fail.
            let mut flipped = proof.clone();
            flipped[3].is_left = !flipped[3].is_left;
            assert!(!verify_merkle_sum(leaf, l.keep, &flipped, root, total));
        }
        println!("S3 merkle-sum: depth={DEPTH} leaves={n} root={} total={total}", hex(&root));
    }

    #[test]
    fn merkle_sum_overflow_is_rejected_not_wrapped() {
        let leaf = [1u8; 32];
        let proof = [ProofNode { hash: [2u8; 32], sum: u64::MAX, is_left: false }];
        assert!(!verify_merkle_sum(leaf, 1, &proof, [0u8; 32], 0));
    }

    #[test]
    fn account_sizes_for_rent_table() {
        // 8-byte discriminator + InitSpace; rent-exempt = (128 + data_len) * 6960 lamports.
        let rows = [
            ("EconomyConfig", 8 + EconomyConfig::INIT_SPACE),
            ("AllocationRoot", 8 + AllocationRoot::INIT_SPACE),
            ("MinerClaim", 8 + MinerClaim::INIT_SPACE),
            ("RenownRecord", 8 + RenownRecord::INIT_SPACE),
            ("PermitReceipt", 8 + PermitReceipt::INIT_SPACE),
            ("ClanCharter", 8 + ClanCharter::INIT_SPACE),
        ];
        for (name, len) in rows {
            println!("S3 size: {name} data_len={len} rent_lamports={}", (128 + len as u64) * 6960);
        }
        assert_eq!(8 + EconomyConfig::INIT_SPACE, 328);
        assert_eq!(8 + AllocationRoot::INIT_SPACE, 87);
        assert_eq!(8 + MinerClaim::INIT_SPACE, 90);
        assert_eq!(8 + RenownRecord::INIT_SPACE, 106);
        assert_eq!(8 + PermitReceipt::INIT_SPACE, 50);
        assert_eq!(8 + ClanCharter::INIT_SPACE, 163);
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
