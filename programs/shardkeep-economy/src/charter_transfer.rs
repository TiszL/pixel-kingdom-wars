//! D153.175 controlled local Charter transfer; policy is an authenticated assertion,
//! never independent proof of backend member/tournament obligation clearance.
use anchor_lang::{prelude::*, system_program::{self, Transfer}};
use shardkeep_charter_interface as wire;
use crate::{charter_state::*, state::*, permit::{self, PermitArgs}, constants::*, EconomyError as E}; #[cfg(not(feature = "devnet-test"))]
const CRAFT:Pubkey=Pubkey::from_str_const("4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59"); #[cfg(feature = "devnet-test")] const CRAFT:Pubkey=crate::DEVNET_TEST_CRAFT_PROGRAM_ID;
#[account] #[derive(InitSpace)]
pub struct CharterTransferConfig {pub version:u8,pub config:Pubkey,pub treasury:Pubkey,pub royalty_bps:u16,pub bump:u8}
#[account] #[derive(InitSpace)]
pub struct CharterTransferReceipt {
 pub version:u8,pub config:Pubkey,pub transfer_id:[u8;16],pub fence_id:[u8;16],pub clan_id:[u8;16],
 pub charter:Pubkey,pub asset:Pubkey,pub seller:Pubkey,pub buyer:Pubkey,pub treasury:Pubkey,
 pub price_lamports:u64,pub seller_lamports:u64,pub royalty_lamports:u64,pub prior_revision:u32,pub revision:u32,
 pub terms_hash:[u8;32],pub permit_id:[u8;16],pub accepted_at:i64,pub bump:u8,
}
#[derive(AnchorSerialize,AnchorDeserialize,Clone)]
pub struct CharterTransferArgs {pub clan_id:[u8;16],pub transfer_id:[u8;16],pub fence_id:[u8;16],pub expected_revision:u32,pub price_lamports:u64,pub terms_hash:[u8;32],pub permit:PermitArgs}
#[derive(AnchorSerialize,AnchorDeserialize,Clone)]
pub struct CharterLockArgs {pub clan_id:[u8;16],pub lock_id:[u8;16],pub expected_revision:u32,pub terms_hash:[u8;32],pub permit:PermitArgs}
#[derive(Accounts)]
pub struct InitializeCharterTransferConfig<'info> {
 #[account(mut)] pub admin:Signer<'info>,
 #[account(constraint=program.programdata_address()?==Some(program_data.key()) @ E::Unauthorized)] pub program:Program<'info,crate::program::ShardkeepEconomy>,
 #[account(constraint=program_data.upgrade_authority_address==Some(admin.key()) @ E::Unauthorized)] pub program_data:Account<'info,ProgramData>,
 #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,has_one=admin,constraint=authority.version==1 @ E::InvalidVersion)] pub authority:Account<'info,SeekerAuthority>,
 #[account(seeds=[b"charter_config"],bump=config.bump,has_one=authority,constraint=config.version==1 @ E::InvalidVersion)] pub config:Account<'info,CharterConfig>,
 #[account(init,payer=admin,space=8+CharterTransferConfig::INIT_SPACE,seeds=[b"charter_transfer_config"],bump)] pub transfer_config:Account<'info,CharterTransferConfig>,
 pub system_program:Program<'info,System>,
}
#[derive(Accounts)] #[instruction(args:CharterTransferArgs)]
pub struct SettleCharterTransfer<'info> {
 #[account(mut)] pub buyer:Signer<'info>,
 #[account(mut)] pub seller:Signer<'info>,
 #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,constraint=authority.version==1 @ E::InvalidVersion)] pub authority:Box<Account<'info,SeekerAuthority>>,
 #[account(seeds=[b"charter_config"],bump=config.bump,has_one=authority,constraint=config.craft_program==cpi.craft_program.key() && config.craft_control==cpi.craft_control.key() && config.collection==cpi.collection.key() && config.collection_authority==cpi.collection_authority.key() @ E::CharterIdentity,constraint=config.version==1 @ E::InvalidVersion)] pub config:Box<Account<'info,CharterConfig>>,
 #[account(seeds=[b"charter_transfer_config"],bump=transfer_config.bump,has_one=config,has_one=treasury,constraint=transfer_config.version==1 && transfer_config.royalty_bps==CHARTER_ROYALTY_BPS @ E::CharterIdentity)] pub transfer_config:Box<Account<'info,CharterTransferConfig>>,
 #[account(mut,address=transfer_config.treasury)] pub treasury:SystemAccount<'info>,
 #[account(mut,seeds=[b"charter",args.clan_id.as_ref()],bump=charter.bump,has_one=config,constraint=charter.asset==cpi.asset.key() && charter.collection==cpi.collection.key() @ E::CharterIdentity,constraint=charter.version==1 && charter.clan_id==args.clan_id @ E::CharterIdentity)] pub charter:Box<Account<'info,ClanCharter>>,
 #[account(seeds=[b"charter_asset",cpi.asset.key().as_ref()],bump=asset_binding.bump,constraint=asset_binding.asset==cpi.asset.key() @ E::CharterIdentity,has_one=charter,constraint=asset_binding.version==1 && asset_binding.clan_id==args.clan_id @ E::CharterIdentity)] pub asset_binding:Box<Account<'info,CharterAssetBinding>>,
 #[account(init,payer=buyer,space=8+CharterTransferReceipt::INIT_SPACE,seeds=[b"charter_transfer",args.transfer_id.as_ref()],bump)] pub transfer_receipt:Box<Account<'info,CharterTransferReceipt>>,
 #[account(init,payer=buyer,space=8+PermitReceipt::INIT_SPACE,seeds=[PERMIT_SEED,args.permit.permit_id.as_ref()],bump)] pub receipt:Box<Account<'info,PermitReceipt>>,
 /// CHECK: Sole signing capability for the fixed craft executor.
 #[account(seeds=[b"charter_executor",args.clan_id.as_ref()],bump)] pub executor:UncheckedAccount<'info>,
 pub cpi:TransferCpiAccounts<'info>,
 pub system_program:Program<'info,System>,pub economy_program:Program<'info,crate::program::ShardkeepEconomy>,
}
// Keep CPI identity constraints in a separate Anchor frame; the transfer's two
// init accounts otherwise exceed the pinned SBF4KiB stack in try_accounts.
#[derive(Accounts)]
pub struct TransferCpiAccounts<'info> {
 /// CHECK: Fixed craft executable.
 #[account(address=CRAFT,executable)] pub craft_program:UncheckedAccount<'info>,
 /// CHECK: Exact canonical typed control checked before mutation.
 #[account(seeds=[b"charter_control"],bump,seeds::program=CRAFT,owner=CRAFT)] pub craft_control:UncheckedAccount<'info>,
 /// CHECK: Strict Core profile before and after fixed CPI.
 #[account(mut)] pub asset:UncheckedAccount<'info>,
 /// CHECK: Strict Core collection before and after fixed CPI.
 #[account(mut,seeds=[b"charter_collection"],bump,seeds::program=CRAFT)] pub collection:UncheckedAccount<'info>,
 /// CHECK: Canonical craft collection capability; no caller-selected authority.
 #[account(seeds=[b"charter_collection_authority"],bump,seeds::program=CRAFT)] pub collection_authority:UncheckedAccount<'info>,
 /// CHECK: Canonical craft freeze capability.
 pub freeze_authority:UncheckedAccount<'info>,
 /// CHECK: Fixed executable Core.
 #[account(address=crate::charter_core::CORE_PROGRAM_ID,executable)] pub mpl_core_program:UncheckedAccount<'info>,
 /// CHECK: Native instructions sysvar.
 #[account(address=anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions:UncheckedAccount<'info>,
}
#[derive(Accounts)] #[instruction(args:CharterLockArgs)]
pub struct ChangeCharterLock<'info> {
 #[account(mut)] pub leader:Signer<'info>,
 #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,constraint=authority.version==1 @ E::InvalidVersion)] pub authority:Account<'info,SeekerAuthority>,
 #[account(seeds=[b"charter_config"],bump=config.bump,has_one=authority,has_one=craft_control,constraint=config.version==1 @ E::InvalidVersion)] pub config:Account<'info,CharterConfig>,
 #[account(mut,seeds=[b"charter",args.clan_id.as_ref()],bump=charter.bump,has_one=config,constraint=charter.version==1 && charter.clan_id==args.clan_id && charter.leader==leader.key() @ E::CharterIdentity)] pub charter:Account<'info,ClanCharter>,
 /// CHECK: Canonical control's exact bytes and pause checked in handler.
 #[account(seeds=[b"charter_control"],bump,seeds::program=CRAFT,owner=CRAFT)] pub craft_control:UncheckedAccount<'info>,
 #[account(init,payer=leader,space=8+PermitReceipt::INIT_SPACE,seeds=[PERMIT_SEED,args.permit.permit_id.as_ref()],bump)] pub receipt:Account<'info,PermitReceipt>,
 /// CHECK: Native instructions sysvar.
 #[account(address=anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions:UncheckedAccount<'info>,
 pub system_program:Program<'info,System>,
}
pub fn initialize(ctx:Context<InitializeCharterTransferConfig>,treasury:Pubkey)->Result<()> {
 require!(ctx.remaining_accounts.is_empty() && treasury!=Pubkey::default() && treasury!=ctx.accounts.config.key() && treasury!=ctx.accounts.transfer_config.key(),E::CharterIdentity);
 ctx.accounts.transfer_config.set_inner(CharterTransferConfig {version:1,config:ctx.accounts.config.key(),treasury,royalty_bps:CHARTER_ROYALTY_BPS,bump:ctx.bumps.transfer_config});
 emit!(CharterTransferConfigured {config:ctx.accounts.transfer_config.key(),treasury,royalty_bps:CHARTER_ROYALTY_BPS});Ok(())
}
fn open(authority:&SeekerAuthority,config:&CharterConfig,control:&AccountInfo<'_>)->Result<()> {
 require!(config.craft_program==CRAFT && !control.executable,E::CharterIdentity);
 let c=wire::decode_control(&control.try_borrow_data()?).map_err(|_|E::CharterIdentity)?;
 require!(c.economy_program==crate::ID.to_bytes() && c.collection==config.collection.to_bytes() && c.collection_authority==config.collection_authority.to_bytes(),E::CharterIdentity);
 require!(!authority.admission_paused && !c.admission_paused,E::Paused);Ok(())
}
fn next_revision(charter:&ClanCharter,expected:u32)->Result<u32>{require!(charter.state==1 && charter.revision==expected,E::CharterIdentity);expected.checked_add(1).ok_or(error!(E::Arithmetic))}
pub fn change_lock(ctx:Context<ChangeCharterLock>,args:CharterLockArgs,action:u8)->Result<()> {
 crate::charter::require_top_level_registration()?;require!(ctx.remaining_accounts.is_empty(),E::CharterIdentity);let a=ctx.accounts;
 open(&a.authority,&a.config,&a.craft_control.to_account_info())?;let revision=next_revision(&a.charter,args.expected_revision)?;
 if action==1 {require!(a.charter.lock_kind==0 && a.charter.lock_id==[0;16],E::CharterIdentity);}else{require!(action==2 && a.charter.lock_kind==1 && a.charter.lock_id==args.lock_id,E::CharterIdentity);}
 let bytes=wire::lock_preimage(&wire::LockCommitment {config:a.config.key().to_bytes(),charter:a.charter.key().to_bytes(),asset:a.charter.asset.to_bytes(),leader:a.leader.key().to_bytes(),clan_id:args.clan_id,lock_id:args.lock_id,expected_revision:args.expected_revision,action,terms_hash:args.terms_hash}).map_err(|_|E::InvalidPermit)?;
 let payload=solana_keccak_hasher::hash(&bytes).0;let now=Clock::get()?.unix_timestamp;
 permit::verify(&a.authority,a.leader.key(),6,&args.permit,payload,&a.instructions.to_account_info(),now)?;
 a.charter.revision=revision;a.charter.lock_kind=if action==1 {1}else{0};a.charter.lock_id=if action==1 {args.lock_id}else{[0;16]};
 permit::consume(&mut a.receipt,a.leader.key(),6,&args.permit,payload,now,ctx.bumps.receipt);
 emit!(CharterLockChanged {charter:a.charter.key(),leader:a.leader.key(),lock_id:args.lock_id,action,revision,terms_hash:args.terms_hash});Ok(())
}
fn royalty(price:u64)->Result<u64>{require!(price>0,E::CharterIdentity);u64::try_from((price as u128).checked_mul(CHARTER_ROYALTY_BPS as u128).ok_or(E::Arithmetic)?/(BPS_DENOMINATOR as u128)).map_err(|_|error!(E::Arithmetic))}
pub fn settle(ctx:Context<SettleCharterTransfer>,args:CharterTransferArgs)->Result<()> {
 crate::charter::require_top_level_registration()?;require!(ctx.remaining_accounts.is_empty(),E::CharterIdentity);let a=ctx.accounts;
 require!(a.cpi.asset.key()==Pubkey::find_program_address(&[b"charter_mint",&args.clan_id],&CRAFT).0
  && a.cpi.freeze_authority.key()==Pubkey::find_program_address(&[b"charter_freeze",&args.clan_id],&CRAFT).0,E::CharterIdentity);
 open(&a.authority,&a.config,&a.cpi.craft_control.to_account_info())?;let revision=next_revision(&a.charter,args.expected_revision)?;
 require!(a.charter.leader==a.seller.key() && a.charter.lock_kind==0 && a.charter.lock_id==[0;16],E::CharterIdentity);
 for wallet in [a.buyer.to_account_info(),a.seller.to_account_info(),a.treasury.to_account_info()] {require!(*wallet.owner==system_program::ID && wallet.data_is_empty() && !wallet.executable,E::CharterIdentity);}
 let keys=[a.buyer.key(),a.seller.key(),a.treasury.key(),a.authority.key(),a.config.key(),a.transfer_config.key(),a.charter.key(),a.asset_binding.key(),a.transfer_receipt.key(),a.receipt.key(),a.executor.key(),a.cpi.craft_program.key(),a.cpi.craft_control.key(),a.cpi.asset.key(),a.cpi.collection.key(),a.cpi.collection_authority.key(),a.cpi.freeze_authority.key(),a.cpi.mpl_core_program.key(),a.cpi.instructions.key(),a.system_program.key(),a.economy_program.key()];
 for i in 0..keys.len(){for j in i+1..keys.len(){require!(keys[i]!=keys[j],E::CharterIdentity);}}
 let royalty_lamports=royalty(args.price_lamports)?;let seller_lamports=args.price_lamports.checked_sub(royalty_lamports).ok_or(E::Arithmetic)?;
 let payload=solana_keccak_hasher::hash(&wire::transfer_preimage(&wire::TransferCommitment {
 config:a.config.key().to_bytes(),transfer_config:a.transfer_config.key().to_bytes(),craft_program:CRAFT.to_bytes(),craft_control:a.cpi.craft_control.key().to_bytes(),collection:a.cpi.collection.key().to_bytes(),collection_authority:a.cpi.collection_authority.key().to_bytes(),charter:a.charter.key().to_bytes(),asset:a.cpi.asset.key().to_bytes(),asset_binding:a.asset_binding.key().to_bytes(),freeze_authority:a.cpi.freeze_authority.key().to_bytes(),executor:a.executor.key().to_bytes(),receipt:a.transfer_receipt.key().to_bytes(),seller:a.seller.key().to_bytes(),buyer:a.buyer.key().to_bytes(),treasury:a.treasury.key().to_bytes(),clan_id:args.clan_id,transfer_id:args.transfer_id,fence_id:args.fence_id,expected_revision:args.expected_revision,price_lamports:args.price_lamports,royalty_bps:CHARTER_ROYALTY_BPS,terms_hash:args.terms_hash}).map_err(|_|E::InvalidPermit)?).0;
 let now=Clock::get()?.unix_timestamp;permit::verify(&a.authority,a.buyer.key(),1,&args.permit,payload,&a.cpi.instructions.to_account_info(),now)?;
 core(a,a.seller.key())?;execute(a,&args,ctx.bumps.executor)?;core(a,a.buyer.key())?;
 system_program::transfer(CpiContext::new(a.system_program.to_account_info(),Transfer {from:a.buyer.to_account_info(),to:a.seller.to_account_info()}),seller_lamports)?;
 if royalty_lamports>0 {system_program::transfer(CpiContext::new(a.system_program.to_account_info(),Transfer {from:a.buyer.to_account_info(),to:a.treasury.to_account_info()}),royalty_lamports)?;}
 a.charter.leader=a.buyer.key();a.charter.revision=revision;
 a.transfer_receipt.set_inner(CharterTransferReceipt {version:1,config:a.transfer_config.key(),transfer_id:args.transfer_id,fence_id:args.fence_id,clan_id:args.clan_id,charter:a.charter.key(),asset:a.cpi.asset.key(),seller:a.seller.key(),buyer:a.buyer.key(),treasury:a.treasury.key(),price_lamports:args.price_lamports,seller_lamports,royalty_lamports,prior_revision:args.expected_revision,revision,terms_hash:args.terms_hash,permit_id:args.permit.permit_id,accepted_at:now,bump:ctx.bumps.transfer_receipt});
 permit::consume(&mut a.receipt,a.buyer.key(),1,&args.permit,payload,now,ctx.bumps.receipt);
 emit!(CharterTransferred {receipt:a.transfer_receipt.key(),charter:a.charter.key(),transfer_id:args.transfer_id,seller:a.seller.key(),buyer:a.buyer.key(),price_lamports:args.price_lamports,seller_lamports,royalty_lamports,revision});Ok(())
}
fn core(a:&SettleCharterTransfer<'_>,owner:Pubkey)->Result<()>{crate::charter_core::verify_charter_core(&a.cpi.asset.to_account_info(),&a.cpi.collection.to_account_info(),&crate::charter_core::CharterCoreTrust {asset:a.cpi.asset.key(),collection:a.cpi.collection.key(),owner,freeze_authority:a.cpi.freeze_authority.key(),collection_authority:a.cpi.collection_authority.key()}).map_err(|_|error!(E::CharterCore))}
#[inline(never)] fn execute(a:&SettleCharterTransfer<'_>,args:&CharterTransferArgs,bump:u8)->Result<()> {
 use anchor_lang::solana_program::{instruction::{Instruction,AccountMeta},program::invoke_signed};
 let infos=vec![a.seller.to_account_info(),a.buyer.to_account_info(),a.executor.to_account_info(),a.economy_program.to_account_info(),a.cpi.craft_control.to_account_info(),a.charter.to_account_info(),a.cpi.asset.to_account_info(),a.cpi.collection.to_account_info(),a.cpi.collection_authority.to_account_info(),a.cpi.freeze_authority.to_account_info(),a.cpi.mpl_core_program.to_account_info(),a.system_program.to_account_info(),a.cpi.craft_program.to_account_info()];
 let accounts=infos[..12].iter().enumerate().map(|(i,v)|if [0,1,6,7].contains(&i){AccountMeta::new(*v.key,i==0||i==1)}else{AccountMeta::new_readonly(*v.key,i==2)}).collect();
 let ix=Instruction {program_id:CRAFT,accounts,data:wire::encode_transfer(args.clan_id,args.expected_revision).map_err(|_|E::InvalidPermit)?};
 invoke_signed(&ix,&infos,&[&[b"charter_executor",&args.clan_id,&[bump]]])?;Ok(())
}
#[event] pub struct CharterTransferConfigured {pub config:Pubkey,pub treasury:Pubkey,pub royalty_bps:u16}
#[event] pub struct CharterLockChanged {pub charter:Pubkey,pub leader:Pubkey,pub lock_id:[u8;16],pub action:u8,pub revision:u32,pub terms_hash:[u8;32]}
#[event] pub struct CharterTransferred {pub receipt:Pubkey,pub charter:Pubkey,pub transfer_id:[u8;16],pub seller:Pubkey,pub buyer:Pubkey,pub price_lamports:u64,pub seller_lamports:u64,pub royalty_lamports:u64,pub revision:u32}
#[cfg(test)] mod tests {use super::*;#[test]fn royalty_conserves_maximum_price_and_dust(){for p in [1,19,20,101,u64::MAX]{let r=royalty(p).unwrap();assert_eq!(r as u128,(p as u128)*500/10000);assert_eq!(p-r+r,p);}assert!(royalty(0).is_err());}}
