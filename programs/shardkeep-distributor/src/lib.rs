//! shardkeep-distributor — TGE-simulation merkle claim distributor.
//!
//! Design: docs/ARCHITECTURE.md §4.2. Merkle pitfalls addressed per
//! docs/research/research-security-economy.md §6:
//! - second-preimage / node-as-leaf: domain-separated hashing — leaves are
//!   keccak(0x00 || claimant || amount_le || version_le) (81-byte preimage),
//!   nodes are keccak(0x01 || min(l,r) || max(l,r)) (65-byte preimage), so a
//!   64-byte node preimage can never be re-interpreted as a leaf;
//! - double-claim: per-(distributor, claimant) ClaimStatus PDA created with
//!   `init` (re-init fails at the system level);
//! - cross-snapshot replay: `version` is part of the leaf and bumps on set_root;
//! - claim window + clawback: claim requires now < claim_end_ts, clawback
//!   requires now >= clawback_after_ts and pays an admin-designated ATA.

use anchor_lang::prelude::*;
use solana_keccak_hasher as keccak;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("6Tgc32nfuEDwvVQii47eLKZXeu39evzG5142UheuxpKU");

pub const DISTRIBUTOR_SEED: &[u8] = b"distributor";
pub const VAULT_SEED: &[u8] = b"vault";
pub const CLAIM_SEED: &[u8] = b"claim";

pub const LEAF_PREFIX: u8 = 0x00;
pub const NODE_PREFIX: u8 = 0x01;

#[program]
pub mod shardkeep_distributor {
    use super::*;

    pub fn initialize_distributor(
        ctx: Context<InitializeDistributor>,
        root: [u8; 32],
        claim_end_ts: i64,
        clawback_after_ts: i64,
    ) -> Result<()> {
        require!(claim_end_ts < clawback_after_ts, DistributorError::InvalidWindow);

        let distributor = &mut ctx.accounts.distributor;
        distributor.admin = ctx.accounts.admin.key();
        distributor.mint = ctx.accounts.mint.key();
        distributor.vault = ctx.accounts.vault.key();
        distributor.root = root;
        distributor.claim_end_ts = claim_end_ts;
        distributor.clawback_after_ts = clawback_after_ts;
        distributor.total_claimed = 0;
        distributor.version = 1;
        distributor.bump = ctx.bumps.distributor;
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let distributor = &ctx.accounts.distributor;
        require!(now < distributor.claim_end_ts, DistributorError::ClaimWindowClosed);

        let claimant = ctx.accounts.claimant.key();
        let leaf = keccak::hashv(&[
            &[LEAF_PREFIX],
            claimant.as_ref(),
            &amount.to_le_bytes(),
            &distributor.version.to_le_bytes(),
        ])
        .0;
        let mut node = leaf;
        for sibling in proof.iter() {
            let (lo, hi) = if node <= *sibling {
                (node, *sibling)
            } else {
                (*sibling, node)
            };
            node = keccak::hashv(&[&[NODE_PREFIX], &lo, &hi]).0;
        }
        require!(node == distributor.root, DistributorError::InvalidProof);

        let claim_status = &mut ctx.accounts.claim_status;
        claim_status.claimant = claimant;
        claim_status.amount = amount;
        claim_status.claimed_at = now;
        claim_status.bump = ctx.bumps.claim_status;

        let vault_authority_bump = ctx.bumps.vault_authority;
        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &[vault_authority_bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.claimant_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let distributor = &mut ctx.accounts.distributor;
        distributor.total_claimed = distributor
            .total_claimed
            .checked_add(amount)
            .ok_or(DistributorError::MathOverflow)?;

        emit!(Claimed {
            claimant,
            amount,
            version: distributor.version,
        });
        Ok(())
    }

    /// Replaces the root for a new snapshot and bumps `version`, invalidating
    /// every proof generated against the previous root.
    pub fn set_root(
        ctx: Context<SetRoot>,
        new_root: [u8; 32],
        claim_end_ts: i64,
        clawback_after_ts: i64,
    ) -> Result<()> {
        require!(claim_end_ts < clawback_after_ts, DistributorError::InvalidWindow);

        let distributor = &mut ctx.accounts.distributor;
        distributor.root = new_root;
        distributor.claim_end_ts = claim_end_ts;
        distributor.clawback_after_ts = clawback_after_ts;
        distributor.version = distributor
            .version
            .checked_add(1)
            .ok_or(DistributorError::MathOverflow)?;
        Ok(())
    }

    /// After the clawback time, sweep the remaining vault balance to an
    /// admin-designated token account of the same mint.
    pub fn clawback(ctx: Context<Clawback>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.distributor.clawback_after_ts,
            DistributorError::ClawbackTooEarly
        );

        let remaining = ctx.accounts.vault.amount;
        let vault_authority_bump = ctx.bumps.vault_authority;
        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &[vault_authority_bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            remaining,
            ctx.accounts.mint.decimals,
        )?;

        emit!(ClawedBack {
            destination: ctx.accounts.destination.key(),
            amount: remaining,
        });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Distributor {
    pub admin: Pubkey,
    pub mint: Pubkey,
    /// Vault ATA (mint, owner = ["vault"] PDA).
    pub vault: Pubkey,
    pub root: [u8; 32],
    pub claim_end_ts: i64,
    pub clawback_after_ts: i64,
    pub total_claimed: u64,
    /// Bumped on every set_root; part of the leaf preimage.
    pub version: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimStatus {
    pub claimant: Pubkey,
    pub amount: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeDistributor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// The distributor may only be initialized by this program's current
    /// upgrade authority. This closes the canonical-PDA first-signer race while
    /// remaining safe across an explicit upgrade-authority rotation.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ DistributorError::Unauthorized
    )]
    pub program: Program<'info, crate::program::ShardkeepDistributor>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ DistributorError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + Distributor::INIT_SPACE,
        seeds = [DISTRIBUTOR_SEED, mint.key().as_ref()],
        bump
    )]
    pub distributor: Account<'info, Distributor>,
    /// CHECK: PDA that owns the vault ATA; holds no data, only signs CPIs.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(
        mut,
        seeds = [DISTRIBUTOR_SEED, distributor.mint.as_ref()],
        bump = distributor.bump,
        has_one = vault @ DistributorError::InvalidVault,
        has_one = mint @ DistributorError::InvalidMint
    )]
    pub distributor: Account<'info, Distributor>,
    #[account(
        init,
        payer = claimant,
        space = 8 + ClaimStatus::INIT_SPACE,
        seeds = [CLAIM_SEED, distributor.key().as_ref(), claimant.key().as_ref()],
        bump
    )]
    pub claim_status: Account<'info, ClaimStatus>,
    /// CHECK: PDA that owns the vault ATA; holds no data, only signs CPIs.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = claimant,
        token::token_program = token_program
    )]
    pub claimant_token_account: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRoot<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [DISTRIBUTOR_SEED, distributor.mint.as_ref()],
        bump = distributor.bump,
        has_one = admin @ DistributorError::Unauthorized
    )]
    pub distributor: Account<'info, Distributor>,
}

#[derive(Accounts)]
pub struct Clawback<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [DISTRIBUTOR_SEED, distributor.mint.as_ref()],
        bump = distributor.bump,
        has_one = admin @ DistributorError::Unauthorized,
        has_one = vault @ DistributorError::InvalidVault,
        has_one = mint @ DistributorError::InvalidMint
    )]
    pub distributor: Account<'info, Distributor>,
    /// CHECK: PDA that owns the vault ATA; holds no data, only signs CPIs.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// Admin-designated treasury token account; only the mint is constrained.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct Claimed {
    pub claimant: Pubkey,
    pub amount: u64,
    pub version: u64,
}

#[event]
pub struct ClawedBack {
    pub destination: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum DistributorError {
    #[msg("claim_end_ts must be before clawback_after_ts")]
    InvalidWindow,
    #[msg("Claim window is closed")]
    ClaimWindowClosed,
    #[msg("Invalid merkle proof")]
    InvalidProof,
    #[msg("Clawback period has not started")]
    ClawbackTooEarly,
    #[msg("Vault account does not match distributor")]
    InvalidVault,
    #[msg("Mint account does not match distributor")]
    InvalidMint,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
}
