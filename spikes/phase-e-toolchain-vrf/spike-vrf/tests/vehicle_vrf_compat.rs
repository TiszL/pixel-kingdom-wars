//! Selected SDK supplies the oracle request bytes; production consumes this same frozen vector.
#[path = "support/vehicle_vector.rs"]
mod vector;
use anchor_lang::prelude::*;
use ephemeral_vrf_sdk::compat::borsh::BorshDeserialize;
use ephemeral_vrf_sdk::types::RequestRandomness;

#[test]
fn entire_scoped_regular_request_and_five_account_metas_match_frozen_sdk_vector() {
    let ix = vector::sdk_request();
    assert_eq!(
        vector::json(),
        include_str!("../../vectors/vehicle-vrf-v1.json")
    );
    assert_eq!(
        vector::hex(&ix.data),
        include_str!("../../vectors/vehicle-vrf-request-v1.hex").trim()
    );
    assert_eq!(ix.data[..8], [10, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(ix.accounts.len(), 5);
    assert_eq!(ix.accounts[0].pubkey, vector::oracle_escrow());
    assert!(ix.accounts[0].is_signer && ix.accounts[0].is_writable);
    assert_eq!(
        ix.accounts[1].pubkey,
        Pubkey::find_program_address(&[b"identity"], &vector::CRAFT).0
    );
    assert!(ix.accounts[1].is_signer && !ix.accounts[1].is_writable);
    assert_eq!(
        ix.accounts[2].pubkey,
        ephemeral_vrf_sdk::consts::DEFAULT_QUEUE
    );
    assert!(!ix.accounts[2].is_signer && ix.accounts[2].is_writable);
    assert_eq!(ix.accounts[3].pubkey, anchor_lang::system_program::ID);
    assert_eq!(
        ix.accounts[4].pubkey,
        anchor_lang::solana_program::sysvar::slot_hashes::ID
    );
    assert!(ix.accounts[3..]
        .iter()
        .all(|m| !m.is_signer && !m.is_writable));
}

#[test]
fn sdk_borsh_decodes_exact_saved_vehicle_callback_capabilities_and_scoped_identity() {
    let ix = vector::sdk_request();
    let mut body = &ix.data[8..];
    let decoded = RequestRandomness::deserialize(&mut body).unwrap();
    assert!(body.is_empty());
    assert_eq!(decoded.caller_seed, vector::terms_hash());
    assert_eq!(decoded.callback_program_id, vector::CRAFT);
    assert_eq!(
        decoded.callback_discriminator,
        vector::CALLBACK_DISCRIMINATOR
    );
    assert_eq!(decoded.callback_args, vector::callback_args());
    assert_eq!(decoded.callback_accounts_metas.len(), 2);
    assert_eq!(decoded.callback_accounts_metas[0].pubkey, vector::root());
    assert!(
        !decoded.callback_accounts_metas[0].is_signer
            && !decoded.callback_accounts_metas[0].is_writable
    );
    assert_eq!(decoded.callback_accounts_metas[1].pubkey, vector::attempt());
    assert!(
        !decoded.callback_accounts_metas[1].is_signer
            && decoded.callback_accounts_metas[1].is_writable
    );
    let scoped = ephemeral_vrf_sdk::consts::scoped_vrf_identity(&vector::CRAFT);
    assert_eq!(
        scoped,
        Pubkey::find_program_address(
            &[b"identity", vector::CRAFT.as_ref()],
            &ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID
        )
        .0
    );
    assert_ne!(scoped, ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY);
    assert_ne!(
        scoped,
        ephemeral_vrf_sdk::consts::scoped_vrf_identity(&Pubkey::new_from_array([9; 32]))
    );
    assert_ne!(scoped, ix.accounts[1].pubkey);
}

#[derive(AnchorSerialize)]
struct VehicleCallbackArgs {
    randomness: [u8; 32],
    root_id: [u8; 16],
    attempt_id: [u8; 16],
}
#[test]
fn callback_prefix_randomness_and_saved_args_have_the_frozen_anchor_argument_order() {
    let request = vector::sdk_request();
    let mut body = &request.data[8..];
    let saved = RequestRandomness::deserialize(&mut body).unwrap();
    let arguments = VehicleCallbackArgs {
        randomness: vector::randomness(),
        root_id: vector::ROOT_ID,
        attempt_id: vector::ATTEMPT_ID,
    }
    .try_to_vec()
    .unwrap();
    let callback = [saved.callback_discriminator, arguments].concat();
    assert_eq!(callback, vector::callback_data());
    assert_eq!(
        vector::hex(&callback),
        include_str!("../../vectors/vehicle-vrf-callback-v1.hex").trim()
    );
    assert_eq!(&callback[8..40], &vector::randomness());
    assert_eq!(&callback[40..], saved.callback_args);
    assert_eq!(callback.len(), 72);
}
