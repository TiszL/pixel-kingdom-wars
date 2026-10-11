//! Guarded Charter collection bootstrap and purpose-bound economy mint capability.
//! No transfer, thaw, revoke, repair or generic CPI entrypoint; local identity only.
use anchor_lang::prelude::*;
pub mod craft_constants;
pub mod vehicle_state;
pub mod vehicle_permit;
pub mod vehicle_protocol;
pub mod vehicle_control;
pub mod vehicle_request;
pub mod vehicle_settlement;
use vehicle_control::*;
use vehicle_request::*;
use vehicle_settlement::*;
use vehicle_state::VehicleTerms;
use vehicle_permit::VehiclePermitArgs;
pub mod charter_mint;
pub mod charter_transfer;
use charter_mint::*;
use charter_transfer::*;
use mpl_core::{accounts::BaseCollectionV1, instructions::CreateCollectionV1CpiBuilder, types::Key as CoreKey};
#[cfg(not(feature = "devnet-test"))]
declare_id!("4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59");
#[cfg(not(feature = "devnet-test"))]
pub const ECONOMY_PROGRAM_ID: Pubkey = Pubkey::from_str_const("5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr"); #[cfg(feature = "devnet-test")] include!("devnet_test_ids.rs");
pub const CONFIG_SEED: &[u8] = b"charter_control";
pub const COLLECTION_SEED: &[u8] = b"charter_collection";
pub const COLLECTION_AUTHORITY_SEED: &[u8] = b"charter_collection_authority";
const VERSION: u8 = 1;
// D153.151: delegated technical bootstrap metadata profile, not game tuning or
// a claim about Core's metadata limits. UTF-8 byte lengths, not character counts.
const MAX_NAME_BYTES: usize = 64;
const MAX_URI_BYTES: usize = 512;
#[program]
pub mod shardkeep_craft {
    use super::*;
    pub fn initialize_vehicle_collection(ctx:Context<InitializeVehicleCollection>,cluster_genesis:[u8;32],policy_key:Pubkey,name:String,uri:String)->Result<()>{vehicle_control::initialize(ctx,cluster_genesis,policy_key,name,uri)}
    pub fn set_vehicle_admission_paused(ctx:Context<UpdateVehicleControl>,paused:bool)->Result<()>{vehicle_control::paused(ctx,paused)}
    pub fn rotate_vehicle_policy(ctx:Context<UpdateVehicleControl>,next_key:Pubkey,previous_valid_until:i64)->Result<()>{vehicle_control::rotate(ctx,next_key,previous_valid_until)}
    pub fn request_vehicle(ctx:Context<RequestVehicle>,root_id:[u8;16],attempt_id:[u8;16],terms:VehicleTerms,permit:VehiclePermitArgs)->Result<()>{vehicle_request::request(ctx,root_id,attempt_id,terms,permit)}
    pub fn consume_vehicle_randomness(ctx:Context<ConsumeVehicleRandomness>,randomness:[u8;32],root_id:[u8;16],attempt_id:[u8;16])->Result<()>{vehicle_request::consume(ctx,randomness,root_id,attempt_id)}
    pub fn settle_vehicle_fee(ctx:Context<SettleVehicleFee>,root_id:[u8;16])->Result<()>{vehicle_settlement::settle(ctx,root_id)}
    pub fn mint_vehicle(ctx:Context<MintVehicle>,root_id:[u8;16],name:String,uri:String)->Result<()>{vehicle_settlement::mint(ctx,root_id,name,uri)}
    pub fn execute_charter_transfer(ctx:Context<ExecuteCharterTransfer>,clan_id:[u8;16],expected_revision:u32)->Result<()> {charter_transfer::execute(ctx,clan_id,expected_revision)}
    pub fn set_charter_admission_paused(ctx: Context<SetCharterAdmissionPaused>, paused: bool) -> Result<()> { charter_mint::set_paused(ctx, paused) }
    pub fn mint_charter(ctx: Context<MintCharter>, clan_id: [u8;16], creation_intent_id: [u8;16], admission_commitment: [u8;32], name: String, uri: String, creation_permit_id: [u8;16]) -> Result<()> {
        charter_mint::mint(ctx, clan_id, creation_intent_id, admission_commitment, name, uri, creation_permit_id)
    }
    pub fn initialize_charter_collection(ctx: Context<InitializeCharterCollection>, name: String, uri: String) -> Result<()> {
        require!(ctx.remaining_accounts.is_empty(), CraftError::RemainingAccounts);
        validate_metadata(&name, &uri)?;
        // The account constraints above already authenticated this program's
        // actual current upgrade authority before any initialization can commit.
        let collection = ctx.accounts.collection.to_account_info();
        let authority = ctx.accounts.collection_authority.to_account_info();
        let admin = ctx.accounts.admin.to_account_info();
        let system = ctx.accounts.system_program.to_account_info();
        let core = ctx.accounts.mpl_core_program.to_account_info();
        validate_empty_system_collection(&collection)?;
        require!(*authority.owner == anchor_lang::system_program::ID
            && authority.data_is_empty() && !authority.executable, CraftError::InvalidAuthority);

        let bump = [ctx.bumps.collection];
        let collection_seeds: &[&[u8]] = &[COLLECTION_SEED, &bump];
        let signers = &[collection_seeds];
        // Core uses System create_account, which rejects even an empty prefunded
        // PDA. D153.151 permits this exact canonical, authenticated sweep only.
        // Core creation and postconditions share the transaction: any failure
        // restores the donation and rolls back config creation, never releases it.
        let prefund = collection.lamports();
        if prefund != 0 {
            anchor_lang::system_program::transfer(CpiContext::new_with_signer(system.clone(),
                anchor_lang::system_program::Transfer { from: collection.clone(), to: admin.clone() }, signers), prefund)?;
        }
        CreateCollectionV1CpiBuilder::new(&core)
            .collection(&collection)
            .update_authority(Some(&authority))
            .payer(&admin)
            .system_program(&system)
            .name(name.clone())
            .uri(uri.clone())
            // No plugins or remaining accounts. The fixed PDA is the only
            // collection authority; the initializer retains no Core capability.
            .invoke_signed(signers)?;
        verify_created_collection(&collection, authority.key(), &name, &uri)?;

        let config = &mut ctx.accounts.config;
        config.version = VERSION;
        config.bootstrap_admin = admin.key();
        config.economy_program = ECONOMY_PROGRAM_ID;
        config.collection = collection.key();
        config.collection_authority = authority.key();
        config.admission_paused = true;
        config.bump = ctx.bumps.config;
        config.collection_bump = ctx.bumps.collection;
        config.authority_bump = ctx.bumps.collection_authority;
        emit!(CharterCollectionInitialized { config: config.key(), admin: admin.key(),
            economy_program: ECONOMY_PROGRAM_ID, collection: collection.key(), collection_authority: authority.key(),
            prefund_returned: prefund, admission_paused: true });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeCharterCollection<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ CraftError::Unauthorized)]
    pub program: Program<'info, crate::program::ShardkeepCraft>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ CraftError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = admin, space = 8 + CharterControl::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, CharterControl>,
    /// CHECK: Canonical PDA; handler additionally requires empty, nonexecutable System account before signed sweep/CPI.
    #[account(mut, seeds = [COLLECTION_SEED], bump, owner = anchor_lang::system_program::ID @ CraftError::InvalidCollection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: Canonical readonly craft PDA; no signer capability is exposed by this instruction.
    #[account(seeds = [COLLECTION_AUTHORITY_SEED], bump)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Fixed executable Core is the only CPI target besides typed System.
    #[account(address = mpl_core::ID @ CraftError::InvalidCore, executable)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct CharterControl {
    pub version: u8,
    pub bootstrap_admin: Pubkey,
    pub economy_program: Pubkey,
    pub collection: Pubkey,
    pub collection_authority: Pubkey,
    pub admission_paused: bool,
    pub bump: u8,
    pub collection_bump: u8,
    pub authority_bump: u8,
}

#[event]
pub struct CharterCollectionInitialized {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub economy_program: Pubkey,
    pub collection: Pubkey,
    pub collection_authority: Pubkey,
    pub prefund_returned: u64,
    pub admission_paused: bool,
}

#[error_code]
pub enum CraftError {
    #[msg("Only this program's current upgrade authority may initialize")]
    Unauthorized,
    #[msg("Remaining accounts are not supported")]
    RemainingAccounts,
    #[msg("Metadata is outside the supported bootstrap profile")]
    InvalidMetadata,
    #[msg("Canonical collection must be an empty nonexecutable System account")]
    InvalidCollection,
    #[msg("Canonical collection authority must be an empty nonexecutable System account")]
    InvalidAuthority,
    #[msg("Core program must be the fixed executable")]
    InvalidCore,
    #[msg("Core collection postcondition mismatch")]
    CollectionPostcondition,
    #[msg("Charter admission is paused")] AdmissionPaused,
    #[msg("Invalid authenticated provisional Charter")] InvalidCharter,
    #[msg("Invalid canonical empty asset")] InvalidAsset,
    #[msg("Core asset postcondition mismatch")] AssetPostcondition,
    #[msg("Checked arithmetic failed")] Arithmetic,
    #[msg("Charter implementation is not available")] CharterNotImplemented,
    // Explicit discriminants keep new local issuance errors apart while retaining
    // Anchor 0.32.1's single correct generated IDL table (offset args are ignored by its IDL emitter).
    #[msg("Invalid control or original binding")] Binding = 1000,
    #[msg("Vehicle admission is paused")] Paused,
    #[msg("Invalid fixed provider profile")] Provider,
    #[msg("Invalid empty System capability")] Capability,
    #[msg("Invalid committed terms")] Terms,
    #[msg("Invalid original permit")] Permit,
    #[msg("Expired original permit")] Expired,
    #[msg("Internal aliases are forbidden")] Alias,
    #[msg("Escrow conservation failed")] Conservation,
    #[msg("Original outcome is not pending")] NotPending,
    #[msg("Original outcome is not ready for this action")] Outcome,
    #[msg("Original fee is already settled")] Settled,
    #[msg("Original asset already minted")] Minted,
    #[msg("Only top-level buyer admission is supported")] TopLevel,
}

fn validate_metadata(name: &str, uri: &str) -> Result<()> {
    require!(!name.is_empty() && name.len() <= MAX_NAME_BYTES && !uri.is_empty() && uri.len() <= MAX_URI_BYTES,
        CraftError::InvalidMetadata);
    Ok(())
}
fn validate_empty_system_collection(collection: &AccountInfo<'_>) -> Result<()> {
    require!(*collection.owner == anchor_lang::system_program::ID && collection.data_is_empty()
        && !collection.executable, CraftError::InvalidCollection);
    Ok(())
}
fn verify_created_collection(collection: &AccountInfo<'_>, authority: Pubkey, name: &str, uri: &str) -> Result<()> {
    validate_metadata(name, uri)?;
    require!(*collection.owner == mpl_core::ID && !collection.executable, CraftError::CollectionPostcondition);
    // Serialize bounded known values instead of allocating from untrusted string
    // lengths or using SDK prefix/normalized-plugin parsing. Exact equality also
    // refuses every plugin header, adapter, padding byte and nonzero mint count.
    let expected = BaseCollectionV1 { key: CoreKey::CollectionV1, update_authority: authority,
        name: name.to_owned(), uri: uri.to_owned(), num_minted: 0, current_size: 0 }.try_to_vec()?;
    require!(&**collection.try_borrow_data()? == expected.as_slice(), CraftError::CollectionPostcondition);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const AUTHORITY: Pubkey = Pubkey::new_from_array([7;32]);
    const COLLECTION: Pubkey = Pubkey::new_from_array([8;32]);
    const OTHER: Pubkey = Pubkey::new_from_array([9;32]);
    fn account<T>(owner: &Pubkey, executable: bool, balance: u64, data: &mut [u8], f: impl FnOnce(&AccountInfo<'_>) -> T) -> T {
        let mut lamports=balance;
        f(&AccountInfo::new(&COLLECTION,false,true,&mut lamports,data,owner,executable,0))
    }
    fn serialized(authority: Pubkey, minted: u32, size: u32) -> Vec<u8> {
        BaseCollectionV1 { key:CoreKey::CollectionV1, update_authority:authority, name:"Charters".into(),uri:"https://invalid.example/charters.json".into(),num_minted:minted,current_size:size }.try_to_vec().unwrap()
    }
    #[test]
    fn metadata_bounds_count_utf8_bytes_without_inventing_game_values() {
        assert!(validate_metadata("Charters","https://invalid.example/charters.json").is_ok());
        assert!(validate_metadata(&"é".repeat(32),&"u".repeat(512)).is_ok());
        for (name,uri) in [(String::new(),"u".into()),("n".into(),String::new()),("é".repeat(33),"u".into()),("n".into(),"u".repeat(513))] {
            assert!(validate_metadata(&name,&uri).is_err());
        }
    }
    #[test]
    fn prefunding_does_not_change_empty_system_profile_but_owned_or_allocated_accounts_hold() {
        for lamports in [0,1,10_000_000] {
            assert!(account(&anchor_lang::system_program::ID,false,lamports,&mut [],validate_empty_system_collection).is_ok());
        }
        assert!(account(&OTHER,false,1,&mut [],validate_empty_system_collection).is_err());
        assert!(account(&anchor_lang::system_program::ID,true,1,&mut [],validate_empty_system_collection).is_err());
        assert!(account(&anchor_lang::system_program::ID,false,1,&mut [0],validate_empty_system_collection).is_err());
    }
    #[test]
    fn postcondition_requires_actual_core_owner_and_exact_plain_empty_bytes() {
        let check=|a:&AccountInfo<'_>| verify_created_collection(a,AUTHORITY,"Charters","https://invalid.example/charters.json");
        let mut valid=serialized(AUTHORITY,0,0);
        assert!(account(&mpl_core::ID,false,1,&mut valid,check).is_ok());
        assert!(account(&OTHER,false,1,&mut valid,check).is_err());
        assert!(account(&mpl_core::ID,true,1,&mut valid,check).is_err());
        for (authority,minted,size) in [(OTHER,0,0),(AUTHORITY,1,0),(AUTHORITY,0,1),(AUTHORITY,1,1)] {
            assert!(account(&mpl_core::ID,false,1,&mut serialized(authority,minted,size),check).is_err());
        }
        for n in 0..valid.len() { assert!(account(&mpl_core::ID,false,1,&mut valid[..n],check).is_err()); }
        let mut extra=valid.clone(); extra.push(0); assert!(account(&mpl_core::ID,false,1,&mut extra,check).is_err());
        let mut changed=valid.clone(); changed[37]^=1; assert!(account(&mpl_core::ID,false,1,&mut changed,check).is_err());
        valid[0]=1; assert!(account(&mpl_core::ID,false,1,&mut valid,check).is_err());
    }
    #[test]
    fn immutable_bootstrap_layout_has_no_mutable_economy_or_authority_arguments() {
        let config=CharterControl { version:VERSION,bootstrap_admin:OTHER,economy_program:ECONOMY_PROGRAM_ID,collection:COLLECTION,collection_authority:AUTHORITY,admission_paused:true,bump:1,collection_bump:2,authority_bump:3 };
        assert_eq!(config.try_to_vec().unwrap().len(),133);
        assert_eq!(CharterControl::INIT_SPACE,133);
        assert_ne!(ECONOMY_PROGRAM_ID,crate::ID);
        let config=Pubkey::find_program_address(&[CONFIG_SEED],&crate::ID).0;
        let collection=Pubkey::find_program_address(&[COLLECTION_SEED],&crate::ID).0;
        let authority=Pubkey::find_program_address(&[COLLECTION_AUTHORITY_SEED],&crate::ID).0;
        assert_ne!(config,collection); assert_ne!(collection,authority); assert_ne!(config,authority);
    }
    #[test]
    fn existing_control_account_bytes_match_the_sdk_free_economy_view() {
        let value=CharterControl {version:VERSION,bootstrap_admin:OTHER,economy_program:ECONOMY_PROGRAM_ID,
            collection:COLLECTION,collection_authority:AUTHORITY,admission_paused:true,bump:1,collection_bump:2,authority_bump:3};
        let mut b=Vec::new();value.try_serialize(&mut b).unwrap();
        assert_eq!(b.len(),shardkeep_charter_interface::CONTROL_BYTES);
        assert_eq!(&b[..8],shardkeep_charter_interface::CONTROL_DISCRIMINATOR);
        let read=shardkeep_charter_interface::decode_control(&b).unwrap();
        assert_eq!(read.economy_program,ECONOMY_PROGRAM_ID.to_bytes());assert!(read.admission_paused);
    }
}
