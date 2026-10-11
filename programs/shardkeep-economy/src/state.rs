use anchor_lang::prelude::*;
use solana_keccak_hasher::hash;
use crate::{constants::*, EconomyError as E};

pub const AUTHORITY_SEED: &[u8] = b"seeker_authority";
pub const CONFIG_SEED: &[u8] = b"auction_config";
pub const REGISTRY_SEED: &[u8] = b"seeker_registry";
pub const TERM_SEED: &[u8] = b"seeker_term";
pub const AUCTION_SEED: &[u8] = b"auction";
pub const BID_SEED: &[u8] = b"bid";
pub const PERMIT_SEED: &[u8] = b"permit";
pub const VERSION: u8 = 1;
pub const FORMAT_VERSION: u16 = 1;
pub const ISLAND: u8 = 1;
pub const KING: u8 = 1;
pub const REGULAR: u8 = 0;
pub const BITMAP_BYTES: usize = (TOTAL_SPOTS + 7) / 8;

#[account]
#[derive(InitSpace)]
pub struct SeekerAuthority {
    pub version: u8,
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub guardian: Pubkey,
    pub current_policy_key: Pubkey,
    pub previous_policy_key: Option<Pubkey>,
    pub previous_valid_until: i64,
    pub cluster_genesis: [u8; 32],
    pub admission_paused: bool,
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct AuctionConfig {
    pub version: u8,
    pub authority: Pubkey,
    pub registry: Pubkey,
    pub registry_hash: [u8; 32],
    pub registry_version: u16,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub prize_owner: Pubkey,
    pub prize_ata: Pubkey,
    pub prize_bps: u16,
    pub opening_bid: u64,
    pub first_operating_start: i64,
    pub term_sec: i64,
    pub auction_sec: i64,
    pub grace_sec: i64,
    pub auction_format: u16,
    pub terms_format: u16,
    pub bump: u8,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default, PartialEq, Eq, Debug)]
pub struct Spot {
    pub id: u8,
    pub class: u8,
    pub realm_mask: u8,
}
#[account]
#[derive(InitSpace)]
pub struct SeekerRegistry {
    pub version: u16,
    pub island: u8,
    pub entries: [Spot; TOTAL_SPOTS],
    pub hash: [u8; 32],
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct SeekerTerm {
    pub version: u8,
    pub config: Pubkey,
    pub registry: Pubkey,
    pub registry_hash: [u8; 32],
    pub round: u64,
    pub previous: Option<Pubkey>,
    pub auction_start: i64,
    pub auction_end: i64,
    pub operating_start: i64,
    pub operating_end: i64,
    pub opened: [u8; BITMAP_BYTES],
    pub settled: [u8; BITMAP_BYTES],
    pub completed_count: u8,
    pub winner_count: u8,
    pub completed_at: Option<i64>,
    pub completed_slot: Option<u64>,
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct Auction {
    pub version: u8,
    pub config: Pubkey,
    pub term: Pubkey,
    pub registry: Pubkey,
    pub spot: Spot,
    pub round: u64,
    pub auction_start: i64,
    pub auction_end: i64,
    pub operating_start: i64,
    pub operating_end: i64,
    pub terms_hash: [u8; 32],
    pub vault: Pubkey,
    pub high_bid: u64,
    pub high_bidder: Option<Pubkey>,
    pub outstanding_escrow: u64,
    pub settled: bool,
    pub result_owner: Option<Pubkey>,
    pub settled_at: Option<i64>,
    pub settled_slot: Option<u64>,
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct Bid {
    pub version: u8,
    pub auction: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
    pub refunded: bool,
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct PermitReceipt {
    pub version: u8,
    pub kind: u8,
    pub wallet: Pubkey,
    pub permit_id: [u8; 16],
    pub expiry: i64,
    pub consumed_at: i64,
    pub payload_hash: [u8; 32],
    pub bump: u8,
}

pub fn registry_entries() -> Result<[Spot; TOTAL_SPOTS]> {
    require!(TOTAL_SPOTS <= usize::from(u8::MAX) && REALM_COUNT <= 8
        && KING_SPOTS + REGULAR_SPOTS == TOTAL_SPOTS
        && REGULAR_REALM_COUNT >= REGULAR_REALM_COUNT_MIN
        && REGULAR_REALM_COUNT <= REGULAR_REALM_COUNT_MAX
        && REGULAR_REALM_COUNT <= REALM_COUNT && REALM_COUNT > 0, E::InvalidPolicy);
    let mut entries = [Spot::default(); TOTAL_SPOTS];
    for (i, entry) in entries.iter_mut().enumerate() {
        let king = i < KING_SPOTS;
        let mut realm_mask = 0u8;
        for n in 0..(if king { REALM_COUNT } else { REGULAR_REALM_COUNT }) {
            let realm = if king { n } else { (i - KING_SPOTS + n) % REALM_COUNT };
            realm_mask |= 1u8.checked_shl(u32::try_from(realm).map_err(|_| E::Arithmetic)?).ok_or(E::Arithmetic)?;
        }
        *entry = Spot { id: u8::try_from(i).map_err(|_| E::Arithmetic)?, class: if king { KING } else { REGULAR }, realm_mask };
    }
    Ok(entries)
}
pub fn registry_hash(entries: &[Spot; TOTAL_SPOTS]) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(11 + TOTAL_SPOTS * 3);
    bytes.extend_from_slice(b"SKAREG01"); bytes.extend_from_slice(&FORMAT_VERSION.to_le_bytes()); bytes.push(ISLAND);
    for entry in entries { bytes.extend_from_slice(&[entry.id, entry.class, entry.realm_mask]); }
    hash(&bytes).0
}
pub fn calendar(config: &AuctionConfig, round: u64) -> Result<[i64; 4]> {
    require!(config.term_sec > 0 && config.auction_sec > 0 && config.auction_sec <= config.term_sec, E::InvalidPolicy);
    let delta = i128::from(round).checked_mul(i128::from(config.term_sec)).ok_or(E::Arithmetic)?;
    let start = i128::from(config.first_operating_start).checked_add(delta).ok_or(E::Arithmetic)?;
    let start = i64::try_from(start).map_err(|_| E::Arithmetic)?;
    Ok([start.checked_sub(config.auction_sec).ok_or(E::Arithmetic)?, start, start,
        start.checked_add(config.term_sec).ok_or(E::Arithmetic)?])
}
pub fn set_bit(bits: &mut [u8; BITMAP_BYTES], spot: u8) -> Result<()> {
    let i = usize::from(spot); require!(i < TOTAL_SPOTS, E::InvalidSpot);
    let mask = 1u8.checked_shl(u32::try_from(i % 8).map_err(|_| E::Arithmetic)?).ok_or(E::Arithmetic)?;
    require!(bits[i / 8] & mask == 0, E::AlreadyRecorded); bits[i / 8] |= mask; Ok(())
}
pub fn full_bitmap(bits: &[u8; BITMAP_BYTES]) -> bool {
    (0..BITMAP_BYTES * 8).all(|i| (bits[i / 8] & (1 << (i % 8)) != 0) == (i < TOTAL_SPOTS))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> AuctionConfig {
        AuctionConfig { version: VERSION, authority: Pubkey::default(), registry: Pubkey::default(), registry_hash: [0; 32],
            registry_version: FORMAT_VERSION, mint: Pubkey::default(), token_program: Pubkey::default(), decimals: 0,
            prize_owner: Pubkey::default(), prize_ata: Pubkey::default(), prize_bps: PRIZE_BPS, opening_bid: OPENING_BID_SKR,
            first_operating_start: OPERATING_TERM_SEC, term_sec: OPERATING_TERM_SEC, auction_sec: OVERLAPPING_AUCTION_SEC,
            grace_sec: SETTLEMENT_GRACE_SEC, auction_format: FORMAT_VERSION, terms_format: FORMAT_VERSION, bump: 0 }
    }
    #[test]
    fn registry_has_exact_stable_population_and_balanced_realms() {
        let entries = registry_entries().unwrap();
        assert_eq!(entries.iter().filter(|x| x.class == KING).count(), KING_SPOTS);
        assert_eq!(entries.iter().filter(|x| x.class == REGULAR).count(), REGULAR_SPOTS);
        let mut per_realm = [0usize; REALM_COUNT];
        for (i, entry) in entries.iter().enumerate() {
            assert_eq!(usize::from(entry.id), i);
            assert_eq!(entry.realm_mask.count_ones() as usize, if i < KING_SPOTS { REALM_COUNT } else { REGULAR_REALM_COUNT });
            if i >= KING_SPOTS {
                for (realm, count) in per_realm.iter_mut().enumerate() { if entry.realm_mask & (1 << realm) != 0 { *count += 1; } }
            }
        }
        assert!(per_realm.iter().all(|count| *count == REGULAR_SPOTS * REGULAR_REALM_COUNT / REALM_COUNT));
    }
    #[test]
    fn registry_hash_matches_executed_typescript_vector() {
        let hash = registry_hash(&registry_entries().unwrap());
        let encoded: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(encoded, "a4aacd9f6dd5caa33c42b3163d9ad45b0efcb9a500520315792b2b677db9e200");
    }
    #[test]
    fn term_calendar_never_moves_with_preparation_time() {
        let c = config(); let first = calendar(&c, 0).unwrap(); let next = calendar(&c, 1).unwrap();
        assert_eq!(first[1], first[2]); assert_eq!(first[3], next[2]);
        assert_eq!(next[1] - next[0], OVERLAPPING_AUCTION_SEC);
        assert_eq!(next[3] - next[2], OPERATING_TERM_SEC);
    }
    #[test]
    fn calendar_rejects_round_and_clock_overflow() {
        let mut c = config(); assert!(calendar(&c, u64::MAX).is_err());
        c.first_operating_start = i64::MAX; assert!(calendar(&c, 0).is_err());
        c.first_operating_start = i64::MIN; assert!(calendar(&c, 0).is_err());
    }
    #[test]
    fn completeness_requires_every_distinct_spot_and_no_unused_bit() {
        let mut bits = [0; BITMAP_BYTES];
        for i in 0..TOTAL_SPOTS - 1 { set_bit(&mut bits, i as u8).unwrap(); }
        assert!(!full_bitmap(&bits)); assert!(set_bit(&mut bits, 0).is_err());
        set_bit(&mut bits, (TOTAL_SPOTS - 1) as u8).unwrap(); assert!(full_bitmap(&bits));
        assert!(set_bit(&mut bits, TOTAL_SPOTS as u8).is_err());
        if TOTAL_SPOTS % 8 != 0 { bits[BITMAP_BYTES - 1] |= 1 << (TOTAL_SPOTS % 8); assert!(!full_bitmap(&bits)); }
    }
}
