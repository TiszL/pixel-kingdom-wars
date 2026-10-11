//! S2 spike — MagicBlock ephemeral-vrf-sdk 0.17.2 (`anchor-compat`) under the SHARDKEEP pins
//! (anchor-lang 0.32.1, Agave 2.3.13, platform-tools v1.48).
//!
//! Shape of a future `shardkeep-craft` program: `request_roll` CPIs the VRF program through the
//! SDK's scoped request builder; `consume_roll` is the VRF-signed callback that stores the
//! 32-byte randomness in a PDA. Not deployed anywhere.
//!
//! SDK facts read from ~/.cargo/registry/src/*/ephemeral-vrf-sdk-0.17.2:
//! - scoped builder = `instructions::create_request_randomness_ix` (data[0] = 10, regular
//!   priority) or `create_request_high_priority_scoped_randomness_ix` (11). The quickstart's
//!   `create_request_scoped_randomness_ix` does NOT exist in 0.17.2.
//! - `#[vrf]` (above `#[derive(Accounts)]`) requires an `oracle_queue` field and injects
//!   `program_identity` (PDA [b"identity"] of THIS program), `vrf_program`, `slot_hashes`,
//!   `system_program`, plus an `invoke_signed_vrf` helper that forces the scoped discriminator.
//! - `#[vrf_callback]` injects `vrf_program_identity: Signer` constrained to
//!   `consts::scoped_vrf_identity(&crate::ID)` = PDA([b"identity", crate::ID], VRF program).
use anchor_lang::prelude::*;
use ephemeral_vrf_sdk::anchor::{vrf, vrf_callback};
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;

declare_id!("SpikeVrf11111111111111111111111111111111111");

/// MagicBlock VRF program (base layer). Must equal `ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID`;
/// a unit test below pins that.
pub const VRF_PROGRAM_ID: Pubkey = pubkey!("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
/// Base-layer (devnet/mainnet) oracle queue. Must equal `ephemeral_vrf_sdk::consts::DEFAULT_QUEUE`.
pub const VRF_BASE_QUEUE: Pubkey = pubkey!("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");

pub const ROLL_SEED: &[u8] = b"roll";

#[program]
pub mod spike_vrf {
    use super::*;

    /// Opens a roll PDA for the payer and CPIs the VRF program for scoped randomness that will be
    /// delivered to `consume_roll`.
    pub fn request_roll(ctx: Context<RequestRoll>, client_seed: u8) -> Result<()> {
        let roll = &mut ctx.accounts.roll;
        roll.owner = ctx.accounts.payer.key();
        roll.pending = true;
        roll.result = [0u8; 32];
        let roll_key = roll.key();

        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: crate::ID,
            callback_discriminator: crate::instruction::ConsumeRoll::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: roll_key,
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback. Only callable with the scoped VRF identity PDA as signer (injected by
    /// `#[vrf_callback]`); stores the randomness on the roll PDA named in the request.
    pub fn consume_roll(ctx: Context<ConsumeRoll>, randomness: [u8; 32]) -> Result<()> {
        let roll = &mut ctx.accounts.roll;
        require!(roll.pending, SpikeError::RollNotPending);
        roll.result = randomness;
        roll.pending = false;
        Ok(())
    }
}

#[vrf]
#[derive(Accounts)]
pub struct RequestRoll<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Roll::INIT_SPACE,
        seeds = [ROLL_SEED, payer.key().as_ref()],
        bump,
    )]
    pub roll: Account<'info, Roll>,
    /// CHECK: VRF oracle queue, address-pinned to the base-layer queue constant.
    #[account(mut, address = VRF_BASE_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
    // `#[vrf]` injects: program_identity, vrf_program, slot_hashes, system_program.
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeRoll<'info> {
    // `#[vrf_callback]` injects `vrf_program_identity: Signer<'info>` at index 0.
    #[account(mut)]
    pub roll: Account<'info, Roll>,
}

#[account]
#[derive(InitSpace)]
pub struct Roll {
    pub owner: Pubkey,
    pub pending: bool,
    pub result: [u8; 32],
}

#[error_code]
pub enum SpikeError {
    #[msg("roll is not pending")]
    RollNotPending,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_sdk() {
        assert_eq!(VRF_PROGRAM_ID, ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID);
        assert_eq!(VRF_BASE_QUEUE, ephemeral_vrf_sdk::consts::DEFAULT_QUEUE);
        assert_eq!(VRF_PROGRAM_ID, ephemeral_vrf_sdk::id());
    }

    #[test]
    fn scoped_request_uses_discriminator_10_and_scoped_identity_is_a_pda_of_vrf() {
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: Pubkey::new_unique(),
            oracle_queue: VRF_BASE_QUEUE,
            callback_program_id: crate::ID,
            callback_discriminator: crate::instruction::ConsumeRoll::DISCRIMINATOR.to_vec(),
            ..Default::default()
        });
        assert_eq!(ix.program_id, VRF_PROGRAM_ID);
        assert_eq!(ix.data[0], 10);
        let identity = ephemeral_vrf_sdk::consts::scoped_vrf_identity(&crate::ID);
        let (expected, _) = Pubkey::find_program_address(
            &[ephemeral_vrf_sdk::consts::IDENTITY, crate::ID.as_ref()],
            &VRF_PROGRAM_ID,
        );
        assert_eq!(identity, expected);
    }
}
