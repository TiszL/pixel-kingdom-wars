//! Independently assembled Borsh bytes pin the contract, not a decoder round-trip.
use shardkeep_charter_interface::*;
const CLAN: Id = [0x12,0x34,0x56,0x78,0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0,0x12,0x34,0x56,0x78];
const INTENT: Id = [0x87,0x65,0x43,0x21,0x43,0x21,0x43,0x21,0x8a,0xbc,0xde,0xf0,0x12,0x34,0x56,0x78];
fn header(d: [u8;8]) -> Vec<u8> { let mut b=d.to_vec();b.push(1);b }
fn key(b: &mut Vec<u8>, n:u8) { b.extend_from_slice(&[n;32]); }
fn control() -> Vec<u8> {
    let mut b=header(CONTROL_DISCRIMINATOR); for n in 1..=4 { key(&mut b,n); }
    b.extend_from_slice(&[1,251,252,253]);b
}
fn config() -> Vec<u8> {
    let mut b=header(CONFIG_DISCRIMINATOR); for n in 1..=5 { key(&mut b,n); } b.push(254);b
}
fn charter() -> Vec<u8> {
    let mut b=header(CHARTER_DISCRIMINATOR);key(&mut b,1);b.extend_from_slice(&CLAN);
    for n in 2..=4 {key(&mut b,n);} b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(&[0,0]);b.extend_from_slice(&[0;16]);b.extend_from_slice(&INTENT);
    key(&mut b,5);key(&mut b,6);b.extend_from_slice(&[0;16]); // Existing permit IDs are opaque, not UUIDs.
    b.extend_from_slice(&1_800_000_000i64.to_le_bytes());b.push(255);b
}
fn binding() -> Vec<u8> {
    let mut b=header(ASSET_BINDING_DISCRIMINATOR);key(&mut b,1);b.extend_from_slice(&CLAN);key(&mut b,2);b.push(250);b
}
fn creation() -> Vec<u8> {
    let mut b=header(CREATION_RECEIPT_DISCRIMINATOR);b.extend_from_slice(&INTENT);b.extend_from_slice(&CLAN);
    for n in 1..=3 {key(&mut b,n);}b.extend_from_slice(&[0;16]);b.push(249);b
}
fn commitment() -> RegistrationCommitment {
    RegistrationCommitment {config:[1;32],craft_program:[2;32],craft_control:[3;32],collection:[4;32],
        collection_authority:[5;32],charter:[6;32],asset:[7;32],asset_binding:[8;32],freeze_authority:[9;32],
        executor:[10;32],creation_receipt:[11;32],clan_id:CLAN,leader:[12;32],creation_intent_id:INTENT,
        metadata_hash:[13;32],admission_commitment:[14;32]}
}
fn mint() -> Vec<u8> {
    let mut b=MINT_DISCRIMINATOR.to_vec();b.extend_from_slice(&CLAN);b.extend_from_slice(&INTENT);key(&mut b,14);
    for s in ["Charter","https://invalid.example/charter.json"] {b.extend_from_slice(&(s.len() as u32).to_le_bytes());b.extend_from_slice(s.as_bytes());}
    b.extend_from_slice(&[0;16]);b
}

#[test]
fn control_authenticates_exact_existing_layout_without_normalizing_bool_or_padding() {
    let b=control();assert_eq!(b.len(),CONTROL_BYTES);
    let v=decode_control(&b).unwrap();assert!(v.admission_paused);assert_eq!(v.economy_program,[2;32]);assert_eq!(v.authority_bump,253);
    for n in 0..b.len() {assert!(decode_control(&b[..n]).is_err());}
    for index in [0,8,137] {let mut bad=b.clone();bad[index]=9;assert!(decode_control(&bad).is_err());}
    let mut bad=b.clone();bad.push(0);assert!(decode_control(&bad).is_err());
}
#[test]
fn config_rejects_absent_pins_and_any_other_account_type_or_length() {
    let b=config();assert_eq!(b.len(),CONFIG_BYTES);let v=decode_config(&b).unwrap();assert_eq!(v.craft_control,[3;32]);
    for n in 0..b.len() {assert!(decode_config(&b[..n]).is_err());}
    for start in [9,41,73,105,137] {let mut bad=b.clone();bad[start..start+32].fill(0);assert!(decode_config(&bad).is_err());}
    let mut bad=b.clone();bad.push(0);assert!(decode_config(&bad).is_err());assert!(decode_config(&control()).is_err());
}
#[test]
fn charter_uses_full_uuid_and_closed_lifecycle_and_lock_fields() {
    let b=charter();assert_eq!(b.len(),CHARTER_BYTES);let v=decode_charter(&b).unwrap();
    assert_eq!(v.clan_id,CLAN);assert_eq!(v.creation_intent_id,INTENT);assert_eq!(v.state,CharterState::Minting);assert_eq!(v.revision,0);
    let mut active=b.clone();active[157]=1;active[153..157].copy_from_slice(&7u32.to_le_bytes());assert_eq!(decode_charter(&active).unwrap().revision,7);
    for n in 0..b.len() {assert!(decode_charter(&b[..n]).is_err());}
    for (at,value) in [(157,2),(158,1),(159,1),(47,0),(181,0)] {let mut bad=b.clone();bad[at]=value;assert!(decode_charter(&bad).is_err(),"offset {at}");}
    let mut bad=b.clone();bad.push(0);assert!(decode_charter(&bad).is_err());
}
#[test]
fn retired_charter_preserves_wire_identity_but_cannot_be_minting_or_tournament_locked() {
    let mut retired=charter();retired[157]=2;retired[153..157].copy_from_slice(&1u32.to_le_bytes());
    let decoded=decode_charter(&retired).expect("a permanently retired Charter is retained history");
    assert_ne!(decoded.state,CharterState::Minting);assert_ne!(decoded.state,CharterState::Active);
    assert_eq!(decoded.clan_id,CLAN);assert_eq!(decoded.creation_intent_id,INTENT);assert_eq!(retired.len(),280);
    let mut zero=retired.clone();zero[153..157].fill(0);assert!(decode_charter(&zero).is_err());
    let mut locked=retired.clone();locked[158]=1;locked[159..175].copy_from_slice(&INTENT);assert!(decode_charter(&locked).is_err());
    let mut unknown=retired;unknown[157]=3;assert!(decode_charter(&unknown).is_err());
}
#[test]
fn retirement_consent_binds_all_pins_original_ids_revision_and_clearance_without_a_sale() {
    let v=RetirementCommitment {config:[1;32],craft_program:[2;32],craft_control:[3;32],collection:[4;32],collection_authority:[5;32],
     charter:[6;32],asset:[7;32],asset_binding:[8;32],freeze_authority:[9;32],receipt:[10;32],leader:[11;32],
     clan_id:CLAN,retirement_id:INTENT,fence_id:CLAN,expected_revision:7,clearance_hash:[12;32]};
    let actual=retirement_preimage(&v).unwrap();let mut expected=b"SKCHRET1".to_vec();expected.extend(1u16.to_le_bytes());
    for n in 1..=11 {key(&mut expected,n);}expected.extend(CLAN);expected.extend(INTENT);expected.extend(CLAN);expected.extend(7u32.to_le_bytes());key(&mut expected,12);
    assert_eq!(actual,expected);assert_eq!(actual.len(),446);
    for i in 0..12 {let mut bad=v;let fields=[&mut bad.config,&mut bad.craft_program,&mut bad.craft_control,&mut bad.collection,&mut bad.collection_authority,
     &mut bad.charter,&mut bad.asset,&mut bad.asset_binding,&mut bad.freeze_authority,&mut bad.receipt,&mut bad.leader,&mut bad.clearance_hash];
     *fields.into_iter().nth(i).unwrap()=[0;32];assert!(retirement_preimage(&bad).is_err());}
    let mut changed=v;changed.retirement_id[15]^=1;assert_ne!(retirement_preimage(&changed).unwrap(),actual);
    changed=v;changed.expected_revision+=1;assert_ne!(retirement_preimage(&changed).unwrap(),actual);
    changed=v;changed.fence_id=[0;16];assert!(retirement_preimage(&changed).is_err());
}
#[test]
fn permanent_asset_and_creation_receipts_retain_both_identities_and_opaque_permit_id() {
    let b=binding();let c=creation();assert_eq!(b.len(),ASSET_BINDING_BYTES);assert_eq!(c.len(),CREATION_RECEIPT_BYTES);
    assert_eq!(decode_asset_binding(&b).unwrap().clan_id,CLAN);
    let receipt=decode_creation_receipt(&c).unwrap();assert_eq!(receipt.intent_id,INTENT);assert_eq!(receipt.clan_id,CLAN);assert_eq!(receipt.permit_id,[0;16]);
    for n in 0..b.len() {assert!(decode_asset_binding(&b[..n]).is_err());}
    for n in 0..c.len() {assert!(decode_creation_receipt(&c[..n]).is_err());}
    let mut bad=b;bad.push(0);assert!(decode_asset_binding(&bad).is_err());
    let mut bad=c;bad.push(0);assert!(decode_creation_receipt(&bad).is_err());
}
#[test]
fn identity_requires_the_complete_rfc_uuid_including_version_and_variant() {
    assert_eq!(validate_uuid(&CLAN),Ok(()));assert_eq!(validate_uuid(&INTENT),Ok(()));
    for version in 1..=8 {let mut b=CLAN;b[6]=version<<4;assert!(validate_uuid(&b).is_ok());}
    for version in [0,9,15] {let mut b=CLAN;b[6]=version<<4;assert!(validate_uuid(&b).is_err());}
    for variant in [0,1,3] {let mut b=CLAN;b[8]=variant<<6;assert!(validate_uuid(&b).is_err());}
    assert!(validate_uuid(&[0;16]).is_err());
}
#[test]
fn metadata_commitment_is_unambiguous_bounded_utf8_bytes_not_character_count() {
    assert_eq!(validate_metadata("Charter","uri"),Ok(()));
    assert!(validate_metadata(&"é".repeat(32),&"u".repeat(512)).is_ok());
    for (n,u) in [("".to_owned(),"u".to_owned()),("n".into(),"".into()),("é".repeat(33),"u".into()),("n".into(),"u".repeat(513))] {assert!(validate_metadata(&n,&u).is_err());}
    let expected=b"SKCHMET1\x02\0\0\0ab\x01\0\0\0c";assert_eq!(metadata_preimage("ab","c").unwrap(),expected);
    assert_ne!(metadata_preimage("ab","c").unwrap(),metadata_preimage("a","bc").unwrap());
}
#[test]
fn registration_preimage_binds_each_account_and_both_creation_and_clan_domains() {
    let p=commitment();let actual=registration_preimage(&p).unwrap();let mut expected=b"SKCHREG1".to_vec();expected.extend_from_slice(&1u16.to_le_bytes());
    for n in 1..=11 {key(&mut expected,n);}expected.extend_from_slice(&CLAN);key(&mut expected,12);expected.extend_from_slice(&INTENT);key(&mut expected,13);key(&mut expected,14);
    assert_eq!(expected.len(),REGISTRATION_PREIMAGE_BYTES);assert_eq!(actual.as_slice(),expected);
    for index in 0..14 {
        let mut changed=p;let fields=[&mut changed.config,&mut changed.craft_program,&mut changed.craft_control,&mut changed.collection,
            &mut changed.collection_authority,&mut changed.charter,&mut changed.asset,&mut changed.asset_binding,&mut changed.freeze_authority,
            &mut changed.executor,&mut changed.creation_receipt,&mut changed.leader,&mut changed.metadata_hash,&mut changed.admission_commitment];
        *fields.into_iter().nth(index).unwrap()=[0;32];assert!(registration_preimage(&changed).is_err());
    }
    let mut changed=p;changed.clan_id[15]^=1;assert_ne!(registration_preimage(&changed).unwrap(),actual);
    let mut changed=p;changed.creation_intent_id[0]^=1;assert_ne!(registration_preimage(&changed).unwrap(),actual);
}
#[test]
fn mint_instruction_has_exact_bounded_argument_order_and_preserves_opaque_permit_id() {
    let b=mint();let v=decode_mint(&b).unwrap();assert_eq!(v.clan_id,CLAN);assert_eq!(v.creation_intent_id,INTENT);
    assert_eq!(v.name,"Charter");assert_eq!(v.creation_permit_id,[0;16]);assert_eq!(encode_mint(&v).unwrap(),b);
    for n in 0..b.len() {assert!(decode_mint(&b[..n]).is_err());}
    let mut bad=b.clone();bad.push(0);assert!(decode_mint(&bad).is_err());
    let mut bad=b.clone();bad[72..76].copy_from_slice(&u32::MAX.to_le_bytes());assert!(decode_mint(&bad).is_err());
    let mut bad=b.clone();bad[76]=255;assert!(decode_mint(&bad).is_err());
    let mut bad=b;bad[40..72].fill(0);assert!(decode_mint(&bad).is_err());
}
