use anchor_lang::prelude::*;
use mpl_core::instructions::CreateCollectionV1CpiBuilder;
use crate::{vehicle_state::*,vehicle_protocol::empty_system,craft_constants::MAX_POLICY_PERMIT_TTL_SEC};
use VehicleError as E;
#[derive(Accounts)]
pub struct InitializeVehicleCollection<'info>{
 #[account(mut)] pub admin:Signer<'info>,
 #[account(constraint=program.programdata_address()?==Some(program_data.key()) @ E::Unauthorized)] pub program:Program<'info,crate::program::ShardkeepCraft>,
 #[account(constraint=program_data.upgrade_authority_address==Some(admin.key()) @ E::Unauthorized)] pub program_data:Account<'info,ProgramData>,
 #[account(init,payer=admin,space=8+VehicleControl::INIT_SPACE,seeds=[VEHICLE_CONTROL_SEED],bump)] pub control:Account<'info,VehicleControl>,
 /// CHECK: Canonical empty System collection, checked before fixed Core CPI.
 #[account(mut,seeds=[VEHICLE_COLLECTION_SEED],bump)] pub collection:UncheckedAccount<'info>,
 /// CHECK: Canonical empty System authority, signs only fixed Core CPI.
 #[account(seeds=[VEHICLE_AUTHORITY_SEED],bump)] pub collection_authority:UncheckedAccount<'info>,
 /// CHECK: Fixed executable Core.
 #[account(address=mpl_core::ID,executable)] pub mpl_core_program:UncheckedAccount<'info>,
 pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
pub struct UpdateVehicleControl<'info>{
 pub admin:Signer<'info>,
 #[account(constraint=program.programdata_address()?==Some(program_data.key()) @ E::Unauthorized)] pub program:Program<'info,crate::program::ShardkeepCraft>,
 #[account(constraint=program_data.upgrade_authority_address==Some(admin.key()) @ E::Unauthorized)] pub program_data:Account<'info,ProgramData>,
 #[account(mut,seeds=[VEHICLE_CONTROL_SEED],bump=control.bump,constraint=control.version==VEHICLE_VERSION @ E::Binding)] pub control:Account<'info,VehicleControl>,
}
pub fn initialize(ctx:Context<InitializeVehicleCollection>,cluster_genesis:[u8;32],policy_key:Pubkey,name:String,uri:String)->Result<()>{
 require!(ctx.remaining_accounts.is_empty(),E::RemainingAccounts);require!(cluster_genesis!=[0;32]&&policy_key!=Pubkey::default(),E::Terms);crate::validate_metadata(&name,&uri)?;
 let a=ctx.accounts;let collection=a.collection.to_account_info();let authority=a.collection_authority.to_account_info();let admin=a.admin.to_account_info();let system=a.system_program.to_account_info();
 empty_system(&collection)?;empty_system(&authority)?;let bump=[ctx.bumps.collection];let seeds:&[&[u8]]=&[VEHICLE_COLLECTION_SEED,&bump];
 let prefund_returned=collection.lamports();if prefund_returned!=0{anchor_lang::system_program::transfer(CpiContext::new_with_signer(system.clone(),anchor_lang::system_program::Transfer{from:collection.clone(),to:admin.clone()},&[seeds]),prefund_returned)?}
 CreateCollectionV1CpiBuilder::new(&a.mpl_core_program.to_account_info()).collection(&collection).update_authority(Some(&authority)).payer(&admin).system_program(&system).name(name.clone()).uri(uri.clone()).invoke_signed(&[seeds])?;
 crate::verify_created_collection(&collection,authority.key(),&name,&uri)?;
 let escrow_rent_reserve=Rent::get()?.minimum_balance(0);
 a.control.set_inner(VehicleControl{version:VEHICLE_VERSION,cluster_genesis,current_policy_key:policy_key,previous_policy_key:Pubkey::default(),previous_valid_until:0,collection:collection.key(),collection_authority:authority.key(),admission_paused:true,escrow_rent_reserve,bump:ctx.bumps.control,collection_bump:ctx.bumps.collection,authority_bump:ctx.bumps.collection_authority});emit!(VehicleCollectionInitialized{admin:admin.key(),collection:collection.key(),collection_authority:authority.key(),prefund_returned,admission_paused:true,escrow_rent_reserve});Ok(())
}
pub fn paused(ctx:Context<UpdateVehicleControl>,paused:bool)->Result<()>{require!(ctx.remaining_accounts.is_empty(),E::RemainingAccounts);ctx.accounts.control.admission_paused=paused;Ok(())}
pub fn rotate(ctx:Context<UpdateVehicleControl>,next_key:Pubkey,previous_valid_until:i64)->Result<()>{
 require!(ctx.remaining_accounts.is_empty(),E::RemainingAccounts);let now=Clock::get()?.unix_timestamp;
 require!(next_key!=Pubkey::default()&&next_key!=ctx.accounts.control.current_policy_key&&previous_valid_until>=now&&previous_valid_until<=now.checked_add(MAX_POLICY_PERMIT_TTL_SEC).ok_or(E::Arithmetic)?,E::Terms);
 let c=&mut ctx.accounts.control;c.previous_policy_key=c.current_policy_key;c.previous_valid_until=previous_valid_until;c.current_policy_key=next_key;Ok(())
}
