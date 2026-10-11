use anchor_lang::prelude::*;
use mpl_core::{accounts::BaseAssetV1,instructions::CreateV1CpiBuilder,types::{Key as CoreKey,UpdateAuthority,DataState}};
use crate::{vehicle_state::*,vehicle_protocol::*,charter_mint::plain_collection};
use VehicleError as E;
#[derive(Accounts)]
#[instruction(root_id:[u8;16])]
pub struct SettleVehicleFee<'info>{
 #[account(seeds=[VEHICLE_CONTROL_SEED],bump=control.bump,constraint=control.version==VEHICLE_VERSION @ E::Binding)] pub control:Account<'info,VehicleControl>,
 #[account(seeds=[ROOT_SEED,root_id.as_ref()],bump=root.bump)] pub root:Account<'info,VehicleRoot>,
 #[account(mut,seeds=[ATTEMPT_SEED,root.attempt_id.as_ref()],bump=attempt.bump)] pub attempt:Account<'info,VehicleAttempt>,
 /// CHECK: Canonical original empty System escrow pays fixed original destinations.
 #[account(mut,seeds=[APP_SEED,root_id.as_ref()],bump)] pub application_escrow:UncheckedAccount<'info>,
 /// CHECK: Original permit-bound recipient, may alias project only.
 #[account(mut,address=attempt.terms.operator)] pub operator:UncheckedAccount<'info>,
 /// CHECK: Original permit-bound recipient, may alias operator only.
 #[account(mut,address=attempt.terms.project)] pub project:UncheckedAccount<'info>,
 pub system_program:Program<'info,System>,
}
pub fn settle(ctx:Context<SettleVehicleFee>,root_id:[u8;16])->Result<()>{
 require!(ctx.remaining_accounts.is_empty(),E::RemainingAccounts);let a=ctx.accounts;original(&a.root,a.root.key(),&a.attempt,a.attempt.key())?;
 require!(a.attempt.root_id==root_id&&(a.attempt.outcome==1||a.attempt.outcome==2),E::Outcome);require!(!a.attempt.fee_settled,E::Settled);
 let escrow=a.application_escrow.to_account_info();empty_system(&escrow)?;require!(a.operator.key()!=escrow.key()&&a.project.key()!=escrow.key()&&a.operator.key()!=a.attempt.key()&&a.project.key()!=a.attempt.key()&&a.operator.key()!=a.root.key()&&a.project.key()!=a.root.key(),E::Alias);
 let(operator_fee,project_fee)=fee_split()?;require!(a.attempt.operator_fee==operator_fee&&a.attempt.project_fee==project_fee&&operator_fee.checked_add(project_fee)==Some(a.attempt.application_fee),E::Binding);
 require!(a.attempt.collection==a.control.collection&&a.attempt.terms_hash==terms_hash(a.control.key(),a.control.cluster_genesis,a.attempt.root_id,a.attempt.attempt_id,a.attempt.buyer,a.attempt.collection,a.attempt.asset,&a.attempt.terms,a.control.escrow_rent_reserve)?,E::Binding);
 let before=escrow.lamports();let operator_before=a.operator.lamports();let project_before=a.project.lamports();let after=remaining_after_fee(before,a.attempt.application_fee,a.control.escrow_rent_reserve)?;
 let bump=[ctx.bumps.application_escrow];let seeds:&[&[u8]]=&[APP_SEED,&root_id,&bump];
 let transfers=if a.operator.key()==a.project.key(){vec![(a.project.to_account_info(),a.attempt.application_fee)]}else{vec![(a.operator.to_account_info(),operator_fee),(a.project.to_account_info(),project_fee)]};
 for(target,amount)in transfers{anchor_lang::system_program::transfer(CpiContext::new_with_signer(a.system_program.to_account_info(),anchor_lang::system_program::Transfer{from:escrow.clone(),to:target},&[seeds]),amount)?}
 require!(escrow.lamports()==after,E::Conservation);
 if a.operator.key()==a.project.key(){require!(a.project.lamports()==project_before.checked_add(a.attempt.application_fee).ok_or(E::Arithmetic)?,E::Conservation)}else{require!(a.operator.lamports()==operator_before.checked_add(operator_fee).ok_or(E::Arithmetic)?&&a.project.lamports()==project_before.checked_add(project_fee).ok_or(E::Arithmetic)?,E::Conservation)}
 a.attempt.fee_settled=true;a.attempt.settlement_slot=Clock::get()?.slot;emit!(VehicleFeeSettled{root:a.root.key(),attempt:a.attempt.key(),buyer:a.attempt.buyer,operator:a.operator.key(),project:a.project.key(),operator_fee,project_fee,escrow_remaining:after});Ok(())
}
/// Neither the immutable rent reserve nor unsolicited donations pay the game fee.
fn remaining_after_fee(before:u64,fee:u64,reserve:u64)->Result<u64>{
 let after=before.checked_sub(fee).ok_or(E::Conservation)?;require!(after>=reserve,E::Conservation);Ok(after)
}
#[derive(Accounts)]
#[instruction(root_id:[u8;16])]
pub struct MintVehicle<'info>{
 #[account(mut,address=attempt.buyer)] pub buyer:Signer<'info>,
 #[account(seeds=[VEHICLE_CONTROL_SEED],bump=control.bump,has_one=collection,has_one=collection_authority,constraint=control.version==VEHICLE_VERSION @ E::Binding)] pub control:Account<'info,VehicleControl>,
 #[account(seeds=[ROOT_SEED,root_id.as_ref()],bump=root.bump)] pub root:Account<'info,VehicleRoot>,
 #[account(mut,seeds=[ATTEMPT_SEED,root.attempt_id.as_ref()],bump=attempt.bump)] pub attempt:Account<'info,VehicleAttempt>,
 /// CHECK: Canonical empty System asset, exact postcondition after Core creation.
 #[account(mut,seeds=[ASSET_SEED,root_id.as_ref()],bump,address=attempt.asset)] pub asset:UncheckedAccount<'info>,
 /// CHECK: Exact plain controlled collection validated before and after Core CPI.
 #[account(mut,seeds=[VEHICLE_COLLECTION_SEED],bump=control.collection_bump,address=attempt.collection)] pub collection:UncheckedAccount<'info>,
 /// CHECK: Canonical empty System capability signs only Core creation.
 #[account(seeds=[VEHICLE_AUTHORITY_SEED],bump=control.authority_bump)] pub collection_authority:UncheckedAccount<'info>,
 /// CHECK: Fixed executable Core program.
 #[account(address=mpl_core::ID,executable)] pub mpl_core_program:UncheckedAccount<'info>,
 pub system_program:Program<'info,System>,
}
pub fn mint(ctx:Context<MintVehicle>,root_id:[u8;16],name:String,uri:String)->Result<()>{
 require!(ctx.remaining_accounts.is_empty(),E::RemainingAccounts);let a=ctx.accounts;original(&a.root,a.root.key(),&a.attempt,a.attempt.key())?;
 require!(a.attempt.root_id==root_id&&a.attempt.outcome==2&&a.attempt.fee_settled,E::Outcome);require!(!a.attempt.minted,E::Minted);require!(metadata_hash(&name,&uri)?==a.attempt.terms.metadata_hash,E::Terms);
 let asset=a.asset.to_account_info();let authority=a.collection_authority.to_account_info();let collection=a.collection.to_account_info();let buyer=a.buyer.to_account_info();let system=a.system_program.to_account_info();empty_system(&asset)?;empty_system(&authority)?;
 let mut after=plain_collection(&collection,authority.key())?;after.num_minted=after.num_minted.checked_add(1).ok_or(E::Arithmetic)?;after.current_size=after.current_size.checked_add(1).ok_or(E::Arithmetic)?;
 let asset_bump=[ctx.bumps.asset];let authority_bump=[a.control.authority_bump];let asset_seeds:&[&[u8]]=&[ASSET_SEED,&root_id,&asset_bump];let authority_seeds:&[&[u8]]=&[VEHICLE_AUTHORITY_SEED,&authority_bump];
 let prefund=asset.lamports();if prefund!=0{anchor_lang::system_program::transfer(CpiContext::new_with_signer(system.clone(),anchor_lang::system_program::Transfer{from:asset.clone(),to:buyer.clone()},&[asset_seeds]),prefund)?}
 CreateV1CpiBuilder::new(&a.mpl_core_program.to_account_info()).asset(&asset).collection(Some(&collection)).authority(Some(&authority)).payer(&buyer).owner(Some(&buyer)).update_authority(None).system_program(&system).data_state(DataState::AccountState).name(name.clone()).uri(uri.clone()).invoke_signed(&[asset_seeds,authority_seeds])?;
 verify_asset(&asset,buyer.key(),collection.key(),&name,&uri)?;require!(*collection.owner==mpl_core::ID&&!collection.executable&&&**collection.try_borrow_data()?==after.try_to_vec()?.as_slice(),crate::CraftError::CollectionPostcondition);
 a.attempt.minted=true;a.attempt.mint_slot=Clock::get()?.slot;emit!(VehicleMinted{root:a.root.key(),attempt:a.attempt.key(),buyer:buyer.key(),asset:asset.key(),collection:collection.key(),metadata_hash:a.attempt.terms.metadata_hash,prefund_returned:prefund});Ok(())
}
pub fn verify_asset(info:&AccountInfo<'_>,owner:Pubkey,collection:Pubkey,name:&str,uri:&str)->Result<()>{
 crate::validate_metadata(name,uri)?;require!(*info.owner==mpl_core::ID&&!info.executable,crate::CraftError::AssetPostcondition);
 let expected=BaseAssetV1{key:CoreKey::AssetV1,owner,update_authority:UpdateAuthority::Collection(collection),name:name.into(),uri:uri.into(),seq:None}.try_to_vec()?;require!(&**info.try_borrow_data()?==expected.as_slice(),crate::CraftError::AssetPostcondition);Ok(())
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn settlement_preserves_immutable_rent_and_even_one_lamport_donations(){
  let fee=crate::craft_constants::APPLICATION_FEE_LAMPORTS;let reserve=Rent::default().minimum_balance(0);
  for donation in [0,1,reserve-1,reserve,reserve+1]{assert_eq!(remaining_after_fee(fee+reserve+donation,fee,reserve).unwrap(),reserve+donation)}
  assert!(remaining_after_fee(fee+reserve-1,fee,reserve).is_err());assert!(remaining_after_fee(fee-1,fee,reserve).is_err());
 }
 #[test]fn issued_core_asset_must_be_exact_plain_and_owned_by_original_buyer(){
  let key=Pubkey::new_unique();let owner=Pubkey::new_unique();let collection=Pubkey::new_unique();let mut rent=1;
  let bytes=BaseAssetV1{key:CoreKey::AssetV1,owner,update_authority:UpdateAuthority::Collection(collection),name:"Local vehicle".into(),uri:"https://invalid.example/vehicle.json".into(),seq:None}.try_to_vec().unwrap();
  let check=|data:&mut[u8],actual_owner:&Pubkey|verify_asset(&AccountInfo::new(&key,false,false,&mut rent,data,actual_owner,false,0),owner,collection,"Local vehicle","https://invalid.example/vehicle.json");
  let mut check=check;assert!(check(&mut bytes.clone(),&mpl_core::ID).is_ok());assert!(check(&mut bytes.clone(),&owner).is_err());for i in 0..bytes.len(){let mut altered=bytes.clone();altered[i]^=1;assert!(check(&mut altered,&mpl_core::ID).is_err(),"byte {i}")}let mut extra=bytes.clone();extra.push(0);assert!(check(&mut extra,&mpl_core::ID).is_err());assert!(check(&mut bytes[..bytes.len()-1].to_vec(),&mpl_core::ID).is_err());
 }
}
