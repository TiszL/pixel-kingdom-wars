//! Phase E / S1 spike: can an Anchor 0.32.1 program CPI into mpl-core through the
//! `mpl-core` crate's generated `*CpiBuilder`s, signing as a program PDA?
//! NOT DEPLOYABLE (program id = System Program). See docs/phase-e/SPIKES.md.
use anchor_lang::prelude::*;
use mpl_core::instructions::{AddPluginV1CpiBuilder, TransferV1CpiBuilder, UpdatePluginV1CpiBuilder};
use mpl_core::types::{PermanentFreezeDelegate, Plugin, PluginAuthority};

declare_id!("11111111111111111111111111111111");

pub const VAULT_SEED: &[u8] = b"spike-vault";

#[program]
pub mod spike_mpl_core_c {
    use super::*;

    /// TransferV1 CPI with the vault PDA as the transfer authority (owner or transfer delegate).
    pub fn transfer_via_pda(ctx: Context<VaultCpi>) -> Result<()> {
        let a = &ctx.accounts;
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &[a.vault.bump]]];
        let mpl = a.mpl_core_program.to_account_info();
        let asset = a.asset.to_account_info();
        let collection = a.collection.as_ref().map(|c| c.to_account_info());
        let payer = a.payer.to_account_info();
        let authority = a.vault.to_account_info();
        let new_owner = a.new_owner.to_account_info();
        let system_program = a.system_program.to_account_info();
        TransferV1CpiBuilder::new(&mpl)
            .asset(&asset)
            .collection(collection.as_ref())
            .payer(&payer)
            .authority(Some(&authority))
            .new_owner(&new_owner)
            .system_program(Some(&system_program))
            .invoke_signed(seeds)?;
        Ok(())
    }

    /// UpdatePluginV1 CPI: flip PermanentFreezeDelegate.frozen with the vault PDA as plugin authority.
    pub fn set_frozen(ctx: Context<VaultCpi>, frozen: bool) -> Result<()> {
        let a = &ctx.accounts;
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &[a.vault.bump]]];
        let mpl = a.mpl_core_program.to_account_info();
        let asset = a.asset.to_account_info();
        let collection = a.collection.as_ref().map(|c| c.to_account_info());
        let payer = a.payer.to_account_info();
        let authority = a.vault.to_account_info();
        let system_program = a.system_program.to_account_info();
        UpdatePluginV1CpiBuilder::new(&mpl)
            .asset(&asset)
            .collection(collection.as_ref())
            .payer(&payer)
            .authority(Some(&authority))
            .system_program(&system_program)
            .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen }))
            .invoke_signed(seeds)?;
        Ok(())
    }

    /// AddPluginV1 CPI: install PermanentFreezeDelegate with the vault PDA as its authority
    /// (charter design A needs this at mint/adoption time).
    pub fn install_freeze_delegate(ctx: Context<VaultCpi>) -> Result<()> {
        let a = &ctx.accounts;
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &[a.vault.bump]]];
        let mpl = a.mpl_core_program.to_account_info();
        let asset = a.asset.to_account_info();
        let collection = a.collection.as_ref().map(|c| c.to_account_info());
        let payer = a.payer.to_account_info();
        let authority = a.vault.to_account_info();
        let system_program = a.system_program.to_account_info();
        AddPluginV1CpiBuilder::new(&mpl)
            .asset(&asset)
            .collection(collection.as_ref())
            .payer(&payer)
            .authority(Some(&authority))
            .system_program(&system_program)
            .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: false }))
            .init_authority(PluginAuthority::Address { address: a.vault.key() })
            .invoke_signed(seeds)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct VaultCpi<'info> {
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, SpikeVault>,
    /// CHECK: mpl-core validates the asset account.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: mpl-core validates the collection account.
    #[account(mut)]
    pub collection: Option<UncheckedAccount<'info>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: destination owner; mpl-core does not constrain it.
    pub new_owner: UncheckedAccount<'info>,
    /// CHECK: constrained to the mpl-core program id.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct SpikeVault {
    pub authority: Pubkey,
    pub bump: u8,
    pub freeze_ops: u64,
}
