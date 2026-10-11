use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed,sysvar::instructions::{load_current_index_checked,load_instruction_at_checked}};
use crate::{craft_constants::*,vehicle_state::*,vehicle_permit::{self,VehiclePermitArgs},vehicle_protocol::*};
use VehicleError as E;
#[derive(Accounts)]
#[instruction(root_id:[u8;16],attempt_id:[u8;16],terms:VehicleTerms,permit:VehiclePermitArgs)]
pub struct RequestVehicle<'info>{
 #[account(mut)] pub buyer:Signer<'info>,
 #[account(seeds=[VEHICLE_CONTROL_SEED],bump=control.bump,constraint=control.version==VEHICLE_VERSION @ E::Binding)] pub control:Box<Account<'info,VehicleControl>>,
 #[account(init,payer=buyer,space=8+VehicleRoot::INIT_SPACE,seeds=[ROOT_SEED,root_id.as_ref()],bump)] pub root:Box<Account<'info,VehicleRoot>>,
 #[account(init,payer=buyer,space=8+VehicleAttempt::INIT_SPACE,seeds=[ATTEMPT_SEED,attempt_id.as_ref()],bump)] pub attempt:Box<Account<'info,VehicleAttempt>>,
 #[account(init,payer=buyer,space=8+VehiclePermitReceipt::INIT_SPACE,seeds=[RECEIPT_SEED,permit.permit_id.as_ref()],bump)] pub receipt:Box<Account<'info,VehiclePermitReceipt>>,
 /// CHECK: Canonical separate empty System escrow, checked before any transfer.
 #[account(mut,seeds=[APP_SEED,root_id.as_ref()],bump)] pub application_escrow:UncheckedAccount<'info>,
 /// CHECK: Canonical separate empty System escrow, exact budget bounds fixed provider CPI.
 #[account(mut,seeds=[ORACLE_SEED,root_id.as_ref()],bump)] pub oracle_escrow:UncheckedAccount<'info>,
 /// CHECK: Canonical future Core asset, empty System account checked at admission.
 #[account(seeds=[ASSET_SEED,root_id.as_ref()],bump)] pub asset:UncheckedAccount<'info>,
 /// CHECK: Canonical empty System craft identity, only fixed request CPI signs it.
 #[account(seeds=[b"identity"],bump)] pub program_identity:UncheckedAccount<'info>,
 /// CHECK: Fixed provider-owned queue; data interpretation belongs to provider.
 #[account(mut,address=VRF_QUEUE,owner=VRF_PROGRAM_ID)] pub oracle_queue:UncheckedAccount<'info>,
 /// CHECK: Fixed executable provider.
 #[account(address=VRF_PROGRAM_ID,executable)] pub vrf_program:UncheckedAccount<'info>,
 /// CHECK: Fixed native instructions sysvar.
 #[account(address=anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions:UncheckedAccount<'info>,
 /// CHECK: Fixed slot hashes sysvar passed only to fixed provider.
 #[account(address=anchor_lang::solana_program::sysvar::slot_hashes::ID)] pub slot_hashes:UncheckedAccount<'info>,
 pub system_program:Program<'info,System>,
}
pub fn request(ctx:Context<RequestVehicle>,root_id:[u8;16],attempt_id:[u8;16],terms:VehicleTerms,permit:VehiclePermitArgs)->Result<()>{
 require!(ctx.remaining_accounts.is_empty(),E::RemainingAccounts);let a=ctx.accounts;
 require!(!a.control.admission_paused,E::Paused);
 let instructions=a.instructions.to_account_info();let current=load_current_index_checked(&instructions)?;
 require!(load_instruction_at_checked(usize::from(current),&instructions)?.program_id==crate::ID,E::TopLevel);
 require!(root_id!=[0;16]&&attempt_id!=[0;16]&&permit.permit_id!=[0;16]&&terms.recipe_version!=0&&terms.recipe_hash!=[0;32]&&terms.material_hash!=[0;32]&&terms.metadata_hash!=[0;32]&&terms.oracle_budget!=0&&terms.site!=Pubkey::default()&&terms.operator!=Pubkey::default()&&terms.project!=Pubkey::default()&&u64::from(terms.odds_bps)<=BPS_DENOMINATOR&&terms.family<VEHICLE_FAMILY_COUNT&&terms.tier>=VEHICLE_MIN_TIER&&terms.tier<=VEHICLE_MAX_TIER,E::Terms);
 let internals=[a.control.key(),a.root.key(),a.attempt.key(),a.receipt.key(),a.application_escrow.key(),a.oracle_escrow.key(),a.asset.key(),a.program_identity.key(),a.oracle_queue.key(),a.vrf_program.key(),a.instructions.key(),a.slot_hashes.key(),a.system_program.key(),a.control.collection,a.control.collection_authority,crate::ID,mpl_core::ID];
 for external in [a.buyer.key(),terms.site,terms.operator,terms.project]{require!(!internals.contains(&external),E::Alias)}
 // A buyer may own the original quoted site. External recipient aliases are
 // safe because settlement aggregates equal destinations and preserves the full fee.
 for account in [&a.application_escrow.to_account_info(),&a.oracle_escrow.to_account_info(),&a.program_identity.to_account_info(),&a.asset.to_account_info()]{empty_system(account)?}
 require!(!a.oracle_queue.executable,E::Provider);
 let reserve=a.control.escrow_rent_reserve;require!(reserve>=Rent::get()?.minimum_balance(0),E::Conservation);
 let clock=Clock::get()?;let payload=terms_hash(a.control.key(),a.control.cluster_genesis,root_id,attempt_id,a.buyer.key(),a.control.collection,a.asset.key(),&terms,reserve)?;
 vehicle_permit::verify(&a.control,a.buyer.key(),vehicle_permit::VEHICLE_KIND,&permit,payload,&instructions,clock.unix_timestamp)?;
 let ix=provider_request(a.root.key(),a.attempt.key(),root_id,attempt_id,payload,a.oracle_escrow.key())?;let request_hash=solana_keccak_hasher::hash(&ix.data).0;
 let (operator_fee,project_fee)=fee_split()?;
 let app_before=a.application_escrow.lamports();let oracle_before=a.oracle_escrow.lamports();
 let app_funding=APPLICATION_FEE_LAMPORTS.checked_add(reserve).ok_or(E::Arithmetic)?;
 let oracle_funding=terms.oracle_budget.checked_add(reserve).ok_or(E::Arithmetic)?;
 for (target,amount) in [(a.application_escrow.to_account_info(),app_funding),(a.oracle_escrow.to_account_info(),oracle_funding)]{
 anchor_lang::system_program::transfer(CpiContext::new(a.system_program.to_account_info(),anchor_lang::system_program::Transfer{from:a.buyer.to_account_info(),to:target}),amount)?}
 let oracle_bump=[ctx.bumps.oracle_escrow];let identity_bump=[ctx.bumps.program_identity];
 let oracle_seeds:&[&[u8]]=&[ORACLE_SEED,&root_id,&oracle_bump];let identity_seeds:&[&[u8]]=&[b"identity",&identity_bump];
 invoke_signed(&ix,&[a.oracle_escrow.to_account_info(),a.program_identity.to_account_info(),a.oracle_queue.to_account_info(),a.system_program.to_account_info(),a.slot_hashes.to_account_info(),a.vrf_program.to_account_info()],&[oracle_seeds,identity_seeds])?;
 require!(a.application_escrow.lamports()==app_before.checked_add(app_funding).ok_or(E::Arithmetic)?,E::Conservation);
 let oracle_spent=oracle_expenditure(oracle_before,a.oracle_escrow.lamports(),terms.oracle_budget,reserve)?;
 empty_system(&a.oracle_escrow.to_account_info())?;
 a.root.set_inner(VehicleRoot{version:VEHICLE_VERSION,root_id,attempt_id,buyer:a.buyer.key(),attempt:a.attempt.key(),asset:a.asset.key(),terms_hash:payload,bump:ctx.bumps.root});
 a.attempt.set_inner(VehicleAttempt{version:VEHICLE_VERSION,root:a.root.key(),root_id,attempt_id,buyer:a.buyer.key(),permit_id:permit.permit_id,collection:a.control.collection,asset:a.asset.key(),terms,terms_hash:payload,request_hash,application_fee:APPLICATION_FEE_LAMPORTS,operator_fee,project_fee,randomness:[0;32],outcome:0,fee_settled:false,minted:false,requested_at:clock.unix_timestamp,request_slot:clock.slot,result_slot:0,settlement_slot:0,mint_slot:0,bump:ctx.bumps.attempt});
 a.receipt.set_inner(VehiclePermitReceipt{version:VEHICLE_VERSION,permit_id:permit.permit_id,buyer:a.buyer.key(),root:a.root.key(),attempt:a.attempt.key(),payload_hash:payload,expiry:permit.expiry,consumed_at:clock.unix_timestamp,bump:ctx.bumps.receipt});
 emit!(VehicleRequested{root:a.root.key(),attempt:a.attempt.key(),buyer:a.buyer.key(),asset:a.asset.key(),terms_hash:payload,request_hash,application_funded:app_funding,oracle_funded:oracle_funding,escrow_rent_reserve:reserve,oracle_spent,oracle_remaining:a.oracle_escrow.lamports()});Ok(())
}
#[derive(Accounts)]
#[instruction(randomness:[u8;32],root_id:[u8;16],attempt_id:[u8;16])]
pub struct ConsumeVehicleRandomness<'info>{
 #[account(seeds=[b"identity",crate::ID.as_ref()],bump,seeds::program=VRF_PROGRAM_ID)] pub vrf_program_identity:Signer<'info>,
 #[account(seeds=[ROOT_SEED,root_id.as_ref()],bump=root.bump)] pub root:Box<Account<'info,VehicleRoot>>,
 #[account(mut,seeds=[ATTEMPT_SEED,attempt_id.as_ref()],bump=attempt.bump)] pub attempt:Box<Account<'info,VehicleAttempt>>,
}
pub fn consume(ctx:Context<ConsumeVehicleRandomness>,randomness:[u8;32],root_id:[u8;16],attempt_id:[u8;16])->Result<()>{
 require!(ctx.remaining_accounts.is_empty(),E::RemainingAccounts);let a=ctx.accounts;original(&a.root,a.root.key(),&a.attempt,a.attempt.key())?;
 require!(a.attempt.root_id==root_id&&a.attempt.attempt_id==attempt_id,E::Binding);require!(a.attempt.outcome==0&&!a.attempt.fee_settled&&!a.attempt.minted,E::NotPending);
 let payer=Pubkey::find_program_address(&[ORACLE_SEED,&root_id],&crate::ID).0;
 let ix=provider_request(a.root.key(),a.attempt.key(),root_id,attempt_id,a.attempt.terms_hash,payer)?;
 require!(solana_keccak_hasher::hash(&ix.data).0==a.attempt.request_hash,E::Binding);
 a.attempt.outcome=if winning(a.attempt.terms.odds_bps,randomness)?{2}else{1};a.attempt.randomness=randomness;a.attempt.result_slot=Clock::get()?.slot;emit!(VehicleOutcomeRecorded{root:a.root.key(),attempt:a.attempt.key(),randomness,outcome:a.attempt.outcome});Ok(())
}
