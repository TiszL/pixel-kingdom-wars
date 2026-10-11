//! Full UUID Charter identities. No account admission or permit authority.
use anchor_lang::prelude::Pubkey;

/// UUID bytes follow canonical textual hex order, never u64 truncation or LE conversion.
pub fn valid_clan_id(id: &[u8; 16]) -> bool {
    (1..=8).contains(&(id[6] >> 4)) && id[8] >> 6 == 2
}

fn derive(program: &Pubkey, seeds: &[&[u8]]) -> Option<(Pubkey, u8)> {
    if *program == Pubkey::default() { return None; }
    Pubkey::try_find_program_address(seeds, program)
}
fn clan_pda(program: &Pubkey, seed: &[u8], clan: &[u8;16]) -> Option<(Pubkey, u8)> {
    if !valid_clan_id(clan) { return None; }
    derive(program, &[seed, clan])
}
pub fn config_pda(economy: &Pubkey) -> Option<(Pubkey, u8)> {
    derive(economy, &[b"charter_config"])
}
pub fn charter_pda(economy: &Pubkey, clan: &[u8;16]) -> Option<(Pubkey, u8)> {
    clan_pda(economy, b"charter", clan)
}
pub fn asset_pda(economy: &Pubkey, asset: &Pubkey) -> Option<(Pubkey, u8)> {
    if *asset == Pubkey::default() { return None; }
    derive(economy, &[b"charter_asset", asset.as_ref()])
}
pub fn freeze_pda(craft: &Pubkey, clan: &[u8;16]) -> Option<(Pubkey, u8)> {
    clan_pda(craft, b"charter_freeze", clan)
}
pub fn executor_pda(economy: &Pubkey, clan: &[u8;16]) -> Option<(Pubkey, u8)> {
    clan_pda(economy, b"charter_executor", clan)
}

#[cfg(test)]
mod tests {
    use super::*;
    const CLAN: [u8; 16] = [0x12,0x34,0x56,0x78,0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0,0x12,0x34,0x56,0x78];

    #[test]
    fn shared_javascript_vectors_pin_the_complete_wire_identity() {
        let economy = Pubkey::new_from_array([1;32]); let craft = Pubkey::new_from_array([2;32]);
        let asset = Pubkey::new_from_array([3;32]);
        for (actual, address, bump) in [
            (config_pda(&economy), "AqpJVrUEYs6cUyZEiZBwoKPJtQzL6VhTYDG92pHJrfmM", 255),
            (charter_pda(&economy,&CLAN), "Ahmr6ZxPALnJcRaGAab6FJzXTs8TD6i7MyNNNhyy1PnQ", 255),
            (asset_pda(&economy,&asset), "2rczKro1HbWybDSyGdD9KEYNpxQrzxGCFW664oK2HccZ", 254),
            (freeze_pda(&craft,&CLAN), "9PxAuT9D41znMPmvPTCJtovc54CE2KKrVv2fK8s7qEKH", 251),
            (executor_pda(&economy,&CLAN), "J3bLRJNipftFt6aWC5onshCr5wNvAboJngpncHosnauY", 255),
        ] { let (key, actual_bump) = actual.unwrap(); assert_eq!(key.to_string(), address); assert_eq!(actual_bump, bump); }
    }

    #[test]
    fn only_rfc_uuid_versions_and_variant_are_admitted() {
        for version in 1..=8 { let mut id = CLAN; id[6] = version << 4; assert!(valid_clan_id(&id)); }
        for version in [0,9,10,11,12,13,14,15] { let mut id = CLAN; id[6] = version << 4; assert!(!valid_clan_id(&id)); }
        for variant in [0,1,3] { let mut id = CLAN; id[8] = variant << 6; assert!(!valid_clan_id(&id)); }
        assert!(!valid_clan_id(&[0;16])); assert!(!valid_clan_id(&[255;16]));
    }

    #[test]
    fn both_uuid_halves_and_program_domains_change_addresses() {
        let economy = Pubkey::new_from_array([1;32]); let craft = Pubkey::new_from_array([2;32]);
        let expected = charter_pda(&economy, &CLAN).unwrap();
        for index in [0,15] { let mut other = CLAN; other[index] ^= 1; assert_ne!(charter_pda(&economy, &other).unwrap(), expected); }
        assert_ne!(charter_pda(&craft, &CLAN).unwrap(), expected);
        assert_ne!(freeze_pda(&craft, &CLAN).unwrap(), executor_pda(&economy, &CLAN).unwrap());
        assert_ne!(freeze_pda(&economy, &CLAN).unwrap(), executor_pda(&economy, &CLAN).unwrap());
    }

    #[test]
    fn absent_program_asset_or_invalid_clan_never_get_an_address() {
        let program = Pubkey::new_from_array([1;32]); let absent = Pubkey::default();
        assert!(config_pda(&absent).is_none()); assert!(asset_pda(&program,&absent).is_none());
        assert!(asset_pda(&absent,&program).is_none());
        for derive in [charter_pda, freeze_pda, executor_pda] {
            assert!(derive(&absent,&CLAN).is_none()); assert!(derive(&program,&[0;16]).is_none());
        }
    }
}
