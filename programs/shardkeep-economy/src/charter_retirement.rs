//! Permanent Charter retirement. Policy authenticates backend member/liability
//! clearance; the program independently enforces identity, consent and finality.
//! No Core mutation, sale payment, reopening or receipt close capability.
use anchor_lang::prelude::*;
use shardkeep_charter_interface as wire;
use crate::{charter_state::*,state::*,permit::{self,PermitArgs},EconomyError as E}; #[cfg(not(feature = "devnet-test"))]
const CRAFT:Pubkey=Pubkey::from_str_const("4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59"); #[cfg(feature = "devnet-test")] const CRAFT:Pubkey=crate::DEVNET_TEST_CRAFT_PROGRAM_ID;
const KIND:u8=9;
#[account] #[derive(InitSpace)]
pub struct CharterRetirementReceipt {
 pub version:u8,pub config:Pubkey,pub retirement_id:[u8;16],pub fence_id:[u8;16],pub clan_id:[u8;16],
 pub charter:Pubkey,pub asset:Pubkey,pub leader:Pubkey,pub prior_revision:u32,pub revision:u32,
 pub clearance_hash:[u8;32],pub permit_id:[u8;16],pub accepted_at:i64,pub bump:u8,
}
#[derive(AnchorSerialize,AnchorDeserialize,Clone)]
pub struct CharterRetirementArgs {
 pub clan_id:[u8;16],pub retirement_id:[u8;16],pub fence_id:[u8;16],pub expected_revision:u32,
 pub clearance_hash:[u8;32],pub permit:PermitArgs,
}
#[derive(Accounts)] #[instruction(args:CharterRetirementArgs)]
pub struct RetireCharter<'info> {
 #[account(mut)] pub leader:Signer<'info>,
 #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,constraint=authority.version==1 @ E::InvalidVersion)]
 pub authority:Box<Account<'info,SeekerAuthority>>,
 #[account(seeds=[b"charter_config"],bump=config.bump,has_one=authority,
  constraint=config.version==1 && config.craft_program==CRAFT && config.craft_control==profile.craft_control.key()
   && config.collection==profile.collection.key() && config.collection_authority==profile.collection_authority.key() @ E::CharterIdentity)]
 pub config:Box<Account<'info,CharterConfig>>,
 #[account(mut,seeds=[b"charter",args.clan_id.as_ref()],bump=charter.bump,has_one=config,
  constraint=charter.version==1 && charter.clan_id==args.clan_id && charter.leader==leader.key()
   && charter.asset==profile.asset.key() && charter.collection==profile.collection.key() @ E::CharterIdentity)]
 pub charter:Box<Account<'info,ClanCharter>>,
 #[account(seeds=[b"charter_asset",profile.asset.key().as_ref()],bump=asset_binding.bump,has_one=charter,
  constraint=asset_binding.version==1 && asset_binding.asset==profile.asset.key() && asset_binding.clan_id==args.clan_id @ E::CharterIdentity)]
 pub asset_binding:Box<Account<'info,CharterAssetBinding>>,
 #[account(init,payer=leader,space=8+CharterRetirementReceipt::INIT_SPACE,seeds=[b"charter_retirement",args.clan_id.as_ref()],bump)]
 pub retirement_receipt:Box<Account<'info,CharterRetirementReceipt>>,
 #[account(init,payer=leader,space=8+PermitReceipt::INIT_SPACE,seeds=[PERMIT_SEED,args.permit.permit_id.as_ref()],bump)]
 pub receipt:Box<Account<'info,PermitReceipt>>,
 pub profile:RetirementProfile<'info>,
 /// CHECK: Fixed native instructions sysvar; permit verifier checks the exact preceding Ed25519 instruction.
 #[account(address=anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions:UncheckedAccount<'info>,
 pub system_program:Program<'info,System>,
}
// Separate Anchor account-validation frame for the two init accounts under the
// pinned SBF stack limit, as in the existing controlled transfer instruction.
#[derive(Accounts)]
pub struct RetirementProfile<'info> {
 /// CHECK: Fixed executable, never invoked by retirement.
 #[account(address=CRAFT,executable)] pub craft_program:UncheckedAccount<'info>,
 /// CHECK: Exact canonical owned control decoded and bound before transition.
 #[account(seeds=[b"charter_control"],bump,seeds::program=CRAFT,owner=CRAFT)] pub craft_control:UncheckedAccount<'info>,
 /// CHECK: Canonical asset checked against clan and strict Core owner/plugin profile.
 pub asset:UncheckedAccount<'info>,
 /// CHECK: Canonical collection and strict Core authority/plugin profile.
 #[account(seeds=[b"charter_collection"],bump,seeds::program=CRAFT)] pub collection:UncheckedAccount<'info>,
 /// CHECK: Canonical collection authority; no signer or CPI capability granted.
 #[account(seeds=[b"charter_collection_authority"],bump,seeds::program=CRAFT)] pub collection_authority:UncheckedAccount<'info>,
 /// CHECK: Canonical per-clan delegate checked in handler; no signer capability granted.
 pub freeze_authority:UncheckedAccount<'info>,
 /// CHECK: Fixed executable Core is only an authenticated identity, never invoked.
 #[account(address=crate::charter_core::CORE_PROGRAM_ID,executable)] pub mpl_core_program:UncheckedAccount<'info>,
}
fn next_revision(charter:&ClanCharter,expected:u32)->Result<u32> {
 require!(charter.state==1 && charter.revision==expected && charter.lock_kind==0 && charter.lock_id==[0;16],E::CharterIdentity);
 expected.checked_add(1).ok_or(error!(E::Arithmetic))
}
pub fn retire(ctx:Context<RetireCharter>,args:CharterRetirementArgs)->Result<()> {
 crate::charter::require_top_level_registration()?;
 require!(ctx.remaining_accounts.is_empty(),E::CharterIdentity);let a=ctx.accounts;
 let revision=next_revision(&a.charter,args.expected_revision)?;
 let control=wire::decode_control(&a.profile.craft_control.try_borrow_data()?).map_err(|_|E::CharterIdentity)?;
 require!(!a.profile.craft_control.executable && control.economy_program==crate::ID.to_bytes()
  && control.collection==a.config.collection.to_bytes() && control.collection_authority==a.config.collection_authority.to_bytes(),E::CharterIdentity);
 require!(!a.authority.admission_paused && !control.admission_paused,E::Paused);
 require!(*a.leader.owner==anchor_lang::system_program::ID && a.leader.data_is_empty() && !a.leader.executable,E::CharterIdentity);
 require!(a.profile.asset.key()==Pubkey::find_program_address(&[b"charter_mint",&args.clan_id],&CRAFT).0
  && a.profile.freeze_authority.key()==Pubkey::find_program_address(&[b"charter_freeze",&args.clan_id],&CRAFT).0,E::CharterIdentity);
 let keys=[a.leader.key(),a.authority.key(),a.config.key(),a.charter.key(),a.asset_binding.key(),a.retirement_receipt.key(),a.receipt.key(),
  a.profile.craft_program.key(),a.profile.craft_control.key(),a.profile.asset.key(),a.profile.collection.key(),a.profile.collection_authority.key(),
  a.profile.freeze_authority.key(),a.profile.mpl_core_program.key(),a.instructions.key(),a.system_program.key()];
 for i in 0..keys.len(){for j in i+1..keys.len(){require!(keys[i]!=keys[j],E::CharterIdentity);}}
 let payload=solana_keccak_hasher::hash(&wire::retirement_preimage(&wire::RetirementCommitment {
  config:a.config.key().to_bytes(),craft_program:CRAFT.to_bytes(),craft_control:a.profile.craft_control.key().to_bytes(),
  collection:a.profile.collection.key().to_bytes(),collection_authority:a.profile.collection_authority.key().to_bytes(),
  charter:a.charter.key().to_bytes(),asset:a.profile.asset.key().to_bytes(),asset_binding:a.asset_binding.key().to_bytes(),
  freeze_authority:a.profile.freeze_authority.key().to_bytes(),receipt:a.retirement_receipt.key().to_bytes(),leader:a.leader.key().to_bytes(),
  clan_id:args.clan_id,retirement_id:args.retirement_id,fence_id:args.fence_id,expected_revision:args.expected_revision,clearance_hash:args.clearance_hash
 }).map_err(|_|E::InvalidPermit)?).0;
 let now=Clock::get()?.unix_timestamp;permit::verify(&a.authority,a.leader.key(),KIND,&args.permit,payload,&a.instructions.to_account_info(),now)?;
 crate::charter_core::verify_charter_core(&a.profile.asset.to_account_info(),&a.profile.collection.to_account_info(),&crate::charter_core::CharterCoreTrust {
  asset:a.profile.asset.key(),collection:a.profile.collection.key(),owner:a.leader.key(),freeze_authority:a.profile.freeze_authority.key(),collection_authority:a.profile.collection_authority.key()
 }).map_err(|_|E::CharterCore)?;
 a.charter.state=2;a.charter.revision=revision;
 a.retirement_receipt.set_inner(CharterRetirementReceipt {version:1,config:a.config.key(),retirement_id:args.retirement_id,fence_id:args.fence_id,
  clan_id:args.clan_id,charter:a.charter.key(),asset:a.profile.asset.key(),leader:a.leader.key(),prior_revision:args.expected_revision,revision,
  clearance_hash:args.clearance_hash,permit_id:args.permit.permit_id,accepted_at:now,bump:ctx.bumps.retirement_receipt});
 permit::consume(&mut a.receipt,a.leader.key(),KIND,&args.permit,payload,now,ctx.bumps.receipt);
 emit!(CharterRetired {receipt:a.retirement_receipt.key(),charter:a.charter.key(),clan_id:args.clan_id,retirement_id:args.retirement_id,
  leader:a.leader.key(),revision,clearance_hash:args.clearance_hash});Ok(())
}
#[event] pub struct CharterRetired {pub receipt:Pubkey,pub charter:Pubkey,pub clan_id:[u8;16],pub retirement_id:[u8;16],pub leader:Pubkey,pub revision:u32,pub clearance_hash:[u8;32]}
#[cfg(test)] mod tests {
 use super::*;
 fn charter()->ClanCharter {ClanCharter {version:1,config:Pubkey::new_unique(),clan_id:[1;16],asset:Pubkey::new_unique(),collection:Pubkey::new_unique(),leader:Pubkey::new_unique(),
  revision:4,state:1,lock_kind:0,lock_id:[0;16],creation_intent_id:[2;16],metadata_hash:[3;32],admission_commitment:[4;32],creation_permit_id:[5;16],created_at:1,bump:255}}
 #[test] fn only_unlocked_active_expected_revision_can_be_retired(){
  let mut c=charter();assert_eq!(next_revision(&c,4).unwrap(),5);assert!(next_revision(&c,3).is_err());
  c.state=2;assert!(next_revision(&c,4).is_err());c.state=0;assert!(next_revision(&c,4).is_err());c.state=1;
  c.lock_kind=1;c.lock_id=[1;16];assert!(next_revision(&c,4).is_err());c.lock_kind=0;assert!(next_revision(&c,4).is_err());
  c.lock_id=[0;16];c.revision=u32::MAX;assert!(next_revision(&c,u32::MAX).is_err());
 }
 #[test] fn permanent_receipt_and_charter_have_exact_preserved_layouts(){
  assert_eq!(8+CharterRetirementReceipt::INIT_SPACE,250);assert_eq!(8+ClanCharter::INIT_SPACE,280);
  let r=CharterRetirementReceipt {version:1,config:Pubkey::new_unique(),retirement_id:[1;16],fence_id:[2;16],clan_id:[3;16],charter:Pubkey::new_unique(),asset:Pubkey::new_unique(),leader:Pubkey::new_unique(),prior_revision:4,revision:5,clearance_hash:[6;32],permit_id:[7;16],accepted_at:123,bump:254};
  let mut bytes=Vec::new();r.try_serialize(&mut bytes).unwrap();assert_eq!(bytes.len(),250);assert_eq!(&bytes[193..225],&[6;32]);
 }
}
