//! Immutable registry/configuration and deterministic manifests. Bid admission,
//! escrow/refunds/settlement remain a separate reviewed implementation block.
use anchor_lang::prelude::*;
use anchor_spl::{associated_token::{self, AssociatedToken, Create, get_associated_token_address_with_program_id},
    token::{Mint, Token, TokenAccount, spl_token::state::AccountState}};
use crate::{constants::*, state::*, EconomyError as E};

#[derive(Accounts)]
pub struct InitializeAuctionConfig<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(seeds = [AUTHORITY_SEED], bump = authority.bump, has_one = admin,
        constraint = authority.version == VERSION @ E::InvalidVersion)]
    pub authority: Account<'info, SeekerAuthority>,
    #[account(init, payer = admin, space = 8 + AuctionConfig::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, AuctionConfig>,
    #[account(init, payer = admin, space = 8 + SeekerRegistry::INIT_SPACE, seeds = [REGISTRY_SEED], bump)]
    pub registry: Account<'info, SeekerRegistry>,
    pub mint: Account<'info, Mint>,
    /// CHECK: Immutable admin-selected custodian; canonical ATA owner validated below.
    pub prize_owner: UncheckedAccount<'info>,
    /// CHECK: Canonical classic ATA, created idempotently and fully decoded below.
    #[account(mut)] pub prize_ata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
pub fn initialize(ctx: Context<InitializeAuctionConfig>, first_operating_start: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(OPERATING_TERM_SEC > 0 && OVERLAPPING_AUCTION_SEC > 0
        && OVERLAPPING_AUCTION_SEC <= OPERATING_TERM_SEC && SETTLEMENT_GRACE_SEC > 0
        && u64::from(PRIZE_BPS) == BPS_DENOMINATOR, E::InvalidPolicy);
    let auction_start = first_operating_start.checked_sub(OVERLAPPING_AUCTION_SEC).ok_or(E::Arithmetic)?;
    first_operating_start.checked_add(OPERATING_TERM_SEC).ok_or(E::Arithmetic)?;
    require!(now < auction_start, E::InvalidCalendar);
    require!(ctx.accounts.prize_owner.key() != Pubkey::default(), E::InvalidAuthority);
    let scale = 10u64.checked_pow(u32::from(ctx.accounts.mint.decimals)).ok_or(E::Arithmetic)?;
    let opening_bid = OPENING_BID_SKR.checked_mul(scale).ok_or(E::Arithmetic)?;
    require!(opening_bid > 0, E::InvalidPolicy);
    let expected_ata = get_associated_token_address_with_program_id(&ctx.accounts.prize_owner.key(),
        &ctx.accounts.mint.key(), &ctx.accounts.token_program.key());
    require_keys_eq!(ctx.accounts.prize_ata.key(), expected_ata, E::InvalidTokenAccount);
    associated_token::create_idempotent(CpiContext::new(ctx.accounts.associated_token_program.to_account_info(), Create {
        payer: ctx.accounts.admin.to_account_info(), associated_token: ctx.accounts.prize_ata.to_account_info(),
        authority: ctx.accounts.prize_owner.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(), token_program: ctx.accounts.token_program.to_account_info(),
    }))?;
    validate_ata(&ctx.accounts.prize_ata.to_account_info(), ctx.accounts.prize_owner.key(), ctx.accounts.mint.key())?;
    let entries = registry_entries()?; let hash = registry_hash(&entries);
    let registry = &mut ctx.accounts.registry;
    registry.version = FORMAT_VERSION; registry.island = ISLAND; registry.entries = entries;
    registry.hash = hash; registry.bump = ctx.bumps.registry;
    let config = &mut ctx.accounts.config;
    config.version = VERSION; config.authority = ctx.accounts.authority.key(); config.registry = registry.key();
    config.registry_hash = hash; config.registry_version = FORMAT_VERSION;
    config.mint = ctx.accounts.mint.key(); config.token_program = ctx.accounts.token_program.key();
    config.decimals = ctx.accounts.mint.decimals; config.prize_owner = ctx.accounts.prize_owner.key();
    config.prize_ata = expected_ata; config.prize_bps = PRIZE_BPS; config.opening_bid = opening_bid;
    config.first_operating_start = first_operating_start; config.term_sec = OPERATING_TERM_SEC;
    config.auction_sec = OVERLAPPING_AUCTION_SEC; config.grace_sec = SETTLEMENT_GRACE_SEC;
    config.auction_format = FORMAT_VERSION; config.terms_format = FORMAT_VERSION; config.bump = ctx.bumps.config;
    emit!(AuctionConfigInitialized { config: config.key(), registry: registry.key(), registry_hash: hash,
        mint: config.mint, prize_owner: config.prize_owner, prize_ata: expected_ata, first_operating_start }); Ok(())
}
/// Safe for already-created/prefunded classic ATAs: their balance is not a bid.
pub fn validate_ata(info: &AccountInfo, owner: Pubkey, mint: Pubkey) -> Result<()> {
    require_keys_eq!(*info.owner, anchor_spl::token::ID, E::InvalidTokenAccount);
    require_keys_eq!(*info.key, get_associated_token_address_with_program_id(&owner, &mint, &anchor_spl::token::ID), E::InvalidTokenAccount);
    let bytes = info.try_borrow_data()?;
    let account = TokenAccount::try_deserialize(&mut bytes.as_ref())?;
    require!(account.state == AccountState::Initialized && account.owner == owner && account.mint == mint, E::InvalidTokenAccount);
    Ok(())
}
#[derive(Accounts)]
#[instruction(round: u64)]
pub struct OpenTerm<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = registry,
        constraint = config.version == VERSION @ E::InvalidVersion)]
    pub config: Account<'info, AuctionConfig>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump,
        constraint = registry.version == config.registry_version @ E::InvalidVersion,
        constraint = registry.hash == config.registry_hash @ E::InvalidRegistry)]
    pub registry: Account<'info, SeekerRegistry>,
    #[account(init, payer = payer, space = 8 + SeekerTerm::INIT_SPACE,
        seeds = [TERM_SEED, config.key().as_ref(), &round.to_le_bytes()], bump)]
    pub term: Account<'info, SeekerTerm>,
    pub previous_term: Option<Account<'info, SeekerTerm>>,
    pub system_program: Program<'info, System>,
}
pub fn open_term(ctx: Context<OpenTerm>, round: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(ctx.accounts.registry.island == ISLAND && ctx.accounts.registry.entries == registry_entries()?
        && registry_hash(&ctx.accounts.registry.entries) == config.registry_hash, E::InvalidRegistry);
    let previous = if round == 0 {
        require!(ctx.accounts.previous_term.is_none(), E::InvalidPredecessor); None
    } else {
        let predecessor_round = round.checked_sub(1).ok_or(E::Arithmetic)?;
        let prior = ctx.accounts.previous_term.as_ref().ok_or(E::InvalidPredecessor)?;
        let (key, bump) = Pubkey::find_program_address(&[TERM_SEED, config.key().as_ref(), &predecessor_round.to_le_bytes()], &crate::ID);
        require!(prior.key() == key && prior.bump == bump && prior.version == VERSION && prior.round == predecessor_round
            && prior.config == config.key() && prior.registry == config.registry && prior.registry_hash == config.registry_hash,
            E::InvalidPredecessor);
        let clocks = calendar(config, predecessor_round)?;
        require!([prior.auction_start, prior.auction_end, prior.operating_start, prior.operating_end] == clocks, E::InvalidPredecessor);
        Some(key)
    };
    let clocks = calendar(config, round)?;
    let term = &mut ctx.accounts.term;
    term.version = VERSION; term.config = config.key(); term.registry = config.registry; term.registry_hash = config.registry_hash;
    term.round = round; term.previous = previous; term.auction_start = clocks[0]; term.auction_end = clocks[1];
    term.operating_start = clocks[2]; term.operating_end = clocks[3]; term.opened = [0; BITMAP_BYTES]; term.settled = [0; BITMAP_BYTES];
    term.completed_count = 0; term.winner_count = 0; term.completed_at = None; term.completed_slot = None; term.bump = ctx.bumps.term;
    emit!(TermOpened { term: term.key(), config: config.key(), round, auction_start: clocks[0], auction_end: clocks[1],
        operating_start: clocks[2], operating_end: clocks[3] }); Ok(())
}
#[event] pub struct AuctionConfigInitialized { pub config: Pubkey, pub registry: Pubkey, pub registry_hash: [u8; 32],
    pub mint: Pubkey, pub prize_owner: Pubkey, pub prize_ata: Pubkey, pub first_operating_start: i64 }
#[event] pub struct TermOpened { pub term: Pubkey, pub config: Pubkey, pub round: u64, pub auction_start: i64,
    pub auction_end: i64, pub operating_start: i64, pub operating_end: i64 }
