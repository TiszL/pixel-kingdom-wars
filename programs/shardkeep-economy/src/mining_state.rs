use anchor_lang::prelude::*;

pub const ECONOMY_SEED: &[u8] = b"economy";
pub const ALLOCATION_SEED: &[u8] = b"alloc";
pub const MINING_EPOCH_SEED: &[u8] = b"mining_epoch";
pub const MINING_VERSION: u8 = 1;
pub const MINING_MAX_LEAVES: u32 = 1 << 16; // Accepted B3a depth-16 wire bound.
pub const CLAIMS_PAUSED: u32 = 1;
pub const PUBLISH_PAUSED: u32 = 2;
pub const RENOWN_SYNC_PAUSED: u32 = 32;
pub const MINING_FLAGS: u32 = CLAIMS_PAUSED | PUBLISH_PAUSED | RENOWN_SYNC_PAUSED;

#[account]
#[derive(InitSpace, Default)]
pub struct EconomyConfig {
    pub version: u8,
    pub authority: Pubkey,
    pub publisher: Pubkey,
    pub keep_mint: Pubkey,
    pub mining_vault: Pubkey,
    pub emission_reserve_owner: Pubkey,
    pub emission_reserve_ata: Pubkey,
    pub decimals: u8,
    pub genesis_day: u64,
    pub latest_day: u64,
    // Allocation identities are never reused, including after revocation.
    pub latest_sequence: u64,
    pub total_published: u64,
    pub total_published_highwater: u64,
    pub total_claimed: u64,
    pub tax_highwater: u64,
    pub tax_paid: u64,
    pub recycled_total: u64,
    pub gross_published: u64,
    pub split_cursor: u8,
    pub flags: u32,
    pub correction_pending: bool,
    pub bump: u8,
}

/// Immutable funded-day fact. Version-two winning-term commitments can accrue
/// into permanent original-term tax pools. Held version-one commitments remain
/// liabilities and can never be reinterpreted by that payout protocol.
#[account]
#[derive(InitSpace, Default)]
pub struct MiningEpochReceipt {
    pub version: u8,
    pub config: Pubkey,
    pub day: u64,
    pub budget_gross: u64,
    pub free_gross: u64,
    pub deed_gross: u64,
    pub player_net: u64,
    pub tax: u64,
    pub recycle: u64,
    pub source_hash: [u8; 32],
    pub tax_commitment: [u8; 32],
    pub tax_version: u16,
    pub split_start: u8,
    pub split_end: u8,
    pub funded_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace, Default)]
pub struct AllocationRoot {
    pub version: u8,
    pub config: Pubkey,
    pub epoch: Pubkey,
    pub sequence: u64,
    pub day: u64,
    pub prev_day: u64,
    pub prev_total: u64,
    pub root: [u8; 32],
    pub total_cumulative: u64,
    pub leaf_count: u32,
    pub claims_count: u64,
    pub published_at: i64,
    pub revoked: bool,
    pub kind: u8,
    pub bump: u8,
}
