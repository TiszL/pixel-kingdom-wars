//! Seeker auctions: immutable terms, native policy permits and conserved escrow.
//! Public deployment and funding remain held pending the complete release gates.
use anchor_lang::prelude::*;
pub mod auction;
pub mod escrow;
pub mod permit;
pub mod state;
#[cfg_attr(feature = "devnet-test", path = "constants_devnet_test.rs")] pub mod constants;
pub mod mining_proof;
pub mod mining_state;
pub mod mining;
pub mod mining_claim;
pub mod mining_tax;
pub mod realm_sale;
pub mod charter_core;
pub mod charter_identity;
pub mod charter_state;
pub mod charter;
pub mod charter_transfer;
pub mod charter_retirement;
use auction::*;
use escrow::*;
use permit::*;
use state::*;
use mining::*;
use mining_claim::*;
use mining_tax::*;
use realm_sale::*;
use charter::*;
use charter_transfer::*;
use charter_retirement::*;
use mining_proof::ProofNode;
#[cfg(not(feature = "devnet-test"))]
declare_id!("5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr");
#[cfg(feature = "devnet-test")] include!("devnet_test_ids.rs");
#[program]
pub mod shardkeep_economy {
    use super::*;
    pub fn retire_charter(ctx:Context<RetireCharter>,args:CharterRetirementArgs)->Result<()> {charter_retirement::retire(ctx,args)}
    pub fn initialize_charter_transfer_config(ctx:Context<InitializeCharterTransferConfig>,treasury:Pubkey)->Result<()> {charter_transfer::initialize(ctx,treasury)}
    pub fn settle_charter_transfer(ctx:Context<SettleCharterTransfer>,args:CharterTransferArgs)->Result<()> {charter_transfer::settle(ctx,args)}
    pub fn set_charter_lock(ctx:Context<ChangeCharterLock>,args:CharterLockArgs)->Result<()> {charter_transfer::change_lock(ctx,args,1)}
    pub fn clear_charter_lock(ctx:Context<ChangeCharterLock>,args:CharterLockArgs)->Result<()> {charter_transfer::change_lock(ctx,args,2)}
    pub fn initialize_charter_config(ctx: Context<InitializeCharterConfig>) -> Result<()> { charter::initialize(ctx) }
    pub fn register_charter(ctx: Context<RegisterCharter>, clan_id: [u8;16], creation_intent_id: [u8;16], admission_commitment: [u8;32], name: String, uri: String, permit: PermitArgs) -> Result<()> {
        charter::require_top_level_registration()?;
        charter::register(ctx, clan_id, creation_intent_id, admission_commitment, name, uri, permit)
    }
    pub fn initialize_seeker_authority(ctx: Context<InitializeSeekerAuthority>, guardian: Pubkey,
        policy_key: Pubkey, cluster_genesis: [u8; 32]) -> Result<()> {
        require!(guardian != Pubkey::default() && policy_key != Pubkey::default()
            && cluster_genesis != [0; 32], EconomyError::InvalidAuthority);
        let authority = &mut ctx.accounts.authority;
        authority.version = VERSION;
        authority.admin = ctx.accounts.admin.key(); authority.pending_admin = None;
        authority.guardian = guardian; authority.current_policy_key = policy_key;
        authority.previous_policy_key = None; authority.previous_valid_until = 0;
        authority.cluster_genesis = cluster_genesis; authority.admission_paused = true;
        authority.bump = ctx.bumps.authority;
        emit!(AuthorityInitialized { admin: authority.admin, guardian, policy_key, cluster_genesis });
        Ok(())
    }
    pub fn set_admission_paused(ctx: Context<ChangePause>, paused: bool) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        let authority = &mut ctx.accounts.authority;
        require!(signer == authority.admin || (paused && signer == authority.guardian), EconomyError::Unauthorized);
        authority.admission_paused = paused;
        emit!(AdmissionPauseChanged { signer, paused }); Ok(())
    }
    pub fn propose_admin(ctx: Context<AdminAuthority>, new_admin: Pubkey) -> Result<()> {
        require!(new_admin != Pubkey::default() && new_admin != ctx.accounts.authority.admin, EconomyError::InvalidAuthority);
        ctx.accounts.authority.pending_admin = Some(new_admin);
        emit!(AdminProposed { admin: ctx.accounts.admin.key(), new_admin }); Ok(())
    }
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let authority = &mut ctx.accounts.authority;
        require!(authority.pending_admin == Some(ctx.accounts.new_admin.key()), EconomyError::Unauthorized);
        let previous_admin = authority.admin;
        authority.admin = ctx.accounts.new_admin.key(); authority.pending_admin = None;
        emit!(AdminAccepted { previous_admin, admin: authority.admin }); Ok(())
    }
    pub fn rotate_policy(ctx: Context<AdminAuthority>, new_key: Pubkey) -> Result<()> {
        let authority = &mut ctx.accounts.authority;
        require!(new_key != Pubkey::default() && new_key != authority.current_policy_key, EconomyError::InvalidAuthority);
        let now = Clock::get()?.unix_timestamp;
        let deadline = now.checked_add(constants::MAX_POLICY_PERMIT_TTL_SEC).ok_or(EconomyError::Arithmetic)?;
        let previous_key = authority.current_policy_key;
        authority.previous_policy_key = Some(previous_key);
        authority.previous_valid_until = deadline; authority.current_policy_key = new_key;
        emit!(PolicyRotated { previous_key, current_key: new_key, previous_valid_until: deadline }); Ok(())
    }
    pub fn initialize_auction_config(ctx: Context<InitializeAuctionConfig>, first_operating_start: i64) -> Result<()> {
        auction::initialize(ctx, first_operating_start)
    }
    pub fn open_term(ctx: Context<OpenTerm>, round: u64) -> Result<()> { auction::open_term(ctx, round) }
    pub fn open_auction(ctx: Context<OpenAuction>, spot: u8, permit: PermitArgs) -> Result<()> { escrow::open_auction(ctx, spot, permit) }
    pub fn open_bid(ctx: Context<OpenBid>) -> Result<()> { escrow::open_bid(ctx) }
    pub fn place_bid(ctx: Context<PlaceBid>, new_total: u64) -> Result<()> { escrow::place_bid(ctx, new_total) }
    pub fn withdraw_bid(ctx: Context<WithdrawBid>) -> Result<()> { escrow::withdraw_bid(ctx) }
    pub fn settle_auction(ctx: Context<SettleAuction>) -> Result<()> {
        escrow::require_top_level_settlement()?;
        escrow::settle_auction(ctx)
    }
    pub fn settle_auction_with_permit(ctx: Context<SettleAuctionWithPermit>, permit: PermitArgs) -> Result<()> {
        escrow::require_top_level_settlement()?;
        escrow::settle_auction_with_permit(ctx, permit)
    }
    pub fn close_permit_receipt(ctx: Context<ClosePermitReceipt>) -> Result<()> { permit::close(ctx) }
    pub fn initialize_economy(ctx: Context<InitializeEconomy>, publisher: Pubkey, genesis_day: u64) -> Result<()> {
        mining::initialize(ctx, publisher, genesis_day)
    }
    pub fn set_mining_flags(ctx: Context<SetMiningFlags>, flags: u32) -> Result<()> { mining::set_flags(ctx, flags) }
    pub fn set_mining_publisher(ctx: Context<AdminMining>, publisher: Pubkey) -> Result<()> { mining::set_publisher(ctx, publisher) }
    pub fn publish_allocation_root(ctx: Context<PublishAllocationRoot>, args: PublishMiningArgs) -> Result<()> { mining::publish(ctx, args) }
    pub fn revoke_allocation_root(ctx: Context<RevokeAllocationRoot>) -> Result<()> { mining::revoke(ctx) }
    pub fn correct_allocation_root(ctx: Context<CorrectAllocationRoot>, args: CorrectMiningArgs) -> Result<()> { mining::correct(ctx, args) }
    pub fn withdraw_mining_surplus(ctx: Context<WithdrawMiningSurplus>, amount: u64) -> Result<()> { mining::withdraw_surplus(ctx, amount) }
    pub fn open_miner_records(ctx: Context<OpenMinerRecords>, wallet: Pubkey) -> Result<()> { mining_claim::open_miner_records(ctx, wallet) }
    pub fn claim_mining(ctx: Context<ClaimMining>, sequence: u64, cumulative_keep: u64, cumulative_renown: u64,
        cumulative_days: u64, proof: Vec<ProofNode>) -> Result<()> {
        mining_claim::claim_mining(ctx, sequence, cumulative_keep, cumulative_renown, cumulative_days, proof)
    }
    pub fn sync_renown(ctx: Context<SyncRenown>, wallet: Pubkey, sequence: u64, cumulative_keep: u64,
        cumulative_renown: u64, cumulative_days: u64, proof: Vec<ProofNode>) -> Result<()> {
        mining_claim::sync_renown(ctx, wallet, sequence, cumulative_keep, cumulative_renown, cumulative_days, proof)
    }

    pub fn open_mining_tax_pool(ctx: Context<OpenMiningTaxPool>) -> Result<()> { mining_tax::open_tax_pool(ctx) }
    pub fn accrue_mining_tax(ctx: Context<AccrueMiningTax>) -> Result<()> { mining_tax::accrue_tax(ctx) }
    pub fn open_mining_tax_spot(ctx: Context<OpenMiningTaxSpot>) -> Result<()> { mining_tax::open_tax_spot(ctx) }
    pub fn claim_mining_tax(ctx: Context<ClaimMiningTax>) -> Result<()> { mining_tax::claim_tax(ctx) }
    pub fn initialize_realm_sale_config(ctx: Context<InitializeRealmSaleConfig>) -> Result<()> { realm_sale::initialize_realm_sales(ctx) }
    pub fn open_realm_access(ctx: Context<OpenRealmAccess>, wallet: Pubkey, realm: u8) -> Result<()> { realm_sale::open_realm_access(ctx, wallet, realm) }
    pub fn open_spot_sales_quota(ctx: Context<OpenSpotSalesQuota>, spot: u8, day: u64) -> Result<()> { realm_sale::open_spot_sales_quota(ctx, spot, day) }
    pub fn buy_realm_access(ctx: Context<BuyRealmAccess>, args: BuyRealmAccessArgs) -> Result<()> { realm_sale::buy_realm_access(ctx, args) }
}

#[derive(Accounts)]
pub struct InitializeSeekerAuthority<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ EconomyError::Unauthorized)]
    pub program: Program<'info, crate::program::ShardkeepEconomy>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ EconomyError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = admin, space = 8 + SeekerAuthority::INIT_SPACE, seeds = [AUTHORITY_SEED], bump)]
    pub authority: Account<'info, SeekerAuthority>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ChangePause<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [AUTHORITY_SEED], bump = authority.bump,
        constraint = authority.version == VERSION @ EconomyError::InvalidVersion)]
    pub authority: Account<'info, SeekerAuthority>,
}
#[derive(Accounts)]
pub struct AdminAuthority<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [AUTHORITY_SEED], bump = authority.bump, has_one = admin,
        constraint = authority.version == VERSION @ EconomyError::InvalidVersion)]
    pub authority: Account<'info, SeekerAuthority>,
}
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [AUTHORITY_SEED], bump = authority.bump,
        constraint = authority.version == VERSION @ EconomyError::InvalidVersion)]
    pub authority: Account<'info, SeekerAuthority>,
}
#[event] pub struct AuthorityInitialized { pub admin: Pubkey, pub guardian: Pubkey, pub policy_key: Pubkey, pub cluster_genesis: [u8; 32] }
#[event] pub struct AdmissionPauseChanged { pub signer: Pubkey, pub paused: bool }
#[event] pub struct AdminProposed { pub admin: Pubkey, pub new_admin: Pubkey }
#[event] pub struct AdminAccepted { pub previous_admin: Pubkey, pub admin: Pubkey }
#[event] pub struct PolicyRotated { pub previous_key: Pubkey, pub current_key: Pubkey, pub previous_valid_until: i64 }

#[error_code]
pub enum EconomyError {
    #[msg("Authority is not authorized")] Unauthorized,
    #[msg("Invalid authority or domain")] InvalidAuthority,
    #[msg("Unsupported account version")] InvalidVersion,
    #[msg("Invalid policy configuration")] InvalidPolicy,
    #[msg("Checked arithmetic failed")] Arithmetic,
    #[msg("Unknown spot")] InvalidSpot,
    #[msg("Already recorded")] AlreadyRecorded,
    #[msg("Invalid native policy permit")] InvalidPermit,
    #[msg("Permit time boundary not satisfied")] PermitExpired,
    #[msg("Initial auction needs the entire prelaunch window")] InvalidCalendar,
    #[msg("Wrong canonical token account")] InvalidTokenAccount,
    #[msg("Wrong deterministic predecessor")] InvalidPredecessor,
    #[msg("Registry identity or contents mismatch")] InvalidRegistry,
    // Anchor 0.32.1 emits only one error section and its IDL always adds the
    // default 6000 offset. Explicit discriminants preserve escrow's original
    // 7000..7012 runtime codes in both the program and generated IDL.
    #[msg("Admission is paused")] Paused = 1000,
    #[msg("Invalid immutable account relationship")] Identity = 1001,
    #[msg("Unsupported immutable configuration")] Configuration = 1002,
    #[msg("Auction clock does not allow this action")] Time = 1003,
    #[msg("All auctions must be prepared before bidding")] Incomplete = 1004,
    #[msg("Auction result is already settled")] Settled = 1005,
    #[msg("Bid must strictly exceed the leader and meet the opening minimum")] BidTooLow = 1006,
    #[msg("No refundable loser balance")] NotRefundable = 1007,
    #[msg("Token balance delta or escrow backing mismatch")] Backing = 1008,
    #[msg("Frozen or substituted token account")] Token = 1009,
    #[msg("Checked arithmetic failed")] EscrowArithmetic = 1010,
    #[msg("Winner account does not match the original leading bid")] Winner = 1011,
    #[msg("Settlement must be a top-level transaction instruction")] TopLevelOnly = 1012,
    #[msg("Invalid cumulative mining proof")] InvalidMiningProof = 2000,
    #[msg("Invalid cumulative mining claim")] InvalidMiningClaim = 2001,
    #[msg("Invalid cumulative Renown or participation days")] InvalidMiningRenown = 2002,
    #[msg("Invalid original Seeker tax term")] InvalidMiningTaxTerm = 2003,
    #[msg("Invalid funded Seeker tax epoch")] InvalidMiningTaxEpoch = 2004,
    #[msg("Invalid original winning spot tax claim")] InvalidMiningTaxClaim = 2005,
    #[msg("Invalid signed realm sale terms")] InvalidRealmSaleTerms = 3000,
    #[msg("The spot has sold its daily quota")] RealmSaleQuotaExhausted = 3001,
    #[msg("Realm access changed since the signed quote")] RealmAccessChanged = 3002,
    #[msg("Invalid current original Seeker seller")] InvalidRealmSeller = 3003,
    #[msg("SOL payment balance delta mismatch")] RealmSaleBalance = 3004,
    #[msg("Charter registration must be a top-level instruction")] CharterTopLevelOnly = 4000,
    #[msg("Invalid canonical Charter identity or state")] CharterIdentity = 4001,
    #[msg("Charter Core postconditions failed")] CharterCore = 4002,
    #[msg("Charter implementation is not available")] CharterNotImplemented = 4003,
}
