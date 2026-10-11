//! Complete Seeker escrow lifecycle. All movement uses the classic token program;
//! donated vault surplus is never counted as a bid, payout or withdrawable claim.
use anchor_lang::prelude::*;
use anchor_spl::{associated_token::{self, AssociatedToken, Create, get_associated_token_address_with_program_id},
    token::{self, Mint, Token, TokenAccount, TransferChecked, spl_token::state::AccountState}};
use solana_keccak_hasher::hash;
use crate::{auction::validate_ata, constants::*, permit::{self, PermitArgs}, state::*};

use crate::EconomyError as E;

/// Settlement evidence is consumed from a top-level transaction instruction.
/// Read the runtime stack, never caller-supplied instruction metadata: allowing
/// CPI settlement could irreversibly complete an auction without readable proof.
pub fn require_top_level_settlement() -> Result<()> {
    use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, E::TopLevelOnly);
    Ok(())
}

fn validate_config(config: &AuctionConfig) -> Result<()> {
    require!(config.version == VERSION && config.registry_version == FORMAT_VERSION
        && config.auction_format == FORMAT_VERSION && config.terms_format == FORMAT_VERSION
        && config.token_program == token::ID && u64::from(config.prize_bps) == BPS_DENOMINATOR
        && config.opening_bid > 0 && config.grace_sec > 0, E::Configuration); Ok(())
}
fn validate_term(config_key: Pubkey, config: &AuctionConfig, term: &SeekerTerm) -> Result<()> {
    validate_config(config)?;
    require!(term.version == VERSION && term.config == config_key && term.registry == config.registry
        && term.registry_hash == config.registry_hash
        && [term.auction_start, term.auction_end, term.operating_start, term.operating_end] == calendar(config, term.round)?, E::Identity);
    Ok(())
}
/// Fixed-width ABI shared with packages/chain/seekerAuctionProtocol.ts.
pub fn immutable_terms(config_key: Pubkey, config: &AuctionConfig, auction_key: Pubkey, auction: &Auction) -> Vec<u8> {
    let mut out = Vec::with_capacity(387);
    for key in [config_key, auction.term, auction_key, auction.registry] { out.extend_from_slice(key.as_ref()); }
    out.extend_from_slice(&config.registry_hash);
    out.extend_from_slice(&[auction.spot.id, auction.spot.class, auction.spot.realm_mask]);
    out.extend_from_slice(&auction.round.to_le_bytes());
    for clock in [auction.auction_start, auction.auction_end, auction.operating_start, auction.operating_end] { out.extend_from_slice(&clock.to_le_bytes()); }
    for key in [config.mint, config.token_program, auction.vault, config.prize_owner, config.prize_ata] { out.extend_from_slice(key.as_ref()); }
    out.extend_from_slice(&config.prize_bps.to_le_bytes()); out.extend_from_slice(&config.grace_sec.to_le_bytes());
    out.extend_from_slice(&config.opening_bid.to_le_bytes());
    for version in [config.registry_version, config.auction_format, config.terms_format] { out.extend_from_slice(&version.to_le_bytes()); }
    out
}
pub fn terms_hash(config_key: Pubkey, config: &AuctionConfig, auction_key: Pubkey, auction: &Auction) -> [u8; 32] {
    let mut bytes = b"SKATERM1".to_vec(); bytes.extend(immutable_terms(config_key, config, auction_key, auction)); hash(&bytes).0
}
pub fn open_hash(config_key: Pubkey, config: &AuctionConfig, auction_key: Pubkey, auction: &Auction) -> [u8; 32] {
    let mut bytes = b"SKAOPEN1".to_vec(); bytes.extend(immutable_terms(config_key, config, auction_key, auction));
    bytes.extend_from_slice(&terms_hash(config_key, config, auction_key, auction)); hash(&bytes).0
}
pub fn settle_hash(auction_key: Pubkey, auction: &Auction) -> Result<[u8; 32]> {
    require!((auction.high_bid == 0) == auction.high_bidder.is_none(), E::Winner);
    let mut bytes = b"SKASETL1".to_vec();
    for key in [auction_key, auction.config, auction.term] { bytes.extend_from_slice(key.as_ref()); }
    bytes.extend_from_slice(&auction.terms_hash); bytes.extend_from_slice(&auction.high_bid.to_le_bytes());
    match auction.high_bidder { Some(key) => { bytes.push(1); bytes.extend_from_slice(key.as_ref()); }, None => bytes.extend_from_slice(&[0; 33]) }
    Ok(hash(&bytes).0)
}
fn validate_auction(config_key: Pubkey, config: &AuctionConfig, auction_key: Pubkey, auction: &Auction) -> Result<()> {
    validate_config(config)?;
    let entries = registry_entries()?;
    require!(auction.version == VERSION && auction.config == config_key && auction.registry == config.registry
        && entries.get(usize::from(auction.spot.id)) == Some(&auction.spot)
        && [auction.auction_start, auction.auction_end, auction.operating_start, auction.operating_end] == calendar(config, auction.round)?
        && auction.vault == get_associated_token_address_with_program_id(&auction_key, &config.mint, &token::ID)
        && auction.vault != config.prize_ata
        && auction.terms_hash == terms_hash(config_key, config, auction_key, auction)
        && (auction.high_bid == 0) == auction.high_bidder.is_none(), E::Identity);
    Ok(())
}
fn validate_token(account: &Account<TokenAccount>, owner: Pubkey, mint: Pubkey) -> Result<()> {
    require!(account.state == AccountState::Initialized && account.owner == owner && account.mint == mint
        && account.key() == get_associated_token_address_with_program_id(&owner, &mint, &token::ID), E::Token); Ok(())
}
fn checked_delta(from_before: u64, to_before: u64, from_after: u64, to_after: u64, amount: u64) -> Result<()> {
    require!(from_before.checked_sub(amount) == Some(from_after) && to_before.checked_add(amount) == Some(to_after), E::Backing); Ok(())
}
fn bid_increment(high: u64, opening: u64, own: u64, new_total: u64) -> Result<u64> {
    require!(new_total >= opening && new_total > high && own <= high, E::BidTooLow);
    new_total.checked_sub(own).ok_or_else(|| error!(E::EscrowArithmetic))
}

#[derive(Accounts)]
#[instruction(spot: u8, permit: PermitArgs)]
pub struct OpenAuction<'info> {
    #[account(mut)] pub wallet: Signer<'info>,
    #[account(seeds = [AUTHORITY_SEED], bump = authority.bump, constraint = authority.version == VERSION @ E::Identity)]
    pub authority: Account<'info, SeekerAuthority>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority, has_one = registry, has_one = mint)]
    pub config: Box<Account<'info, AuctionConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)] pub registry: Box<Account<'info, SeekerRegistry>>,
    #[account(mut, seeds = [TERM_SEED, config.key().as_ref(), &term.round.to_le_bytes()], bump = term.bump, has_one = config)]
    pub term: Box<Account<'info, SeekerTerm>>,
    #[account(init, payer = wallet, space = 8 + Auction::INIT_SPACE,
        seeds = [AUCTION_SEED, config.key().as_ref(), &[spot], &term.round.to_le_bytes()], bump)]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: Canonical classic ATA created idempotently and validated before admission.
    #[account(mut)] pub vault: UncheckedAccount<'info>,
    #[account(constraint = mint.decimals == config.decimals @ E::Token)] pub mint: Account<'info, Mint>,
    #[account(init, payer = wallet, space = 8 + PermitReceipt::INIT_SPACE, seeds = [PERMIT_SEED, permit.permit_id.as_ref()], bump)]
    pub receipt: Account<'info, PermitReceipt>,
    /// CHECK: Only the genuine instructions sysvar supplies native signature evidence.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
pub fn open_auction(ctx: Context<OpenAuction>, spot: u8, args: PermitArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp; let config = &ctx.accounts.config; let term = &mut ctx.accounts.term;
    validate_term(config.key(), config, term)?;
    require!(!ctx.accounts.authority.admission_paused, E::Paused); require!(now < term.auction_start, E::Time);
    let entries = registry_entries()?;
    require!(ctx.accounts.registry.version == config.registry_version && ctx.accounts.registry.island == ISLAND
        && ctx.accounts.registry.entries == entries && ctx.accounts.registry.hash == config.registry_hash
        && registry_hash(&entries) == config.registry_hash, E::Identity);
    let entry = *entries.get(usize::from(spot)).ok_or(E::Identity)?;
    let auction_key = ctx.accounts.auction.key();
    let vault = get_associated_token_address_with_program_id(&auction_key, &config.mint, &token::ID);
    require!(ctx.accounts.vault.key() == vault && vault != config.prize_ata, E::Token);
    let auction = &mut ctx.accounts.auction;
    auction.set_inner(Auction { version: VERSION, config: config.key(), term: term.key(), registry: config.registry,
        spot: entry, round: term.round, auction_start: term.auction_start, auction_end: term.auction_end,
        operating_start: term.operating_start, operating_end: term.operating_end, terms_hash: [0; 32], vault,
        high_bid: 0, high_bidder: None, outstanding_escrow: 0, settled: false, result_owner: None,
        settled_at: None, settled_slot: None, bump: ctx.bumps.auction });
    auction.terms_hash = terms_hash(config.key(), config, auction_key, auction);
    let payload = open_hash(config.key(), config, auction_key, auction);
    permit::verify(&ctx.accounts.authority, ctx.accounts.wallet.key(), permit::OPEN_KIND, &args,
        payload, &ctx.accounts.instructions.to_account_info(), now)?;
    associated_token::create_idempotent(CpiContext::new(ctx.accounts.associated_token_program.to_account_info(), Create {
        payer: ctx.accounts.wallet.to_account_info(), associated_token: ctx.accounts.vault.to_account_info(),
        authority: auction.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(), token_program: ctx.accounts.token_program.to_account_info(),
    }))?;
    validate_ata(&ctx.accounts.vault.to_account_info(), auction_key, config.mint)?;
    set_bit(&mut term.opened, spot)?;
    permit::consume(&mut ctx.accounts.receipt, ctx.accounts.wallet.key(), permit::OPEN_KIND, &args, payload, now, ctx.bumps.receipt);
    emit!(AuctionOpened { auction: auction_key, term: term.key(), spot, round: term.round, terms_hash: auction.terms_hash }); Ok(())
}

#[derive(Accounts)]
pub struct OpenBid<'info> {
    #[account(mut)] pub wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)] pub config: Box<Account<'info, AuctionConfig>>,
    #[account(seeds = [AUCTION_SEED, config.key().as_ref(), &[auction.spot.id], &auction.round.to_le_bytes()], bump = auction.bump, has_one = config)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(init, payer = wallet, space = 8 + Bid::INIT_SPACE, seeds = [BID_SEED, auction.key().as_ref(), wallet.key().as_ref()], bump)]
    pub bid: Account<'info, Bid>,
    pub system_program: Program<'info, System>,
}
pub fn open_bid(ctx: Context<OpenBid>) -> Result<()> {
    validate_auction(ctx.accounts.config.key(), &ctx.accounts.config, ctx.accounts.auction.key(), &ctx.accounts.auction)?;
    require!(!ctx.accounts.auction.settled, E::Settled);
    ctx.accounts.bid.set_inner(Bid { version: VERSION, auction: ctx.accounts.auction.key(), wallet: ctx.accounts.wallet.key(),
        amount: 0, refunded: false, bump: ctx.bumps.bid }); Ok(())
}
#[derive(Accounts)]
pub struct PlaceBid<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [AUTHORITY_SEED], bump = authority.bump, constraint = authority.version == VERSION @ E::Identity)]
    pub authority: Account<'info, SeekerAuthority>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority, has_one = mint)] pub config: Box<Account<'info, AuctionConfig>>,
    #[account(seeds = [TERM_SEED, config.key().as_ref(), &term.round.to_le_bytes()], bump = term.bump, has_one = config)] pub term: Box<Account<'info, SeekerTerm>>,
    #[account(mut, seeds = [AUCTION_SEED, config.key().as_ref(), &[auction.spot.id], &auction.round.to_le_bytes()], bump = auction.bump,
        has_one = config, has_one = term, has_one = vault)] pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [BID_SEED, auction.key().as_ref(), wallet.key().as_ref()], bump = bid.bump, has_one = auction, has_one = wallet,
        constraint = bid.version == VERSION @ E::Identity)] pub bid: Account<'info, Bid>,
    #[account(constraint = mint.decimals == config.decimals @ E::Token)] pub mint: Account<'info, Mint>,
    #[account(mut)] pub source: Account<'info, TokenAccount>,
    #[account(mut)] pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
pub fn place_bid(ctx: Context<PlaceBid>, new_total: u64) -> Result<()> {
    let config = &ctx.accounts.config; let auction = &mut ctx.accounts.auction; let bid = &mut ctx.accounts.bid;
    validate_auction(config.key(), config, auction.key(), auction)?; validate_term(config.key(), config, &ctx.accounts.term)?;
    require!(auction.round == ctx.accounts.term.round && full_bitmap(&ctx.accounts.term.opened), E::Incomplete);
    require!(!ctx.accounts.authority.admission_paused, E::Paused); require!(!auction.settled, E::Settled);
    let now = Clock::get()?.unix_timestamp; require!(now >= auction.auction_start && now < auction.auction_end, E::Time);
    require!(!bid.refunded || bid.amount == 0, E::Backing);
    if auction.high_bidder == Some(bid.wallet) { require!(bid.amount == auction.high_bid, E::Backing); }
    let increment = bid_increment(auction.high_bid, config.opening_bid, bid.amount, new_total)?;
    let outstanding = auction.outstanding_escrow.checked_add(increment).ok_or(E::EscrowArithmetic)?;
    validate_token(&ctx.accounts.source, bid.wallet, config.mint)?; validate_token(&ctx.accounts.vault, auction.key(), config.mint)?;
    require!(ctx.accounts.source.key() != ctx.accounts.vault.key() && ctx.accounts.vault.amount >= auction.outstanding_escrow, E::Backing);
    let source_before = ctx.accounts.source.amount; let vault_before = ctx.accounts.vault.amount;
    token::transfer_checked(CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
        from: ctx.accounts.source.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.wallet.to_account_info(),
    }), increment, config.decimals)?;
    ctx.accounts.source.reload()?; ctx.accounts.vault.reload()?;
    checked_delta(source_before, vault_before, ctx.accounts.source.amount, ctx.accounts.vault.amount, increment)?;
    require!(ctx.accounts.vault.amount >= outstanding, E::Backing);
    bid.amount = new_total; bid.refunded = false; auction.high_bid = new_total; auction.high_bidder = Some(bid.wallet); auction.outstanding_escrow = outstanding;
    emit!(BidPlaced { auction: auction.key(), wallet: bid.wallet, deposited: increment, total: new_total, outstanding }); Ok(())
}

#[derive(Accounts)]
pub struct WithdrawBid<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint)] pub config: Box<Account<'info, AuctionConfig>>,
    #[account(mut, seeds = [AUCTION_SEED, config.key().as_ref(), &[auction.spot.id], &auction.round.to_le_bytes()], bump = auction.bump,
        has_one = config, has_one = vault)] pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [BID_SEED, auction.key().as_ref(), wallet.key().as_ref()], bump = bid.bump, has_one = auction, has_one = wallet,
        constraint = bid.version == VERSION @ E::Identity)] pub bid: Account<'info, Bid>,
    #[account(constraint = mint.decimals == config.decimals @ E::Token)] pub mint: Account<'info, Mint>,
    #[account(mut)] pub destination: Account<'info, TokenAccount>,
    #[account(mut)] pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
pub fn withdraw_bid(ctx: Context<WithdrawBid>) -> Result<()> {
    let config = &ctx.accounts.config; let auction = &mut ctx.accounts.auction; let bid = &mut ctx.accounts.bid;
    validate_auction(config.key(), config, auction.key(), auction)?;
    require!(bid.amount > 0 && !bid.refunded && auction.high_bidder != Some(bid.wallet), E::NotRefundable);
    validate_token(&ctx.accounts.destination, bid.wallet, config.mint)?; validate_token(&ctx.accounts.vault, auction.key(), config.mint)?;
    require!(ctx.accounts.destination.key() != ctx.accounts.vault.key() && ctx.accounts.vault.amount >= auction.outstanding_escrow, E::Backing);
    let amount = bid.amount; let outstanding = auction.outstanding_escrow.checked_sub(amount).ok_or(E::EscrowArithmetic)?;
    let from_before = ctx.accounts.vault.amount; let to_before = ctx.accounts.destination.amount;
    transfer_from_vault(config, auction, &ctx.accounts.vault, &ctx.accounts.destination, &ctx.accounts.mint, &ctx.accounts.token_program, amount)?;
    ctx.accounts.vault.reload()?; ctx.accounts.destination.reload()?;
    checked_delta(from_before, to_before, ctx.accounts.vault.amount, ctx.accounts.destination.amount, amount)?;
    require!(ctx.accounts.vault.amount >= outstanding, E::Backing);
    auction.outstanding_escrow = outstanding; bid.amount = 0; bid.refunded = true;
    emit!(BidWithdrawn { auction: auction.key(), wallet: bid.wallet, amount, outstanding }); Ok(())
}
fn transfer_from_vault<'info>(config: &AuctionConfig, auction: &Account<'info, Auction>, vault: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>, mint: &Account<'info, Mint>, token_program: &Program<'info, Token>, amount: u64) -> Result<()> {
    let spot = [auction.spot.id]; let round = auction.round.to_le_bytes(); let bump = [auction.bump];
    let seeds: &[&[u8]] = &[AUCTION_SEED, auction.config.as_ref(), &spot, &round, &bump];
    token::transfer_checked(CpiContext::new_with_signer(token_program.to_account_info(), TransferChecked {
        from: vault.to_account_info(), mint: mint.to_account_info(), to: destination.to_account_info(), authority: auction.to_account_info(),
    }, &[seeds]), amount, config.decimals)
}

#[derive(Accounts)]
pub struct SettleAuction<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint)] pub config: Box<Account<'info, AuctionConfig>>,
    #[account(mut, seeds = [TERM_SEED, config.key().as_ref(), &term.round.to_le_bytes()], bump = term.bump, has_one = config)] pub term: Box<Account<'info, SeekerTerm>>,
    #[account(mut, seeds = [AUCTION_SEED, config.key().as_ref(), &[auction.spot.id], &auction.round.to_le_bytes()], bump = auction.bump,
        has_one = config, has_one = term, has_one = vault)] pub auction: Box<Account<'info, Auction>>,
    #[account(constraint = mint.decimals == config.decimals @ E::Token)] pub mint: Account<'info, Mint>,
    #[account(mut)] pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = config.prize_ata)] pub prize_ata: Account<'info, TokenAccount>,
    #[account(mut)] pub winner_bid: Option<Account<'info, Bid>>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
#[instruction(permit: PermitArgs)]
pub struct SettleAuctionWithPermit<'info> {
    #[account(mut)] pub wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority, has_one = mint)] pub config: Box<Account<'info, AuctionConfig>>,
    #[account(mut, seeds = [TERM_SEED, config.key().as_ref(), &term.round.to_le_bytes()], bump = term.bump, has_one = config)] pub term: Box<Account<'info, SeekerTerm>>,
    #[account(mut, seeds = [AUCTION_SEED, config.key().as_ref(), &[auction.spot.id], &auction.round.to_le_bytes()], bump = auction.bump,
        has_one = config, has_one = term, has_one = vault)] pub auction: Box<Account<'info, Auction>>,
    #[account(constraint = mint.decimals == config.decimals @ E::Token)] pub mint: Account<'info, Mint>,
    #[account(mut)] pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = config.prize_ata)] pub prize_ata: Account<'info, TokenAccount>,
    #[account(mut)] pub winner_bid: Option<Account<'info, Bid>>,
    pub token_program: Program<'info, Token>,
    #[account(seeds = [AUTHORITY_SEED], bump = authority.bump, constraint = authority.version == VERSION @ E::Identity)] pub authority: Account<'info, SeekerAuthority>,
    #[account(init, payer = wallet, space = 8 + PermitReceipt::INIT_SPACE, seeds = [PERMIT_SEED, permit.permit_id.as_ref()], bump)] pub receipt: Account<'info, PermitReceipt>,
    /// CHECK: Fixed sysvar address; native evidence is validated before any transfer.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
pub fn settle_auction(ctx: Context<SettleAuction>) -> Result<()> {
    let clock = Clock::get()?;
    let deadline = ctx.accounts.auction.auction_end.checked_add(ctx.accounts.config.grace_sec).ok_or(E::EscrowArithmetic)?;
    require!(clock.unix_timestamp >= deadline, E::Time);
    settle_checked(ctx.accounts.wallet.key(), &ctx.accounts.config, &mut ctx.accounts.term, &mut ctx.accounts.auction,
        &ctx.accounts.mint, &mut ctx.accounts.vault, &mut ctx.accounts.prize_ata, ctx.accounts.winner_bid.as_mut(),
        &ctx.accounts.token_program, clock)
}
pub fn settle_auction_with_permit(ctx: Context<SettleAuctionWithPermit>, args: PermitArgs) -> Result<()> {
    let clock = Clock::get()?;
    let payload = settle_hash(ctx.accounts.auction.key(), &ctx.accounts.auction)?;
    permit::verify(&ctx.accounts.authority, ctx.accounts.wallet.key(), permit::SETTLE_KIND, &args,
        payload, &ctx.accounts.instructions.to_account_info(), clock.unix_timestamp)?;
    settle_checked(ctx.accounts.wallet.key(), &ctx.accounts.config, &mut ctx.accounts.term, &mut ctx.accounts.auction,
        &ctx.accounts.mint, &mut ctx.accounts.vault, &mut ctx.accounts.prize_ata, ctx.accounts.winner_bid.as_mut(),
        &ctx.accounts.token_program, clock.clone())?;
    permit::consume(&mut ctx.accounts.receipt, ctx.accounts.wallet.key(), permit::SETTLE_KIND, &args, payload,
        clock.unix_timestamp, ctx.bumps.receipt); Ok(())
}
fn validate_completion(term: &SeekerTerm) -> Result<()> {
    let mut count = 0u8;
    for i in 0..BITMAP_BYTES * 8 {
        if term.settled[i / 8] & (1 << (i % 8)) != 0 {
            require!(i < TOTAL_SPOTS && term.opened[i / 8] & (1 << (i % 8)) != 0, E::Identity);
            count = count.checked_add(1).ok_or(E::EscrowArithmetic)?;
        }
    }
    require!(count == term.completed_count && term.winner_count <= count
        && usize::from(count) < TOTAL_SPOTS && term.completed_at.is_none() && term.completed_slot.is_none(), E::Identity); Ok(())
}
#[allow(clippy::too_many_arguments)]
fn settle_checked<'info>(settler: Pubkey, config: &Account<'info, AuctionConfig>, term: &mut Account<'info, SeekerTerm>,
    auction: &mut Account<'info, Auction>, mint: &Account<'info, Mint>, vault: &mut Account<'info, TokenAccount>,
    prize_ata: &mut Account<'info, TokenAccount>, mut winner_bid: Option<&mut Account<'info, Bid>>,
    token_program: &Program<'info, Token>, clock: Clock) -> Result<()> {
    validate_auction(config.key(), config, auction.key(), auction)?; validate_term(config.key(), config, term)?;
    require!(auction.round == term.round, E::Identity); require!(!auction.settled, E::Settled);
    require!(clock.unix_timestamp >= auction.auction_end, E::Time); validate_completion(term)?;
    let i = usize::from(auction.spot.id); let bit = 1u8 << (i % 8);
    require!(term.opened[i / 8] & bit != 0 && term.settled[i / 8] & bit == 0, E::Identity);
    validate_token(vault, auction.key(), config.mint)?; validate_token(prize_ata, config.prize_owner, config.mint)?;
    require!(vault.key() != prize_ata.key() && vault.amount >= auction.outstanding_escrow, E::Backing);
    let amount = auction.high_bid;
    if let Some(winner) = auction.high_bidder {
        let bid = winner_bid.as_ref().ok_or(E::Winner)?;
        let (key, bump) = Pubkey::find_program_address(&[BID_SEED, auction.key().as_ref(), winner.as_ref()], &crate::ID);
        require!(bid.key() == key && bid.bump == bump && bid.version == VERSION && bid.auction == auction.key()
            && bid.wallet == winner && !bid.refunded && bid.amount == amount && amount >= config.opening_bid, E::Winner);
    } else { require!(winner_bid.is_none() && amount == 0, E::Winner); }
    let outstanding = auction.outstanding_escrow.checked_sub(amount).ok_or(E::EscrowArithmetic)?;
    let from_before = vault.amount; let to_before = prize_ata.amount;
    if amount > 0 {
        // D153.22's immutable prize_bps equals the full denominator. There is no
        // operator leg, caller-selected recipient, donation sweep or rounding.
        transfer_from_vault(config, auction, vault, prize_ata, mint, token_program, amount)?;
        vault.reload()?; prize_ata.reload()?;
        checked_delta(from_before, to_before, vault.amount, prize_ata.amount, amount)?;
    }
    require!(vault.amount >= outstanding, E::Backing);
    if let Some(bid) = winner_bid.as_mut() { bid.amount = 0; }
    auction.outstanding_escrow = outstanding; auction.settled = true; auction.result_owner = auction.high_bidder;
    auction.settled_at = Some(clock.unix_timestamp); auction.settled_slot = Some(clock.slot);
    set_bit(&mut term.settled, auction.spot.id)?;
    term.completed_count = term.completed_count.checked_add(1).ok_or(E::EscrowArithmetic)?;
    if auction.result_owner.is_some() { term.winner_count = term.winner_count.checked_add(1).ok_or(E::EscrowArithmetic)?; }
    if usize::from(term.completed_count) == TOTAL_SPOTS {
        require!(full_bitmap(&term.opened) && full_bitmap(&term.settled), E::Incomplete);
        term.completed_at = Some(clock.unix_timestamp); term.completed_slot = Some(clock.slot);
        emit!(TermCompleted { term: term.key(), round: term.round, winners: term.winner_count, at: clock.unix_timestamp, slot: clock.slot });
    }
    emit!(AuctionSettled { auction: auction.key(), term: term.key(), settler, winner: auction.result_owner,
        amount, outstanding, at: clock.unix_timestamp, slot: clock.slot }); Ok(())
}

#[event] pub struct AuctionOpened { pub auction: Pubkey, pub term: Pubkey, pub spot: u8, pub round: u64, pub terms_hash: [u8; 32] }
#[event] pub struct BidPlaced { pub auction: Pubkey, pub wallet: Pubkey, pub deposited: u64, pub total: u64, pub outstanding: u64 }
#[event] pub struct BidWithdrawn { pub auction: Pubkey, pub wallet: Pubkey, pub amount: u64, pub outstanding: u64 }
#[event] pub struct AuctionSettled { pub auction: Pubkey, pub term: Pubkey, pub settler: Pubkey, pub winner: Option<Pubkey>,
    pub amount: u64, pub outstanding: u64, pub at: i64, pub slot: u64 }
#[event] pub struct TermCompleted { pub term: Pubkey, pub round: u64, pub winners: u8, pub at: i64, pub slot: u64 }

#[cfg(test)]
mod tests {
    use super::*;
    fn pk(n: u8) -> Pubkey { Pubkey::new_from_array([n; 32]) }
    fn vector() -> (AuctionConfig, Auction) {
        // Byte-vector fixture only; these synthetic clocks/keys are not admitted policy.
        let config = AuctionConfig { version: VERSION, authority: pk(0), registry: pk(4), registry_hash: [5; 32], registry_version: 1,
            mint: pk(6), token_program: pk(7), decimals: 6, prize_owner: pk(9), prize_ata: pk(10), prize_bps: PRIZE_BPS,
            opening_bid: 10_000_000, first_operating_start: 200, term_sec: 100, auction_sec: 100, grace_sec: SETTLEMENT_GRACE_SEC,
            auction_format: 1, terms_format: 1, bump: 0 };
        let auction = Auction { version: VERSION, config: pk(1), term: pk(2), registry: pk(4), spot: Spot { id: 20, class: 0, realm_mask: 15 },
            round: 3, auction_start: 100, auction_end: 200, operating_start: 200, operating_end: 300, terms_hash: [5; 32], vault: pk(8),
            high_bid: 10_000_000, high_bidder: Some(pk(11)), outstanding_escrow: 10_000_000, settled: false, result_owner: None,
            settled_at: None, settled_slot: None, bump: 0 };
        (config, auction)
    }
    fn hex(bytes: [u8; 32]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
    #[test]
    fn fixed_immutable_and_open_bytes_match_executed_typescript_vectors() {
        let (config, auction) = vector(); assert_eq!(immutable_terms(pk(1), &config, pk(3), &auction).len(), 387);
        assert_eq!(hex(terms_hash(pk(1), &config, pk(3), &auction)), "2e02c4a891bc4e06caeb2532416389ba685151dc728bf0eb03a49f34790d4e45");
        assert_eq!(hex(open_hash(pk(1), &config, pk(3), &auction)), "45a717f5f19c484565c91471ed06cd40c0dcefde61e3facf62a6e69820a45954");
    }
    #[test]
    fn settle_bytes_bind_high_bid_and_fixed_width_optional_winner() {
        let (_, mut auction) = vector();
        assert_eq!(hex(settle_hash(pk(3), &auction).unwrap()), "d0988320db6aab703fbe0725c22fc4f4a09408352a20f6dffaad944165b28f49");
        auction.high_bid = 0; auction.high_bidder = None;
        assert_eq!(hex(settle_hash(pk(3), &auction).unwrap()), "a4ef2af4d82921ff50f1726731f1ab528970c4732691e372296c43a9ac9809f7");
        auction.high_bidder = Some(pk(11)); assert!(settle_hash(pk(3), &auction).is_err());
    }
    #[test]
    fn open_permit_digest_changes_with_every_economic_destination_or_clock() {
        let (mut config, mut auction) = vector(); let original = open_hash(pk(1), &config, pk(3), &auction);
        config.prize_owner = pk(12); assert_ne!(open_hash(pk(1), &config, pk(3), &auction), original);
        config.prize_owner = pk(9); auction.operating_end += 1; assert_ne!(open_hash(pk(1), &config, pk(3), &auction), original);
        auction.operating_end -= 1; auction.vault = pk(12); assert_ne!(open_hash(pk(1), &config, pk(3), &auction), original);
    }
    #[test]
    fn leader_topup_and_loser_rebid_move_only_new_escrow() {
        assert_eq!(bid_increment(100, 10, 100, 150).unwrap(), 50);
        assert_eq!(bid_increment(100, 10, 70, 150).unwrap(), 80);
        assert_eq!(bid_increment(100, 10, 0, 150).unwrap(), 150); // refunded claim is zero
    }
    #[test]
    fn equal_below_minimum_and_impossible_old_balance_refuse() {
        assert!(bid_increment(100, 10, 100, 100).is_err());
        assert!(bid_increment(0, 10, 0, 9).is_err());
        assert!(bid_increment(100, 10, 101, 150).is_err());
        assert!(bid_increment(u64::MAX, 10, 0, u64::MAX).is_err());
    }
    #[test]
    fn exact_cpi_delta_rejects_clipping_double_debit_or_overflow() {
        assert!(checked_delta(100, 5, 90, 15, 10).is_ok());
        assert!(checked_delta(100, 5, 89, 15, 10).is_err());
        assert!(checked_delta(100, 5, 90, 14, 10).is_err());
        assert!(checked_delta(100, u64::MAX, 90, 0, 10).is_err());
        assert!(checked_delta(9, 0, 0, 10, 10).is_err());
    }
    #[test]
    fn term_completion_cannot_come_from_counter_without_distinct_opened_results() {
        let mut term = SeekerTerm { version: VERSION, config: pk(1), registry: pk(4), registry_hash: [5; 32], round: 0, previous: None,
            auction_start: 0, auction_end: 1, operating_start: 1, operating_end: 2,
            opened: [0; BITMAP_BYTES], settled: [0; BITMAP_BYTES], completed_count: 0, winner_count: 0,
            completed_at: None, completed_slot: None, bump: 0 };
        assert!(validate_completion(&term).is_ok()); term.completed_count = 1; assert!(validate_completion(&term).is_err());
        set_bit(&mut term.settled, 0).unwrap(); assert!(validate_completion(&term).is_err());
        set_bit(&mut term.opened, 0).unwrap(); assert!(validate_completion(&term).is_ok());
        term.winner_count = 2; assert!(validate_completion(&term).is_err());
        term.winner_count = 1; term.completed_at = Some(1); assert!(validate_completion(&term).is_err());
    }
}
