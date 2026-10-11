//! Deterministic fixture built by the installed SDK, outside the production graph.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;

pub const CRAFT: Pubkey = pubkey!("4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59");
pub const ROOT_ID: [u8; 16] = [0x11; 16];
pub const ATTEMPT_ID: [u8; 16] = [0x22; 16];
// SHA256("global:consume_vehicle_randomness")[0..8]. Production Anchor verifies this independently.
pub const CALLBACK_DISCRIMINATOR: [u8; 8] = [0xe2, 0x39, 0xa1, 0x7d, 0x61, 0x02, 0x16, 0x14];

pub fn terms_hash() -> [u8; 32] {
    std::array::from_fn(|n| n as u8)
}
pub fn randomness() -> [u8; 32] {
    std::array::from_fn(|n| 0xa0 + n as u8)
}
pub fn root() -> Pubkey {
    Pubkey::find_program_address(&[b"vehicle_root", &ROOT_ID], &CRAFT).0
}
pub fn attempt() -> Pubkey {
    Pubkey::find_program_address(&[b"vehicle_attempt", &ATTEMPT_ID], &CRAFT).0
}
pub fn oracle_escrow() -> Pubkey {
    Pubkey::find_program_address(&[b"vehicle_oracle", &ROOT_ID], &CRAFT).0
}
pub fn callback_args() -> Vec<u8> {
    [ROOT_ID, ATTEMPT_ID].concat()
}
pub fn sdk_request() -> Instruction {
    create_request_randomness_ix(RequestRandomnessParams {
        payer: oracle_escrow(),
        oracle_queue: ephemeral_vrf_sdk::consts::DEFAULT_QUEUE,
        callback_program_id: CRAFT,
        callback_discriminator: CALLBACK_DISCRIMINATOR.to_vec(),
        caller_seed: terms_hash(),
        callback_args: Some(callback_args()),
        accounts_metas: Some(vec![
            SerializableAccountMeta {
                pubkey: root(),
                is_signer: false,
                is_writable: false,
            },
            SerializableAccountMeta {
                pubkey: attempt(),
                is_signer: false,
                is_writable: true,
            },
        ]),
    })
}
pub fn callback_data() -> Vec<u8> {
    [
        CALLBACK_DISCRIMINATOR.as_slice(),
        randomness().as_slice(),
        callback_args().as_slice(),
    ]
    .concat()
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn metas(accounts: &[AccountMeta]) -> String {
    accounts
        .iter()
        .map(|m| {
            format!(
                "{{\"address\":\"{}\",\"isSigner\":{},\"isWritable\":{}}}",
                m.pubkey, m.is_signer, m.is_writable
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}
pub fn json() -> String {
    let ix = sdk_request();
    let scoped = ephemeral_vrf_sdk::consts::scoped_vrf_identity(&CRAFT);
    let callback_accounts = [
        AccountMeta::new_readonly(scoped, true),
        AccountMeta::new_readonly(root(), false),
        AccountMeta::new(attempt(), false),
    ];
    format!(concat!(
        "{{\n  \"schemaVersion\":1,\n  \"sdk\":\"ephemeral-vrf-sdk@0.17.2/anchor-compat\",\n",
        "  \"scope\":\"deterministic ABI compatibility; no provider delivery or unpredictability proof\",\n",
        "  \"craftProgram\":\"{}\",\n  \"rootIdHex\":\"{}\",\n  \"attemptIdHex\":\"{}\",\n  \"termsHashHex\":\"{}\",\n",
        "  \"root\":\"{}\",\n  \"attempt\":\"{}\",\n  \"oracleEscrow\":\"{}\",\n  \"scopedProviderIdentity\":\"{}\",\n",
        "  \"request\":{{\"programId\":\"{}\",\"accounts\":[{}],\"dataHex\":\"{}\",\"dataLength\":{}}},\n",
        "  \"callback\":{{\"programId\":\"{}\",\"accounts\":[{}],\"discriminatorHex\":\"{}\",\"randomnessHex\":\"{}\",\"argsHex\":\"{}\",\"dataHex\":\"{}\",\"dataLength\":{}}}\n}}\n"
    ), CRAFT, hex(&ROOT_ID), hex(&ATTEMPT_ID), hex(&terms_hash()),root(),attempt(),oracle_escrow(),scoped,
    ix.program_id,metas(&ix.accounts),hex(&ix.data),ix.data.len(),CRAFT,metas(&callback_accounts),hex(&CALLBACK_DISCRIMINATOR),hex(&randomness()),hex(&callback_args()),hex(&callback_data()),callback_data().len())
}
