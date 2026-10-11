//! Purpose-bound economy capability for atomic Charter minting.
use anchor_lang::prelude::*;
use shardkeep_charter_interface as wire;
use mpl_core::{accounts::{BaseAssetV1, BaseCollectionV1, PluginHeaderV1, PluginRegistryV1},
    instructions::CreateV1CpiBuilder, types::{Key as CoreKey, DataState, UpdateAuthority, Plugin, PluginAuthority,
        PluginAuthorityPair, PermanentFreezeDelegate, PluginType, RegistryRecord}};
use crate::{CharterControl, CraftError as E, ECONOMY_PROGRAM_ID, CONFIG_SEED, COLLECTION_SEED, COLLECTION_AUTHORITY_SEED};

#[derive(Accounts)]
pub struct SetCharterAdmissionPaused<'info> {
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ E::Unauthorized)]
    pub program: Program<'info, crate::program::ShardkeepCraft>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ E::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == 1 @ E::InvalidCharter)]
    pub config: Account<'info, CharterControl>,
}
#[derive(Accounts)]
#[instruction(clan_id: [u8;16])]
pub struct MintCharter<'info> {
    #[account(mut)] pub leader: Signer<'info>,
    #[account(seeds = [b"charter_executor", clan_id.as_ref()], bump, seeds::program = ECONOMY_PROGRAM_ID)]
    pub executor: Signer<'info>,
    /// CHECK: Fixed executable owner of the provisional record and signer capability.
    #[account(address = ECONOMY_PROGRAM_ID, executable)] pub economy_program: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = economy_program,
        has_one = collection, has_one = collection_authority, constraint = config.version == 1 @ E::InvalidCharter)]
    pub config: Account<'info, CharterControl>,
    /// CHECK: Canonical owner/PDA plus exact bounded provisional wire validation in handler.
    #[account(seeds = [b"charter", clan_id.as_ref()], bump, seeds::program = ECONOMY_PROGRAM_ID, owner = ECONOMY_PROGRAM_ID)]
    pub charter: UncheckedAccount<'info>,
    /// CHECK: Canonical empty System account is checked before atomic sweep/create.
    #[account(mut, seeds = [b"charter_mint", clan_id.as_ref()], bump)] pub asset: UncheckedAccount<'info>,
    /// CHECK: Plain controlled collection is checked before and after Core mint.
    #[account(mut, seeds = [COLLECTION_SEED], bump = config.collection_bump)] pub collection: UncheckedAccount<'info>,
    /// CHECK: Canonical craft capability signs only fixed Core creation.
    #[account(seeds = [COLLECTION_AUTHORITY_SEED], bump = config.authority_bump)] pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Per-clan frozen delegate is never exposed as a signing capability.
    #[account(seeds = [b"charter_freeze", clan_id.as_ref()], bump)] pub freeze_authority: UncheckedAccount<'info>,
    /// CHECK: Fixed executable Core only.
    #[account(address = mpl_core::ID, executable)] pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn set_paused(ctx: Context<SetCharterAdmissionPaused>, paused: bool) -> Result<()> {
    require!(ctx.remaining_accounts.is_empty(), E::RemainingAccounts);
    // Account constraints authenticate the exact current ProgramData on every call.
    // bootstrap_admin is retained only as historical audit data.
    ctx.accounts.config.admission_paused = paused;
    emit!(CharterAdmissionPauseChanged { admin: ctx.accounts.admin.key(), paused });
    Ok(())
}
pub fn mint(ctx: Context<MintCharter>, clan_id: [u8;16], creation_intent_id: [u8;16], admission_commitment: [u8;32], name: String, uri: String, creation_permit_id: [u8;16]) -> Result<()> {
    require!(ctx.remaining_accounts.is_empty(), E::RemainingAccounts);
    let a = ctx.accounts;
    require!(!a.config.admission_paused, E::AdmissionPaused);
    let preimage = wire::metadata_preimage(&name, &uri).map_err(|_| E::InvalidMetadata)?;
    let metadata_hash = solana_keccak_hasher::hash(&preimage).0;
    let expected = wire::CharterView { version: wire::VERSION,
        config: Pubkey::find_program_address(&[b"charter_config"], &ECONOMY_PROGRAM_ID).0.to_bytes(),
        clan_id, asset: a.asset.key().to_bytes(), collection: a.collection.key().to_bytes(), leader: a.leader.key().to_bytes(),
        revision: 0, state: wire::CharterState::Minting, lock: wire::CharterLock::None, lock_id: [0;16], creation_intent_id,
        metadata_hash, admission_commitment, creation_permit_id, created_at: Clock::get()?.unix_timestamp, bump: ctx.bumps.charter };
    require!(!a.charter.executable, E::InvalidCharter);
    validate_provisional(&a.charter.try_borrow_data()?, &expected)?;
    let asset = a.asset.to_account_info();
    let collection = a.collection.to_account_info();
    let authority = a.collection_authority.to_account_info();
    let leader = a.leader.to_account_info();
    let system = a.system_program.to_account_info();
    let core = a.mpl_core_program.to_account_info();
    require!(*asset.owner == anchor_lang::system_program::ID && asset.data_is_empty() && !asset.executable, E::InvalidAsset);
    for capability in [&authority, &a.freeze_authority.to_account_info()] {
        require!(*capability.owner == anchor_lang::system_program::ID && capability.data_is_empty() && !capability.executable, E::InvalidAuthority);
    }
    let mut after = plain_collection(&collection, authority.key())?;
    after.num_minted = after.num_minted.checked_add(1).ok_or(E::Arithmetic)?;
    after.current_size = after.current_size.checked_add(1).ok_or(E::Arithmetic)?;
    let asset_bump = [ctx.bumps.asset];
    let authority_bump = [a.config.authority_bump];
    let asset_seeds: &[&[u8]] = &[b"charter_mint", &clan_id, &asset_bump];
    let authority_seeds: &[&[u8]] = &[COLLECTION_AUTHORITY_SEED, &authority_bump];
    let prefund = asset.lamports();
    if prefund != 0 {
        // Only this authenticated canonical asset can be swept, immediately before
        // fixed Core creation. Any failure propagates and restores the donation.
        anchor_lang::system_program::transfer(CpiContext::new_with_signer(system.clone(),
            anchor_lang::system_program::Transfer { from: asset.clone(), to: leader.clone() }, &[asset_seeds]), prefund)?;
    }
    CreateV1CpiBuilder::new(&core).asset(&asset).collection(Some(&collection)).authority(Some(&authority))
        .payer(&leader).owner(Some(&leader)).update_authority(None).system_program(&system)
        .data_state(DataState::AccountState).name(name.clone()).uri(uri.clone())
        .plugins(vec![PluginAuthorityPair { plugin: Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: true }),
            authority: Some(PluginAuthority::Address { address: a.freeze_authority.key() }) }])
        .invoke_signed(&[asset_seeds, authority_seeds])?;
    verify_created_asset(&asset, leader.key(), collection.key(), a.freeze_authority.key(), &name, &uri)?;
    require!(*collection.owner == mpl_core::ID && !collection.executable
        && &**collection.try_borrow_data()? == after.try_to_vec()?.as_slice(), E::CollectionPostcondition);
    emit!(CharterMinted { clan_id, creation_intent_id, charter: a.charter.key(), asset: asset.key(), leader: leader.key(),
        metadata_hash, admission_commitment, creation_permit_id, prefund_returned: prefund });
    Ok(())
}
fn validate_provisional(data: &[u8], expected: &wire::CharterView) -> Result<()> {
    let actual = wire::decode_charter(data).map_err(|_| E::InvalidCharter)?;
    require!(actual == *expected, E::InvalidCharter);
    Ok(())
}
fn bounded_string_end(data: &[u8], at: usize, maximum: usize) -> Result<usize> {
    let length_end = at.checked_add(4).ok_or(E::Arithmetic)?;
    let length = u32::from_le_bytes(data.get(at..length_end).ok_or(E::CollectionPostcondition)?.try_into().map_err(|_| E::CollectionPostcondition)?) as usize;
    require!(length > 0 && length <= maximum, E::CollectionPostcondition);
    let end = length_end.checked_add(length).ok_or(E::Arithmetic)?;
    core::str::from_utf8(data.get(length_end..end).ok_or(E::CollectionPostcondition)?).map_err(|_| E::CollectionPostcondition)?;
    Ok(end)
}
pub(crate) fn plain_collection(info: &AccountInfo<'_>, authority: Pubkey) -> Result<BaseCollectionV1> {
    require!(*info.owner == mpl_core::ID && !info.executable, E::CollectionPostcondition);
    let data = info.try_borrow_data()?;
    // Bound both string lengths before invoking the raw generated Borsh decoder;
    // its prefix parsing alone cannot establish the absence of plugins or padding.
    let name_end = bounded_string_end(&data, 33, wire::MAX_NAME_BYTES)?;
    let uri_end = bounded_string_end(&data, name_end, wire::MAX_URI_BYTES)?;
    require!(uri_end.checked_add(8) == Some(data.len()), E::CollectionPostcondition);
    let value = BaseCollectionV1::from_bytes(&data).map_err(|_| E::CollectionPostcondition)?;
    require!(value.key == CoreKey::CollectionV1 && value.update_authority == authority && value.current_size <= value.num_minted,
        E::CollectionPostcondition);
    Ok(value)
}
pub(crate) fn verify_created_asset(info: &AccountInfo<'_>, owner: Pubkey, collection: Pubkey, freeze: Pubkey, name: &str, uri: &str) -> Result<()> {
    require!(*info.owner == mpl_core::ID && !info.executable, E::AssetPostcondition);
    wire::validate_metadata(name, uri).map_err(|_| E::InvalidMetadata)?;
    let data = info.try_borrow_data()?;
    let base = BaseAssetV1 { key: CoreKey::AssetV1, owner, update_authority: UpdateAuthority::Collection(collection),
        name: name.to_owned(), uri: uri.to_owned(), seq: None };
    let mut expected = base.try_to_vec()?;
    // This is a fresh AccountState CreateV1, whose base has seq=None. Historical
    // compression-restored Some(seq) forms are outside this creation capability.
    let plugin_offset = expected.len().checked_add(PluginHeaderV1::LEN).ok_or(E::Arithmetic)? as u64;
    let plugin = Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: true }).try_to_vec()?;
    let registry_offset = plugin_offset.checked_add(plugin.len() as u64).ok_or(E::Arithmetic)?;
    expected.extend(PluginHeaderV1 { key: CoreKey::PluginHeaderV1, plugin_registry_offset: registry_offset }.try_to_vec()?);
    expected.extend(plugin);
    expected.extend(PluginRegistryV1 { key: CoreKey::PluginRegistryV1, registry: vec![RegistryRecord {
        plugin_type: PluginType::PermanentFreezeDelegate, authority: PluginAuthority::Address { address: freeze }, offset: plugin_offset }],
        external_registry: vec![] }.try_to_vec()?);
    require!(&**data == expected.as_slice(), E::AssetPostcondition);
    Ok(())
}
#[event]
pub struct CharterAdmissionPauseChanged { pub admin: Pubkey, pub paused: bool }
#[event]
pub struct CharterMinted { pub clan_id: [u8;16], pub creation_intent_id: [u8;16], pub charter: Pubkey, pub asset: Pubkey,
    pub leader: Pubkey, pub metadata_hash: [u8;32], pub admission_commitment: [u8;32], pub creation_permit_id: [u8;16], pub prefund_returned: u64 }

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::InstructionData;
    mod fixture { include!("../../test-fixtures/charter-core/vectors.rs"); }
    fn core_account<T>(bytes: &mut [u8], owner: &Pubkey, executable: bool, f: impl FnOnce(&AccountInfo<'_>) -> T) -> T {
        let key=Pubkey::new_from_array(fixture::ASSET); let mut lamports=1;
        f(&AccountInfo::new(&key,false,false,&mut lamports,bytes,owner,executable,0))
    }
    #[test]
    fn minted_asset_postcondition_binds_metadata_and_the_entire_frozen_profile() {
        let owner=Pubkey::new_from_array(fixture::OWNER); let collection=Pubkey::new_from_array(fixture::COLLECTION);
        let freeze=Pubkey::new_from_array(fixture::FREEZE_AUTHORITY);
        let check=|a:&AccountInfo<'_>| verify_created_asset(a,owner,collection,freeze,"Charter codec fixture","https://invalid.example/charter.json");
        assert!(core_account(&mut fixture::ASSET_NONE.to_vec(),&mpl_core::ID,false,check).is_ok());
        assert!(core_account(&mut fixture::ASSET_SOME.to_vec(),&mpl_core::ID,false,check).is_err());
        let mut some_zero=fixture::ASSET_SOME.to_vec(); some_zero[fixture::SEQ_TAG+1..fixture::SEQ_TAG+9].fill(0);
        assert!(core_account(&mut some_zero,&mpl_core::ID,false,check).is_err());
        for at in 0..fixture::ASSET_NONE.len() {
            let mut bytes=fixture::ASSET_NONE.to_vec(); bytes[at]^=1;
            assert!(core_account(&mut bytes,&mpl_core::ID,false,check).is_err(),"byte {at}");
        }
        let mut bytes=fixture::ASSET_NONE.to_vec(); bytes.push(0);
        assert!(core_account(&mut bytes,&mpl_core::ID,false,check).is_err());
        assert!(core_account(&mut fixture::ASSET_NONE.to_vec(),&owner,false,check).is_err());
        assert!(core_account(&mut fixture::ASSET_NONE.to_vec(),&mpl_core::ID,true,check).is_err());
        assert!(core_account(&mut fixture::ASSET_NONE.to_vec(),&mpl_core::ID,false,|a|
            verify_created_asset(a,owner,collection,freeze,"different consent","https://invalid.example/charter.json")).is_err());
    }
    #[test]
    fn collection_precheck_rejects_unbounded_metadata_and_any_nonplain_region() {
        let authority=Pubkey::new_from_array(fixture::COLLECTION_AUTHORITY);
        let check=|a:&AccountInfo<'_>| plain_collection(a,authority);
        assert!(core_account(&mut fixture::COLLECTION_BYTES.to_vec(),&mpl_core::ID,false,check).is_ok());
        for n in 0..fixture::COLLECTION_BYTES.len() {
            assert!(core_account(&mut fixture::COLLECTION_BYTES[..n].to_vec(),&mpl_core::ID,false,check).is_err());
        }
        let mut extra=fixture::COLLECTION_BYTES.to_vec(); extra.push(0);
        assert!(core_account(&mut extra,&mpl_core::ID,false,check).is_err());
        let mut huge=fixture::COLLECTION_BYTES.to_vec(); huge[33..37].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(core_account(&mut huge,&mpl_core::ID,false,check).is_err());
        assert!(core_account(&mut fixture::COLLECTION_BYTES.to_vec(),&authority,false,check).is_err());
        assert!(core_account(&mut fixture::COLLECTION_BYTES.to_vec(),&mpl_core::ID,true,check).is_err());
    }
    #[test]
    fn provisional_record_requires_every_consent_field_and_exact_initial_state() {
        use shardkeep_charter_interface as wire;
        let id=[0x12,0x34,0x56,0x78,0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0,0x12,0x34,0x56,0x78];
        let expected=wire::CharterView {version:1,config:[1;32],clan_id:id,asset:[2;32],collection:[3;32],leader:[4;32],revision:0,
            state:wire::CharterState::Minting,lock:wire::CharterLock::None,lock_id:[0;16],creation_intent_id:id,
            metadata_hash:[5;32],admission_commitment:[6;32],creation_permit_id:[7;16],created_at:123,bump:254};
        let mut bytes=wire::CHARTER_DISCRIMINATOR.to_vec(); bytes.push(1);
        bytes.extend([1;32]); bytes.extend(id); bytes.extend([2;32]); bytes.extend([3;32]); bytes.extend([4;32]);
        bytes.extend(0u32.to_le_bytes()); bytes.extend([0;18]); bytes.extend(id); bytes.extend([5;32]); bytes.extend([6;32]);
        bytes.extend([7;16]); bytes.extend(123i64.to_le_bytes()); bytes.push(254);
        assert!(validate_provisional(&bytes,&expected).is_ok());
        // Every byte is authenticated, including second UUID halves, initial locks,
        // revision, all permit fields and discriminator; no lossy wire normalization.
        for at in 0..bytes.len() { let mut other=bytes.clone(); other[at]^=1; assert!(validate_provisional(&other,&expected).is_err(),"byte {at}"); }
        let mut extra=bytes.clone(); extra.push(0); assert!(validate_provisional(&extra,&expected).is_err());
        assert!(validate_provisional(&bytes[..bytes.len()-1],&expected).is_err());
    }
    #[test]
    fn generated_anchor_mint_instruction_matches_the_shared_cpi_codec() {
        let clan_id=[0x12,0x34,0x56,0x78,0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0,0x12,0x34,0x56,0x78];
        let creation_intent_id=clan_id; let admission_commitment=[9;32]; let creation_permit_id=[7;16];
        let actual=crate::instruction::MintCharter {clan_id,creation_intent_id,admission_commitment,name:"Clan é".into(),uri:"https://invalid.example/charter".into(),creation_permit_id}.data();
        let expected=shardkeep_charter_interface::encode_mint(&shardkeep_charter_interface::MintArgs {clan_id,creation_intent_id,admission_commitment,name:"Clan é",uri:"https://invalid.example/charter",creation_permit_id}).unwrap();
        assert_eq!(&actual[..8],shardkeep_charter_interface::MINT_DISCRIMINATOR); assert_eq!(actual,expected);
    }
}
