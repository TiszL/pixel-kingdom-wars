//! Charter-only accounts. Existing mining and Seeker account layouts are untouched.
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct CharterConfig {
    pub version: u8,
    pub authority: Pubkey,
    pub craft_program: Pubkey,
    pub craft_control: Pubkey,
    pub collection: Pubkey,
    pub collection_authority: Pubkey,
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct ClanCharter {
    pub version: u8,
    pub config: Pubkey,
    pub clan_id: [u8;16],
    pub asset: Pubkey,
    pub collection: Pubkey,
    pub leader: Pubkey,
    pub revision: u32,
    pub state: u8,
    pub lock_kind: u8,
    pub lock_id: [u8;16],
    pub creation_intent_id: [u8;16],
    pub metadata_hash: [u8;32],
    pub admission_commitment: [u8;32],
    pub creation_permit_id: [u8;16],
    pub created_at: i64,
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct CharterAssetBinding {
    pub version: u8,
    pub asset: Pubkey,
    pub clan_id: [u8;16],
    pub charter: Pubkey,
    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct CharterCreationReceipt {
    pub version: u8,
    pub intent_id: [u8;16],
    pub clan_id: [u8;16],
    pub charter: Pubkey,
    pub asset: Pubkey,
    pub leader: Pubkey,
    pub permit_id: [u8;16],
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use shardkeep_charter_interface as wire;
    const CLAN: [u8;16]=[0x12,0x34,0x56,0x78,0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0,0x12,0x34,0x56,0x78];
    const INTENT: [u8;16]=[0x87,0x65,0x43,0x21,0x43,0x21,0x43,0x21,0x8a,0xbc,0xde,0xf0,0x12,0x34,0x56,0x78];
    const KEY: Pubkey=Pubkey::new_from_array([7;32]);
    fn encoded<T: AccountSerialize>(value:&T)->Vec<u8> {let mut bytes=Vec::new();value.try_serialize(&mut bytes).unwrap();bytes}
    #[test]
    fn charter_config_anchor_bytes_match_the_independent_cross_program_contract() {
        let value=CharterConfig {version:1,authority:KEY,craft_program:KEY,craft_control:KEY,collection:KEY,collection_authority:KEY,bump:252};
        let b=encoded(&value);assert_eq!(b.len(),8+CharterConfig::INIT_SPACE);assert_eq!(b.len(),wire::CONFIG_BYTES);
        assert_eq!(&b[..8],wire::CONFIG_DISCRIMINATOR);assert_eq!(wire::decode_config(&b).unwrap().craft_program,KEY.to_bytes());
    }
    #[test]
    fn charter_provisional_state_has_the_exact_typed_cpi_layout_and_complete_uuid() {
        let value=ClanCharter {version:1,config:KEY,clan_id:CLAN,asset:KEY,collection:KEY,leader:KEY,revision:0,state:0,lock_kind:0,
            lock_id:[0;16],creation_intent_id:INTENT,metadata_hash:[1;32],admission_commitment:[2;32],creation_permit_id:[0;16],created_at:1_800_000_000,bump:251};
        let b=encoded(&value);assert_eq!(b.len(),8+ClanCharter::INIT_SPACE);assert_eq!(b.len(),wire::CHARTER_BYTES);
        assert_eq!(&b[..8],wire::CHARTER_DISCRIMINATOR);let read=wire::decode_charter(&b).unwrap();
        assert_eq!(read.clan_id,CLAN);assert_eq!(read.creation_intent_id,INTENT);assert_eq!(read.state,wire::CharterState::Minting);
    }
    #[test]
    fn permanent_asset_binding_cannot_be_confused_with_a_time_closeable_permit() {
        let value=CharterAssetBinding {version:1,asset:KEY,clan_id:CLAN,charter:KEY,bump:250};
        let b=encoded(&value);assert_eq!(b.len(),8+CharterAssetBinding::INIT_SPACE);assert_eq!(b.len(),wire::ASSET_BINDING_BYTES);
        assert_eq!(&b[..8],wire::ASSET_BINDING_DISCRIMINATOR);assert_eq!(wire::decode_asset_binding(&b).unwrap().clan_id,CLAN);
    }
    #[test]
    fn permanent_creation_receipt_preserves_cross_clan_intent_uniqueness_and_original_actor() {
        let value=CharterCreationReceipt {version:1,intent_id:INTENT,clan_id:CLAN,charter:KEY,asset:KEY,leader:KEY,permit_id:[0;16],bump:249};
        let b=encoded(&value);assert_eq!(b.len(),8+CharterCreationReceipt::INIT_SPACE);assert_eq!(b.len(),wire::CREATION_RECEIPT_BYTES);
        assert_eq!(&b[..8],wire::CREATION_RECEIPT_DISCRIMINATOR);let read=wire::decode_creation_receipt(&b).unwrap();
        assert_eq!(read.intent_id,INTENT);assert_eq!(read.clan_id,CLAN);assert_eq!(read.leader,KEY.to_bytes());
    }
}
