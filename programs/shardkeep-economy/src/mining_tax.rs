//! Permanent KEEP tax rights for the original, completed Seeker winning spots.
//! Version one held commitments remain encumbered and are never reinterpreted.

use anchor_lang::prelude::*;
use anchor_spl::{associated_token::get_associated_token_address_with_program_id,
    token::{self, Mint, Token, TokenAccount, TransferChecked}};
use solana_keccak_hasher::hash;
use crate::{constants::*, escrow::terms_hash, mining::{liability_floor, validate_mining_ata},
    mining_state::*, state::*, EconomyError as E};

pub const TAX_POOL_SEED: &[u8] = b"mining_tax_pool";
pub const TAX_EPOCH_SEED: &[u8] = b"mining_tax_epoch";
pub const TAX_SPOT_SEED: &[u8] = b"mining_tax_spot";
pub const TAX_VERSION: u16 = 2;
/// Equal cumulative share for every winning spot, with dust retained by its term.
pub const TAX_DISTRIBUTION_VERSION: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct MiningTaxPool {
    pub version: u16,
    pub distribution_version: u8,
    pub config: Pubkey,
    pub term: Pubkey,
    pub term_identity: [u8; 32],
    pub winner_count: u8,
    pub accrued: u64,
    pub paid: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MiningTaxAccrual {
    pub version: u16,
    pub config: Pubkey,
    pub pool: Pubkey,
    pub epoch: Pubkey,
    pub amount: u64,
    pub accrued_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MiningTaxSpot {
    pub version: u16,
    pub pool: Pubkey,
    pub auction: Pubkey,
    pub wallet: Pubkey,
    pub spot: u8,
    pub claimed_total: u64,
    pub bump: u8,
}

fn term_bytes(out: &mut Vec<u8>, auction_config: Pubkey, term_key: Pubkey, registry: Pubkey, term: &SeekerTerm) {
    for key in [auction_config, term_key, registry] { out.extend_from_slice(key.as_ref()); }
    out.extend_from_slice(&term.registry_hash);
    out.extend_from_slice(&term.round.to_le_bytes());
    for value in [term.auction_start, term.auction_end, term.operating_start, term.operating_end] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&[term.winner_count, TAX_DISTRIBUTION_VERSION]);
}

fn identity_prefix(domain: &[u8; 8], config: Pubkey, mint: Pubkey) -> Vec<u8> {
    let mut out = domain.to_vec();
    out.extend_from_slice(&TAX_VERSION.to_le_bytes());
    for key in [crate::ID, config, mint] { out.extend_from_slice(key.as_ref()); }
    out
}

/// Fixed-width v2 wire. The epoch key and day prevent cross-day reinterpretation.
pub fn winning_tax_commitment(config: Pubkey, mint: Pubkey, epoch: Pubkey, day: u64,
    auction_config: Pubkey, term_key: Pubkey, registry: Pubkey, term: &SeekerTerm) -> [u8; 32] {
    let mut out = identity_prefix(b"SKMTAX02", config, mint);
    out.extend_from_slice(epoch.as_ref()); out.extend_from_slice(&day.to_le_bytes());
    term_bytes(&mut out, auction_config, term_key, registry, term);
    hash(&out).0
}

fn term_identity(config: Pubkey, mint: Pubkey, auction_config: Pubkey, term_key: Pubkey,
    registry: Pubkey, term: &SeekerTerm) -> [u8; 32] {
    let mut out = identity_prefix(b"SKMTPI02", config, mint);
    term_bytes(&mut out, auction_config, term_key, registry, term);
    hash(&out).0
}

fn validate_term(economy: &EconomyConfig, config_key: Pubkey, config: &AuctionConfig,
    registry_key: Pubkey, registry: &SeekerRegistry, term: &SeekerTerm) -> Result<()> {
    require!(economy.version == MINING_VERSION && economy.keep_mint != Pubkey::default()
        && economy.authority != Pubkey::default(), E::InvalidVersion);
    // Auction initialization stores token base units, not whole SKR. Use its
    // exact checked conversion so valid nonzero-decimal configs remain usable.
    let scale = 10u64.checked_pow(u32::from(config.decimals)).ok_or(E::Arithmetic)?;
    let opening_bid = OPENING_BID_SKR.checked_mul(scale).ok_or(E::Arithmetic)?;
    require!(config.version == VERSION && config.authority == economy.authority
        && config.registry == registry_key && config.registry_hash == registry.hash
        && config.registry_version == FORMAT_VERSION && config.auction_format == FORMAT_VERSION
        && config.terms_format == FORMAT_VERSION && config.token_program == token::ID
        && config.mint != Pubkey::default() && config.prize_owner != Pubkey::default()
        && config.prize_ata != Pubkey::default() && config.prize_bps == PRIZE_BPS
        && config.opening_bid == opening_bid && config.term_sec == OPERATING_TERM_SEC
        && config.auction_sec == OVERLAPPING_AUCTION_SEC && config.grace_sec == SETTLEMENT_GRACE_SEC,
        E::InvalidMiningTaxTerm);
    require!(registry.version == FORMAT_VERSION && registry.island == ISLAND
        && registry.entries == registry_entries()? && registry.hash == registry_hash(&registry.entries), E::InvalidRegistry);
    require!(term.version == VERSION && term.config == config_key && term.registry == registry_key
        && term.registry_hash == registry.hash
        && [term.auction_start, term.auction_end, term.operating_start, term.operating_end] == calendar(config, term.round)?
        && full_bitmap(&term.opened) && full_bitmap(&term.settled)
        && usize::from(term.completed_count) == TOTAL_SPOTS && term.winner_count > 0
        && term.winner_count <= term.completed_count
        && term.completed_at.is_some_and(|at| at >= term.auction_end)
        && term.completed_slot.is_some_and(|slot| slot > 0), E::InvalidMiningTaxTerm);
    Ok(())
}

fn validate_pool(pool: &MiningTaxPool, config_key: Pubkey, config: &EconomyConfig,
    auction_config: Pubkey, term_key: Pubkey, registry: Pubkey, term: &SeekerTerm) -> Result<()> {
    require!(pool.version == TAX_VERSION && pool.distribution_version == TAX_DISTRIBUTION_VERSION
        && pool.config == config_key && pool.term == term_key && pool.winner_count == term.winner_count
        && pool.term_identity == term_identity(config_key, config.keep_mint, auction_config, term_key, registry, term)
        && pool.paid <= pool.accrued && pool.accrued <= config.tax_highwater && pool.paid <= config.tax_paid,
        E::InvalidMiningTaxTerm);
    Ok(())
}

fn validate_epoch(config: &EconomyConfig, config_key: Pubkey, epoch_key: Pubkey, epoch: &MiningEpochReceipt,
    auction_config: Pubkey, term_key: Pubkey, registry: Pubkey, term: &SeekerTerm, now: i64) -> Result<()> {
    require!(epoch.version == MINING_VERSION && epoch.tax_version == TAX_VERSION && epoch.config == config_key
        && epoch.day > 0 && epoch.day >= config.genesis_day && epoch.day <= config.latest_day
        && epoch.source_hash != [0; 32], E::InvalidMiningTaxEpoch);
    let day_start = i64::try_from(epoch.day).map_err(|_| E::Arithmetic)?
        .checked_mul(MINING_DAY_SEC).ok_or(E::Arithmetic)?;
    let day_end = day_start.checked_add(MINING_DAY_SEC).ok_or(E::Arithmetic)?;
    require!(day_start >= term.operating_start && day_end <= term.operating_end
        && term.completed_at.is_some_and(|at| at <= day_start)
        && epoch.funded_at >= day_end, E::InvalidMiningTaxEpoch);
    require!(now >= epoch.funded_at.checked_add(MINING_CLAIM_DELAY_SEC).ok_or(E::Arithmetic)?, E::Time);
    require!(epoch.tax_commitment == winning_tax_commitment(config_key, config.keep_mint, epoch_key,
        epoch.day, auction_config, term_key, registry, term), E::InvalidMiningTaxEpoch);
    Ok(())
}

fn validate_winner(config_key: Pubkey, config: &AuctionConfig, term_key: Pubkey, term: &SeekerTerm,
    registry: &SeekerRegistry, auction_key: Pubkey, auction: &Auction) -> Result<Pubkey> {
    let winner = auction.result_owner.ok_or(E::InvalidMiningTaxClaim)?;
    require!(winner != Pubkey::default() && auction.version == VERSION && auction.config == config_key
        && auction.term == term_key && auction.registry == term.registry && auction.round == term.round
        && registry.entries.get(usize::from(auction.spot.id)) == Some(&auction.spot)
        && [auction.auction_start, auction.auction_end, auction.operating_start, auction.operating_end]
            == [term.auction_start, term.auction_end, term.operating_start, term.operating_end]
        && auction.terms_hash == terms_hash(config_key, config, auction_key, auction)
        && auction.vault == get_associated_token_address_with_program_id(&auction_key, &config.mint, &token::ID)
        && auction.vault != config.prize_ata && auction.settled && auction.high_bid > 0
        && auction.high_bidder == Some(winner)
        && auction.settled_at.is_some_and(|at| at >= auction.auction_end && Some(at) <= term.completed_at)
        && auction.settled_slot.is_some_and(|slot| slot > 0 && Some(slot) <= term.completed_slot), E::InvalidMiningTaxClaim);
    Ok(winner)
}

fn accrued_total(config: &EconomyConfig, pool: &MiningTaxPool, amount: u64) -> Result<u64> {
    liability_floor(config)?;
    let total = pool.accrued.checked_add(amount).ok_or(E::Arithmetic)?;
    require!(pool.paid <= pool.accrued && total <= config.tax_highwater, E::Backing);
    Ok(total)
}

/// All spots divide the same cumulative total. No caller supplies a payout amount.
fn tax_balances(config: &EconomyConfig, pool: &MiningTaxPool, claimed: u64, vault: u64, destination: u64)
    -> Result<(u64, u64, u64, u64, u64)> {
    require!(pool.winner_count > 0 && pool.paid <= pool.accrued && pool.accrued <= config.tax_highwater,
        E::InvalidMiningTaxClaim);
    let entitlement = pool.accrued / u64::from(pool.winner_count);
    let delta = entitlement.checked_sub(claimed).ok_or(E::InvalidMiningTaxClaim)?;
    require!(delta > 0, E::InvalidMiningTaxClaim);
    require!(vault >= liability_floor(config)?, E::Backing);
    let paid = pool.paid.checked_add(delta).ok_or(E::Arithmetic)?;
    require!(paid <= pool.accrued, E::Backing);
    let total_paid = config.tax_paid.checked_add(delta).ok_or(E::Arithmetic)?;
    let tax_left = config.tax_highwater.checked_sub(total_paid).ok_or(E::Backing)?;
    let floor = config.total_published_highwater.checked_sub(config.total_claimed)
        .and_then(|player| player.checked_add(tax_left)).ok_or(E::Backing)?;
    let after = vault.checked_sub(delta).ok_or(E::Backing)?;
    let destination_after = destination.checked_add(delta).ok_or(E::Arithmetic)?;
    require!(after >= floor, E::Backing);
    Ok((delta, entitlement, paid, after, destination_after))
}

#[derive(Accounts)]
pub struct OpenMiningTaxPool<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(seeds = [ECONOMY_SEED], bump = config.bump)] pub config: Box<Account<'info, EconomyConfig>>,
    #[account(seeds = [CONFIG_SEED], bump = auction_config.bump)] pub auction_config: Box<Account<'info, AuctionConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)] pub registry: Box<Account<'info, SeekerRegistry>>,
    #[account(seeds = [TERM_SEED, auction_config.key().as_ref(), &term.round.to_le_bytes()], bump = term.bump)]
    pub term: Box<Account<'info, SeekerTerm>>,
    #[account(init, payer = payer, space = 8 + MiningTaxPool::INIT_SPACE,
        seeds = [TAX_POOL_SEED, config.key().as_ref(), term.key().as_ref()], bump)]
    pub pool: Account<'info, MiningTaxPool>,
    pub system_program: Program<'info, System>,
}

pub fn open_tax_pool(ctx: Context<OpenMiningTaxPool>) -> Result<()> {
    let a = &ctx.accounts;
    validate_term(&a.config, a.auction_config.key(), &a.auction_config, a.registry.key(), &a.registry, &a.term)?;
    let identity = term_identity(a.config.key(), a.config.keep_mint, a.auction_config.key(), a.term.key(), a.registry.key(), &a.term);
    let pool = &mut ctx.accounts.pool;
    pool.set_inner(MiningTaxPool { version: TAX_VERSION, distribution_version: TAX_DISTRIBUTION_VERSION,
        config: ctx.accounts.config.key(), term: ctx.accounts.term.key(), term_identity: identity,
        winner_count: ctx.accounts.term.winner_count, accrued: 0, paid: 0, bump: ctx.bumps.pool });
    emit!(MiningTaxPoolOpened { pool: pool.key(), config: pool.config, term: pool.term,
        term_identity: identity, winner_count: pool.winner_count, distribution_version: pool.distribution_version });
    Ok(())
}

#[derive(Accounts)]
pub struct AccrueMiningTax<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(seeds = [ECONOMY_SEED], bump = config.bump)] pub config: Box<Account<'info, EconomyConfig>>,
    #[account(seeds = [CONFIG_SEED], bump = auction_config.bump)] pub auction_config: Box<Account<'info, AuctionConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)] pub registry: Box<Account<'info, SeekerRegistry>>,
    #[account(seeds = [TERM_SEED, auction_config.key().as_ref(), &term.round.to_le_bytes()], bump = term.bump)]
    pub term: Box<Account<'info, SeekerTerm>>,
    #[account(mut, seeds = [TAX_POOL_SEED, config.key().as_ref(), term.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, MiningTaxPool>,
    #[account(seeds = [MINING_EPOCH_SEED, &epoch.day.to_le_bytes()], bump = epoch.bump, has_one = config)]
    pub epoch: Account<'info, MiningEpochReceipt>,
    #[account(init, payer = payer, space = 8 + MiningTaxAccrual::INIT_SPACE,
        seeds = [TAX_EPOCH_SEED, config.key().as_ref(), epoch.key().as_ref()], bump)]
    pub accrual: Account<'info, MiningTaxAccrual>,
    pub system_program: Program<'info, System>,
}

pub fn accrue_tax(ctx: Context<AccrueMiningTax>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    validate_term(&a.config, a.auction_config.key(), &a.auction_config, a.registry.key(), &a.registry, &a.term)?;
    validate_pool(&a.pool, a.config.key(), &a.config, a.auction_config.key(), a.term.key(), a.registry.key(), &a.term)?;
    validate_epoch(&a.config, a.config.key(), a.epoch.key(), &a.epoch, a.auction_config.key(), a.term.key(), a.registry.key(), &a.term, now)?;
    let total = accrued_total(&a.config, &a.pool, a.epoch.tax)?;
    ctx.accounts.pool.accrued = total;
    ctx.accounts.accrual.set_inner(MiningTaxAccrual { version: TAX_VERSION, config: ctx.accounts.config.key(),
        pool: ctx.accounts.pool.key(), epoch: ctx.accounts.epoch.key(), amount: ctx.accounts.epoch.tax,
        accrued_at: now, bump: ctx.bumps.accrual });
    emit!(MiningTaxAccrued { pool: ctx.accounts.pool.key(), epoch: ctx.accounts.epoch.key(),
        day: ctx.accounts.epoch.day, amount: ctx.accounts.epoch.tax, accrued: total });
    Ok(())
}

#[derive(Accounts)]
pub struct OpenMiningTaxSpot<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(seeds = [ECONOMY_SEED], bump = config.bump)] pub config: Box<Account<'info, EconomyConfig>>,
    #[account(seeds = [CONFIG_SEED], bump = auction_config.bump)] pub auction_config: Box<Account<'info, AuctionConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)] pub registry: Box<Account<'info, SeekerRegistry>>,
    #[account(seeds = [TERM_SEED, auction_config.key().as_ref(), &term.round.to_le_bytes()], bump = term.bump)]
    pub term: Box<Account<'info, SeekerTerm>>,
    #[account(seeds = [TAX_POOL_SEED, config.key().as_ref(), term.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, MiningTaxPool>,
    #[account(seeds = [AUCTION_SEED, auction_config.key().as_ref(), &[auction.spot.id], &term.round.to_le_bytes()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(init, payer = payer, space = 8 + MiningTaxSpot::INIT_SPACE,
        seeds = [TAX_SPOT_SEED, pool.key().as_ref(), &[auction.spot.id]], bump)]
    pub spot_claim: Account<'info, MiningTaxSpot>,
    pub system_program: Program<'info, System>,
}

pub fn open_tax_spot(ctx: Context<OpenMiningTaxSpot>) -> Result<()> {
    let a = &ctx.accounts;
    validate_term(&a.config, a.auction_config.key(), &a.auction_config, a.registry.key(), &a.registry, &a.term)?;
    validate_pool(&a.pool, a.config.key(), &a.config, a.auction_config.key(), a.term.key(), a.registry.key(), &a.term)?;
    let wallet = validate_winner(a.auction_config.key(), &a.auction_config, a.term.key(), &a.term, &a.registry, a.auction.key(), &a.auction)?;
    ctx.accounts.spot_claim.set_inner(MiningTaxSpot { version: TAX_VERSION, pool: ctx.accounts.pool.key(),
        auction: ctx.accounts.auction.key(), wallet, spot: ctx.accounts.auction.spot.id, claimed_total: 0, bump: ctx.bumps.spot_claim });
    emit!(MiningTaxSpotOpened { pool: ctx.accounts.pool.key(), auction: ctx.accounts.auction.key(),
        spot: ctx.accounts.auction.spot.id, wallet });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimMiningTax<'info> {
    pub claimant: Signer<'info>,
    #[account(mut, seeds = [ECONOMY_SEED], bump = config.bump)] pub config: Box<Account<'info, EconomyConfig>>,
    #[account(seeds = [CONFIG_SEED], bump = auction_config.bump)] pub auction_config: Box<Account<'info, AuctionConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)] pub registry: Box<Account<'info, SeekerRegistry>>,
    #[account(seeds = [TERM_SEED, auction_config.key().as_ref(), &term.round.to_le_bytes()], bump = term.bump)]
    pub term: Box<Account<'info, SeekerTerm>>,
    #[account(mut, seeds = [TAX_POOL_SEED, config.key().as_ref(), term.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, MiningTaxPool>,
    #[account(seeds = [AUCTION_SEED, auction_config.key().as_ref(), &[auction.spot.id], &term.round.to_le_bytes()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [TAX_SPOT_SEED, pool.key().as_ref(), &[auction.spot.id]], bump = spot_claim.bump,
        has_one = pool, has_one = auction, constraint = spot_claim.wallet == claimant.key() @ E::Unauthorized)]
    pub spot_claim: Account<'info, MiningTaxSpot>,
    #[account(mut, address = config.mining_vault @ E::Token)] pub vault: Account<'info, TokenAccount>,
    #[account(mut)] pub destination: Account<'info, TokenAccount>,
    #[account(address = config.keep_mint @ E::Token,
        constraint = keep_mint.decimals == config.decimals && config.decimals == MINING_TOKEN_DECIMALS @ E::Token)]
    pub keep_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn claim_tax(ctx: Context<ClaimMiningTax>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.config.flags & CLAIMS_PAUSED == 0, E::Paused);
    validate_term(&a.config, a.auction_config.key(), &a.auction_config, a.registry.key(), &a.registry, &a.term)?;
    validate_pool(&a.pool, a.config.key(), &a.config, a.auction_config.key(), a.term.key(), a.registry.key(), &a.term)?;
    let wallet = validate_winner(a.auction_config.key(), &a.auction_config, a.term.key(), &a.term, &a.registry, a.auction.key(), &a.auction)?;
    require!(a.spot_claim.version == TAX_VERSION && a.spot_claim.spot == a.auction.spot.id
        && a.spot_claim.wallet == wallet && a.claimant.key() == wallet, E::InvalidMiningTaxClaim);
    require!(a.keep_mint.mint_authority.is_none() && a.keep_mint.freeze_authority.is_none(), E::Token);
    validate_mining_ata(&a.vault, a.config.key(), a.keep_mint.key())?;
    validate_mining_ata(&a.destination, wallet, a.keep_mint.key())?;
    require!(a.vault.key() != a.destination.key(), E::Token);
    let (delta, entitlement, paid, vault_after, destination_after) = tax_balances(&a.config, &a.pool,
        a.spot_claim.claimed_total, a.vault.amount, a.destination.amount)?;
    let total_paid = a.config.tax_paid.checked_add(delta).ok_or(E::Arithmetic)?;
    let bump = [a.config.bump]; let seeds: &[&[u8]] = &[ECONOMY_SEED, &bump];
    token::transfer_checked(CpiContext::new_with_signer(a.token_program.to_account_info(), TransferChecked {
        from: a.vault.to_account_info(), mint: a.keep_mint.to_account_info(), to: a.destination.to_account_info(),
        authority: a.config.to_account_info(),
    }, &[seeds]), delta, a.config.decimals)?;
    ctx.accounts.vault.reload()?; ctx.accounts.destination.reload()?;
    require!(ctx.accounts.vault.amount == vault_after && ctx.accounts.destination.amount == destination_after, E::Backing);
    ctx.accounts.config.tax_paid = total_paid;
    ctx.accounts.pool.paid = paid;
    ctx.accounts.spot_claim.claimed_total = entitlement;
    require!(ctx.accounts.vault.amount >= liability_floor(&ctx.accounts.config)?, E::Backing);
    emit!(MiningTaxClaimed { pool: ctx.accounts.pool.key(), term: ctx.accounts.term.key(),
        auction: ctx.accounts.auction.key(), spot: ctx.accounts.spot_claim.spot, wallet,
        amount: delta, cumulative: entitlement, pool_paid: paid, total_tax_paid: total_paid });
    Ok(())
}

#[event] pub struct MiningTaxPoolOpened { pub pool: Pubkey, pub config: Pubkey, pub term: Pubkey,
    pub term_identity: [u8; 32], pub winner_count: u8, pub distribution_version: u8 }
#[event] pub struct MiningTaxAccrued { pub pool: Pubkey, pub epoch: Pubkey, pub day: u64, pub amount: u64, pub accrued: u64 }
#[event] pub struct MiningTaxSpotOpened { pub pool: Pubkey, pub auction: Pubkey, pub spot: u8, pub wallet: Pubkey }
#[event] pub struct MiningTaxClaimed { pub pool: Pubkey, pub term: Pubkey, pub auction: Pubkey, pub spot: u8,
    pub wallet: Pubkey, pub amount: u64, pub cumulative: u64, pub pool_paid: u64, pub total_tax_paid: u64 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialized_auction_config_uses_token_scaled_opening_bid() {
        let (config, mut auction_config, registry, term, _) = fixture();
        for decimals in [0, 6, 9, 18] {
            auction_config.decimals = decimals;
            auction_config.opening_bid = OPENING_BID_SKR.checked_mul(10u64.checked_pow(u32::from(decimals)).unwrap()).unwrap();
            assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_ok());
        }
        auction_config.decimals = 9; auction_config.opening_bid = OPENING_BID_SKR;
        assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_err());
        for decimals in [19, u8::MAX] {
            auction_config.decimals = decimals;
            assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_err());
        }
    }

    fn fixture() -> (EconomyConfig, AuctionConfig, SeekerRegistry, SeekerTerm, MiningTaxPool) {
        let entries = registry_entries().unwrap();
        let registry = SeekerRegistry { version: FORMAT_VERSION, island: ISLAND, hash: registry_hash(&entries), entries, bump: 0 };
        let config = EconomyConfig { version: MINING_VERSION, authority: Pubkey::new_unique(), keep_mint: Pubkey::new_unique(),
            genesis_day: 10, latest_day: 20, total_published_highwater: 800, tax_highwater: 100, ..Default::default() };
        let auction_config = AuctionConfig { version: VERSION, authority: config.authority, registry: Pubkey::new_unique(),
            registry_hash: registry.hash, registry_version: FORMAT_VERSION, mint: Pubkey::new_unique(), token_program: token::ID,
            decimals: 9, prize_owner: Pubkey::new_unique(), prize_ata: Pubkey::new_unique(), prize_bps: PRIZE_BPS,
            opening_bid: OPENING_BID_SKR * 10u64.pow(9), first_operating_start: 10 * MINING_DAY_SEC, term_sec: OPERATING_TERM_SEC,
            auction_sec: OVERLAPPING_AUCTION_SEC, grace_sec: SETTLEMENT_GRACE_SEC, auction_format: FORMAT_VERSION,
            terms_format: FORMAT_VERSION, bump: 0 };
        let mut bits = [0; BITMAP_BYTES];
        for i in 0..TOTAL_SPOTS { set_bit(&mut bits, i as u8).unwrap(); }
        let times = calendar(&auction_config, 0).unwrap();
        let term = SeekerTerm { version: VERSION, config: Pubkey::new_unique(), registry: auction_config.registry,
            registry_hash: registry.hash, round: 0, previous: None, auction_start: times[0], auction_end: times[1],
            operating_start: times[2], operating_end: times[3], opened: bits, settled: bits, completed_count: TOTAL_SPOTS as u8,
            winner_count: 3, completed_at: Some(times[2]), completed_slot: Some(1), bump: 0 };
        let pool = MiningTaxPool { version: TAX_VERSION, distribution_version: TAX_DISTRIBUTION_VERSION,
            config: Pubkey::new_unique(), term: Pubkey::new_unique(), term_identity: [9; 32], winner_count: 3,
            accrued: 10, paid: 0, bump: 0 };
        (config, auction_config, registry, term, pool)
    }

    #[test]
    fn equal_cumulative_spot_rights_keep_dust_with_the_original_term() {
        let (config, _, _, _, pool) = fixture();
        assert_eq!(tax_balances(&config, &pool, 0, 900, 0).unwrap(), (3, 3, 3, 897, 3));
        let mut later = pool;
        later.accrued = 11; later.paid = 9;
        assert!(tax_balances(&config, &later, 3, 900, 3).is_err());
        later.accrued = 12;
        assert_eq!(tax_balances(&config, &later, 3, 900, 3).unwrap(), (1, 4, 10, 899, 4));
    }

    #[test]
    fn duplicate_claim_and_zero_entitlement_do_not_move_value() {
        let (config, _, _, _, mut pool) = fixture();
        assert!(tax_balances(&config, &pool, 3, 900, 3).is_err());
        assert!(tax_balances(&config, &pool, 4, 900, 3).is_err());
        pool.accrued = 2;
        assert!(tax_balances(&config, &pool, 0, 900, 0).is_err());
        pool.winner_count = 0;
        assert!(tax_balances(&config, &pool, 0, 900, 0).is_err());
    }

    #[test]
    fn complete_player_and_tax_liabilities_are_preserved() {
        let (mut config, _, _, _, pool) = fixture();
        assert!(tax_balances(&config, &pool, 0, 899, 0).is_err());
        assert!(tax_balances(&config, &pool, 0, 900, u64::MAX).is_err());
        config.tax_paid = 99;
        assert!(tax_balances(&config, &pool, 0, 801, 0).is_err());
        config.tax_paid = 0; config.total_claimed = 801;
        assert!(tax_balances(&config, &pool, 0, 900, 0).is_err());
    }

    #[test]
    fn pool_counter_overflow_and_inconsistent_counters_refuse() {
        let (config, _, _, _, mut pool) = fixture();
        pool.paid = pool.accrued + 1;
        assert!(tax_balances(&config, &pool, 0, 900, 0).is_err());
        pool.paid = 9;
        assert!(tax_balances(&config, &pool, 0, 900, 0).is_err());
        pool.accrued = u64::MAX;
        assert!(accrued_total(&config, &pool, 1).is_err());
        pool.accrued = 99; pool.paid = 0;
        assert!(accrued_total(&config, &pool, 2).is_err());
    }

    #[test]
    fn term_must_be_final_complete_and_bind_original_calendar_and_registry() {
        let (config, mut auction_config, registry, mut term, _) = fixture();
        assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_ok());
        term.completed_slot = None;
        assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_err());
        term.completed_slot = Some(0);
        assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_err());
        term.completed_slot = Some(1); term.settled[0] = 0;
        assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_err());
        term.settled = term.opened; term.settled[BITMAP_BYTES - 1] |= 128;
        assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_err());
        term.settled = term.opened; term.winner_count = 0;
        assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_err());
        term.winner_count = (TOTAL_SPOTS + 1) as u8;
        assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_err());
        term.winner_count = 3; auction_config.first_operating_start += 1;
        assert!(validate_term(&config, term.config, &auction_config, auction_config.registry, &registry, &term).is_err());
    }

    #[test]
    fn funded_epoch_needs_one_whole_day_and_the_same_v2_commitment() {
        let (config, ac, registry, term, _) = fixture();
        let economy = Pubkey::new_unique(); let term_key = Pubkey::new_unique(); let epoch_key = Pubkey::new_unique();
        let mut epoch = MiningEpochReceipt { version: MINING_VERSION, config: economy, day: 11, tax: 10,
            source_hash: [1; 32], tax_version: TAX_VERSION, funded_at: 12 * MINING_DAY_SEC, ..Default::default() };
        epoch.tax_commitment = winning_tax_commitment(economy, config.keep_mint, epoch_key, epoch.day, term.config,
            term_key, ac.registry, &term);
        let ready = epoch.funded_at + MINING_CLAIM_DELAY_SEC;
        assert!(validate_epoch(&config, economy, epoch_key, &epoch, term.config, term_key, ac.registry, &term, ready).is_ok());
        assert!(validate_epoch(&config, economy, epoch_key, &epoch, term.config, term_key, ac.registry, &term, ready - 1).is_err());
        epoch.tax_version = 1;
        assert!(validate_epoch(&config, economy, epoch_key, &epoch, term.config, term_key, ac.registry, &term, ready).is_err());
        epoch.tax_version = TAX_VERSION; epoch.day = u64::MAX;
        assert!(validate_epoch(&config, economy, epoch_key, &epoch, term.config, term_key, ac.registry, &term, ready).is_err());
        assert!(validate_term(&config, term.config, &ac, ac.registry, &registry, &term).is_ok());
    }

    #[test]
    fn crossing_term_days_late_completion_and_successor_commitments_refuse() {
        let (config, ac, _, mut term, _) = fixture();
        let economy = Pubkey::new_unique(); let term_key = Pubkey::new_unique(); let epoch_key = Pubkey::new_unique();
        let mut epoch = MiningEpochReceipt { version: MINING_VERSION, config: economy, day: 11, tax: 10,
            source_hash: [1; 32], tax_version: TAX_VERSION, funded_at: 12 * MINING_DAY_SEC, ..Default::default() };
        epoch.tax_commitment = winning_tax_commitment(economy, config.keep_mint, epoch_key, epoch.day, term.config, term_key, ac.registry, &term);
        let now = epoch.funded_at + MINING_CLAIM_DELAY_SEC;
        term.completed_at = Some(11 * MINING_DAY_SEC + 1);
        assert!(validate_epoch(&config, economy, epoch_key, &epoch, term.config, term_key, ac.registry, &term, now).is_err());
        term.completed_at = Some(10 * MINING_DAY_SEC); term.operating_end = 12 * MINING_DAY_SEC - 1;
        assert!(validate_epoch(&config, economy, epoch_key, &epoch, term.config, term_key, ac.registry, &term, now).is_err());
        term.operating_end = 17 * MINING_DAY_SEC;
        assert!(validate_epoch(&config, economy, epoch_key, &epoch, term.config, Pubkey::new_unique(), ac.registry, &term, now).is_err());
    }

    #[test]
    fn commitment_changes_for_every_original_identity_field() {
        let (config, ac, _, mut term, _) = fixture();
        let economy = Pubkey::new_unique(); let term_key = Pubkey::new_unique(); let epoch = Pubkey::new_unique();
        let before = winning_tax_commitment(economy, config.keep_mint, epoch, 11, term.config, term_key, ac.registry, &term);
        assert_ne!(before, winning_tax_commitment(economy, config.keep_mint, epoch, 12, term.config, term_key, ac.registry, &term));
        assert_ne!(before, winning_tax_commitment(economy, Pubkey::new_unique(), epoch, 11, term.config, term_key, ac.registry, &term));
        term.winner_count += 1;
        assert_ne!(before, winning_tax_commitment(economy, config.keep_mint, epoch, 11, term.config, term_key, ac.registry, &term));
    }

    #[test]
    fn fixed_wire_matches_independent_typescript_vector() {
        let (_, _, _, mut term, _) = fixture();
        let config = Pubkey::find_program_address(&[ECONOMY_SEED], &crate::ID).0;
        let auction_config = Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID).0;
        let registry = Pubkey::find_program_address(&[REGISTRY_SEED], &crate::ID).0;
        let term_key = Pubkey::find_program_address(&[TERM_SEED, auction_config.as_ref(), &5u64.to_le_bytes()], &crate::ID).0;
        let epoch = Pubkey::find_program_address(&[MINING_EPOCH_SEED, &24u64.to_le_bytes()], &crate::ID).0;
        term.config = auction_config; term.registry = registry; term.registry_hash = [9; 32]; term.round = 5;
        term.auction_start = 22 * MINING_DAY_SEC; term.auction_end = 23 * MINING_DAY_SEC;
        term.operating_start = 23 * MINING_DAY_SEC; term.operating_end = 30 * MINING_DAY_SEC;
        let hex = |bytes: [u8; 32]| -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() };
        assert_eq!(hex(term_identity(config, Pubkey::new_from_array([3; 32]), auction_config, term_key, registry, &term)),
            "6f6996699ff67fca924362b300b054fbcc7d3e5d8b63c798c10b7ff1a415edf8");
        assert_eq!(hex(winning_tax_commitment(config, Pubkey::new_from_array([3; 32]), epoch, 24, auction_config, term_key, registry, &term)),
            "8c2333efa488f3f789cf26e7e9d6045863ceef0fdc30a364a955192846ef34cd");
    }

    fn auction_fixture(config: &AuctionConfig, term_key: Pubkey, term: &SeekerTerm, registry: &SeekerRegistry,
        id: u8, winner: Pubkey) -> (Pubkey, Auction) {
        let (key, bump) = Pubkey::find_program_address(&[AUCTION_SEED, term.config.as_ref(), &[id], &term.round.to_le_bytes()], &crate::ID);
        let mut auction = Auction { version: VERSION, config: term.config, term: term_key, registry: term.registry,
            spot: registry.entries[usize::from(id)], round: term.round, auction_start: term.auction_start,
            auction_end: term.auction_end, operating_start: term.operating_start, operating_end: term.operating_end,
            terms_hash: [0; 32], vault: get_associated_token_address_with_program_id(&key, &config.mint, &token::ID),
            high_bid: config.opening_bid, high_bidder: Some(winner), outstanding_escrow: 0, settled: true,
            result_owner: Some(winner), settled_at: term.completed_at, settled_slot: term.completed_slot, bump };
        auction.terms_hash = terms_hash(term.config, config, key, &auction);
        (key, auction)
    }

    #[test]
    fn king_regular_and_multiple_spots_bind_the_same_original_wallet_without_weighting() {
        let (_, config, registry, term, _) = fixture();
        let term_key = Pubkey::new_unique(); let winner = Pubkey::new_unique();
        for id in [0, KING_SPOTS as u8, (KING_SPOTS + 1) as u8] {
            let (key, auction) = auction_fixture(&config, term_key, &term, &registry, id, winner);
            assert_eq!(validate_winner(term.config, &config, term_key, &term, &registry, key, &auction).unwrap(), winner);
        }
    }

    #[test]
    fn unsold_successor_mutable_owner_or_incomplete_settlement_never_grants_rights() {
        let (_, config, registry, term, _) = fixture();
        let term_key = Pubkey::new_unique(); let winner = Pubkey::new_unique();
        let (key, mut auction) = auction_fixture(&config, term_key, &term, &registry, 0, winner);
        auction.result_owner = None;
        assert!(validate_winner(term.config, &config, term_key, &term, &registry, key, &auction).is_err());
        auction.result_owner = Some(Pubkey::default());
        assert!(validate_winner(term.config, &config, term_key, &term, &registry, key, &auction).is_err());
        auction.result_owner = Some(winner); auction.high_bidder = Some(Pubkey::new_unique());
        assert!(validate_winner(term.config, &config, term_key, &term, &registry, key, &auction).is_err());
        auction.high_bidder = Some(winner); auction.settled_slot = None;
        assert!(validate_winner(term.config, &config, term_key, &term, &registry, key, &auction).is_err());
        auction.settled_slot = term.completed_slot; auction.settled_at = Some(term.completed_at.unwrap() + 1);
        assert!(validate_winner(term.config, &config, term_key, &term, &registry, key, &auction).is_err());
        auction.settled_at = term.completed_at;
        assert!(validate_winner(term.config, &config, Pubkey::new_unique(), &term, &registry, key, &auction).is_err());
    }
}
