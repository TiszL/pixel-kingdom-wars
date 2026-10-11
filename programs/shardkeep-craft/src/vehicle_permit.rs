//! Native Ed25519 instruction evidence; no policy signer or fixture fallback.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};
use crate::{craft_constants::*, vehicle_state::{VehicleControl,VehicleError as E,VEHICLE_VERSION}};
// A second declare_id! also emits an Anchor IDL address and can overwrite this
// program's generated identity. Native precompiles are constants, not our program.
const ED25519_PROGRAM_ID: Pubkey = Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
pub const VEHICLE_KIND:u8=3;
pub const MESSAGE_LEN: usize = 161;
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct VehiclePermitArgs {
    pub permit_id: [u8; 16],
    pub expiry: i64,
    pub ed25519_instruction: u16,
}
pub fn message(authority: &VehicleControl, kind: u8, wallet: Pubkey, args: &VehiclePermitArgs, payload: [u8; 32]) -> [u8; MESSAGE_LEN] {
    let mut bytes = [0u8; MESSAGE_LEN];
    bytes[..8].copy_from_slice(b"SKPERMT2"); bytes[8..40].copy_from_slice(&authority.cluster_genesis);
    bytes[40..72].copy_from_slice(crate::ID.as_ref()); bytes[72] = kind;
    bytes[73..89].copy_from_slice(&args.permit_id); bytes[89..121].copy_from_slice(wallet.as_ref());
    bytes[121..129].copy_from_slice(&args.expiry.to_le_bytes()); bytes[129..].copy_from_slice(&payload); bytes
}
fn u16_at(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data.get(at..at.checked_add(2).ok_or(E::Arithmetic)?).ok_or(E::Permit)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}
fn range(offset: u16, size: usize, len: usize) -> Result<std::ops::Range<usize>> {
    let start = usize::from(offset); let end = start.checked_add(size).ok_or(E::Arithmetic)?;
    require!(start >= 16 && end <= len, E::Permit); Ok(start..end)
}
fn overlap(a: &std::ops::Range<usize>, b: &std::ops::Range<usize>) -> bool { a.start < b.end && b.start < a.end }
/// Public for byte-vector tests; native verification authenticates the signature.
pub fn parse_native(data: &[u8]) -> Result<(&[u8], &[u8])> {
    require!(data.len() >= 16 && data[0] == 1 && data[1] == 0, E::Permit);
    for at in [4, 8, 14] { require!(u16_at(data, at)? == u16::MAX, E::Permit); }
    require!(usize::from(u16_at(data, 12)?) == MESSAGE_LEN, E::Permit);
    let signature = range(u16_at(data, 2)?, 64, data.len())?;
    let key = range(u16_at(data, 6)?, 32, data.len())?;
    let msg = range(u16_at(data, 10)?, MESSAGE_LEN, data.len())?;
    require!(!overlap(&signature, &key) && !overlap(&signature, &msg) && !overlap(&key, &msg), E::Permit);
    Ok((&data[key], &data[msg]))
}
pub fn verify(authority: &VehicleControl, wallet: Pubkey, kind: u8, args: &VehiclePermitArgs,
    payload: [u8; 32], instructions: &AccountInfo, now: i64) -> Result<()> {
    require!(authority.version == VEHICLE_VERSION, E::Binding);
    require!(now < args.expiry && args.expiry <= now.checked_add(MAX_POLICY_PERMIT_TTL_SEC).ok_or(E::Arithmetic)?, E::Expired);
    let current = load_current_index_checked(instructions)?;
    require!(args.ed25519_instruction < current, E::Permit);
    let ix = load_instruction_at_checked(usize::from(args.ed25519_instruction), instructions)?;
    require!(ix.program_id == ED25519_PROGRAM_ID && ix.accounts.is_empty(), E::Permit);
    let (key, signed) = parse_native(&ix.data)?;
    let valid_key = key == authority.current_policy_key.as_ref()
        || (now < authority.previous_valid_until && authority.previous_policy_key.as_ref() == key);
    require!(valid_key && signed == message(authority, kind, wallet, args, payload), E::Permit);
    Ok(())
}
#[cfg(test)]mod tests{
 use super::*;
 fn native()->Vec<u8>{let mut b=vec![0;16+32+64+MESSAGE_LEN];b[0]=1;for(at,value)in[(2,48u16),(4,u16::MAX),(6,16),(8,u16::MAX),(10,112),(12,MESSAGE_LEN as u16),(14,u16::MAX)]{b[at..at+2].copy_from_slice(&value.to_le_bytes())}b[16..48].fill(7);b[112..].fill(9);b}
 #[test]fn native_signature_evidence_is_self_contained_single_and_nonoverlapping(){let valid=native();let(k,m)=parse_native(&valid).unwrap();assert_eq!(k,[7;32]);assert_eq!(m,[9;161]);for at in[4,8,14]{let mut b=valid.clone();b[at..at+2].fill(0);assert!(parse_native(&b).is_err())}for at in[0,1,10,12]{let mut b=valid.clone();b[at]=if at==1{1}else{0};assert!(parse_native(&b).is_err())}assert!(parse_native(&valid[..valid.len()-1]).is_err())}
 #[test]fn permits_bind_craft_domain_kind_buyer_id_expiry_and_terms(){
  let c=VehicleControl{version:1,cluster_genesis:[1;32],current_policy_key:Pubkey::default(),previous_policy_key:Pubkey::default(),previous_valid_until:0,collection:Pubkey::default(),collection_authority:Pubkey::default(),admission_paused:true,escrow_rent_reserve:Rent::default().minimum_balance(0),bump:1,collection_bump:2,authority_bump:3};let args=VehiclePermitArgs{permit_id:[2;16],expiry:99,ed25519_instruction:0};let wallet=Pubkey::new_from_array([3;32]);let b=message(&c,VEHICLE_KIND,wallet,&args,[4;32]);assert_eq!(&b[..8],b"SKPERMT2");assert_eq!(&b[8..40],&[1;32]);assert_eq!(&b[40..72],crate::ID.as_ref());assert_eq!(b[72],3);assert_eq!(&b[73..89],&[2;16]);assert_eq!(&b[89..121],wallet.as_ref());assert_eq!(&b[121..129],&99i64.to_le_bytes());assert_eq!(&b[129..],&[4;32]);assert_ne!(b,message(&c,5,wallet,&args,[4;32]));
 }
}
