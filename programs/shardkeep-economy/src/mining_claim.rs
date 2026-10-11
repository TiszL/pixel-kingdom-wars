//! Permanent cumulative mining claims and permissionless Renown synchronization.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use crate::{constants::{MINING_CLAIM_DELAY_SEC, MINING_TOKEN_DECIMALS}, mining::{liability_floor, validate_mining_ata},
    mining_proof::{self, AllocationLeaf, ProofNode}, mining_state::*, EconomyError as E};

pub const MINER_SEED: &[u8] = b"miner";
pub const RENOWN_SEED: &[u8] = b"renown";

#[account]
#[derive(InitSpace)]
pub struct MinerClaim {
    pub wallet: Pubkey,
    pub claimed_total: u64,
    pub last_sequence: u64,
    pub last_claim_at: i64,
    pub version: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RenownRecord {
    pub wallet: Pubkey,
    pub renown_total: u64,
    pub days_attested: u64,
    pub last_sequence: u64,
    pub synced_at: i64,
    pub version: u8,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct OpenMinerRecords<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + MinerClaim::INIT_SPACE,
        seeds = [MINER_SEED, wallet.as_ref()], bump)]
    pub miner: Account<'info, MinerClaim>,
    #[account(init, payer = payer, space = 8 + RenownRecord::INIT_SPACE,
        seeds = [RENOWN_SEED, wallet.as_ref()], bump)]
    pub renown: Account<'info, RenownRecord>,
    pub system_program: Program<'info, System>,
}

pub fn open_miner_records(ctx: Context<OpenMinerRecords>, wallet: Pubkey) -> Result<()> {
    // Permissionless rent payment does not grant the payer any claim authority.
    ctx.accounts.miner.set_inner(MinerClaim { wallet, claimed_total: 0, last_sequence: 0,
        last_claim_at: 0, version: MINING_VERSION, bump: ctx.bumps.miner });
    ctx.accounts.renown.set_inner(RenownRecord { wallet, renown_total: 0, days_attested: 0,
        last_sequence: 0, synced_at: 0, version: MINING_VERSION, bump: ctx.bumps.renown });
    emit!(MinerRecordsOpened { wallet, payer: ctx.accounts.payer.key() });
    Ok(())
}

#[derive(Accounts)]
#[instruction(sequence: u64)]
pub struct ClaimMining<'info> {
    pub claimant: Signer<'info>,
    #[account(mut, seeds = [ECONOMY_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EconomyConfig>>,
    #[account(mut, seeds = [ALLOCATION_SEED, &sequence.to_le_bytes()], bump = root.bump, has_one = config)]
    pub root: Box<Account<'info, AllocationRoot>>,
    #[account(mut, seeds = [MINER_SEED, claimant.key().as_ref()], bump = miner.bump,
        constraint = miner.wallet == claimant.key() @ E::Identity)]
    pub miner: Account<'info, MinerClaim>,
    #[account(mut, seeds = [RENOWN_SEED, claimant.key().as_ref()], bump = renown.bump,
        constraint = renown.wallet == claimant.key() @ E::Identity)]
    pub renown: Account<'info, RenownRecord>,
    #[account(mut, address = config.mining_vault @ E::Token)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)] pub destination: Account<'info, TokenAccount>,
    #[account(address = config.keep_mint @ E::Token,
        constraint = keep_mint.decimals == config.decimals && config.decimals == MINING_TOKEN_DECIMALS @ E::Token)]
    pub keep_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn claim_mining(ctx: Context<ClaimMining>, sequence: u64, cumulative_keep: u64,
    cumulative_renown: u64, cumulative_days: u64, proof: Vec<ProofNode>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let leaf = AllocationLeaf { wallet: ctx.accounts.claimant.key(), cumulative_keep,
        cumulative_renown, cumulative_days, sequence };
    let uses = entitlement(&ctx.accounts.config, &ctx.accounts.root, &ctx.accounts.miner,
        &ctx.accounts.renown, &leaf, &proof, now, CLAIMS_PAUSED)?;
    require!(ctx.accounts.keep_mint.mint_authority.is_none() && ctx.accounts.keep_mint.freeze_authority.is_none(), E::Token);
    validate_mining_ata(&ctx.accounts.vault, ctx.accounts.config.key(), ctx.accounts.keep_mint.key())?;
    validate_mining_ata(&ctx.accounts.destination, leaf.wallet, ctx.accounts.keep_mint.key())?;
    require!(ctx.accounts.vault.key() != ctx.accounts.destination.key(), E::Token);
    let (delta, total_claimed, vault_after, destination_after) = claim_balances(&ctx.accounts.config,
        &ctx.accounts.miner, cumulative_keep, ctx.accounts.vault.amount, ctx.accounts.destination.amount)?;
    let bump = [ctx.accounts.config.bump];
    let seeds: &[&[u8]] = &[ECONOMY_SEED, &bump];
    token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
        from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.keep_mint.to_account_info(),
        to: ctx.accounts.destination.to_account_info(), authority: ctx.accounts.config.to_account_info(),
    }, &[seeds]), delta, ctx.accounts.config.decimals)?;
    ctx.accounts.vault.reload()?;
    ctx.accounts.destination.reload()?;
    require!(ctx.accounts.vault.amount == vault_after && ctx.accounts.destination.amount == destination_after, E::Backing);
    ctx.accounts.config.total_claimed = total_claimed;
    require!(ctx.accounts.vault.amount >= liability_floor(&ctx.accounts.config)?, E::Backing);
    ctx.accounts.miner.claimed_total = cumulative_keep;
    ctx.accounts.miner.last_sequence = sequence;
    ctx.accounts.miner.last_claim_at = now;
    update_renown(&mut ctx.accounts.renown, &leaf, now);
    ctx.accounts.root.claims_count = uses;
    emit!(MiningClaimed { wallet: leaf.wallet, sequence, day: ctx.accounts.root.day, delta,
        cumulative_keep, cumulative_renown, cumulative_days });
    Ok(())
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey, sequence: u64)]
pub struct SyncRenown<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [ECONOMY_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EconomyConfig>>,
    #[account(mut, seeds = [ALLOCATION_SEED, &sequence.to_le_bytes()], bump = root.bump, has_one = config)]
    pub root: Box<Account<'info, AllocationRoot>>,
    #[account(seeds = [MINER_SEED, wallet.as_ref()], bump = miner.bump,
        constraint = miner.wallet == wallet @ E::Identity)]
    pub miner: Account<'info, MinerClaim>,
    #[account(mut, seeds = [RENOWN_SEED, wallet.as_ref()], bump = renown.bump,
        constraint = renown.wallet == wallet @ E::Identity)]
    pub renown: Account<'info, RenownRecord>,
}

pub fn sync_renown(ctx: Context<SyncRenown>, wallet: Pubkey, sequence: u64, cumulative_keep: u64,
    cumulative_renown: u64, cumulative_days: u64, proof: Vec<ProofNode>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let leaf = AllocationLeaf { wallet, cumulative_keep, cumulative_renown, cumulative_days, sequence };
    let uses = entitlement(&ctx.accounts.config, &ctx.accounts.root, &ctx.accounts.miner,
        &ctx.accounts.renown, &leaf, &proof, now, RENOWN_SYNC_PAUSED)?;
    require_sync_progress(&ctx.accounts.renown, &leaf)?;
    update_renown(&mut ctx.accounts.renown, &leaf, now);
    ctx.accounts.root.claims_count = uses;
    emit!(RenownSynced { wallet, sequence, cumulative_renown, cumulative_days });
    Ok(())
}

fn entitlement(config: &EconomyConfig, root: &AllocationRoot, miner: &MinerClaim, renown: &RenownRecord,
    leaf: &AllocationLeaf, proof: &[ProofNode], now: i64, pause: u32) -> Result<u64> {
    require!(config.version == MINING_VERSION && root.version == MINING_VERSION
        && miner.version == MINING_VERSION && renown.version == MINING_VERSION, E::Identity);
    require!(config.flags & pause == 0, E::Paused);
    require!(!root.revoked && root.sequence > 0 && leaf.sequence == root.sequence
        && root.sequence <= config.latest_sequence && leaf.wallet == miner.wallet && leaf.wallet == renown.wallet, E::InvalidMiningClaim);
    let ready = root.published_at.checked_add(MINING_CLAIM_DELAY_SEC).ok_or(E::Arithmetic)?;
    require!(now >= ready, E::Time);
    require!(leaf.sequence >= miner.last_sequence && leaf.sequence >= renown.last_sequence
        && leaf.cumulative_keep >= miner.claimed_total, E::InvalidMiningClaim);
    let elapsed = root.day.checked_sub(config.genesis_day).and_then(|days| days.checked_add(1)).ok_or(E::InvalidMiningRenown)?;
    require!(leaf.cumulative_renown >= renown.renown_total && leaf.cumulative_days >= renown.days_attested
        && leaf.cumulative_renown <= leaf.cumulative_days && leaf.cumulative_days <= elapsed, E::InvalidMiningRenown);
    liability_floor(config)?;
    require!(mining_proof::verify(leaf, proof, &root.root, root.total_cumulative), E::InvalidMiningProof);
    root.claims_count.checked_add(1).ok_or_else(|| error!(E::Arithmetic))
}

/// Return exact post-CPI balances only after proving both liabilities stay funded.
fn claim_balances(config: &EconomyConfig, miner: &MinerClaim, cumulative: u64, vault: u64, recipient: u64)
    -> Result<(u64, u64, u64, u64)> {
    let delta = cumulative.checked_sub(miner.claimed_total).ok_or(E::InvalidMiningClaim)?;
    require!(delta > 0, E::InvalidMiningClaim);
    require!(vault >= liability_floor(config)?, E::Backing);
    let total_claimed = config.total_claimed.checked_add(delta).ok_or(E::Arithmetic)?;
    let player_left = config.total_published_highwater.checked_sub(total_claimed).ok_or(E::Backing)?;
    let tax_left = config.tax_highwater.checked_sub(config.tax_paid).ok_or(E::Backing)?;
    let floor = player_left.checked_add(tax_left).ok_or(E::Arithmetic)?;
    let vault_after = vault.checked_sub(delta).ok_or(E::Backing)?;
    let recipient_after = recipient.checked_add(delta).ok_or(E::Arithmetic)?;
    require!(vault_after >= floor, E::Backing);
    Ok((delta, total_claimed, vault_after, recipient_after))
}

fn require_sync_progress(renown: &RenownRecord, leaf: &AllocationLeaf) -> Result<()> {
    require!(leaf.cumulative_renown > renown.renown_total || leaf.cumulative_days > renown.days_attested, E::InvalidMiningRenown);
    Ok(())
}

fn update_renown(renown: &mut RenownRecord, leaf: &AllocationLeaf, now: i64) {
    renown.renown_total = leaf.cumulative_renown;
    renown.days_attested = leaf.cumulative_days;
    renown.last_sequence = leaf.sequence;
    renown.synced_at = now;
}

#[event] pub struct MinerRecordsOpened { pub wallet: Pubkey, pub payer: Pubkey }
#[event] pub struct MiningClaimed { pub wallet: Pubkey, pub sequence: u64, pub day: u64, pub delta: u64,
    pub cumulative_keep: u64, pub cumulative_renown: u64, pub cumulative_days: u64 }
#[event] pub struct RenownSynced { pub wallet: Pubkey, pub sequence: u64, pub cumulative_renown: u64, pub cumulative_days: u64 }

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (EconomyConfig, AllocationRoot, MinerClaim, RenownRecord, AllocationLeaf) {
        let wallet = Pubkey::new_from_array([9; 32]);
        let leaf = AllocationLeaf { wallet, cumulative_keep: 100, cumulative_renown: 3, cumulative_days: 3, sequence: 4 };
        let config = EconomyConfig { version: MINING_VERSION, authority: Pubkey::new_unique(), publisher: Pubkey::new_unique(),
            keep_mint: Pubkey::new_unique(), mining_vault: Pubkey::new_unique(), emission_reserve_owner: Pubkey::new_unique(),
            emission_reserve_ata: Pubkey::new_unique(), decimals: 9, genesis_day: 100, latest_day: 103, latest_sequence: 5,
            total_published: 1000, total_published_highwater: 1000, total_claimed: 0, tax_highwater: 100, tax_paid: 20,
            recycled_total: 100, gross_published: 1200, split_cursor: 0, flags: 0, correction_pending: false, bump: 1 };
        let root = AllocationRoot { version: MINING_VERSION, config: Pubkey::new_unique(), epoch: Pubkey::new_unique(),
            sequence: 4, day: 102, prev_day: 101, prev_total: 0, total_cumulative: 100, root: mining_proof::hash_leaf(&leaf),
            leaf_count: 1, claims_count: 0, published_at: 100, revoked: false, kind: 0, bump: 1 };
        let miner = MinerClaim { wallet, claimed_total: 0, last_sequence: 0, last_claim_at: 0, version: MINING_VERSION, bump: 1 };
        let renown = RenownRecord { wallet, renown_total: 0, days_attested: 0, last_sequence: 0, synced_at: 0, version: MINING_VERSION, bump: 1 };
        (config, root, miner, renown, leaf)
    }

    #[test]
    fn unused_older_root_remains_claimable_after_the_exact_audit_delay() {
        let (mut config, root, miner, renown, leaf) = fixture();
        let ready = root.published_at + MINING_CLAIM_DELAY_SEC;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], ready - 1, CLAIMS_PAUSED).is_err());
        assert_eq!(entitlement(&config, &root, &miner, &renown, &leaf, &[], ready, CLAIMS_PAUSED).unwrap(), 1);
        config.correction_pending = true;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], ready, CLAIMS_PAUSED).is_ok());
    }

    #[test]
    fn revoked_roots_pause_bits_and_root_use_overflow_refuse() {
        let (mut config, mut root, miner, renown, leaf) = fixture();
        let now = root.published_at + MINING_CLAIM_DELAY_SEC;
        config.flags = CLAIMS_PAUSED;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, RENOWN_SYNC_PAUSED).is_ok());
        config.flags = RENOWN_SYNC_PAUSED;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, RENOWN_SYNC_PAUSED).is_err());
        config.flags = 0; root.revoked = true;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        root.revoked = false; root.claims_count = u64::MAX;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        root.claims_count = 0; root.published_at = i64::MAX;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], i64::MAX, CLAIMS_PAUSED).is_err());
    }

    #[test]
    fn both_record_sequences_and_all_cumulative_fields_remain_monotone() {
        let (config, root, mut miner, mut renown, leaf) = fixture();
        let now = root.published_at + MINING_CLAIM_DELAY_SEC;
        miner.last_sequence = leaf.sequence + 1;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        miner.last_sequence = 0; renown.last_sequence = leaf.sequence + 1;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        renown.last_sequence = 0; miner.claimed_total = leaf.cumulative_keep + 1;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, RENOWN_SYNC_PAUSED).is_err());
        miner.claimed_total = 0; renown.renown_total = leaf.cumulative_renown + 1;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        renown.renown_total = 0; renown.days_attested = leaf.cumulative_days + 1;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
    }

    #[test]
    fn proof_and_permanent_records_bind_the_same_wallet_and_sequence() {
        let (config, mut root, miner, renown, mut leaf) = fixture();
        let now = root.published_at + MINING_CLAIM_DELAY_SEC;
        let wallet = leaf.wallet;
        leaf.wallet = Pubkey::new_unique();
        root.root = mining_proof::hash_leaf(&leaf);
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        leaf.wallet = wallet; leaf.sequence += 1;
        root.root = mining_proof::hash_leaf(&leaf);
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        leaf.sequence = root.sequence;
        root.root = [0; 32];
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
    }

    #[test]
    fn valid_proof_cannot_authorize_impossible_renown_or_elapsed_days() {
        let (config, mut root, miner, renown, mut leaf) = fixture();
        let now = root.published_at + MINING_CLAIM_DELAY_SEC;
        leaf.cumulative_renown = leaf.cumulative_days + 1; root.root = mining_proof::hash_leaf(&leaf);
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        leaf.cumulative_renown = 0; leaf.cumulative_days = 4; root.root = mining_proof::hash_leaf(&leaf);
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
        root.day = config.genesis_day - 1;
        assert!(entitlement(&config, &root, &miner, &renown, &leaf, &[], now, CLAIMS_PAUSED).is_err());
    }

    #[test]
    fn claims_preserve_tax_backing_and_never_repay_a_paid_cumulative_amount() {
        let (mut config, _, mut miner, _, leaf) = fixture();
        assert_eq!(claim_balances(&config, &miner, leaf.cumulative_keep, 1080, 8).unwrap(), (100, 100, 980, 108));
        assert!(claim_balances(&config, &miner, leaf.cumulative_keep, 1079, 8).is_err());
        assert!(claim_balances(&config, &miner, leaf.cumulative_keep, 1080, u64::MAX).is_err());
        miner.claimed_total = 100;
        assert!(claim_balances(&config, &miner, leaf.cumulative_keep, 1080, 8).is_err());
        miner.claimed_total = 0; config.total_claimed = config.total_published_highwater;
        assert!(claim_balances(&config, &miner, leaf.cumulative_keep, 1000, 8).is_err());
        config.total_claimed = 0; config.tax_paid = config.tax_highwater + 1;
        assert!(claim_balances(&config, &miner, leaf.cumulative_keep, 1080, 8).is_err());
    }

    #[test]
    fn permissionless_sync_requires_actual_progress_and_leaves_claim_cursor_untouched() {
        let (config, mut root, miner, mut renown, leaf) = fixture();
        let now = root.published_at + MINING_CLAIM_DELAY_SEC;
        let uses = entitlement(&config, &root, &miner, &renown, &leaf, &[], now, RENOWN_SYNC_PAUSED).unwrap();
        assert!(require_sync_progress(&renown, &leaf).is_ok());
        update_renown(&mut renown, &leaf, now); root.claims_count = uses;
        assert_eq!(miner.claimed_total, 0); assert_eq!(miner.last_sequence, 0);
        assert_eq!(root.claims_count, 1); assert_eq!(renown.renown_total, 3);
        assert!(require_sync_progress(&renown, &leaf).is_err());
        let newer_noop = AllocationLeaf { sequence: leaf.sequence + 1, ..leaf };
        assert!(require_sync_progress(&renown, &newer_noop).is_err());
        assert_eq!(claim_balances(&config, &miner, 100, 1080, 0).unwrap().0, 100);
    }
}
