//! shardkeep-core — entry payments, player registry, weekly epoch merkle roots.
//!
//! Design: docs/ARCHITECTURE.md §4.1. Security checklist:
//! docs/research/research-security-economy.md §7 (overflow-checks, checked math,
//! typed accounts, init-not-init_if_needed, address-constrained treasuries).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b");

pub const CONFIG_SEED: &[u8] = b"config";
pub const PLAYER_SEED: &[u8] = b"player";
pub const ROOT_SEED: &[u8] = b"root";

pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_BUILDERS: u8 = 2;
pub const MAX_EXPANSIONS: u8 = 2;

pub const PAYMENT_KIND_ENTRY: u8 = 0;
pub const PAYMENT_KIND_BUILDER: u8 = 1;
pub const PAYMENT_KIND_EXPANSION: u8 = 2;
pub const PAYMENT_KIND_ENERGY: u8 = 3;
pub const PAYMENT_KIND_SHIELD: u8 = 4;
pub const PAYMENT_KIND_MINE: u8 = 5;
/// First kind reserved for repeatable SOL sinks (0–2 are entry/builder/expansion,
/// which have their own instructions). buy_sink accepts any kind ≥ this.
pub const PAYMENT_KIND_SINK_MIN: u8 = 3;

#[program]
pub mod shardkeep_core {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        let sum: u64 = args.splits.iter().map(|s| u64::from(*s)).sum();
        require!(sum == BPS_DENOMINATOR, CoreError::InvalidSplits);

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.pending_admin = None;
        config.keep_mint = args.keep_mint;
        config.treasury_liquidity = args.treasury_liquidity;
        config.treasury_dev = args.treasury_dev;
        config.treasury_ops = args.treasury_ops;
        config.splits = args.splits;
        config.prices = args.prices;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Player signs; entry price is split across the three treasuries by bps
    /// (remainder dust deterministically to the liquidity leg); Player PDA is
    /// `init` (NOT init_if_needed) so one wallet = one base, enforced on-chain.
    /// `reference` is a client-supplied no-op account for off-chain detection.
    pub fn pay_entry(ctx: Context<PayEntry>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, CoreError::Paused);

        let amount = config.prices.entry_lamports;
        route_payment(
            &ctx.accounts.player_wallet,
            &ctx.accounts.treasury_liquidity,
            &ctx.accounts.treasury_dev,
            &ctx.accounts.treasury_ops,
            &ctx.accounts.system_program,
            amount,
            config.splits,
        )?;

        let player = &mut ctx.accounts.player;
        player.wallet = ctx.accounts.player_wallet.key();
        player.opened_at = Clock::get()?.unix_timestamp;
        player.builders_purchased = 0;
        player.expansions_purchased = 0;
        player.bump = ctx.bumps.player;

        emit!(PaymentMade {
            wallet: ctx.accounts.player_wallet.key(),
            kind: PAYMENT_KIND_ENTRY,
            lamports: amount,
            reference: ctx.accounts.reference.key(),
        });
        Ok(())
    }

    /// Sequential on-chain enforcement: `index` must equal builders_purchased.
    pub fn buy_builder(ctx: Context<Purchase>, index: u8) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, CoreError::Paused);
        require!(
            index == ctx.accounts.player.builders_purchased,
            CoreError::OutOfOrderPurchase
        );
        require!(index < MAX_BUILDERS, CoreError::PurchaseLimitReached);

        let amount = config.prices.builder_lamports[usize::from(index)];
        route_payment(
            &ctx.accounts.player_wallet,
            &ctx.accounts.treasury_liquidity,
            &ctx.accounts.treasury_dev,
            &ctx.accounts.treasury_ops,
            &ctx.accounts.system_program,
            amount,
            config.splits,
        )?;

        let player = &mut ctx.accounts.player;
        player.builders_purchased = player
            .builders_purchased
            .checked_add(1)
            .ok_or(CoreError::MathOverflow)?;

        emit!(PaymentMade {
            wallet: ctx.accounts.player_wallet.key(),
            kind: PAYMENT_KIND_BUILDER,
            lamports: amount,
            reference: ctx.accounts.reference.key(),
        });
        Ok(())
    }

    /// Sequential on-chain enforcement: `index` must equal expansions_purchased.
    pub fn buy_expansion(ctx: Context<Purchase>, index: u8) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, CoreError::Paused);
        require!(
            index == ctx.accounts.player.expansions_purchased,
            CoreError::OutOfOrderPurchase
        );
        require!(index < MAX_EXPANSIONS, CoreError::PurchaseLimitReached);

        let amount = config.prices.expansion_lamports;
        route_payment(
            &ctx.accounts.player_wallet,
            &ctx.accounts.treasury_liquidity,
            &ctx.accounts.treasury_dev,
            &ctx.accounts.treasury_ops,
            &ctx.accounts.system_program,
            amount,
            config.splits,
        )?;

        let player = &mut ctx.accounts.player;
        player.expansions_purchased = player
            .expansions_purchased
            .checked_add(1)
            .ok_or(CoreError::MathOverflow)?;

        emit!(PaymentMade {
            wallet: ctx.accounts.player_wallet.key(),
            kind: PAYMENT_KIND_EXPANSION,
            lamports: amount,
            reference: ctx.accounts.reference.key(),
        });
        Ok(())
    }

    /// Repeatable SOL sink — raid energy (3), shield extension (4), Mines (5),
    /// and any future sink (kind ≥ 3).
    ///
    /// Deliberately different from buy_builder/buy_expansion: there is NO
    /// on-chain counter and NO Player PDA, because these sinks are unbounded
    /// on-chain. The KIND is just a tag echoed in the event; the SERVER maps
    /// kind → effect and enforces price + eligibility at `finalized` before it
    /// grants, so a client that underpays (or sends a bogus kind) only wastes
    /// its own SOL and gets nothing — and new sinks need no program change. Kinds
    /// 0–2 are reserved for entry/builder/expansion (their own instructions), so
    /// buy_sink rejects kind < 3. `amount` is split across the three treasuries
    /// by config.splits exactly like every other payment; `reference` is the
    /// off-chain-detection no-op the deposit watcher looks up signatures for.
    pub fn buy_sink(ctx: Context<BuySink>, kind: u8, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, CoreError::Paused);
        require!(kind >= PAYMENT_KIND_SINK_MIN, CoreError::InvalidPaymentKind);
        require!(amount > 0, CoreError::InvalidAmount);

        route_payment(
            &ctx.accounts.player_wallet,
            &ctx.accounts.treasury_liquidity,
            &ctx.accounts.treasury_dev,
            &ctx.accounts.treasury_ops,
            &ctx.accounts.system_program,
            amount,
            config.splits,
        )?;

        emit!(PaymentMade {
            wallet: ctx.accounts.player_wallet.key(),
            kind,
            lamports: amount,
            reference: ctx.accounts.reference.key(),
        });
        Ok(())
    }

    /// Admin-only weekly proof-of-liabilities snapshot. `init`-once per epoch:
    /// an EpochRoot is immutable after posting.
    pub fn post_root(
        ctx: Context<PostRoot>,
        epoch: u64,
        root: [u8; 32],
        total_balance: u64,
    ) -> Result<()> {
        let epoch_root = &mut ctx.accounts.epoch_root;
        epoch_root.epoch = epoch;
        epoch_root.root = root;
        epoch_root.total_balance = total_balance;
        epoch_root.posted_at = Clock::get()?.unix_timestamp;
        epoch_root.bump = ctx.bumps.epoch_root;

        emit!(RootPosted {
            epoch,
            root,
            total_balance,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = Some(new_admin);
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.pending_admin == Some(ctx.accounts.new_admin.key()),
            CoreError::Unauthorized
        );
        config.admin = ctx.accounts.new_admin.key();
        config.pending_admin = None;
        Ok(())
    }
}

/// Split `amount` by bps [liquidity, dev, ops]; multiply-before-divide in u128;
/// the rounding remainder goes deterministically to the liquidity leg.
fn route_payment<'info>(
    payer: &Signer<'info>,
    treasury_liquidity: &SystemAccount<'info>,
    treasury_dev: &SystemAccount<'info>,
    treasury_ops: &SystemAccount<'info>,
    system_program: &Program<'info, System>,
    amount: u64,
    splits: [u16; 3],
) -> Result<()> {
    let dev_cut = mul_bps(amount, splits[1])?;
    let ops_cut = mul_bps(amount, splits[2])?;
    let liquidity_cut = amount
        .checked_sub(dev_cut)
        .and_then(|v| v.checked_sub(ops_cut))
        .ok_or(CoreError::MathOverflow)?;

    for (treasury, cut) in [
        (treasury_liquidity, liquidity_cut),
        (treasury_dev, dev_cut),
        (treasury_ops, ops_cut),
    ] {
        if cut > 0 {
            transfer(
                CpiContext::new(
                    system_program.to_account_info(),
                    Transfer {
                        from: payer.to_account_info(),
                        to: treasury.to_account_info(),
                    },
                ),
                cut,
            )?;
        }
    }
    Ok(())
}

fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    let v = u128::from(amount)
        .checked_mul(u128::from(bps))
        .ok_or(CoreError::MathOverflow)?
        / u128::from(BPS_DENOMINATOR);
    u64::try_from(v).map_err(|_| error!(CoreError::MathOverflow))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Prices {
    pub entry_lamports: u64,
    /// Prices for the 2nd and 3rd builder (index 0 = first purchasable builder).
    pub builder_lamports: [u64; 2],
    pub expansion_lamports: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub keep_mint: Pubkey,
    pub treasury_liquidity: Pubkey,
    pub treasury_dev: Pubkey,
    pub treasury_ops: Pubkey,
    /// [liquidity, dev, ops] in bps; must sum to 10_000.
    pub splits: [u16; 3],
    pub prices: Prices,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub keep_mint: Pubkey,
    pub treasury_liquidity: Pubkey,
    pub treasury_dev: Pubkey,
    pub treasury_ops: Pubkey,
    pub splits: [u16; 3],
    pub prices: Prices,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub wallet: Pubkey,
    pub opened_at: i64,
    pub builders_purchased: u8,
    pub expansions_purchased: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EpochRoot {
    pub epoch: u64,
    pub root: [u8; 32],
    pub total_balance: u64,
    pub posted_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// The canonical Config PDA may only be initialized by this program's
    /// current upgrade authority. Binding the executable to its ProgramData
    /// account closes the first-signer race without pinning a stale authority.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ CoreError::Unauthorized
    )]
    pub program: Program<'info, crate::program::ShardkeepCore>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ CoreError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayEntry<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub player_wallet: Signer<'info>,
    #[account(
        init,
        payer = player_wallet,
        space = 8 + Player::INIT_SPACE,
        seeds = [PLAYER_SEED, player_wallet.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    #[account(mut, address = config.treasury_liquidity @ CoreError::InvalidTreasury)]
    pub treasury_liquidity: SystemAccount<'info>,
    #[account(mut, address = config.treasury_dev @ CoreError::InvalidTreasury)]
    pub treasury_dev: SystemAccount<'info>,
    #[account(mut, address = config.treasury_ops @ CoreError::InvalidTreasury)]
    pub treasury_ops: SystemAccount<'info>,
    /// CHECK: client-supplied reference key, passed as a no-op account purely so
    /// off-chain payment detection can find the tx by this key. Never read.
    pub reference: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Shared accounts for buy_builder / buy_expansion (Player must already exist).
#[derive(Accounts)]
pub struct Purchase<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub player_wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, player_wallet.key().as_ref()],
        bump = player.bump
    )]
    pub player: Account<'info, Player>,
    #[account(mut, address = config.treasury_liquidity @ CoreError::InvalidTreasury)]
    pub treasury_liquidity: SystemAccount<'info>,
    #[account(mut, address = config.treasury_dev @ CoreError::InvalidTreasury)]
    pub treasury_dev: SystemAccount<'info>,
    #[account(mut, address = config.treasury_ops @ CoreError::InvalidTreasury)]
    pub treasury_ops: SystemAccount<'info>,
    /// CHECK: client-supplied reference key for off-chain payment detection. Never read.
    pub reference: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Accounts for buy_sink — repeatable SOL sinks (energy/shield). No Player PDA:
/// nothing on-chain is per-purchase, so the server (not the program) enforces
/// price, per-day caps, and shield-active eligibility before granting.
#[derive(Accounts)]
pub struct BuySink<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub player_wallet: Signer<'info>,
    #[account(mut, address = config.treasury_liquidity @ CoreError::InvalidTreasury)]
    pub treasury_liquidity: SystemAccount<'info>,
    #[account(mut, address = config.treasury_dev @ CoreError::InvalidTreasury)]
    pub treasury_dev: SystemAccount<'info>,
    #[account(mut, address = config.treasury_ops @ CoreError::InvalidTreasury)]
    pub treasury_ops: SystemAccount<'info>,
    /// CHECK: client-supplied reference key for off-chain payment detection. Never read.
    pub reference: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct PostRoot<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ CoreError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + EpochRoot::INIT_SPACE,
        seeds = [ROOT_SEED, epoch.to_le_bytes().as_ref()],
        bump
    )]
    pub epoch_root: Account<'info, EpochRoot>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ CoreError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub new_admin: Signer<'info>,
}

#[event]
pub struct PaymentMade {
    pub wallet: Pubkey,
    /// 0=entry, 1=builder, 2=expansion, 3=energy, 4=shield, 5=mine (≥3 = SOL sink).
    pub kind: u8,
    pub lamports: u64,
    pub reference: Pubkey,
}

#[event]
pub struct RootPosted {
    pub epoch: u64,
    pub root: [u8; 32],
    pub total_balance: u64,
}

#[error_code]
pub enum CoreError {
    #[msg("Splits must sum to 10000 bps")]
    InvalidSplits,
    #[msg("Payments are paused")]
    Paused,
    #[msg("Purchase index must equal the current purchase count")]
    OutOfOrderPurchase,
    #[msg("Purchase limit reached")]
    PurchaseLimitReached,
    #[msg("Treasury account does not match config")]
    InvalidTreasury,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Payment kind is not a valid SOL sink")]
    InvalidPaymentKind,
    #[msg("Amount must be positive")]
    InvalidAmount,
}
