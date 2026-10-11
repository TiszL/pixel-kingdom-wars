//! Local-only original vehicle issuance. Permanent records have no close or retry path.
use anchor_lang::prelude::*;
pub const VEHICLE_VERSION:u8=1;
pub const VEHICLE_CONTROL_SEED:&[u8]=b"vehicle_control";
pub const VEHICLE_COLLECTION_SEED:&[u8]=b"vehicle_collection";
pub const VEHICLE_AUTHORITY_SEED:&[u8]=b"vehicle_authority";
pub const ROOT_SEED:&[u8]=b"vehicle_root";
pub const ATTEMPT_SEED:&[u8]=b"vehicle_attempt";
pub const RECEIPT_SEED:&[u8]=b"vehicle_permit";
pub const APP_SEED:&[u8]=b"vehicle_app";
pub const ORACLE_SEED:&[u8]=b"vehicle_oracle";
pub const ASSET_SEED:&[u8]=b"vehicle_asset";
pub const VRF_PROGRAM_ID:Pubkey=Pubkey::from_str_const("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
pub const VRF_QUEUE:Pubkey=Pubkey::from_str_const("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
#[derive(AnchorSerialize,AnchorDeserialize,Clone,Copy,InitSpace,Debug,PartialEq,Eq)]
pub struct VehicleTerms {
 pub recipe_version:u32,pub recipe_hash:[u8;32],pub material_hash:[u8;32],pub metadata_hash:[u8;32],
 pub site:Pubkey,pub operator:Pubkey,pub project:Pubkey,pub oracle_budget:u64,pub odds_bps:u16,pub family:u8,pub tier:u8,
}
#[account]
#[derive(InitSpace)]
pub struct VehicleControl {
 pub version:u8,pub cluster_genesis:[u8;32],pub current_policy_key:Pubkey,pub previous_policy_key:Pubkey,pub previous_valid_until:i64,
 pub collection:Pubkey,pub collection_authority:Pubkey,pub admission_paused:bool,pub escrow_rent_reserve:u64,pub bump:u8,pub collection_bump:u8,pub authority_bump:u8,
}
#[account]
#[derive(InitSpace)]
pub struct VehicleRoot {
 pub version:u8,pub root_id:[u8;16],pub attempt_id:[u8;16],pub buyer:Pubkey,pub attempt:Pubkey,pub asset:Pubkey,pub terms_hash:[u8;32],pub bump:u8,
}
#[account]
#[derive(InitSpace)]
pub struct VehicleAttempt {
 pub version:u8,pub root:Pubkey,pub root_id:[u8;16],pub attempt_id:[u8;16],pub buyer:Pubkey,pub permit_id:[u8;16],pub collection:Pubkey,pub asset:Pubkey,
 pub terms:VehicleTerms,pub terms_hash:[u8;32],pub request_hash:[u8;32],pub application_fee:u64,pub operator_fee:u64,pub project_fee:u64,
 pub randomness:[u8;32],pub outcome:u8,pub fee_settled:bool,pub minted:bool,pub requested_at:i64,pub request_slot:u64,pub result_slot:u64,pub settlement_slot:u64,pub mint_slot:u64,pub bump:u8,
}
#[account]
#[derive(InitSpace)]
pub struct VehiclePermitReceipt {
 pub version:u8,pub permit_id:[u8;16],pub buyer:Pubkey,pub root:Pubkey,pub attempt:Pubkey,pub payload_hash:[u8;32],pub expiry:i64,pub consumed_at:i64,pub bump:u8,
}
// One Anchor error table preserves existing Charter IDs and correct IDL emission.
pub type VehicleError=crate::CraftError;
#[event]
pub struct VehicleRequested{pub root:Pubkey,pub attempt:Pubkey,pub buyer:Pubkey,pub asset:Pubkey,pub terms_hash:[u8;32],pub request_hash:[u8;32],pub application_funded:u64,pub oracle_funded:u64,pub escrow_rent_reserve:u64,pub oracle_spent:u64,pub oracle_remaining:u64}
#[event]
pub struct VehicleOutcomeRecorded{pub root:Pubkey,pub attempt:Pubkey,pub randomness:[u8;32],pub outcome:u8}
#[event]
pub struct VehicleFeeSettled{pub root:Pubkey,pub attempt:Pubkey,pub buyer:Pubkey,pub operator:Pubkey,pub project:Pubkey,pub operator_fee:u64,pub project_fee:u64,pub escrow_remaining:u64}
#[event]
pub struct VehicleMinted{pub root:Pubkey,pub attempt:Pubkey,pub buyer:Pubkey,pub asset:Pubkey,pub collection:Pubkey,pub metadata_hash:[u8;32],pub prefund_returned:u64}

#[event]
pub struct VehicleCollectionInitialized{pub admin:Pubkey,pub collection:Pubkey,pub collection_authority:Pubkey,pub prefund_returned:u64,pub admission_paused:bool,pub escrow_rent_reserve:u64}
