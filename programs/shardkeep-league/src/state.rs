use anchor_lang::prelude::*;
use crate::{constants::*, LeagueError as E};

pub const VERSION: u8 = 1;
pub const CONFIG_SEED: &[u8] = b"league_config";
pub const WEEK_SEED: &[u8] = b"league_week";
pub const VAULT_SEED: &[u8] = b"league_vault";
// Calendar wire protocol constants, authorized by Lantern2c498a74. Reward policy
// and settlement delay are generated exclusively from shared constants.
pub const LEAGUE_WEEK_SEC: i64 = 604_800;
pub const MONDAY_OFFSET_SEC: i64 = 345_600;
const _: () = assert!(LEAGUE_BITMAP_BYTES == (LEAGUE_SKR_MAX_PLACES as usize + 7) / 8);

#[account]
#[derive(InitSpace)]
pub struct LeagueConfig {
    pub version: u8,
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub guardian: Pubkey,
    pub funder: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub sweep_owner: Pubkey,
    pub sweep_ata: Pubkey,
    pub claim_window_sec: i64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct LeagueWeek {
    pub version: u8,
    pub config: Pubkey,
    pub week_start: i64,
    pub root: [u8; 32],
    pub total_raw: u64,
    pub leaf_count: u16,
    pub allocation_hash: [u8; 32],
    pub vault: Pubkey,
    pub claimed_raw: u64,
    pub claimed_count: u16,
    pub claimed_bitmap: [u8; LEAGUE_BITMAP_BYTES],
    pub opened_at: i64,
    pub claim_deadline: i64,
    pub swept: bool,
    pub swept_raw: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

pub fn validate_window(window: i64) -> Result<()> {
    require!(window > 0 && window <= LEAGUE_CLAIM_WINDOW_MAX_SEC, E::InvalidWindow);
    Ok(())
}

pub fn validate_week_start(start: i64) -> Result<()> {
    require!(start > 0, E::InvalidWeekStart);
    let offset = start.checked_sub(MONDAY_OFFSET_SEC).ok_or(E::ArithmeticOverflow)?;
    require!(offset.rem_euclid(LEAGUE_WEEK_SEC) == 0, E::InvalidWeekStart);
    Ok(())
}

pub fn week_close(start: i64) -> Result<i64> {
    validate_week_start(start)?;
    start.checked_add(LEAGUE_WEEK_SEC).and_then(|v| v.checked_add(LEAGUE_SETTLEMENT_DELAY_SEC))
        .ok_or_else(|| error!(E::ArithmeticOverflow))
}

pub fn initial_deadline(now: i64, window: i64) -> Result<i64> {
    validate_window(window)?;
    // Every opened week must retain a representable extension ceiling.
    now.checked_add(LEAGUE_CLAIM_WINDOW_MAX_SEC).ok_or(E::ArithmeticOverflow)?;
    now.checked_add(window).ok_or_else(|| error!(E::ArithmeticOverflow))
}

pub fn validate_open(now: i64, start: i64, root: &[u8; 32], total: u64, count: u16) -> Result<()> {
    require!(now >= week_close(start)?, E::WeekNotClosed);
    require!(*root != [0; 32], E::InvalidRoot);
    require!(count > 0 && count <= LEAGUE_SKR_MAX_PLACES, E::InvalidLeafCount);
    require!(total > 0, E::InvalidAmount);
    Ok(())
}

/// Computes the next counters without mutating state. The caller verifies the
/// proof and token deltas before committing these values and the bitmap bit.
pub fn validate_claim(week: &LeagueWeek, now: i64, index: u16, amount: u64) -> Result<(u64, u16)> {
    require!(!week.swept, E::WeekSwept);
    require!(now < week.claim_deadline, E::ClaimExpired);
    require!(index < LEAGUE_SKR_MAX_PLACES, E::InvalidIndex);
    require!(week.claimed_bitmap[usize::from(index / 8)] & (1 << (index % 8)) == 0, E::AlreadyClaimed);
    require!(amount > 0, E::InvalidAmount);
    let claimed_raw = week.claimed_raw.checked_add(amount).ok_or(E::ArithmeticOverflow)?;
    let claimed_count = week.claimed_count.checked_add(1).ok_or(E::ArithmeticOverflow)?;
    require!(claimed_raw <= week.total_raw && claimed_count <= week.leaf_count, E::ClaimTotalExceeded);
    Ok((claimed_raw, claimed_count))
}

pub fn record_claim(week: &mut LeagueWeek, index: u16, raw: u64, count: u16) {
    week.claimed_bitmap[usize::from(index / 8)] |= 1 << (index % 8);
    week.claimed_raw = raw;
    week.claimed_count = count;
}

pub fn validate_sweep(week: &LeagueWeek, now: i64) -> Result<()> {
    require!(!week.swept, E::WeekSwept);
    require!(now >= week.claim_deadline, E::ClaimWindowOpen);
    Ok(())
}

pub fn validate_extension(week: &LeagueWeek, new_deadline: i64) -> Result<()> {
    require!(!week.swept, E::WeekSwept);
    let ceiling = week.opened_at.checked_add(LEAGUE_CLAIM_WINDOW_MAX_SEC).ok_or(E::ArithmeticOverflow)?;
    require!(new_deadline > week.claim_deadline && new_deadline <= ceiling, E::InvalidDeadline);
    Ok(())
}

pub fn verify_deltas(source_before: u64, source_after: u64, destination_before: u64, destination_after: u64, amount: u64) -> Result<()> {
    let debit = source_before.checked_sub(source_after).ok_or(E::ArithmeticOverflow)?;
    let credit = destination_after.checked_sub(destination_before).ok_or(E::ArithmeticOverflow)?;
    require!(debit == amount && credit == amount, E::TransferDeltaMismatch);
    Ok(())
}
