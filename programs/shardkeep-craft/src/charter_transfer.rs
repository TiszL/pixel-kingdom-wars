//! Only the canonical economy executor can atomically thaw, transfer, refreeze.
use anchor_lang::prelude::*;
use mpl_core::{instructions::{TransferV1CpiBuilder,UpdatePluginV1CpiBuilder},types::{Plugin,PermanentFreezeDelegate}};
use shardkeep_charter_interface as wire;
use crate::{CharterControl,CraftError as E,ECONOMY_PROGRAM_ID,CONFIG_SEED,COLLECTION_SEED,COLLECTION_AUTHORITY_SEED};
#[derive(Accounts)] #[instruction(clan_id:[u8;16])]
pub struct ExecuteCharterTransfer<'info> {
 #[account(mut)] pub seller:Signer<'info>,#[account(mut)] pub buyer:Signer<'info>,
 #[account(seeds=[b"charter_executor",clan_id.as_ref()],bump,seeds::program=ECONOMY_PROGRAM_ID)] pub executor:Signer<'info>,
 /// CHECK: Fixed executable owner of registry and signer capability.
 #[account(address=ECONOMY_PROGRAM_ID,executable)] pub economy_program:UncheckedAccount<'info>,
 #[account(seeds=[CONFIG_SEED],bump=config.bump,has_one=economy_program,has_one=collection,has_one=collection_authority,constraint=config.version==1 @ E::InvalidCharter)] pub config:Account<'info,CharterControl>,
 /// CHECK: Canonical bounded economy account is fully decoded in handler.
 #[account(seeds=[b"charter",clan_id.as_ref()],bump,seeds::program=ECONOMY_PROGRAM_ID,owner=ECONOMY_PROGRAM_ID)] pub charter:UncheckedAccount<'info>,
 /// CHECK: Canonical Core asset, exact strict profile before/after.
 #[account(mut,seeds=[b"charter_mint",clan_id.as_ref()],bump)] pub asset:UncheckedAccount<'info>,
 /// CHECK: Exact unchanged plain controlled collection.
 #[account(mut,seeds=[COLLECTION_SEED],bump=config.collection_bump)] pub collection:UncheckedAccount<'info>,
 /// CHECK: Canonical capability, never signed for collection mutations here.
 #[account(seeds=[COLLECTION_AUTHORITY_SEED],bump=config.authority_bump)] pub collection_authority:UncheckedAccount<'info>,
 /// CHECK: Canonical freeze capability, signed only around fixed Core CPIs.
 #[account(seeds=[b"charter_freeze",clan_id.as_ref()],bump)] pub freeze_authority:UncheckedAccount<'info>,
 /// CHECK: Fixed executable Core.
 #[account(address=mpl_core::ID,executable)] pub mpl_core_program:UncheckedAccount<'info>,
 pub system_program:Program<'info,System>,
}
// Read only the bounded metadata; the reused exact profile verifier then checks
// every byte, including owner/collection, seq=None and the single frozen plugin.
fn metadata(data:&[u8])->Result<(String,String)>{
 let mut at=66usize;let mut values=Vec::with_capacity(2);
 for maximum in [wire::MAX_NAME_BYTES,wire::MAX_URI_BYTES]{
  let n=u32::from_le_bytes(data.get(at..at+4).ok_or(E::AssetPostcondition)?.try_into().map_err(|_|E::AssetPostcondition)?) as usize;at+=4;
  require!(n>0 && n<=maximum,E::AssetPostcondition);let end=at.checked_add(n).ok_or(E::Arithmetic)?;
  values.push(core::str::from_utf8(data.get(at..end).ok_or(E::AssetPostcondition)?).map_err(|_|E::AssetPostcondition)?.to_owned());at=end;
 }
 Ok((values.remove(0),values.remove(0)))
}
pub fn execute(ctx:Context<ExecuteCharterTransfer>,clan_id:[u8;16],expected_revision:u32)->Result<()> {
 require!(ctx.remaining_accounts.is_empty(),E::RemainingAccounts);let a=ctx.accounts;
 require!(!a.config.admission_paused,E::AdmissionPaused);require!(a.seller.key()!=a.buyer.key(),E::InvalidCharter);
 for wallet in [a.seller.to_account_info(),a.buyer.to_account_info()] {require!(*wallet.owner==anchor_lang::system_program::ID && wallet.data_is_empty() && !wallet.executable,E::InvalidCharter);}
 let c=wire::decode_charter(&a.charter.try_borrow_data()?).map_err(|_|E::InvalidCharter)?;
 require!(!a.charter.executable && c.config==Pubkey::find_program_address(&[b"charter_config"],&ECONOMY_PROGRAM_ID).0.to_bytes()
  && c.clan_id==clan_id && c.asset==a.asset.key().to_bytes() && c.collection==a.collection.key().to_bytes()
  && c.leader==a.seller.key().to_bytes() && c.revision==expected_revision && c.state==wire::CharterState::Active
  && c.lock==wire::CharterLock::None && c.lock_id==[0;16] && c.bump==ctx.bumps.charter,E::InvalidCharter);
 let asset=a.asset.to_account_info();let collection=a.collection.to_account_info();let freeze=a.freeze_authority.to_account_info();
 let buyer=a.buyer.to_account_info();let seller=a.seller.to_account_info();let core=a.mpl_core_program.to_account_info();let system=a.system_program.to_account_info();
 require!(*freeze.owner==anchor_lang::system_program::ID && freeze.data_is_empty() && !freeze.executable,E::InvalidAuthority);
 crate::charter_mint::plain_collection(&collection,a.collection_authority.key())?;
 let collection_before=collection.try_borrow_data()?.to_vec();
 let (name,uri)=metadata(&asset.try_borrow_data()?)?;
 crate::charter_mint::verify_created_asset(&asset,seller.key(),collection.key(),freeze.key(),&name,&uri)?;
 require!(solana_keccak_hasher::hash(&wire::metadata_preimage(&name,&uri).map_err(|_|E::InvalidMetadata)?).0==c.metadata_hash,E::InvalidMetadata);
 let bump=[ctx.bumps.freeze_authority];let seeds:&[&[u8]]=&[b"charter_freeze",&clan_id,&bump];
 UpdatePluginV1CpiBuilder::new(&core).asset(&asset).collection(Some(&collection)).payer(&buyer).authority(Some(&freeze)).system_program(&system)
  .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate {frozen:false})).invoke_signed(&[seeds])?;
 TransferV1CpiBuilder::new(&core).asset(&asset).collection(Some(&collection)).payer(&buyer).authority(Some(&seller)).new_owner(&buyer).system_program(Some(&system)).invoke()?;
 UpdatePluginV1CpiBuilder::new(&core).asset(&asset).collection(Some(&collection)).payer(&buyer).authority(Some(&freeze)).system_program(&system)
  .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate {frozen:true})).invoke_signed(&[seeds])?;
 crate::charter_mint::verify_created_asset(&asset,buyer.key(),collection.key(),freeze.key(),&name,&uri)?;
 require!(*collection.owner==mpl_core::ID && !collection.executable && &**collection.try_borrow_data()?==collection_before.as_slice(),E::CollectionPostcondition);
 Ok(())
}
#[cfg(test)]mod tests {use super::*;use anchor_lang::InstructionData;
 #[test]fn generated_craft_instruction_matches_shared_exact_codec(){let id=[0x12,0x34,0x56,0x78,0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0,0x12,0x34,0x56,0x78];assert_eq!(crate::instruction::ExecuteCharterTransfer {clan_id:id,expected_revision:19}.data(),wire::encode_transfer(id,19).unwrap());}
}
