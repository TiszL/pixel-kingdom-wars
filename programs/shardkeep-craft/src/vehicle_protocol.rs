//! Fixed raw provider ABI; no provider SDK or Solana toolchain migration.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta,Instruction};
use crate::{craft_constants::*,vehicle_state::*};
use VehicleError as E;
#[derive(AnchorSerialize,AnchorDeserialize,Clone,Debug,PartialEq,Eq)]
pub struct CallbackMeta {pub pubkey:Pubkey,pub is_signer:bool,pub is_writable:bool}
#[derive(AnchorSerialize,AnchorDeserialize,Clone,Debug,PartialEq,Eq)]
pub struct ProviderRequest {pub caller_seed:[u8;32],pub callback_program_id:Pubkey,pub callback_discriminator:Vec<u8>,pub callback_accounts_metas:Vec<CallbackMeta>,pub callback_args:Vec<u8>}
pub fn provider_request(root:Pubkey,attempt:Pubkey,root_id:[u8;16],attempt_id:[u8;16],payload:[u8;32],payer:Pubkey)->Result<Instruction>{
 let mut args=root_id.to_vec();args.extend(attempt_id);
 let wire=ProviderRequest {caller_seed:payload,callback_program_id:crate::ID,callback_discriminator:crate::instruction::ConsumeVehicleRandomness::DISCRIMINATOR.to_vec(),
 callback_accounts_metas:vec![CallbackMeta{pubkey:root,is_signer:false,is_writable:false},CallbackMeta{pubkey:attempt,is_signer:false,is_writable:true}],callback_args:args};
 let mut data=vec![10,0,0,0,0,0,0,0];data.extend(wire.try_to_vec()?);
 Ok(Instruction{program_id:VRF_PROGRAM_ID,accounts:vec![AccountMeta::new(payer,true),AccountMeta::new_readonly(Pubkey::find_program_address(&[b"identity"],&crate::ID).0,true),AccountMeta::new(VRF_QUEUE,false),AccountMeta::new_readonly(anchor_lang::system_program::ID,false),AccountMeta::new_readonly(anchor_lang::solana_program::sysvar::slot_hashes::ID,false)],data})
}
pub fn fee_split()->Result<(u64,u64)>{
 require!(u64::from(CRAFT_OPERATOR_BPS).checked_add(u64::from(CRAFT_PROJECT_BPS))==Some(BPS_DENOMINATOR),E::Terms);
 let operator=APPLICATION_FEE_LAMPORTS.checked_mul(u64::from(CRAFT_OPERATOR_BPS)).ok_or(E::Arithmetic)?.checked_div(BPS_DENOMINATOR).ok_or(E::Arithmetic)?;
 Ok((operator,APPLICATION_FEE_LAMPORTS.checked_sub(operator).ok_or(E::Arithmetic)?))
}
pub fn terms_hash(control:Pubkey,genesis:[u8;32],root_id:[u8;16],attempt_id:[u8;16],buyer:Pubkey,collection:Pubkey,asset:Pubkey,terms:&VehicleTerms,escrow_rent_reserve:u64)->Result<[u8;32]>{
 let(operator,project)=fee_split()?;let mut b=b"SKVEHT01".to_vec();
 for v in [crate::ID.to_bytes(),genesis,control.to_bytes()]{b.extend(v)} b.extend(root_id);b.extend(attempt_id);
 for v in [buyer,collection,asset]{b.extend(v.to_bytes())}b.extend(terms.try_to_vec()?);
 for v in [APPLICATION_FEE_LAMPORTS,operator,project,escrow_rent_reserve]{b.extend(v.to_le_bytes())}Ok(solana_keccak_hasher::hash(&b).0)
}
/// Provider spending is bounded by the quoted budget; rent and prior donations
/// remain held even when the provider charges less than its available budget.
pub fn oracle_expenditure(before:u64,after:u64,budget:u64,reserve:u64)->Result<u64>{
 let floor=before.checked_add(reserve).ok_or(E::Arithmetic)?;
 let upper=floor.checked_add(budget).ok_or(E::Arithmetic)?;
 require!(after>=floor&&after<=upper,E::Conservation);Ok(upper-after)
}
pub fn metadata_hash(name:&str,uri:&str)->Result<[u8;32]>{
 crate::validate_metadata(name,uri)?;let mut b=b"SKVEHM01".to_vec();
 for value in [name,uri]{b.extend((value.len() as u32).to_le_bytes());b.extend(value.as_bytes())}Ok(solana_keccak_hasher::hash(&b).0)
}
pub fn winning(odds:u16,randomness:[u8;32])->Result<bool>{
 require!(u64::from(odds)<=BPS_DENOMINATOR,E::Terms);
 if u64::from(odds)==BPS_DENOMINATOR{return Ok(true)}
 let threshold=(u128::from(odds)<<64)/u128::from(BPS_DENOMINATOR);
 Ok(u128::from(u64::from_le_bytes(randomness[..8].try_into().map_err(|_|E::Arithmetic)?))<threshold)
}
pub fn empty_system(account:&AccountInfo<'_>)->Result<()>{require!(*account.owner==anchor_lang::system_program::ID&&account.data_is_empty()&&!account.executable,E::Capability);Ok(())}
pub fn original(root:&VehicleRoot,root_key:Pubkey,attempt:&VehicleAttempt,attempt_key:Pubkey)->Result<()>{
 require!(root.version==VEHICLE_VERSION&&attempt.version==VEHICLE_VERSION&&root.attempt==attempt_key&&attempt.root==root_key&&root.root_id==attempt.root_id&&root.attempt_id==attempt.attempt_id&&root.buyer==attempt.buyer&&root.asset==attempt.asset&&root.terms_hash==attempt.terms_hash,E::Binding);Ok(())
}

#[cfg(test)]
mod tests{
 use super::*;use anchor_lang::InstructionData;
 fn hex(s:&str)->Vec<u8>{let s=s.trim();(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
 fn terms()->VehicleTerms{VehicleTerms{recipe_version:1,recipe_hash:[1;32],material_hash:[2;32],metadata_hash:[3;32],site:Pubkey::new_from_array([4;32]),operator:Pubkey::new_from_array([5;32]),project:Pubkey::new_from_array([6;32]),oracle_budget:7,odds_bps:8,family:0,tier:1}}
 #[test]fn selected_sdk_full_request_and_callback_vectors_match_production_encoder(){
  let root_id=[0x11;16];let attempt_id=[0x22;16];let payload=core::array::from_fn(|i|i as u8);
  let root=Pubkey::find_program_address(&[ROOT_SEED,&root_id],&crate::ID).0;let attempt=Pubkey::find_program_address(&[ATTEMPT_SEED,&attempt_id],&crate::ID).0;let payer=Pubkey::find_program_address(&[ORACLE_SEED,&root_id],&crate::ID).0;
  let ix=provider_request(root,attempt,root_id,attempt_id,payload,payer).unwrap();
  assert_eq!(ix.data,hex(include_str!("../../../spikes/phase-e-toolchain-vrf/vectors/vehicle-vrf-request-v2.hex")));assert_eq!(ix.program_id,VRF_PROGRAM_ID);
  assert_eq!(ix.accounts,vec![AccountMeta::new(payer,true),AccountMeta::new_readonly(Pubkey::find_program_address(&[b"identity"],&crate::ID).0,true),AccountMeta::new(VRF_QUEUE,false),AccountMeta::new_readonly(anchor_lang::system_program::ID,false),AccountMeta::new_readonly(anchor_lang::solana_program::sysvar::slot_hashes::ID,false)]);
  let randomness=core::array::from_fn(|i|0xa0+i as u8);assert_eq!(crate::instruction::ConsumeVehicleRandomness{randomness,root_id,attempt_id}.data(),hex(include_str!("../../../spikes/phase-e-toolchain-vrf/vectors/vehicle-vrf-callback-v2.hex")));
  assert_eq!(Pubkey::find_program_address(&[b"identity",crate::ID.as_ref()],&VRF_PROGRAM_ID).0.to_string(),"9BcREKyefAixeFpCJXJBuAdxLbrBrPYxTG8fGwAnVP7F");
 }
 #[test]fn odds_use_exact_integer_thresholds_including_total_success(){
  assert!(!winning(0,[0;32]).unwrap());assert!(winning(10000,[255;32]).unwrap());assert!(winning(10001,[0;32]).is_err());
  for odds in [1u16,5000,9999]{let threshold=((u128::from(odds)<<64)/u128::from(BPS_DENOMINATOR)) as u64;let mut below=[0;32];below[..8].copy_from_slice(&(threshold-1).to_le_bytes());assert!(winning(odds,below).unwrap());let mut at=[0;32];at[..8].copy_from_slice(&threshold.to_le_bytes());assert!(!winning(odds,at).unwrap());at[31]=255;assert!(!winning(odds,at).unwrap())}
 }
 #[test]fn fixed_fee_legs_conserve_the_owner_approved_obligation(){let(a,b)=fee_split().unwrap();assert_eq!(a,35_000_000);assert_eq!(b,15_000_000);assert_eq!(a+b,APPLICATION_FEE_LAMPORTS)}
 #[test]fn every_original_term_byte_changes_the_permit_commitment(){
  let original=terms();let args=(Pubkey::new_from_array([7;32]),[8;32],[9;16],[10;16],Pubkey::new_from_array([11;32]),Pubkey::new_from_array([12;32]),Pubkey::new_from_array([13;32]));
  let hash=|terms:&VehicleTerms|terms_hash(args.0,args.1,args.2,args.3,args.4,args.5,args.6,terms,14).unwrap();let expected=hash(&original);let bytes=original.try_to_vec().unwrap();assert_eq!(bytes.len(),208);
  for i in 0..bytes.len(){let mut changed=bytes.clone();changed[i]^=1;let decoded=VehicleTerms::try_from_slice(&changed).unwrap();assert_ne!(hash(&decoded),expected,"byte {i}")}
  assert_ne!(expected,terms_hash(args.0,args.1,[0;16],args.3,args.4,args.5,args.6,&original,14).unwrap());assert_ne!(expected,terms_hash(args.0,args.1,args.2,[0;16],args.4,args.5,args.6,&original,14).unwrap());
 }
 #[test]fn quoted_rent_is_bound_separately_from_the_game_fee(){
  let t=terms();let k=Pubkey::new_from_array([7;32]);let h=|rent|terms_hash(k,[8;32],[9;16],[10;16],k,k,k,&t,rent).unwrap();assert_ne!(h(13),h(14));
 }
 #[test]fn oracle_budget_preserves_rent_and_donations_with_partial_or_no_provider_spend(){
  let reserve=Rent::default().minimum_balance(0);let budget=7;
  for donation in [0,1,reserve-1,reserve,reserve+1]{
   let floor=donation+reserve;
   assert_eq!(oracle_expenditure(donation,floor,budget,reserve).unwrap(),budget);
   assert_eq!(oracle_expenditure(donation,floor+3,budget,reserve).unwrap(),budget-3);
   assert_eq!(oracle_expenditure(donation,floor+budget,budget,reserve).unwrap(),0);
   assert!(oracle_expenditure(donation,floor-1,budget,reserve).is_err());
   assert!(oracle_expenditure(donation,floor+budget+1,budget,reserve).is_err());
  }
  assert!(oracle_expenditure(u64::MAX,0,budget,reserve).is_err());assert!(oracle_expenditure(0,0,u64::MAX,reserve).is_err());
 }
 #[test]fn metadata_is_length_delimited_and_counts_utf8_bytes(){assert_ne!(metadata_hash("ab","c").unwrap(),metadata_hash("a","bc").unwrap());assert!(metadata_hash(&"é".repeat(32),"u").is_ok());assert!(metadata_hash(&"é".repeat(33),"u").is_err());assert!(metadata_hash("n",&"u".repeat(513)).is_err())}
 #[test]fn existing_charter_errors_and_new_vehicle_errors_have_disjoint_stable_codes(){assert_eq!(u32::from(crate::CraftError::Unauthorized),6000);assert_eq!(u32::from(crate::CraftError::CharterNotImplemented),6012);assert_eq!(u32::from(crate::CraftError::Binding),7000);assert_eq!(u32::from(crate::CraftError::TopLevel),7013);}
 #[test]fn permanent_account_sizes_match_the_frozen_exact_reader_contract(){
  assert_eq!(VehicleControl::INIT_SPACE,181);
  let c=VehicleControl{version:1,cluster_genesis:[1;32],current_policy_key:Pubkey::default(),previous_policy_key:Pubkey::default(),previous_valid_until:0,collection:Pubkey::default(),collection_authority:Pubkey::default(),admission_paused:true,escrow_rent_reserve:Rent::default().minimum_balance(0),bump:1,collection_bump:2,authority_bump:3};let mut control=Vec::new();c.try_serialize(&mut control).unwrap();assert_eq!(control.len(),189);assert_eq!(&control[178..186],&c.escrow_rent_reserve.to_le_bytes());assert_eq!(&control[186..],[1,2,3]);assert_eq!(VehicleRoot::INIT_SPACE,162);assert_eq!(VehiclePermitReceipt::INIT_SPACE,162);assert_eq!(VehicleAttempt::INIT_SPACE,549);
  let value=VehicleAttempt{version:1,root:Pubkey::default(),root_id:[0;16],attempt_id:[0;16],buyer:Pubkey::default(),permit_id:[0;16],collection:Pubkey::default(),asset:Pubkey::default(),terms:terms(),terms_hash:[0;32],request_hash:[0;32],application_fee:0,operator_fee:0,project_fee:0,randomness:[0;32],outcome:0,fee_settled:false,minted:false,requested_at:0,request_slot:0,result_slot:0,settlement_slot:0,mint_slot:0,bump:0};let mut bytes=Vec::new();value.try_serialize(&mut bytes).unwrap();assert_eq!(bytes.len(),557);
 }
}
