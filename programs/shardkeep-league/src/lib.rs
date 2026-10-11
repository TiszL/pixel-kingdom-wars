//! Funded weekly league claims. Classic SPL only; no economy CPI or mutable
//! reward policy. Source-only candidate: review money review precedes execution.
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken, Create},
    token::{self, spl_token::state::AccountState, Mint, Token, TokenAccount, TransferChecked},
};

pub mod constants;
pub mod proof;
pub mod state;
use proof::{leaf_hash, verify_proof, ProofNode};
use state::*;
#[cfg(not(feature = "devnet-test"))]
declare_id!("2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE");
#[cfg(feature = "devnet-test")] include!("devnet_test_ids.rs");
/// This MUST remain the final initialize argument. Anchor normally ignores
/// trailing instruction bytes. EOF here rejects the removed first_week_start
/// layout before account initialization. Wire: one i64; IDL: { value: i64 }.
#[derive(AnchorSerialize, Clone, Debug)]
pub struct StrictClaimWindow { pub value: i64 }
impl AnchorDeserialize for StrictClaimWindow {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        Ok(Self { value: <i64 as AnchorDeserialize>::try_from_reader(reader)? })
    }
}

#[program]
pub mod shardkeep_league {
    use super::*;

    pub fn initialize_league(ctx: Context<InitializeLeague>, guardian: Pubkey, funder: Pubkey, claim_window_sec: StrictClaimWindow) -> Result<()> {
        validate_window(claim_window_sec.value)?;
        require!(guardian != Pubkey::default() && funder != Pubkey::default()
            && ctx.accounts.sweep_owner.key() != Pubkey::default(), LeagueError::InvalidAuthority);
        require!(ctx.accounts.mint.mint_authority.is_none(), LeagueError::MintAuthorityPresent);
        require!(ctx.accounts.mint.freeze_authority.is_none(), LeagueError::FreezeAuthorityPresent);
        let sweep_ata = get_associated_token_address_with_program_id(&ctx.accounts.sweep_owner.key(), &ctx.accounts.mint.key(), &token::ID);
        require_keys_eq!(ctx.accounts.sweep_ata.key(), sweep_ata, LeagueError::InvalidTokenAccount);
        associated_token::create_idempotent(CpiContext::new(ctx.accounts.associated_token_program.to_account_info(), Create {
            payer: ctx.accounts.admin.to_account_info(), associated_token: ctx.accounts.sweep_ata.to_account_info(),
            authority: ctx.accounts.sweep_owner.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(), token_program: ctx.accounts.token_program.to_account_info(),
        }))?;
        validate_ata(&ctx.accounts.sweep_ata.to_account_info(), ctx.accounts.sweep_owner.key(), ctx.accounts.mint.key())?;
        let config = &mut ctx.accounts.config;
        config.version = VERSION; config.admin = ctx.accounts.admin.key(); config.pending_admin = None;
        config.guardian = guardian; config.funder = funder; config.mint = ctx.accounts.mint.key();
        config.token_program = token::ID; config.decimals = ctx.accounts.mint.decimals;
        config.sweep_owner = ctx.accounts.sweep_owner.key(); config.sweep_ata = sweep_ata;
        config.claim_window_sec = claim_window_sec.value; config.paused = false; config.bump = ctx.bumps.config;
        emit!(LeagueInitialized { config: config.key(), admin: config.admin, mint: config.mint,
            funder, guardian, sweep_owner: config.sweep_owner, sweep_ata, claim_window_sec: config.claim_window_sec });
        Ok(())
    }

    pub fn open_week(ctx: Context<OpenWeek>, week_start: i64, root: [u8; 32], total_raw: u64, leaf_count: u16, allocation_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        require!(!config.paused, LeagueError::Paused);
        validate_open(now, week_start, &root, total_raw, leaf_count)?;
        let claim_deadline = initial_deadline(now, config.claim_window_sec)?;
        validate_ata(&ctx.accounts.funder_ata.to_account_info(), ctx.accounts.funder.key(), config.mint)?;
        let source_before = ctx.accounts.funder_ata.amount; let vault_before = ctx.accounts.vault.amount;
        token::transfer_checked(CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
            from: ctx.accounts.funder_ata.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.funder.to_account_info(),
        }), total_raw, config.decimals)?;
        ctx.accounts.funder_ata.reload()?; ctx.accounts.vault.reload()?;
        verify_deltas(source_before, ctx.accounts.funder_ata.amount, vault_before, ctx.accounts.vault.amount, total_raw)?;
        let week = &mut ctx.accounts.week;
        week.version = VERSION; week.config = config.key(); week.week_start = week_start; week.root = root;
        week.total_raw = total_raw; week.leaf_count = leaf_count; week.allocation_hash = allocation_hash;
        week.vault = ctx.accounts.vault.key(); week.claimed_raw = 0; week.claimed_count = 0;
        week.claimed_bitmap = [0; constants::LEAGUE_BITMAP_BYTES]; week.opened_at = now; week.claim_deadline = claim_deadline;
        week.swept = false; week.swept_raw = 0; week.bump = ctx.bumps.week; week.vault_bump = ctx.bumps.vault;
        emit!(LeagueWeekOpened { config: config.key(), week: week.key(), week_start, root, total_raw,
            leaf_count, allocation_hash, vault: week.vault, opened_at: now, claim_deadline });
        Ok(())
    }

    pub fn claim_league_reward(ctx: Context<ClaimLeagueReward>, week_start: i64, index: u16, amount: u64, proof: Vec<ProofNode>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config; let week = &ctx.accounts.week;
        require!(!config.paused, LeagueError::Paused);
        let (next_raw, next_count) = validate_claim(week, now, index, amount)?;
        validate_ata(&ctx.accounts.destination.to_account_info(), ctx.accounts.claimant.key(), config.mint)?;
        verify_proof(leaf_hash(&crate::ID, &config.key(), week_start, index, &ctx.accounts.claimant.key(), amount), amount, &proof, week.root, week.total_raw)?;
        let source_before = ctx.accounts.vault.amount; let destination_before = ctx.accounts.destination.amount;
        let config_key = config.key(); let start = week_start.to_le_bytes(); let bump = [week.bump];
        let seeds: &[&[u8]] = &[WEEK_SEED, config_key.as_ref(), &start, &bump];
        token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
            from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.destination.to_account_info(), authority: week.to_account_info(),
        }, &[seeds]), amount, config.decimals)?;
        ctx.accounts.vault.reload()?; ctx.accounts.destination.reload()?;
        verify_deltas(source_before, ctx.accounts.vault.amount, destination_before, ctx.accounts.destination.amount, amount)?;
        let week = &mut ctx.accounts.week;
        record_claim(week, index, next_raw, next_count);
        emit!(LeagueRewardClaimed { config: config.key(), week: week.key(), week_start, index,
            claimant: ctx.accounts.claimant.key(), amount, claimed_raw: next_raw, claimed_count: next_count });
        Ok(())
    }

    pub fn sweep_week(ctx: Context<SweepWeek>, week_start: i64) -> Result<()> {
        let config = &ctx.accounts.config; let week = &ctx.accounts.week;
        require!(!config.paused, LeagueError::Paused);
        validate_sweep(week, Clock::get()?.unix_timestamp)?;
        validate_ata(&ctx.accounts.destination.to_account_info(), config.sweep_owner, config.mint)?;
        let amount = ctx.accounts.vault.amount; let before = ctx.accounts.destination.amount;
        let config_key = config.key(); let start = week_start.to_le_bytes(); let bump = [week.bump];
        let seeds: &[&[u8]] = &[WEEK_SEED, config_key.as_ref(), &start, &bump];
        token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
            from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.destination.to_account_info(), authority: week.to_account_info(),
        }, &[seeds]), amount, config.decimals)?;
        ctx.accounts.vault.reload()?; ctx.accounts.destination.reload()?;
        verify_deltas(amount, ctx.accounts.vault.amount, before, ctx.accounts.destination.amount, amount)?;
        let week = &mut ctx.accounts.week; week.swept = true; week.swept_raw = amount;
        emit!(LeagueWeekSwept { config: config.key(), week: week.key(), week_start,
            destination: config.sweep_ata, amount });
        Ok(())
    }

    pub fn extend_claim_deadline(ctx: Context<ExtendClaimDeadline>, week_start: i64, new_deadline: i64) -> Result<()> {
        let week = &mut ctx.accounts.week;
        validate_extension(week, new_deadline)?;
        let previous_deadline = week.claim_deadline; week.claim_deadline = new_deadline;
        emit!(LeagueDeadlineExtended { config: ctx.accounts.config.key(), week: week.key(),
            week_start, previous_deadline, new_deadline });
        Ok(())
    }

    pub fn set_league_paused(ctx: Context<ManageLeague>, paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config; let signer = ctx.accounts.signer.key();
        require!(signer == config.admin || (paused && signer == config.guardian), LeagueError::Unauthorized);
        config.paused = paused;
        emit!(LeaguePaused { config: config.key(), signer, paused }); Ok(())
    }

    pub fn propose_admin(ctx: Context<ManageLeague>, next_admin: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(ctx.accounts.signer.key(), config.admin, LeagueError::Unauthorized);
        require!(next_admin != Pubkey::default(), LeagueError::InvalidAuthority);
        config.pending_admin = Some(next_admin);
        emit!(LeagueAdminProposed { config: config.key(), admin: config.admin, next_admin }); Ok(())
    }

    pub fn accept_admin(ctx: Context<ManageLeague>) -> Result<()> {
        let config = &mut ctx.accounts.config; let next_admin = ctx.accounts.signer.key();
        require!(config.pending_admin == Some(next_admin), LeagueError::Unauthorized);
        let previous_admin = config.admin; config.admin = next_admin; config.pending_admin = None;
        emit!(LeagueAdminAccepted { config: config.key(), previous_admin, admin: next_admin }); Ok(())
    }

    pub fn set_funder(ctx: Context<ManageLeague>, funder: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(ctx.accounts.signer.key(), config.admin, LeagueError::Unauthorized);
        require!(funder != Pubkey::default(), LeagueError::InvalidAuthority);
        let previous_funder = config.funder; config.funder = funder;
        emit!(LeagueFunderChanged { config: config.key(), previous_funder, funder }); Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeLeague<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + LeagueConfig::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, LeagueConfig>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ LeagueError::Unauthorized)]
    pub program: Program<'info, crate::program::ShardkeepLeague>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ LeagueError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub mint: Account<'info, Mint>,
    /// CHECK: Immutable nonzero recipient, then canonical ATA ownership validated.
    pub sweep_owner: UncheckedAccount<'info>,
    /// CHECK: Canonical classic ATA; create_idempotent and validate_ata in handler.
    #[account(mut)] pub sweep_ata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(week_start: i64)]
pub struct OpenWeek<'info> {
    #[account(mut)] pub funder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = config.version == VERSION @ LeagueError::InvalidVersion,
        constraint = config.funder == funder.key() @ LeagueError::Unauthorized)]
    pub config: Account<'info, LeagueConfig>,
    #[account(init, payer = funder, space = 8 + LeagueWeek::INIT_SPACE,
        seeds = [WEEK_SEED, config.key().as_ref(), &week_start.to_le_bytes()], bump)]
    pub week: Account<'info, LeagueWeek>,
    #[account(init, payer = funder, seeds = [VAULT_SEED, week.key().as_ref()], bump,
        token::mint = mint, token::authority = week, token::token_program = token_program)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)] pub funder_ata: Account<'info, TokenAccount>,
    #[account(address = config.mint)] pub mint: Account<'info, Mint>,
    #[account(address = config.token_program)] pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(week_start: i64)]
pub struct ClaimLeagueReward<'info> {
    pub claimant: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == VERSION @ LeagueError::InvalidVersion)]
    pub config: Account<'info, LeagueConfig>,
    #[account(mut, seeds = [WEEK_SEED, config.key().as_ref(), &week_start.to_le_bytes()], bump = week.bump,
        has_one = config, constraint = week.version == VERSION @ LeagueError::InvalidVersion,
        constraint = week.week_start == week_start @ LeagueError::InvalidWeekStart)]
    pub week: Account<'info, LeagueWeek>,
    #[account(mut, seeds = [VAULT_SEED, week.key().as_ref()], bump = week.vault_bump,
        constraint = vault.key() == week.vault && vault.owner == week.key() && vault.mint == config.mint
            && vault.state == AccountState::Initialized @ LeagueError::InvalidTokenAccount)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)] pub destination: Account<'info, TokenAccount>,
    #[account(address = config.mint)] pub mint: Account<'info, Mint>,
    #[account(address = config.token_program)] pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(week_start: i64)]
pub struct SweepWeek<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == VERSION @ LeagueError::InvalidVersion)]
    pub config: Account<'info, LeagueConfig>,
    #[account(mut, seeds = [WEEK_SEED, config.key().as_ref(), &week_start.to_le_bytes()], bump = week.bump,
        has_one = config, constraint = week.version == VERSION @ LeagueError::InvalidVersion,
        constraint = week.week_start == week_start @ LeagueError::InvalidWeekStart)]
    pub week: Account<'info, LeagueWeek>,
    #[account(mut, seeds = [VAULT_SEED, week.key().as_ref()], bump = week.vault_bump,
        constraint = vault.key() == week.vault && vault.owner == week.key() && vault.mint == config.mint
            && vault.state == AccountState::Initialized @ LeagueError::InvalidTokenAccount)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = config.sweep_ata)] pub destination: Account<'info, TokenAccount>,
    #[account(address = config.mint)] pub mint: Account<'info, Mint>,
    #[account(address = config.token_program)] pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(week_start: i64)]
pub struct ExtendClaimDeadline<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = config.version == VERSION @ LeagueError::InvalidVersion,
        constraint = config.admin == admin.key() @ LeagueError::Unauthorized)]
    pub config: Account<'info, LeagueConfig>,
    #[account(mut, seeds = [WEEK_SEED, config.key().as_ref(), &week_start.to_le_bytes()], bump = week.bump,
        has_one = config, constraint = week.version == VERSION @ LeagueError::InvalidVersion,
        constraint = week.week_start == week_start @ LeagueError::InvalidWeekStart)]
    pub week: Account<'info, LeagueWeek>,
}

#[derive(Accounts)]
pub struct ManageLeague<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == VERSION @ LeagueError::InvalidVersion)]
    pub config: Account<'info, LeagueConfig>,
}

fn validate_ata(info: &AccountInfo, owner: Pubkey, mint: Pubkey) -> Result<()> {
    require_keys_eq!(*info.owner, token::ID, LeagueError::InvalidTokenAccount);
    require_keys_eq!(*info.key, get_associated_token_address_with_program_id(&owner, &mint, &token::ID), LeagueError::InvalidTokenAccount);
    let bytes = info.try_borrow_data()?;
    let account = TokenAccount::try_deserialize(&mut bytes.as_ref())?;
    require!(account.state == AccountState::Initialized && account.owner == owner && account.mint == mint, LeagueError::InvalidTokenAccount);
    Ok(())
}

#[event] pub struct LeagueInitialized { pub config: Pubkey, pub admin: Pubkey, pub mint: Pubkey, pub funder: Pubkey, pub guardian: Pubkey, pub sweep_owner: Pubkey, pub sweep_ata: Pubkey, pub claim_window_sec: i64 }
#[event] pub struct LeagueWeekOpened { pub config: Pubkey, pub week: Pubkey, pub week_start: i64, pub root: [u8;32], pub total_raw: u64, pub leaf_count: u16, pub allocation_hash: [u8;32], pub vault: Pubkey, pub opened_at: i64, pub claim_deadline: i64 }
#[event] pub struct LeagueRewardClaimed { pub config: Pubkey, pub week: Pubkey, pub week_start: i64, pub index: u16, pub claimant: Pubkey, pub amount: u64, pub claimed_raw: u64, pub claimed_count: u16 }
#[event] pub struct LeagueWeekSwept { pub config: Pubkey, pub week: Pubkey, pub week_start: i64, pub destination: Pubkey, pub amount: u64 }
#[event] pub struct LeagueDeadlineExtended { pub config: Pubkey, pub week: Pubkey, pub week_start: i64, pub previous_deadline: i64, pub new_deadline: i64 }
#[event] pub struct LeaguePaused { pub config: Pubkey, pub signer: Pubkey, pub paused: bool }
#[event] pub struct LeagueAdminProposed { pub config: Pubkey, pub admin: Pubkey, pub next_admin: Pubkey }
#[event] pub struct LeagueAdminAccepted { pub config: Pubkey, pub previous_admin: Pubkey, pub admin: Pubkey }
#[event] pub struct LeagueFunderChanged { pub config: Pubkey, pub previous_funder: Pubkey, pub funder: Pubkey }

#[error_code]
pub enum LeagueError {
    #[msg("Signer is not authorized")] Unauthorized,
    #[msg("Unsupported account version")] InvalidVersion,
    #[msg("Authority must be nonzero")] InvalidAuthority,
    #[msg("Claim window is outside policy")] InvalidWindow,
    #[msg("Mint authority must be revoked")] MintAuthorityPresent,
    #[msg("Freeze authority must be revoked")] FreezeAuthorityPresent,
    #[msg("Expected initialized canonical classic token account")] InvalidTokenAccount,
    #[msg("League payouts are paused")] Paused,
    #[msg("Week start must be positive Monday UTC")] InvalidWeekStart,
    #[msg("Week has not closed and settled")] WeekNotClosed,
    #[msg("Root must be nonzero")] InvalidRoot,
    #[msg("Leaf count is outside policy")] InvalidLeafCount,
    #[msg("Amount must be positive")] InvalidAmount,
    #[msg("Checked arithmetic overflow")] ArithmeticOverflow,
    #[msg("Claim index is outside the bitmap")] InvalidIndex,
    #[msg("Entitlement already claimed")] AlreadyClaimed,
    #[msg("Proof is deeper than the protocol permits")] ProofTooDeep,
    #[msg("Proof root or authenticated sum mismatch")] InvalidProof,
    #[msg("Claim exceeds funded accounting")] ClaimTotalExceeded,
    #[msg("Claim deadline reached")] ClaimExpired,
    #[msg("Week already swept")] WeekSwept,
    #[msg("Claim window is still open")] ClaimWindowOpen,
    #[msg("New deadline must increase within policy ceiling")] InvalidDeadline,
    #[msg("Token debit or credit does not equal requested transfer")] TransferDeltaMismatch,
}

#[cfg(test)] mod tests;
