#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_is_nonnegative_exact_and_never_resets_at_fragment_boundaries() {
        for cursor in 0..MINING_SPLIT_PERIOD as u8 {
            for gross in 0..101 {
                let all = split_gross(cursor, gross).unwrap();
                assert_eq!(all.player + all.recycle + all.tax, gross);
                for first in 0..=gross {
                    let a = split_gross(cursor, first).unwrap();
                    let b = split_gross(a.end, gross - first).unwrap();
                    assert_eq!((a.player+b.player,a.recycle+b.recycle,a.tax+b.tax,b.end),
                        (all.player,all.recycle,all.tax,all.end));
                }
            }
        }
        let huge = split_gross(9, u64::MAX).unwrap();
        assert_eq!(huge.player.checked_add(huge.recycle).unwrap().checked_add(huge.tax).unwrap(), u64::MAX);
        assert!(split_gross(MINING_SPLIT_PERIOD as u8, 1).is_err());
    }
    #[test]
    fn each_cohort_has_its_own_gross_ceiling_and_rounding_is_funded() {
        let free = MINING_GROSS_DAILY_CEILING_BASE_UNITS / BPS_DENOMINATOR * MINING_FREE_POOL_BPS;
        let deed = MINING_GROSS_DAILY_CEILING_BASE_UNITS / BPS_DENOMINATOR * MINING_DEED_POOL_BPS;
        assert_eq!(check_gross(MINING_GROSS_DAILY_CEILING_BASE_UNITS,free,deed).unwrap(), MINING_GROSS_DAILY_CEILING_BASE_UNITS);
        assert!(check_gross(MINING_GROSS_DAILY_CEILING_BASE_UNITS,free+1,0).is_err()); assert!(check_gross(MINING_GROSS_DAILY_CEILING_BASE_UNITS,0,deed+1).is_err());
        assert!(check_gross(100,6,0).is_err());assert!(check_gross(100,0,96).is_err());
        assert_eq!(check_gross(101,5,96).unwrap(),101);assert!(check_gross(0,0,0).is_err());
        let last = split_gross(9,1).unwrap(); assert_eq!((last.player,last.recycle,last.tax,last.end),(0,0,1,0));
    }
    #[test]
    fn paid_counter_violations_are_not_saturated_into_surplus() {
        let mut c = EconomyConfig { total_published_highwater:8,total_claimed:3,tax_highwater:4,tax_paid:1,..Default::default() };
        assert_eq!(liability_floor(&c).unwrap(),8);
        c.total_claimed=9; assert!(liability_floor(&c).is_err());
        c.total_claimed=3;c.tax_paid=5;assert!(liability_floor(&c).is_err());
        c.total_claimed=0;c.tax_paid=0;c.total_published_highwater=u64::MAX;assert!(liability_floor(&c).is_err());
    }
    #[test]
    fn revoke_preserves_funding_tax_recycle_and_cursor_until_explicit_correction() {
        let mut c=EconomyConfig { latest_sequence:3,latest_day:12,total_published:80,total_published_highwater:80,
            tax_highwater:10,recycled_total:10,gross_published:100,split_cursor:7,..Default::default() };
        let mut r=AllocationRoot { sequence:3,day:12,prev_day:11,prev_total:50,total_cumulative:80,..Default::default() };
        revoke_frontier(&mut c,&mut r).unwrap();
        assert!(r.revoked && c.correction_pending);
        assert_eq!((c.latest_sequence,c.latest_day,c.total_published),(3,11,50));
        assert_eq!((c.total_published_highwater,c.tax_highwater,c.recycled_total,c.gross_published,c.split_cursor),(80,10,10,100,7));
        assert!(revoke_frontier(&mut c,&mut r).is_err());
        c.correction_pending=false;r.revoked=false;r.claims_count=1;assert!(revoke_frontier(&mut c,&mut r).is_err());
        r.claims_count=0;r.sequence=2;assert!(revoke_frontier(&mut c,&mut r).is_err());
    }
}

use anchor_lang::prelude::*;
use anchor_spl::{associated_token::{self,AssociatedToken,Create,get_associated_token_address_with_program_id},
    token::{self,Mint,Token,TokenAccount,TransferChecked,spl_token::state::AccountState}};
use crate::{constants::*,mining_state::*,state::{SeekerAuthority,AUTHORITY_SEED,VERSION},EconomyError as E};

#[derive(Debug,PartialEq,Eq)]
pub struct GrossSplit { pub player:u64,pub recycle:u64,pub tax:u64,pub end:u8 }
/// A single persistent 8-player/1-recycle/1-tax stream. Quotients handle huge
/// amounts; at most nine individual units remain. No per-day floor subtraction.
pub fn split_gross(cursor:u8,gross:u64)->Result<GrossSplit>{
    require!(MINING_SPLIT_PLAYER_UNITS+MINING_SPLIT_RECYCLE_UNITS+MINING_SPLIT_TAX_UNITS==MINING_SPLIT_PERIOD
        && MINING_SPLIT_PERIOD>0 && MINING_SPLIT_PERIOD<=u8::MAX as u64 && u64::from(cursor)<MINING_SPLIT_PERIOD,E::InvalidPolicy);
    let cycles=gross/MINING_SPLIT_PERIOD;
    let mut out=GrossSplit{player:cycles.checked_mul(MINING_SPLIT_PLAYER_UNITS).ok_or(E::Arithmetic)?,
        recycle:cycles.checked_mul(MINING_SPLIT_RECYCLE_UNITS).ok_or(E::Arithmetic)?,
        tax:cycles.checked_mul(MINING_SPLIT_TAX_UNITS).ok_or(E::Arithmetic)?,end:cursor};
    for _ in 0..gross%MINING_SPLIT_PERIOD {
        let counter=if u64::from(out.end)<MINING_SPLIT_PLAYER_UNITS {&mut out.player}
            else if u64::from(out.end)<MINING_SPLIT_PLAYER_UNITS+MINING_SPLIT_RECYCLE_UNITS {&mut out.recycle}else{&mut out.tax};
        *counter=counter.checked_add(1).ok_or(E::Arithmetic)?;
        out.end=((u64::from(out.end)+1)%MINING_SPLIT_PERIOD) as u8;
    }
    require!(out.player.checked_add(out.recycle).and_then(|v|v.checked_add(out.tax))==Some(gross),E::Arithmetic);Ok(out)
}
pub fn check_gross(budget:u64,free:u64,deed:u64)->Result<u64>{
    require!(MINING_FREE_POOL_BPS+MINING_DEED_POOL_BPS==BPS_DENOMINATOR,E::InvalidPolicy);
    require!(budget>0&&budget<=MINING_GROSS_DAILY_CEILING_BASE_UNITS,E::Configuration);
    let free_cap=u64::try_from(u128::from(budget).checked_mul(u128::from(MINING_FREE_POOL_BPS)).ok_or(E::Arithmetic)?/u128::from(BPS_DENOMINATOR)).map_err(|_|error!(E::Arithmetic))?;
    let deed_cap=budget.checked_sub(free_cap).ok_or(E::Arithmetic)?;
    require!(free<=free_cap&&deed<=deed_cap,E::Configuration);
    let gross=free.checked_add(deed).ok_or(E::Arithmetic)?;require!(gross<=budget,E::Configuration);Ok(gross)
}
pub fn liability_floor(config:&EconomyConfig)->Result<u64>{
    config.total_published_highwater.checked_sub(config.total_claimed)
        .and_then(|player|config.tax_highwater.checked_sub(config.tax_paid).and_then(|tax|player.checked_add(tax)))
        .ok_or_else(||error!(E::Backing))
}
pub fn validate_mining_ata(account:&Account<TokenAccount>,owner:Pubkey,mint:Pubkey)->Result<()>{
    require_keys_eq!(*account.to_account_info().owner,token::ID,E::Token);
    require_keys_eq!(account.key(),get_associated_token_address_with_program_id(&owner,&mint,&token::ID),E::Token);
    require!(account.owner==owner&&account.mint==mint&&account.state==AccountState::Initialized
        && account.delegate.is_none()&&account.close_authority.is_none(),E::Token);Ok(())
}
fn validate_vaults(config:&Account<EconomyConfig>,vault:&Account<TokenAccount>,reserve:&Account<TokenAccount>)->Result<()>{
    require!(config.version==MINING_VERSION,E::InvalidVersion);
    require_keys_eq!(vault.key(),config.mining_vault,E::Identity);require_keys_eq!(reserve.key(),config.emission_reserve_ata,E::Identity);
    require!(vault.key()!=reserve.key(),E::Identity);
    validate_mining_ata(vault,config.key(),config.keep_mint)?;
    validate_mining_ata(reserve,config.emission_reserve_owner,config.keep_mint)
}
fn chain_day(now:i64)->Result<u64>{
    require!(now>=0&&MINING_DAY_SEC>0,E::Time);Ok((now/MINING_DAY_SEC) as u64)
}
fn authorize_publication(config:&EconomyConfig,authority:&SeekerAuthority,signer:Pubkey,kind:u8,day:u64)->Result<()>{
    require!(config.flags&PUBLISH_PAUSED==0,E::Paused);
    match kind {
        0=>{require_keys_eq!(signer,config.publisher,E::Unauthorized);
            require!(day.checked_sub(config.latest_day).ok_or(E::Time)?<=MINING_PUBLISHER_MAX_GAP_DAYS,E::Time);},
        2=>require_keys_eq!(signer,authority.admin,E::Unauthorized),
        _=>return err!(E::Configuration),
    }Ok(())
}
fn validate_commitment(root:[u8;32],leaves:u32)->Result<()>{
    require!(root!=[0;32]&&leaves>0&&leaves<=MINING_MAX_LEAVES,E::Configuration);Ok(())
}
fn write_root(root:&mut AllocationRoot,config:Pubkey,epoch:Pubkey,args:&CorrectMiningArgs,day:u64,prev_day:u64,prev_total:u64,now:i64,bump:u8){
    root.version=MINING_VERSION;root.config=config;root.epoch=epoch;root.sequence=args.sequence;root.day=day;
    root.prev_day=prev_day;root.prev_total=prev_total;root.root=args.root;root.total_cumulative=args.total_cumulative;
    root.leaf_count=args.leaf_count;root.claims_count=0;root.published_at=now;root.revoked=false;root.kind=args.kind;root.bump=bump;
}
fn transfer_reserve<'info>(config:&Account<'info,EconomyConfig>,vault:&mut Account<'info,TokenAccount>,reserve:&mut Account<'info,TokenAccount>,mint:&Account<'info,Mint>,program:&Program<'info,Token>,amount:u64)->Result<()>{
    validate_vaults(config,vault,reserve)?;
    require_keys_eq!(mint.key(),config.keep_mint,E::Token);require!(mint.decimals==config.decimals,E::Token);
    let before=vault.amount;let dest=reserve.amount;
    let after=before.checked_sub(amount).ok_or(E::Backing)?;let expected_dest=dest.checked_add(amount).ok_or(E::Arithmetic)?;
    require!(after>=liability_floor(config)?,E::Backing);
    if amount>0 {
        let bump=[config.bump];let seeds:&[&[u8]]=&[ECONOMY_SEED,&bump];
        token::transfer_checked(CpiContext::new_with_signer(program.to_account_info(),TransferChecked{
            from:vault.to_account_info(),mint:mint.to_account_info(),to:reserve.to_account_info(),authority:config.to_account_info()},&[seeds]),amount,config.decimals)?;
    }
    vault.reload()?;reserve.reload()?;validate_vaults(config,vault,reserve)?;
    require!(vault.amount==after&&reserve.amount==expected_dest&&vault.amount>=liability_floor(config)?,E::Backing);Ok(())
}

#[derive(AnchorSerialize,AnchorDeserialize,Clone)]
pub struct PublishMiningArgs {
    pub sequence:u64,pub day:u64,pub kind:u8,pub root:[u8;32],pub total_cumulative:u64,pub leaf_count:u32,
    pub budget_gross:u64,pub free_gross:u64,pub deed_gross:u64,pub source_hash:[u8;32],pub tax_commitment:[u8;32],pub tax_version:u16,
}
#[derive(AnchorSerialize,AnchorDeserialize,Clone)]
pub struct CorrectMiningArgs {pub sequence:u64,pub root:[u8;32],pub total_cumulative:u64,pub leaf_count:u32,pub kind:u8}

#[derive(Accounts)]
pub struct InitializeEconomy<'info>{
    #[account(mut)] pub admin:Signer<'info>,
    pub upgrade_authority:Signer<'info>,
    #[account(constraint=program.programdata_address()?==Some(program_data.key()) @ E::Unauthorized)]
    pub program:Program<'info,crate::program::ShardkeepEconomy>,
    #[account(constraint=program_data.upgrade_authority_address==Some(upgrade_authority.key()) @ E::Unauthorized)]
    pub program_data:Account<'info,ProgramData>,
    #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,has_one=admin,constraint=authority.version==VERSION @ E::InvalidVersion)]
    pub authority:Account<'info,SeekerAuthority>,
    #[account(init,payer=admin,space=8+EconomyConfig::INIT_SPACE,seeds=[ECONOMY_SEED],bump)]
    pub config:Account<'info,EconomyConfig>,
    pub mint:Account<'info,Mint>,
    /// CHECK: Immutable reserve owner; exact canonical ATA validated at initialization.
    pub reserve_owner:UncheckedAccount<'info>,
    pub reserve_ata:Account<'info,TokenAccount>,
    /// CHECK: Exact classic config ATA, idempotently created then fully decoded.
    #[account(mut)] pub mining_vault:UncheckedAccount<'info>,
    pub token_program:Program<'info,Token>,pub associated_token_program:Program<'info,AssociatedToken>,pub system_program:Program<'info,System>,
}
pub fn initialize(ctx:Context<InitializeEconomy>,publisher:Pubkey,genesis_day:u64)->Result<()>{
    let day=chain_day(Clock::get()?.unix_timestamp)?;
    require!(publisher!=Pubkey::default()&&ctx.accounts.reserve_owner.key()!=Pubkey::default()
        && ctx.accounts.reserve_owner.key()!=ctx.accounts.config.key(),E::InvalidAuthority);
    require!(genesis_day>0&&genesis_day<=day,E::Time);
    require!(ctx.accounts.mint.decimals==MINING_TOKEN_DECIMALS&&ctx.accounts.mint.mint_authority.is_none()
        &&ctx.accounts.mint.freeze_authority.is_none(),E::Token);
    validate_mining_ata(&ctx.accounts.reserve_ata,ctx.accounts.reserve_owner.key(),ctx.accounts.mint.key())?;
    let vault=get_associated_token_address_with_program_id(&ctx.accounts.config.key(),&ctx.accounts.mint.key(),&token::ID);
    require_keys_eq!(ctx.accounts.mining_vault.key(),vault,E::Token);require!(vault!=ctx.accounts.reserve_ata.key(),E::Identity);
    associated_token::create_idempotent(CpiContext::new(ctx.accounts.associated_token_program.to_account_info(),Create{
        payer:ctx.accounts.admin.to_account_info(),associated_token:ctx.accounts.mining_vault.to_account_info(),authority:ctx.accounts.config.to_account_info(),
        mint:ctx.accounts.mint.to_account_info(),system_program:ctx.accounts.system_program.to_account_info(),token_program:ctx.accounts.token_program.to_account_info()}))?;
    let info=ctx.accounts.mining_vault.to_account_info();let bytes=info.try_borrow_data()?;
    let ata=TokenAccount::try_deserialize(&mut bytes.as_ref())?;
    require_keys_eq!(*info.owner,token::ID,E::Token);
    require!(ata.owner==ctx.accounts.config.key()&&ata.mint==ctx.accounts.mint.key()&&ata.state==AccountState::Initialized
        &&ata.delegate.is_none()&&ata.close_authority.is_none(),E::Token);
    let c=&mut ctx.accounts.config;
    c.version=MINING_VERSION;c.authority=ctx.accounts.authority.key();c.publisher=publisher;c.keep_mint=ctx.accounts.mint.key();
    c.mining_vault=vault;c.emission_reserve_owner=ctx.accounts.reserve_owner.key();c.emission_reserve_ata=ctx.accounts.reserve_ata.key();
    c.decimals=MINING_TOKEN_DECIMALS;c.genesis_day=genesis_day;c.latest_day=genesis_day-1;c.flags=MINING_FLAGS;c.bump=ctx.bumps.config;
    emit!(MiningInitialized{config:c.key(),authority:c.authority,mint:c.keep_mint,vault,reserve:c.emission_reserve_ata,publisher,genesis_day});Ok(())
}

#[derive(Accounts)]
pub struct SetMiningFlags<'info>{
    pub signer:Signer<'info>,
    #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,constraint=authority.version==VERSION @ E::InvalidVersion)] pub authority:Account<'info,SeekerAuthority>,
    #[account(mut,seeds=[ECONOMY_SEED],bump=config.bump,has_one=authority,constraint=config.version==MINING_VERSION @ E::InvalidVersion)] pub config:Account<'info,EconomyConfig>,
}
pub fn set_flags(ctx:Context<SetMiningFlags>,flags:u32)->Result<()>{
    require!(flags&!MINING_FLAGS==0,E::Configuration);
    let signer=ctx.accounts.signer.key();let c=&mut ctx.accounts.config;
    require!(signer==ctx.accounts.authority.admin||(signer==ctx.accounts.authority.guardian&&(flags|c.flags)==flags),E::Unauthorized);
    c.flags=flags;emit!(MiningFlagsChanged{config:c.key(),signer,flags});Ok(())
}
#[derive(Accounts)]
pub struct AdminMining<'info>{
    pub admin:Signer<'info>,
    #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,has_one=admin,constraint=authority.version==VERSION @ E::InvalidVersion)] pub authority:Account<'info,SeekerAuthority>,
    #[account(mut,seeds=[ECONOMY_SEED],bump=config.bump,has_one=authority,constraint=config.version==MINING_VERSION @ E::InvalidVersion)] pub config:Account<'info,EconomyConfig>,
}
pub fn set_publisher(ctx:Context<AdminMining>,publisher:Pubkey)->Result<()>{
    require!(publisher!=Pubkey::default(),E::InvalidAuthority);ctx.accounts.config.publisher=publisher;
    emit!(MiningPublisherChanged{config:ctx.accounts.config.key(),publisher});Ok(())
}

#[derive(Accounts)]
#[instruction(args:PublishMiningArgs)]
pub struct PublishAllocationRoot<'info>{
    #[account(mut)] pub signer:Signer<'info>,
    #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,constraint=authority.version==VERSION @ E::InvalidVersion)] pub authority:Account<'info,SeekerAuthority>,
    #[account(mut,seeds=[ECONOMY_SEED],bump=config.bump,has_one=authority,constraint=config.version==MINING_VERSION @ E::InvalidVersion)] pub config:Account<'info,EconomyConfig>,
    #[account(init,payer=signer,space=8+AllocationRoot::INIT_SPACE,seeds=[ALLOCATION_SEED,&args.sequence.to_le_bytes()],bump)] pub root:Account<'info,AllocationRoot>,
    #[account(init,payer=signer,space=8+MiningEpochReceipt::INIT_SPACE,seeds=[MINING_EPOCH_SEED,&args.day.to_le_bytes()],bump)] pub epoch:Account<'info,MiningEpochReceipt>,
    #[account(address=config.keep_mint)] pub mint:Account<'info,Mint>,
    #[account(mut,address=config.mining_vault)] pub mining_vault:Account<'info,TokenAccount>,
    #[account(mut,address=config.emission_reserve_ata)] pub reserve_ata:Account<'info,TokenAccount>,
    pub token_program:Program<'info,Token>,pub system_program:Program<'info,System>,
}
pub fn publish(ctx:Context<PublishAllocationRoot>,args:PublishMiningArgs)->Result<()>{
    let now=Clock::get()?.unix_timestamp;let c=&ctx.accounts.config;
    authorize_publication(c,&ctx.accounts.authority,ctx.accounts.signer.key(),args.kind,args.day)?;
    require!(!c.correction_pending&&args.sequence==c.latest_sequence.checked_add(1).ok_or(E::Arithmetic)?,E::InvalidPredecessor);
    require!(args.day>=c.genesis_day&&args.day>c.latest_day&&args.day<chain_day(now)?,E::Time);
    validate_commitment(args.root,args.leaf_count)?;
    require!(args.source_hash!=[0;32]&&args.tax_commitment!=[0;32]&&args.tax_version>0,E::Configuration);
    validate_vaults(c,&ctx.accounts.mining_vault,&ctx.accounts.reserve_ata)?;
    let gross=check_gross(args.budget_gross,args.free_gross,args.deed_gross)?;
    require!(ctx.accounts.mining_vault.amount.checked_sub(liability_floor(c)?).ok_or(E::Backing)?>=args.budget_gross,E::Backing);
    let split=split_gross(c.split_cursor,gross)?;
    require!(args.total_cumulative==c.total_published.checked_add(split.player).ok_or(E::Arithmetic)?,E::Backing);
    let prev_day=c.latest_day;let prev_total=c.total_published;let split_start=c.split_cursor;
    let next_tax=c.tax_highwater.checked_add(split.tax).ok_or(E::Arithmetic)?;
    let next_recycle=c.recycled_total.checked_add(split.recycle).ok_or(E::Arithmetic)?;
    let next_gross=c.gross_published.checked_add(gross).ok_or(E::Arithmetic)?;
    let c=&mut ctx.accounts.config;
    c.total_published_highwater=c.total_published_highwater.max(args.total_cumulative);c.tax_highwater=next_tax;
    // The updated full liability floor is checked before the one recycle CPI.
    transfer_reserve(c,&mut ctx.accounts.mining_vault,&mut ctx.accounts.reserve_ata,&ctx.accounts.mint,&ctx.accounts.token_program,split.recycle)?;
    c.recycled_total=next_recycle;c.gross_published=next_gross;c.split_cursor=split.end;
    let epoch=&mut ctx.accounts.epoch;
    epoch.version=MINING_VERSION;epoch.config=c.key();epoch.day=args.day;epoch.budget_gross=args.budget_gross;epoch.free_gross=args.free_gross;epoch.deed_gross=args.deed_gross;
    epoch.player_net=split.player;epoch.tax=split.tax;epoch.recycle=split.recycle;epoch.source_hash=args.source_hash;
    epoch.tax_commitment=args.tax_commitment;epoch.tax_version=args.tax_version;epoch.split_start=split_start;epoch.split_end=split.end;epoch.funded_at=now;epoch.bump=ctx.bumps.epoch;
    let root_args=CorrectMiningArgs{sequence:args.sequence,root:args.root,total_cumulative:args.total_cumulative,leaf_count:args.leaf_count,kind:args.kind};
    write_root(&mut ctx.accounts.root,c.key(),epoch.key(),&root_args,args.day,prev_day,prev_total,now,ctx.bumps.root);
    c.total_published=args.total_cumulative;c.latest_day=args.day;c.latest_sequence=args.sequence;
    emit!(MiningEpochFunded{config:c.key(),epoch:epoch.key(),day:args.day,budget_gross:args.budget_gross,free_gross:args.free_gross,deed_gross:args.deed_gross,
        player_net:split.player,tax:split.tax,recycle:split.recycle,source_hash:args.source_hash,tax_commitment:args.tax_commitment,tax_version:args.tax_version,split_start,split_end:split.end});
    emit!(MiningRootPublished{config:c.key(),root:ctx.accounts.root.key(),epoch:epoch.key(),sequence:args.sequence,day:args.day,total_cumulative:args.total_cumulative,corrected:false});Ok(())
}

pub fn revoke_frontier(c:&mut EconomyConfig,root:&mut AllocationRoot)->Result<()>{
    require!(!c.correction_pending&&!root.revoked&&root.claims_count==0&&root.sequence==c.latest_sequence
        &&root.day==c.latest_day&&root.total_cumulative==c.total_published,E::InvalidPredecessor);
    root.revoked=true;c.total_published=root.prev_total;c.latest_day=root.prev_day;c.correction_pending=true;Ok(())
}
#[derive(Accounts)]
pub struct RevokeAllocationRoot<'info>{
    pub admin:Signer<'info>,
    #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,has_one=admin,constraint=authority.version==VERSION @ E::InvalidVersion)] pub authority:Account<'info,SeekerAuthority>,
    #[account(mut,seeds=[ECONOMY_SEED],bump=config.bump,has_one=authority,constraint=config.version==MINING_VERSION @ E::InvalidVersion)] pub config:Account<'info,EconomyConfig>,
    #[account(mut,seeds=[ALLOCATION_SEED,&root.sequence.to_le_bytes()],bump=root.bump,has_one=config,constraint=root.version==MINING_VERSION @ E::InvalidVersion)] pub root:Account<'info,AllocationRoot>,
}
pub fn revoke(ctx:Context<RevokeAllocationRoot>)->Result<()>{
    revoke_frontier(&mut ctx.accounts.config,&mut ctx.accounts.root)?;
    emit!(MiningRootRevoked{config:ctx.accounts.config.key(),root:ctx.accounts.root.key(),sequence:ctx.accounts.root.sequence});Ok(())
}
#[derive(Accounts)]
#[instruction(args:CorrectMiningArgs)]
pub struct CorrectAllocationRoot<'info>{
    #[account(mut)] pub signer:Signer<'info>,
    #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,constraint=authority.version==VERSION @ E::InvalidVersion)] pub authority:Account<'info,SeekerAuthority>,
    #[account(mut,seeds=[ECONOMY_SEED],bump=config.bump,has_one=authority,constraint=config.version==MINING_VERSION @ E::InvalidVersion)] pub config:Account<'info,EconomyConfig>,
    #[account(seeds=[ALLOCATION_SEED,&revoked_root.sequence.to_le_bytes()],bump=revoked_root.bump,has_one=config,constraint=revoked_root.version==MINING_VERSION @ E::InvalidVersion)] pub revoked_root:Account<'info,AllocationRoot>,
    #[account(seeds=[MINING_EPOCH_SEED,&epoch.day.to_le_bytes()],bump=epoch.bump,has_one=config,constraint=epoch.version==MINING_VERSION @ E::InvalidVersion)] pub epoch:Account<'info,MiningEpochReceipt>,
    #[account(init,payer=signer,space=8+AllocationRoot::INIT_SPACE,seeds=[ALLOCATION_SEED,&args.sequence.to_le_bytes()],bump)] pub root:Account<'info,AllocationRoot>,
    #[account(address=config.mining_vault)] pub mining_vault:Account<'info,TokenAccount>,
    pub system_program:Program<'info,System>,
}
pub fn correct(ctx:Context<CorrectAllocationRoot>,args:CorrectMiningArgs)->Result<()>{
    let c=&ctx.accounts.config;let old=&ctx.accounts.revoked_root;let epoch=&ctx.accounts.epoch;
    authorize_publication(c,&ctx.accounts.authority,ctx.accounts.signer.key(),args.kind,old.day)?;
    require!(c.correction_pending&&old.revoked&&old.claims_count==0&&old.sequence==c.latest_sequence
        &&args.sequence==c.latest_sequence.checked_add(1).ok_or(E::Arithmetic)?,E::InvalidPredecessor);
    require_keys_eq!(old.epoch,epoch.key(),E::Identity);
    require!(old.day==epoch.day&&c.latest_day==old.prev_day&&c.total_published==old.prev_total
        &&old.total_cumulative==old.prev_total.checked_add(epoch.player_net).ok_or(E::Arithmetic)?
        &&args.total_cumulative==old.total_cumulative&&c.total_published_highwater>=args.total_cumulative,E::Backing);
    validate_commitment(args.root,args.leaf_count)?;
    validate_mining_ata(&ctx.accounts.mining_vault,c.key(),c.keep_mint)?;
    require!(ctx.accounts.mining_vault.amount>=liability_floor(c)?,E::Backing);
    let now=Clock::get()?.unix_timestamp;
    write_root(&mut ctx.accounts.root,c.key(),epoch.key(),&args,old.day,old.prev_day,old.prev_total,now,ctx.bumps.root);
    let c=&mut ctx.accounts.config;c.latest_sequence=args.sequence;c.latest_day=old.day;c.total_published=args.total_cumulative;c.correction_pending=false;
    emit!(MiningRootPublished{config:c.key(),root:ctx.accounts.root.key(),epoch:epoch.key(),sequence:args.sequence,day:old.day,total_cumulative:args.total_cumulative,corrected:true});Ok(())
}
#[derive(Accounts)]
pub struct WithdrawMiningSurplus<'info>{
    pub admin:Signer<'info>,
    #[account(seeds=[AUTHORITY_SEED],bump=authority.bump,has_one=admin,constraint=authority.version==VERSION @ E::InvalidVersion)] pub authority:Account<'info,SeekerAuthority>,
    #[account(seeds=[ECONOMY_SEED],bump=config.bump,has_one=authority,constraint=config.version==MINING_VERSION @ E::InvalidVersion)] pub config:Account<'info,EconomyConfig>,
    #[account(address=config.keep_mint)] pub mint:Account<'info,Mint>,
    #[account(mut,address=config.mining_vault)] pub mining_vault:Account<'info,TokenAccount>,
    #[account(mut,address=config.emission_reserve_ata)] pub reserve_ata:Account<'info,TokenAccount>,
    pub token_program:Program<'info,Token>,
}
pub fn withdraw_surplus(ctx:Context<WithdrawMiningSurplus>,amount:u64)->Result<()>{
    require!(amount>0,E::Configuration);
    transfer_reserve(&ctx.accounts.config,&mut ctx.accounts.mining_vault,&mut ctx.accounts.reserve_ata,&ctx.accounts.mint,&ctx.accounts.token_program,amount)?;
    emit!(MiningSurplusWithdrawn{config:ctx.accounts.config.key(),reserve:ctx.accounts.reserve_ata.key(),amount,outstanding:liability_floor(&ctx.accounts.config)?});Ok(())
}

#[event] pub struct MiningInitialized{pub config:Pubkey,pub authority:Pubkey,pub mint:Pubkey,pub vault:Pubkey,pub reserve:Pubkey,pub publisher:Pubkey,pub genesis_day:u64}
#[event] pub struct MiningFlagsChanged{pub config:Pubkey,pub signer:Pubkey,pub flags:u32}
#[event] pub struct MiningPublisherChanged{pub config:Pubkey,pub publisher:Pubkey}
#[event] pub struct MiningEpochFunded{pub config:Pubkey,pub epoch:Pubkey,pub day:u64,pub budget_gross:u64,pub free_gross:u64,pub deed_gross:u64,pub player_net:u64,pub tax:u64,pub recycle:u64,pub source_hash:[u8;32],pub tax_commitment:[u8;32],pub tax_version:u16,pub split_start:u8,pub split_end:u8}
#[event] pub struct MiningRootPublished{pub config:Pubkey,pub root:Pubkey,pub epoch:Pubkey,pub sequence:u64,pub day:u64,pub total_cumulative:u64,pub corrected:bool}
#[event] pub struct MiningRootRevoked{pub config:Pubkey,pub root:Pubkey,pub sequence:u64}
#[event] pub struct MiningSurplusWithdrawn{pub config:Pubkey,pub reserve:Pubkey,pub amount:u64,pub outstanding:u64}
