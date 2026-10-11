//! One atomic SOL purchase creates access, quota use and its permanent receipt.
//! Current seller authority is required at acceptance; paid access outlives it.
use anchor_lang::{prelude::*, system_program::{self, Transfer}};
use anchor_spl::{associated_token::get_associated_token_address_with_program_id, token};
use crate::{constants::*, escrow::terms_hash, state::*, EconomyError as E};

pub const REALM_SALE_CONFIG_SEED: &[u8] = b"realm_sale_config";
pub const REALM_ACCESS_SEED: &[u8] = b"realm_access";
pub const SPOT_SALES_SEED: &[u8] = b"spot_sales";
pub const REALM_SALE_RECEIPT_SEED: &[u8] = b"realm_sale";

#[account]
#[derive(InitSpace)]
pub struct RealmSaleConfig {
    pub version: u8,
    pub authority: Pubkey,
    pub developer: Pubkey,
    pub price_lamports: u64,
    pub duration_sec: i64,
    pub seller_bps: u16,
    pub developer_bps: u16,
    pub quota_max: u8,
    pub day_sec: i64,
    pub quote_ttl_sec: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RealmAccess {
    pub version: u8,
    pub config: Pubkey,
    pub wallet: Pubkey,
    pub realm: u8,
    pub expires_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SpotSalesQuota {
    pub version: u8,
    pub spot: u8,
    pub day: u64,
    pub sales: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RealmSaleReceipt {
    pub version: u8,
    pub config: Pubkey,
    pub sale_id: [u8; 16],
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub developer: Pubkey,
    pub term: Pubkey,
    pub spot: u8,
    pub realm: u8,
    pub day: u64,
    pub round: u64,
    pub registry_version: u16,
    pub registry_hash: [u8; 32],
    pub price_lamports: u64,
    pub seller_lamports: u64,
    pub developer_lamports: u64,
    pub prior_expiry: i64,
    pub coverage_start: i64,
    pub expires_at: i64,
    pub accepted_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BuyRealmAccessArgs {
    pub version: u8,
    pub sale_id: [u8; 16],
    pub spot: u8,
    pub realm: u8,
    pub round: u64,
    pub day: u64,
    pub seller: Pubkey,
    pub developer: Pubkey,
    pub registry_version: u16,
    pub price_lamports: u64,
    pub duration_sec: i64,
    pub seller_bps: u16,
    pub developer_bps: u16,
    pub prior_expiry: i64,
    pub valid_after: i64,
    pub valid_until: i64,
}

fn validate_config(c: &RealmSaleConfig) -> Result<()> {
    require!(c.version == REALM_SALE_VERSION && c.authority != Pubkey::default()
        && c.developer != Pubkey::default() && c.price_lamports == REALM_SALE_PRICE_LAMPORTS
        && c.duration_sec == REALM_SALE_DURATION_SEC && c.seller_bps == REALM_SALE_SELLER_BPS
        && c.developer_bps == REALM_SALE_DEV_BPS && c.quota_max == REALM_SALE_DAILY_QUOTA
        && c.day_sec == MINING_DAY_SEC && c.quote_ttl_sec == REALM_SALE_QUOTE_TTL_SEC,
        E::InvalidRealmSaleTerms);
    require!(c.price_lamports > 0 && c.duration_sec > 0 && c.day_sec > 0 && c.quote_ttl_sec > 0
        && c.quota_max > 0 && u64::from(c.seller_bps) + u64::from(c.developer_bps) == BPS_DENOMINATOR,
        E::InvalidPolicy);
    Ok(())
}

fn utc_day(now: i64) -> Result<u64> {
    require!(now >= 0 && MINING_DAY_SEC > 0, E::Time);
    u64::try_from(now / MINING_DAY_SEC).map_err(|_| error!(E::Arithmetic))
}

fn validate_quote(c: &RealmSaleConfig, a: &BuyRealmAccessArgs, now: i64) -> Result<()> {
    validate_config(c)?;
    require!(a.version == c.version && a.sale_id != [0; 16] && usize::from(a.spot) < TOTAL_SPOTS
        && usize::from(a.realm) < REALM_COUNT && a.seller != Pubkey::default() && a.developer == c.developer
        && a.registry_version == FORMAT_VERSION && a.price_lamports == c.price_lamports
        && a.duration_sec == c.duration_sec && a.seller_bps == c.seller_bps && a.developer_bps == c.developer_bps,
        E::InvalidRealmSaleTerms);
    require!(a.valid_after >= 0 && a.valid_until >= a.valid_after && now >= a.valid_after && now <= a.valid_until
        && a.valid_until.checked_sub(a.valid_after).ok_or(E::Arithmetic)? <= c.quote_ttl_sec
        && a.day == utc_day(now)?, E::Time);
    Ok(())
}

fn coverage(c: &RealmSaleConfig, a: &BuyRealmAccessArgs, prior: i64, now: i64) -> Result<(i64, i64)> {
    require!(prior >= 0 && prior == a.prior_expiry, E::RealmAccessChanged);
    let start = now.max(prior);
    let end = start.checked_add(c.duration_sec).ok_or(E::Arithmetic)?;
    Ok((start, end))
}

fn next_quota(c: &RealmSaleConfig, q: &SpotSalesQuota, spot: u8, day: u64) -> Result<u8> {
    require!(q.version == REALM_SALE_VERSION && q.spot == spot && q.day == day, E::Identity);
    require!(q.sales < c.quota_max, E::RealmSaleQuotaExhausted);
    q.sales.checked_add(1).ok_or_else(|| error!(E::Arithmetic))
}

fn sale_legs(c: &RealmSaleConfig) -> Result<(u64, u64)> {
    let leg = |bps: u16| -> Result<u64> {
        u64::try_from(u128::from(c.price_lamports).checked_mul(u128::from(bps)).ok_or(E::Arithmetic)?
            / u128::from(BPS_DENOMINATOR)).map_err(|_| error!(E::Arithmetic))
    };
    let seller = leg(c.seller_bps)?; let developer = leg(c.developer_bps)?;
    require!(seller.checked_add(developer) == Some(c.price_lamports), E::InvalidPolicy);
    Ok((seller, developer))
}

/// Role obligations aggregate by unique key. Self-directed legs are zero-net,
/// never a different price; two recipient roles may also share the same key.
fn payment_balances(keys: [Pubkey; 3], before: [u64; 3], seller: u64, developer: u64) -> Result<[u64; 3]> {
    let total = seller.checked_add(developer).ok_or(E::Arithmetic)?;
    let deltas = [-i128::from(total), i128::from(seller), i128::from(developer)];
    let mut after = [0; 3];
    for i in 0..3 {
        let mut value = i128::from(before[i]);
        for j in 0..3 {
            if keys[i] == keys[j] {
                require!(before[i] == before[j], E::RealmSaleBalance);
                value = value.checked_add(deltas[j]).ok_or(E::Arithmetic)?;
            }
        }
        after[i] = u64::try_from(value).map_err(|_| error!(E::RealmSaleBalance))?;
    }
    Ok(after)
}

fn validate_seller(authority: Pubkey, config_key: Pubkey, c: &AuctionConfig, registry_key: Pubkey,
    registry: &SeekerRegistry, term_key: Pubkey, term: &SeekerTerm, auction_key: Pubkey,
    auction: &Auction, a: &BuyRealmAccessArgs, now: i64, slot: u64) -> Result<()> {
    let scale = 10u64.checked_pow(u32::from(c.decimals)).ok_or(E::Arithmetic)?;
    let opening_bid = OPENING_BID_SKR.checked_mul(scale).ok_or(E::Arithmetic)?;
    require!(c.version == VERSION && c.authority == authority && c.registry == registry_key
        && c.registry_version == FORMAT_VERSION && c.registry_hash == registry.hash
        && c.auction_format == FORMAT_VERSION && c.terms_format == FORMAT_VERSION
        && c.token_program == token::ID && c.mint != Pubkey::default() && c.prize_owner != Pubkey::default()
        && c.prize_ata == get_associated_token_address_with_program_id(&c.prize_owner, &c.mint, &token::ID)
        && c.prize_bps == PRIZE_BPS && c.opening_bid == opening_bid && c.term_sec == OPERATING_TERM_SEC
        && c.auction_sec == OVERLAPPING_AUCTION_SEC && c.grace_sec == SETTLEMENT_GRACE_SEC, E::InvalidRealmSeller);
    require!(registry.version == FORMAT_VERSION && registry.island == ISLAND
        && registry.entries == registry_entries()? && registry.hash == registry_hash(&registry.entries), E::InvalidRegistry);
    require!(term.version == VERSION && term.config == config_key && term.registry == registry_key
        && term.registry_hash == registry.hash && term.round == a.round
        && [term.auction_start, term.auction_end, term.operating_start, term.operating_end] == calendar(c, a.round)?
        && full_bitmap(&term.opened) && full_bitmap(&term.settled) && usize::from(term.completed_count) == TOTAL_SPOTS
        && term.winner_count > 0 && term.winner_count <= term.completed_count
        && term.completed_at.is_some_and(|at| at >= term.auction_end && at <= now)
        && term.completed_slot.is_some_and(|completed| completed > 0 && completed <= slot), E::InvalidRealmSeller);
    require!(now >= term.operating_start && now < term.operating_end, E::Time);
    let realm_bit = 1u8.checked_shl(u32::from(a.realm)).ok_or(E::InvalidRealmSaleTerms)?;
    require!(auction.version == VERSION && auction.config == config_key && auction.term == term_key
        && auction.registry == registry_key && auction.round == a.round && auction.spot.id == a.spot
        && registry.entries.get(usize::from(a.spot)) == Some(&auction.spot) && auction.spot.realm_mask & realm_bit != 0
        && [auction.auction_start, auction.auction_end, auction.operating_start, auction.operating_end]
            == [term.auction_start, term.auction_end, term.operating_start, term.operating_end]
        && auction.terms_hash == terms_hash(config_key, c, auction_key, auction)
        && auction.vault == get_associated_token_address_with_program_id(&auction_key, &c.mint, &token::ID)
        && auction.vault != c.prize_ata && auction.settled && auction.high_bid >= opening_bid
        && auction.high_bidder == Some(a.seller) && auction.result_owner == Some(a.seller)
        && auction.settled_at.is_some_and(|at| at >= auction.auction_end && Some(at) <= term.completed_at)
        && auction.settled_slot.is_some_and(|settled| settled > 0 && Some(settled) <= term.completed_slot), E::InvalidRealmSeller);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeRealmSaleConfig<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    pub upgrade_authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ E::Unauthorized)]
    pub program: Program<'info, crate::program::ShardkeepEconomy>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ E::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(seeds = [AUTHORITY_SEED], bump = authority.bump, has_one = admin,
        constraint = authority.version == VERSION @ E::InvalidVersion)]
    pub authority: Account<'info, SeekerAuthority>,
    #[account(init, payer = admin, space = 8 + RealmSaleConfig::INIT_SPACE, seeds = [REALM_SALE_CONFIG_SEED], bump)]
    pub config: Account<'info, RealmSaleConfig>,
    pub developer: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_realm_sales(ctx: Context<InitializeRealmSaleConfig>) -> Result<()> {
    require!(ctx.accounts.developer.key() != Pubkey::default() && !ctx.accounts.developer.executable
        && ctx.accounts.developer.data_is_empty(), E::InvalidAuthority);
    let config = RealmSaleConfig { version: REALM_SALE_VERSION, authority: ctx.accounts.authority.key(),
        developer: ctx.accounts.developer.key(), price_lamports: REALM_SALE_PRICE_LAMPORTS,
        duration_sec: REALM_SALE_DURATION_SEC, seller_bps: REALM_SALE_SELLER_BPS, developer_bps: REALM_SALE_DEV_BPS,
        quota_max: REALM_SALE_DAILY_QUOTA, day_sec: MINING_DAY_SEC, quote_ttl_sec: REALM_SALE_QUOTE_TTL_SEC, bump: ctx.bumps.config };
    validate_config(&config)?; sale_legs(&config)?;
    ctx.accounts.config.set_inner(config);
    emit!(RealmSaleConfigured { config: ctx.accounts.config.key(), authority: ctx.accounts.authority.key(),
        developer: ctx.accounts.developer.key(), version: REALM_SALE_VERSION });
    Ok(())
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey, realm: u8)]
pub struct OpenRealmAccess<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(seeds = [REALM_SALE_CONFIG_SEED], bump = config.bump)] pub config: Account<'info, RealmSaleConfig>,
    #[account(init, payer = payer, space = 8 + RealmAccess::INIT_SPACE,
        seeds = [REALM_ACCESS_SEED, wallet.as_ref(), &[realm]], bump)]
    pub access: Account<'info, RealmAccess>,
    pub system_program: Program<'info, System>,
}

pub fn open_realm_access(ctx: Context<OpenRealmAccess>, wallet: Pubkey, realm: u8) -> Result<()> {
    validate_config(&ctx.accounts.config)?;
    require!(wallet != Pubkey::default() && usize::from(realm) < REALM_COUNT, E::InvalidRealmSaleTerms);
    ctx.accounts.access.set_inner(RealmAccess { version: REALM_SALE_VERSION, config: ctx.accounts.config.key(),
        wallet, realm, expires_at: 0, bump: ctx.bumps.access });
    emit!(RealmAccessOpened { access: ctx.accounts.access.key(), wallet, realm });
    Ok(())
}

#[derive(Accounts)]
#[instruction(spot: u8, day: u64)]
pub struct OpenSpotSalesQuota<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(seeds = [REALM_SALE_CONFIG_SEED], bump = config.bump)] pub config: Account<'info, RealmSaleConfig>,
    #[account(init, payer = payer, space = 8 + SpotSalesQuota::INIT_SPACE,
        seeds = [SPOT_SALES_SEED, &[spot], &day.to_le_bytes()], bump)]
    pub quota: Account<'info, SpotSalesQuota>,
    pub system_program: Program<'info, System>,
}

pub fn open_spot_sales_quota(ctx: Context<OpenSpotSalesQuota>, spot: u8, day: u64) -> Result<()> {
    validate_config(&ctx.accounts.config)?;
    require!(usize::from(spot) < TOTAL_SPOTS && day == utc_day(Clock::get()?.unix_timestamp)?, E::InvalidRealmSaleTerms);
    ctx.accounts.quota.set_inner(SpotSalesQuota { version: REALM_SALE_VERSION, spot, day, sales: 0, bump: ctx.bumps.quota });
    emit!(SpotSalesQuotaOpened { quota: ctx.accounts.quota.key(), spot, day });
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: BuyRealmAccessArgs)]
pub struct BuyRealmAccess<'info> {
    #[account(mut)] pub buyer: Signer<'info>,
    #[account(seeds = [AUTHORITY_SEED], bump = authority.bump,
        constraint = authority.version == VERSION @ E::InvalidVersion)]
    pub authority: Account<'info, SeekerAuthority>,
    #[account(seeds = [REALM_SALE_CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Box<Account<'info, RealmSaleConfig>>,
    #[account(seeds = [CONFIG_SEED], bump = auction_config.bump)] pub auction_config: Box<Account<'info, AuctionConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)] pub registry: Box<Account<'info, SeekerRegistry>>,
    #[account(seeds = [TERM_SEED, auction_config.key().as_ref(), &args.round.to_le_bytes()], bump = term.bump)]
    pub term: Box<Account<'info, SeekerTerm>>,
    #[account(seeds = [AUCTION_SEED, auction_config.key().as_ref(), &[args.spot], &args.round.to_le_bytes()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [SPOT_SALES_SEED, &[args.spot], &args.day.to_le_bytes()], bump = quota.bump)]
    pub quota: Account<'info, SpotSalesQuota>,
    #[account(mut, seeds = [REALM_ACCESS_SEED, buyer.key().as_ref(), &[args.realm]], bump = access.bump, has_one = config,
        constraint = access.wallet == buyer.key() && access.realm == args.realm @ E::Identity)]
    pub access: Account<'info, RealmAccess>,
    #[account(init, payer = buyer, space = 8 + RealmSaleReceipt::INIT_SPACE,
        seeds = [REALM_SALE_RECEIPT_SEED, buyer.key().as_ref(), &args.sale_id], bump)]
    pub receipt: Account<'info, RealmSaleReceipt>,
    /// CHECK: exact signed recipient is independently bound to the typed canonical
    /// settled Auction winner; receiving SOL does not require system ownership.
    #[account(mut, address = args.seller @ E::InvalidRealmSeller)] pub seller: UncheckedAccount<'info>,
    #[account(mut, address = config.developer @ E::InvalidRealmSaleTerms)] pub developer: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn buy_realm_access(ctx: Context<BuyRealmAccess>, args: BuyRealmAccessArgs) -> Result<()> {
    let clock = Clock::get()?; let now = clock.unix_timestamp;
    let a = &ctx.accounts;
    require!(!a.authority.admission_paused, E::Paused);
    require!(a.access.version == REALM_SALE_VERSION, E::InvalidVersion);
    validate_quote(&a.config, &args, now)?;
    validate_seller(a.authority.key(), a.auction_config.key(), &a.auction_config, a.registry.key(), &a.registry,
        a.term.key(), &a.term, a.auction.key(), &a.auction, &args, now, clock.slot)?;
    let next = next_quota(&a.config, &a.quota, args.spot, args.day)?;
    let (start, expires_at) = coverage(&a.config, &args, a.access.expires_at, now)?;
    let (seller_lamports, developer_lamports) = sale_legs(&a.config)?;
    require!(*a.buyer.owner == system_program::ID && a.buyer.data_is_empty() && !a.buyer.executable
        && a.developer.data_is_empty() && !a.developer.executable,
        E::RealmSaleBalance);
    // Anchor has already funded the new receipt's rent. Snapshot now so fees,
    // rent and duplicate recipient roles cannot contaminate payment evidence.
    let keys = [a.buyer.key(), a.seller.key(), a.developer.key()];
    let before = [a.buyer.lamports(), a.seller.lamports(), a.developer.lamports()];
    let after = payment_balances(keys, before, seller_lamports, developer_lamports)?;
    if keys[0] != keys[1] {
        system_program::transfer(CpiContext::new(a.system_program.to_account_info(), Transfer {
            from: a.buyer.to_account_info(), to: a.seller.to_account_info(),
        }), seller_lamports)?;
    }
    if keys[0] != keys[2] {
        system_program::transfer(CpiContext::new(a.system_program.to_account_info(), Transfer {
            from: a.buyer.to_account_info(), to: a.developer.to_account_info(),
        }), developer_lamports)?;
    }
    require!([a.buyer.lamports(), a.seller.lamports(), a.developer.lamports()] == after, E::RealmSaleBalance);
    ctx.accounts.quota.sales = next;
    ctx.accounts.access.expires_at = expires_at;
    ctx.accounts.receipt.set_inner(RealmSaleReceipt { version: REALM_SALE_VERSION, config: ctx.accounts.config.key(),
        sale_id: args.sale_id, buyer: ctx.accounts.buyer.key(), seller: args.seller, developer: args.developer,
        term: ctx.accounts.term.key(), spot: args.spot, realm: args.realm, day: args.day, round: args.round,
        registry_version: args.registry_version, registry_hash: ctx.accounts.registry.hash, price_lamports: args.price_lamports,
        seller_lamports, developer_lamports, prior_expiry: args.prior_expiry, coverage_start: start, expires_at,
        accepted_at: now, bump: ctx.bumps.receipt });
    emit!(RealmAccessPurchased { receipt: ctx.accounts.receipt.key(), buyer: ctx.accounts.buyer.key(),
        seller: args.seller, developer: args.developer, term: ctx.accounts.term.key(), spot: args.spot,
        realm: args.realm, day: args.day, coverage_start: start, expires_at, seller_lamports, developer_lamports });
    Ok(())
}

#[event] pub struct RealmSaleConfigured { pub config: Pubkey, pub authority: Pubkey, pub developer: Pubkey, pub version: u8 }
#[event] pub struct RealmAccessOpened { pub access: Pubkey, pub wallet: Pubkey, pub realm: u8 }
#[event] pub struct SpotSalesQuotaOpened { pub quota: Pubkey, pub spot: u8, pub day: u64 }
#[event] pub struct RealmAccessPurchased { pub receipt: Pubkey, pub buyer: Pubkey, pub seller: Pubkey,
    pub developer: Pubkey, pub term: Pubkey, pub spot: u8, pub realm: u8, pub day: u64,
    pub coverage_start: i64, pub expires_at: i64, pub seller_lamports: u64, pub developer_lamports: u64 }

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> RealmSaleConfig {
        RealmSaleConfig { version: REALM_SALE_VERSION, authority: Pubkey::new_unique(), developer: Pubkey::new_unique(),
            price_lamports: REALM_SALE_PRICE_LAMPORTS, duration_sec: REALM_SALE_DURATION_SEC,
            seller_bps: REALM_SALE_SELLER_BPS, developer_bps: REALM_SALE_DEV_BPS,
            quota_max: REALM_SALE_DAILY_QUOTA, day_sec: MINING_DAY_SEC, quote_ttl_sec: REALM_SALE_QUOTE_TTL_SEC, bump: 0 }
    }
    fn args(c: &RealmSaleConfig, now: i64) -> BuyRealmAccessArgs {
        BuyRealmAccessArgs { version: REALM_SALE_VERSION, sale_id: [1; 16], spot: 0, realm: 0, round: 0,
            day: (now / MINING_DAY_SEC) as u64, seller: Pubkey::new_unique(), developer: c.developer,
            registry_version: FORMAT_VERSION, price_lamports: c.price_lamports, duration_sec: c.duration_sec,
            seller_bps: c.seller_bps, developer_bps: c.developer_bps, prior_expiry: 0,
            valid_after: now, valid_until: now + c.quote_ttl_sec }
    }

    #[test]
    fn fresh_expired_and_future_coverage_extend_one_full_duration() {
        let c = config(); let now = 10 * MINING_DAY_SEC; let mut a = args(&c, now);
        assert_eq!(coverage(&c, &a, 0, now).unwrap(), (now, now + c.duration_sec));
        a.prior_expiry = now - 1;
        assert_eq!(coverage(&c, &a, a.prior_expiry, now).unwrap(), (now, now + c.duration_sec));
        a.prior_expiry = now + c.duration_sec;
        assert_eq!(coverage(&c, &a, a.prior_expiry, now).unwrap(), (a.prior_expiry, now + 2 * c.duration_sec));
    }

    #[test]
    fn duplicate_coverage_or_corrupt_expiry_never_grants_again() {
        let c = config(); let now = 10 * MINING_DAY_SEC; let mut a = args(&c, now);
        assert!(coverage(&c, &a, now + c.duration_sec, now).is_err());
        a.prior_expiry = -1; assert!(coverage(&c, &a, -1, now).is_err());
        a.prior_expiry = i64::MAX; assert!(coverage(&c, &a, i64::MAX, now).is_err());
    }

    #[test]
    fn quote_window_and_authoritative_utc_day_are_both_required() {
        let c = config(); let now = 10 * MINING_DAY_SEC; let mut a = args(&c, now);
        assert!(validate_quote(&c, &a, now).is_ok());
        assert!(validate_quote(&c, &a, now - 1).is_err());
        assert!(validate_quote(&c, &a, a.valid_until + 1).is_err());
        a.valid_until += 1; assert!(validate_quote(&c, &a, now).is_err());
        a.valid_until -= 1; a.day -= 1; assert!(validate_quote(&c, &a, now).is_err());
        a = args(&c, now + MINING_DAY_SEC - 1);
        assert!(validate_quote(&c, &a, now + MINING_DAY_SEC).is_err());
    }

    #[test]
    fn signed_price_duration_split_recipient_and_registry_terms_cannot_change() {
        let c = config(); let now = 10 * MINING_DAY_SEC;
        for field in 0..9 {
            let mut a = args(&c, now);
            match field {
                0 => a.version += 1, 1 => a.price_lamports += 1, 2 => a.duration_sec += 1,
                3 => a.seller_bps += 1, 4 => a.developer_bps += 1, 5 => a.developer = Pubkey::new_unique(),
                6 => a.registry_version += 1, 7 => a.sale_id = [0; 16], _ => a.realm = REALM_COUNT as u8,
            }
            assert!(validate_quote(&c, &a, now).is_err());
        }
    }

    #[test]
    fn the_tenth_sale_is_final_and_quota_has_no_owner_realm_or_term_reset() {
        let c = config(); let mut q = SpotSalesQuota { version: REALM_SALE_VERSION, spot: 0, day: 10,
            sales: c.quota_max - 1, bump: 0 };
        assert_eq!(next_quota(&c, &q, 0, 10).unwrap(), c.quota_max);
        q.sales = c.quota_max; assert!(next_quota(&c, &q, 0, 10).is_err());
        q.sales = 0; assert!(next_quota(&c, &q, 1, 10).is_err());
        assert!(next_quota(&c, &q, 0, 11).is_err());
        q.sales = u8::MAX; assert!(next_quota(&c, &q, 0, 10).is_err());
    }

    #[test]
    fn every_recipient_alias_pattern_preserves_aggregate_role_obligations() {
        let c = config(); let (seller_leg, developer_leg) = sale_legs(&c).unwrap();
        let a = Pubkey::new_unique(); let b = Pubkey::new_unique(); let d = Pubkey::new_unique();
        let price = c.price_lamports; let before = 2 * price;
        for keys in [[a,b,d], [a,a,d], [a,b,a], [a,b,b], [a,a,a]] {
            let after = payment_balances(keys, [before; 3], seller_leg, developer_leg).unwrap();
            for i in 0..3 {
                let mut expected = before as i128;
                for (key, delta) in [(a, -(price as i128)), (keys[1], seller_leg as i128), (keys[2], developer_leg as i128)] {
                    if keys[i] == key { expected += delta; }
                }
                assert_eq!(i128::from(after[i]), expected);
            }
        }
    }

    #[test]
    fn insufficient_funds_overflow_and_inconsistent_alias_snapshots_refuse() {
        let c = config(); let (seller, dev) = sale_legs(&c).unwrap();
        let a = Pubkey::new_unique(); let b = Pubkey::new_unique(); let d = Pubkey::new_unique();
        assert!(payment_balances([a,b,d], [c.price_lamports - 1, 0, 0], seller, dev).is_err());
        assert!(payment_balances([a,b,d], [c.price_lamports, u64::MAX, 0], seller, dev).is_err());
        assert!(payment_balances([a,a,d], [c.price_lamports, 0, 0], seller, dev).is_err());
    }
    fn seller_fixture() -> (AuctionConfig, SeekerRegistry, SeekerTerm, Auction, BuyRealmAccessArgs, Pubkey) {
        let c = config(); let now = 10 * MINING_DAY_SEC; let a = args(&c, now);
        let entries = registry_entries().unwrap();
        let registry = SeekerRegistry { version: FORMAT_VERSION, island: ISLAND, hash: registry_hash(&entries), entries, bump: 0 };
        let mint = Pubkey::new_unique(); let prize_owner = Pubkey::new_unique();
        let ac = AuctionConfig { version: VERSION, authority: c.authority, registry: Pubkey::new_unique(),
            registry_hash: registry.hash, registry_version: FORMAT_VERSION, mint, token_program: token::ID,
            decimals: 9, prize_owner, prize_ata: get_associated_token_address_with_program_id(&prize_owner, &mint, &token::ID),
            prize_bps: PRIZE_BPS, opening_bid: OPENING_BID_SKR * 10u64.pow(9), first_operating_start: now,
            term_sec: OPERATING_TERM_SEC, auction_sec: OVERLAPPING_AUCTION_SEC, grace_sec: SETTLEMENT_GRACE_SEC,
            auction_format: FORMAT_VERSION, terms_format: FORMAT_VERSION, bump: 0 };
        let mut bits = [0; BITMAP_BYTES]; for id in 0..TOTAL_SPOTS { set_bit(&mut bits, id as u8).unwrap(); }
        let times = calendar(&ac, 0).unwrap(); let term_key = Pubkey::new_unique();
        let term = SeekerTerm { version: VERSION, config: Pubkey::new_unique(), registry: ac.registry, registry_hash: registry.hash,
            round: 0, previous: None, auction_start: times[0], auction_end: times[1], operating_start: times[2], operating_end: times[3],
            opened: bits, settled: bits, completed_count: TOTAL_SPOTS as u8, winner_count: 1,
            completed_at: Some(now), completed_slot: Some(1), bump: 0 };
        let auction_key = Pubkey::new_unique();
        let mut auction = Auction { version: VERSION, config: term.config, term: term_key, registry: ac.registry,
            spot: registry.entries[0], round: 0, auction_start: times[0], auction_end: times[1], operating_start: times[2], operating_end: times[3],
            terms_hash: [0; 32], vault: get_associated_token_address_with_program_id(&auction_key, &mint, &token::ID),
            high_bid: ac.opening_bid, high_bidder: Some(a.seller), outstanding_escrow: 0, settled: true, result_owner: Some(a.seller),
            settled_at: Some(now), settled_slot: Some(1), bump: 0 };
        auction.terms_hash = terms_hash(term.config, &ac, auction_key, &auction);
        (ac, registry, term, auction, a, auction_key)
    }

    #[test]
    fn current_completed_original_winner_is_required_with_full_calendar_identity() {
        let (ac, registry, term, auction, a, key) = seller_fixture();
        let now = term.operating_start;
        assert!(validate_seller(ac.authority, term.config, &ac, ac.registry, &registry, auction.term, &term, key, &auction, &a, now, 1).is_ok());
        for mutation in 0..21 {
            let (mut ac, mut registry, mut term, mut auction, mut a, key) = seller_fixture();
            match mutation {
                0 => ac.opening_bid = OPENING_BID_SKR, 1 => ac.decimals = u8::MAX,
                2 => registry.hash[0] ^= 1, 3 => registry.entries[0].realm_mask = 0,
                4 => term.winner_count = 0, 5 => term.winner_count = (TOTAL_SPOTS + 1) as u8,
                6 => term.completed_at = None, 7 => term.completed_slot = None,
                8 => term.completed_at = Some(now + 1), 9 => term.completed_slot = Some(2),
                10 => term.settled[BITMAP_BYTES - 1] |= 128, 11 => term.opened[0] = 0,
                12 => term.round += 1, 13 => auction.result_owner = None, 14 => auction.high_bidder = None,
                15 => auction.settled = false, 16 => auction.settled_at = None, 17 => auction.settled_slot = None,
                18 => auction.terms_hash[0] ^= 1, 19 => a.seller = Pubkey::new_unique(), _ => auction.config = Pubkey::new_unique(),
            }
            assert!(validate_seller(ac.authority, term.config, &ac, ac.registry, &registry, auction.term, &term, key, &auction, &a, now, 1).is_err(), "mutation {}", mutation);
        }
    }

    #[test]
    fn sale_closes_at_term_end_while_paid_access_extends_beyond_turnover() {
        let (ac, registry, term, auction, a, key) = seller_fixture();
        let validate = |now| validate_seller(ac.authority, term.config, &ac, ac.registry, &registry, auction.term, &term, key, &auction, &a, now, 1);
        assert!(validate(term.operating_end - 1).is_ok()); assert!(validate(term.operating_end).is_err());
        assert!(validate(term.operating_start - 1).is_err());
        let c = config(); let (_, expires) = coverage(&c, &a, 0, term.operating_end - 1).unwrap();
        assert!(expires > term.operating_end);
    }

}
