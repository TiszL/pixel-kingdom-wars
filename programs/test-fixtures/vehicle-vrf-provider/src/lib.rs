//! SYNTHETIC local test provider. No entropy, oracle network, liveness or failure proof.
//! Never deploy publicly. Its controller chooses test outputs; craft still validates
//! the exact selected request wire and provider-scoped callback capability.
use anchor_lang::{prelude::*,solana_program::{entrypoint::ProgramResult,instruction::{AccountMeta,Instruction},program::{invoke,invoke_signed},program_error::ProgramError}};
const CRAFT:Pubkey=Pubkey::from_str_const("4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59");
const PROVIDER:Pubkey=Pubkey::from_str_const("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const QUEUE:Pubkey=Pubkey::from_str_const("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
#[derive(AnchorSerialize,AnchorDeserialize)]struct Meta{pubkey:Pubkey,is_signer:bool,is_writable:bool}
#[derive(AnchorSerialize,AnchorDeserialize)]struct Request{caller_seed:[u8;32],callback_program_id:Pubkey,callback_discriminator:Vec<u8>,callback_accounts_metas:Vec<Meta>,callback_args:Vec<u8>}
#[cfg(not(feature="no-entrypoint"))]
anchor_lang::solana_program::entrypoint!(process_instruction);
fn check(ok:bool)->ProgramResult{if ok{Ok(())}else{Err(ProgramError::InvalidArgument)}}
fn queue(info:&AccountInfo)->ProgramResult{check(info.key==&QUEUE&&info.owner==&PROVIDER&&!info.executable&&info.data_len()==4096)?;check(&info.try_borrow_data()?[..8]==b"SYNVRF01")}
fn controller(admin:&AccountInfo,q:&AccountInfo)->ProgramResult{queue(q)?;check(admin.is_signer&&admin.key.as_ref()==&q.try_borrow_data()?[8..40])}
fn read_u32(b:&[u8])->std::result::Result<usize,ProgramError>{Ok(u32::from_le_bytes(b.try_into().map_err(|_|ProgramError::InvalidInstructionData)?) as usize)}
fn request_at(data:&[u8],wanted:usize)->std::result::Result<Vec<u8>,ProgramError>{let count=read_u32(&data[49..53])?;check(wanted<count)?;let mut at=53;for n in 0..count{let size=read_u32(data.get(at..at+4).ok_or(ProgramError::InvalidAccountData)?)?;at+=4;let v=data.get(at..at+size).ok_or(ProgramError::InvalidAccountData)?;if n==wanted{return Ok(v.to_vec())}at+=size}Err(ProgramError::InvalidArgument)}
pub fn process_instruction(program:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{
 check(program==&PROVIDER)?;
 if data.first()==Some(&202){check(accounts.len()==15&&accounts[14].key==&CRAFT&&accounts[14].executable)?;let ix=Instruction{program_id:CRAFT,accounts:accounts[..14].iter().map(|a|AccountMeta{pubkey:*a.key,is_signer:a.is_signer,is_writable:a.is_writable}).collect(),data:data[1..].to_vec()};return invoke(&ix,accounts)}
 if data.first()==Some(&200){check(data.len()==10&&accounts.len()==2)?;controller(&accounts[0],&accounts[1])?;check(data[1]<=2)?;let mut b=accounts[1].try_borrow_mut_data()?;b[40]=data[1];b[41..49].copy_from_slice(&data[2..10]);return Ok(())}
 if data.first()==Some(&201){
  check(data.len()==38&&accounts.len()==6)?;controller(&accounts[0],&accounts[1])?;
  let saved=request_at(&accounts[1].try_borrow_data()?,read_u32(&data[1..5])?)?;let mut request=Request::try_from_slice(&saved[8..]).map_err(|_|ProgramError::InvalidInstructionData)?;
  check(accounts[2].key==&CRAFT&&accounts[2].executable&&request.callback_program_id==CRAFT&&request.callback_accounts_metas.len()==2)?;
  for(i,m)in request.callback_accounts_metas.iter().enumerate(){check(accounts[4+i].key==&m.pubkey&&!m.is_signer&&m.is_writable==(i==1))?}
  let mode=data[37];check(mode<=3)?;let scoped:[&[u8];2]=[b"identity",CRAFT.as_ref()];let global:[&[u8];1]=[b"identity"];let seeds=if mode==1{&global[..]}else{&scoped[..]};let(identity,bump)=Pubkey::find_program_address(seeds,&PROVIDER);check(accounts[3].key==&identity)?;
  if mode==2{request.callback_args[0]^=1}let mut callback=request.callback_discriminator;callback.extend(&data[5..37]);callback.extend(request.callback_args);
  let ix=Instruction{program_id:CRAFT,accounts:vec![AccountMeta::new_readonly(identity,mode!=3),AccountMeta::new(*accounts[4].key,false),AccountMeta::new(*accounts[5].key,false)],data:callback};
  // Match saved readonly root rather than grant the callback extra write capability.
  let mut ix=ix;ix.accounts[1].is_writable=false;let bump=[bump];let mut signing=seeds.to_vec();signing.push(&bump);
  return invoke_signed(&ix,&[accounts[3].clone(),accounts[4].clone(),accounts[5].clone(),accounts[2].clone()],&[&signing])
 }
 check(data.len()>=8&&data[..8]==[10,0,0,0,0,0,0,0]&&accounts.len()==5)?;
 let request=Request::try_from_slice(&data[8..]).map_err(|_|ProgramError::InvalidInstructionData)?;check(request.callback_program_id==CRAFT&&request.callback_discriminator.len()==8&&request.callback_accounts_metas.len()==2&&request.callback_args.len()==32)?;
 check(request.callback_discriminator==[0xe2,0x39,0xa1,0x7d,0x61,0x02,0x16,0x14])?;
 let root_id=&request.callback_args[..16];let attempt_id=&request.callback_args[16..];let root=Pubkey::find_program_address(&[b"vehicle_root",root_id],&CRAFT).0;let attempt=Pubkey::find_program_address(&[b"vehicle_attempt",attempt_id],&CRAFT).0;
 for(i,key)in[root,attempt].iter().enumerate(){let m=&request.callback_accounts_metas[i];check(m.pubkey==*key&&!m.is_signer&&m.is_writable==(i==1))?}
 check(accounts[0].key==&Pubkey::find_program_address(&[b"vehicle_oracle",root_id],&CRAFT).0&&accounts[0].is_signer&&accounts[0].is_writable&&accounts[0].owner==&anchor_lang::system_program::ID&&accounts[0].data_is_empty())?;
 check(accounts[1].key==&Pubkey::find_program_address(&[b"identity"],&CRAFT).0&&accounts[1].is_signer&&!accounts[1].is_writable)?;queue(&accounts[2])?;check(accounts[2].is_writable&&accounts[3].key==&anchor_lang::system_program::ID&&accounts[4].key==&anchor_lang::solana_program::sysvar::slot_hashes::ID)?;
 let(mode,charge,count,end)={let b=accounts[2].try_borrow_data()?;let mode=b[40];let charge=u64::from_le_bytes(b[41..49].try_into().unwrap());let count=read_u32(&b[49..53])?;let mut end=53;for _ in 0..count{let len=read_u32(b.get(end..end+4).ok_or(ProgramError::InvalidAccountData)?)?;end+=4+len;check(end<=b.len())?}(mode,charge,count,end)};
 if mode==1{return Err(ProgramError::Custom(9000))}check(end+4+data.len()<=accounts[2].data_len())?;let amount=charge.checked_add(u64::from(mode==2)).ok_or(ProgramError::ArithmeticOverflow)?;
 // Fixed fixture charge comes exclusively from the original oracle escrow.
 let ix=anchor_lang::solana_program::system_instruction::transfer(accounts[0].key,accounts[2].key,amount);invoke(&ix,&[accounts[0].clone(),accounts[2].clone(),accounts[3].clone()])?;
 let mut b=accounts[2].try_borrow_mut_data()?;b[49..53].copy_from_slice(&((count+1) as u32).to_le_bytes());b[end..end+4].copy_from_slice(&(data.len() as u32).to_le_bytes());b[end+4..end+4+data.len()].copy_from_slice(data);Ok(())
}
