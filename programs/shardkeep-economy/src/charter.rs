//! Atomic purpose-bound Charter registration. No transfer, thaw or repair capability.
use anchor_lang::prelude::*;
use crate::{EconomyError, state::{SeekerAuthority, PermitReceipt, AUTHORITY_SEED, PERMIT_SEED}, permit::PermitArgs, charter_state::*};
use EconomyError as E;
use shardkeep_charter_interface::RegistrationCommitment;

pub fn metadata_hash(name: &str, uri: &str) -> Result<[u8;32]> {
    let bytes=shardkeep_charter_interface::metadata_preimage(name,uri).map_err(|_|EconomyError::InvalidPermit)?;
    Ok(solana_keccak_hasher::hash(&bytes).0)
}
pub fn registration_payload(value: &RegistrationCommitment) -> Result<[u8;32]> {
    let bytes=shardkeep_charter_interface::registration_preimage(value).map_err(|_|EconomyError::InvalidPermit)?;
    Ok(solana_keccak_hasher::hash(&bytes).0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_uses_the_existing_program_keccak_of_the_versioned_preimage() {
        let expected=solana_keccak_hasher::hash(b"SKCHMET1\x02\0\0\0ab\x01\0\0\0c").0;
        assert_eq!(metadata_hash("ab","c").unwrap(),expected);
    }
}

#[cfg(not(feature = "devnet-test"))]
pub const CRAFT_PROGRAM_ID: Pubkey = Pubkey::from_str_const("4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59"); #[cfg(feature = "devnet-test")] pub const CRAFT_PROGRAM_ID: Pubkey = crate::DEVNET_TEST_CRAFT_PROGRAM_ID;
pub fn require_top_level_registration() -> Result<()> {
    use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, E::CharterTopLevelOnly); Ok(())
}
#[derive(Accounts)]
pub struct InitializeCharterConfig<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ E::Unauthorized)]
    pub program: Program<'info, crate::program::ShardkeepEconomy>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ E::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(seeds = [AUTHORITY_SEED], bump = authority.bump, constraint = authority.version == 1 @ E::InvalidVersion)]
    pub authority: Account<'info, SeekerAuthority>,
    #[account(init, payer = admin, space = 8 + CharterConfig::INIT_SPACE, seeds = [b"charter_config"], bump)]
    pub config: Account<'info, CharterConfig>,
    /// CHECK: Fixed executable capability.
    #[account(address = CRAFT_PROGRAM_ID, executable)] pub craft_program: UncheckedAccount<'info>,
    /// CHECK: Exact craft-owned wire profile checked in handler.
    #[account(seeds = [b"charter_control"], bump, seeds::program = CRAFT_PROGRAM_ID, owner = CRAFT_PROGRAM_ID)]
    pub craft_control: UncheckedAccount<'info>,
    /// CHECK: Canonical controlled collection; no caller-supplied config pins.
    #[account(seeds = [b"charter_collection"], bump, seeds::program = CRAFT_PROGRAM_ID)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: Canonical craft authority.
    #[account(seeds = [b"charter_collection_authority"], bump, seeds::program = CRAFT_PROGRAM_ID)]
    pub collection_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(clan_id: [u8;16], creation_intent_id: [u8;16], admission_commitment: [u8;32], name: String, uri: String, permit: PermitArgs)]
pub struct RegisterCharter<'info> {
    #[account(mut)] pub leader: Signer<'info>,
    #[account(seeds = [AUTHORITY_SEED], bump = authority.bump, constraint = authority.version == 1 @ E::InvalidVersion)]
    pub authority: Box<Account<'info, SeekerAuthority>>,
    #[account(seeds = [b"charter_config"], bump = config.bump, has_one = authority,
        has_one = craft_program, has_one = craft_control, has_one = collection, has_one = collection_authority,
        constraint = config.version == 1 @ E::InvalidVersion)]
    pub config: Box<Account<'info, CharterConfig>>,
    #[account(init, payer = leader, space = 8 + ClanCharter::INIT_SPACE, seeds = [b"charter", clan_id.as_ref()], bump)]
    pub charter: Box<Account<'info, ClanCharter>>,
    #[account(init, payer = leader, space = 8 + CharterAssetBinding::INIT_SPACE, seeds = [b"charter_asset", asset.key().as_ref()], bump)]
    pub asset_binding: Box<Account<'info, CharterAssetBinding>>,
    #[account(init, payer = leader, space = 8 + CharterCreationReceipt::INIT_SPACE, seeds = [b"charter_creation", creation_intent_id.as_ref()], bump)]
    pub creation_receipt: Box<Account<'info, CharterCreationReceipt>>,
    #[account(init, payer = leader, space = 8 + PermitReceipt::INIT_SPACE, seeds = [PERMIT_SEED, permit.permit_id.as_ref()], bump)]
    pub receipt: Box<Account<'info, PermitReceipt>>,
    /// CHECK: Canonical economy signer capability, signed only for fixed craft mint.
    #[account(seeds = [b"charter_executor", clan_id.as_ref()], bump)] pub executor: UncheckedAccount<'info>,
    /// CHECK: Fixed executable capability.
    #[account(address = CRAFT_PROGRAM_ID, executable)] pub craft_program: UncheckedAccount<'info>,
    /// CHECK: Exact craft-owned control bytes checked before CPI.
    #[account(seeds = [b"charter_control"], bump, seeds::program = CRAFT_PROGRAM_ID, owner = CRAFT_PROGRAM_ID)]
    pub craft_control: UncheckedAccount<'info>,
    /// CHECK: Craft validates empty System state, creates and postvalidates Core asset.
    #[account(mut, seeds = [b"charter_mint", clan_id.as_ref()], bump, seeds::program = CRAFT_PROGRAM_ID)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: Canonical collection checked by craft and strict Core postvalidation.
    #[account(mut, seeds = [b"charter_collection"], bump, seeds::program = CRAFT_PROGRAM_ID)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: Canonical craft authority.
    #[account(seeds = [b"charter_collection_authority"], bump, seeds::program = CRAFT_PROGRAM_ID)]
    pub collection_authority: UncheckedAccount<'info>,
    /// CHECK: Canonical per-clan freeze authority; never signed by economy.
    #[account(seeds = [b"charter_freeze", clan_id.as_ref()], bump, seeds::program = CRAFT_PROGRAM_ID)]
    pub freeze_authority: UncheckedAccount<'info>,
    /// CHECK: Fixed Core executable.
    #[account(address = crate::charter_core::CORE_PROGRAM_ID, executable)] pub mpl_core_program: UncheckedAccount<'info>,
    /// CHECK: Native instruction evidence only.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub economy_program: Program<'info, crate::program::ShardkeepEconomy>,
}

fn control_view(control: &AccountInfo<'_>, collection: Pubkey, collection_authority: Pubkey) -> Result<shardkeep_charter_interface::ControlView> {
    require!(*control.owner == CRAFT_PROGRAM_ID && !control.executable, E::CharterIdentity);
    let view = shardkeep_charter_interface::decode_control(&control.try_borrow_data()?).map_err(|_| E::CharterIdentity)?;
    let (control_key, control_bump) = Pubkey::find_program_address(&[b"charter_control"], &CRAFT_PROGRAM_ID);
    let (collection_key, collection_bump) = Pubkey::find_program_address(&[b"charter_collection"], &CRAFT_PROGRAM_ID);
    let (authority_key, authority_bump) = Pubkey::find_program_address(&[b"charter_collection_authority"], &CRAFT_PROGRAM_ID);
    require!(control.key() == control_key && view.economy_program == crate::ID.to_bytes()
        && collection == collection_key && collection_authority == authority_key
        && view.collection == collection.to_bytes() && view.collection_authority == collection_authority.to_bytes()
        && view.bump == control_bump && view.collection_bump == collection_bump && view.authority_bump == authority_bump,
        E::CharterIdentity);
    Ok(view)
}
pub fn initialize(ctx: Context<InitializeCharterConfig>) -> Result<()> {
    require!(ctx.remaining_accounts.is_empty(), E::CharterIdentity);
    control_view(&ctx.accounts.craft_control.to_account_info(), ctx.accounts.collection.key(), ctx.accounts.collection_authority.key())?;
    require!(*ctx.accounts.collection.owner == crate::charter_core::CORE_PROGRAM_ID && !ctx.accounts.collection.executable,
        E::CharterIdentity);
    ctx.accounts.config.set_inner(CharterConfig { version: shardkeep_charter_interface::VERSION,
        authority: ctx.accounts.authority.key(), craft_program: CRAFT_PROGRAM_ID, craft_control: ctx.accounts.craft_control.key(),
        collection: ctx.accounts.collection.key(), collection_authority: ctx.accounts.collection_authority.key(), bump: ctx.bumps.config });
    emit!(CharterConfigInitialized { config: ctx.accounts.config.key(), admin: ctx.accounts.admin.key(),
        authority: ctx.accounts.authority.key(), collection: ctx.accounts.collection.key() });
    Ok(())
}
// Keep each stage in its own SBF frame. None of these helpers changes the
// instruction ABI; large CPI account lists are built directly on the heap.
struct RegistrationRequest {
    clan_id: [u8;16],
    creation_intent_id: [u8;16],
    admission_commitment: [u8;32],
    name: String,
    uri: String,
    permit: PermitArgs,
}
struct RegistrationEvidence { metadata_hash: [u8;32], payload: [u8;32], now: i64 }

pub fn register(ctx: Context<RegisterCharter>, clan_id: [u8;16], creation_intent_id: [u8;16], admission_commitment: [u8;32], name: String, uri: String, permit: PermitArgs) -> Result<()> {
    require!(ctx.remaining_accounts.is_empty(), E::CharterIdentity);
    let request = RegistrationRequest { clan_id, creation_intent_id, admission_commitment, name, uri, permit };
    let evidence = authorize_registration(ctx.accounts, &request)?;
    stage_registration(ctx.accounts, &request, &evidence, ctx.bumps.charter)?;
    mint_registration(ctx.accounts, &request, ctx.bumps.executor)?;
    finish_registration(ctx.accounts, &request, &evidence, &ctx.bumps)
}

#[inline(never)]
fn authorize_registration(a: &RegisterCharter<'_>, r: &RegistrationRequest) -> Result<RegistrationEvidence> {
    use crate::permit as policy;
    let control = control_view(&a.craft_control.to_account_info(), a.collection.key(), a.collection_authority.key())?;
    require!(!a.authority.admission_paused && !control.admission_paused, E::Paused);
    let metadata_hash = metadata_hash(&r.name, &r.uri)?;
    let payload = registration_payload(&RegistrationCommitment { config: a.config.key().to_bytes(), craft_program: CRAFT_PROGRAM_ID.to_bytes(),
        craft_control: a.craft_control.key().to_bytes(), collection: a.collection.key().to_bytes(), collection_authority: a.collection_authority.key().to_bytes(),
        charter: a.charter.key().to_bytes(), asset: a.asset.key().to_bytes(), asset_binding: a.asset_binding.key().to_bytes(),
        freeze_authority: a.freeze_authority.key().to_bytes(), executor: a.executor.key().to_bytes(), creation_receipt: a.creation_receipt.key().to_bytes(),
        clan_id: r.clan_id, leader: a.leader.key().to_bytes(), creation_intent_id: r.creation_intent_id, metadata_hash, admission_commitment: r.admission_commitment })?;
    let now = Clock::get()?.unix_timestamp;
    policy::verify(&a.authority, a.leader.key(), policy::CHARTER_REGISTER_KIND, &r.permit, payload, &a.instructions.to_account_info(), now)?;
    Ok(RegistrationEvidence { metadata_hash, payload, now })
}

#[inline(never)]
fn stage_registration(a: &mut RegisterCharter<'_>, r: &RegistrationRequest, evidence: &RegistrationEvidence, bump: u8) -> Result<()> {
    a.charter.set_inner(ClanCharter { version: shardkeep_charter_interface::VERSION, config: a.config.key(), clan_id: r.clan_id,
        asset: a.asset.key(), collection: a.collection.key(), leader: a.leader.key(), revision: 0, state: 0, lock_kind: 0, lock_id: [0;16],
        creation_intent_id: r.creation_intent_id, metadata_hash: evidence.metadata_hash, admission_commitment: r.admission_commitment,
        creation_permit_id: r.permit.permit_id, created_at: evidence.now, bump });
    // Anchor normally serializes at instruction exit. Craft must authenticate this
    // provisional state during CPI, so persist it explicitly. Both borrows are
    // released when this helper returns, before the caller invokes craft.
    let info = a.charter.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    a.charter.try_serialize(&mut &mut data[..])?;
    Ok(())
}

#[inline(never)]
fn mint_registration(a: &RegisterCharter<'_>, r: &RegistrationRequest, executor_bump: u8) -> Result<()> {
    use anchor_lang::solana_program::{instruction::{Instruction, AccountMeta}, program::invoke_signed};
    use shardkeep_charter_interface as wire;
    let data = wire::encode_mint(&wire::MintArgs { clan_id: r.clan_id, creation_intent_id: r.creation_intent_id, admission_commitment: r.admission_commitment,
        name: &r.name, uri: &r.uri, creation_permit_id: r.permit.permit_id }).map_err(|_| E::InvalidPermit)?;
    let mut accounts = Vec::with_capacity(11);
    accounts.push(AccountMeta::new(a.leader.key(), true));
    accounts.push(AccountMeta::new_readonly(a.executor.key(), true));
    accounts.push(AccountMeta::new_readonly(a.economy_program.key(), false));
    accounts.push(AccountMeta::new_readonly(a.craft_control.key(), false));
    accounts.push(AccountMeta::new_readonly(a.charter.key(), false));
    accounts.push(AccountMeta::new(a.asset.key(), false));
    accounts.push(AccountMeta::new(a.collection.key(), false));
    accounts.push(AccountMeta::new_readonly(a.collection_authority.key(), false));
    accounts.push(AccountMeta::new_readonly(a.freeze_authority.key(), false));
    accounts.push(AccountMeta::new_readonly(a.mpl_core_program.key(), false));
    accounts.push(AccountMeta::new_readonly(a.system_program.key(), false));
    let instruction = Instruction { program_id: CRAFT_PROGRAM_ID, data, accounts };
    let mut infos = Vec::with_capacity(12);
    infos.push(a.leader.to_account_info());
    infos.push(a.executor.to_account_info());
    infos.push(a.economy_program.to_account_info());
    infos.push(a.craft_control.to_account_info());
    infos.push(a.charter.to_account_info());
    infos.push(a.asset.to_account_info());
    infos.push(a.collection.to_account_info());
    infos.push(a.collection_authority.to_account_info());
    infos.push(a.freeze_authority.to_account_info());
    infos.push(a.mpl_core_program.to_account_info());
    infos.push(a.system_program.to_account_info());
    infos.push(a.craft_program.to_account_info());
    let bump = [executor_bump];
    invoke_signed(&instruction, &infos, &[&[b"charter_executor", &r.clan_id, &bump]])?;
    Ok(())
}

#[inline(never)]
fn finish_registration(a: &mut RegisterCharter<'_>, r: &RegistrationRequest, evidence: &RegistrationEvidence, bumps: &RegisterCharterBumps) -> Result<()> {
    use crate::{permit as policy, charter_core::{verify_charter_core, CharterCoreTrust}};
    use shardkeep_charter_interface as wire;
    verify_charter_core(&a.asset.to_account_info(), &a.collection.to_account_info(), &CharterCoreTrust {
        asset: a.asset.key(), collection: a.collection.key(), owner: a.leader.key(), freeze_authority: a.freeze_authority.key(),
        collection_authority: a.collection_authority.key() }).map_err(|_| E::CharterCore)?;
    a.charter.state = 1;
    a.asset_binding.set_inner(CharterAssetBinding { version: wire::VERSION, asset: a.asset.key(), clan_id: r.clan_id,
        charter: a.charter.key(), bump: bumps.asset_binding });
    a.creation_receipt.set_inner(CharterCreationReceipt { version: wire::VERSION, intent_id: r.creation_intent_id, clan_id: r.clan_id,
        charter: a.charter.key(), asset: a.asset.key(), leader: a.leader.key(), permit_id: r.permit.permit_id, bump: bumps.creation_receipt });
    policy::consume(&mut a.receipt, a.leader.key(), policy::CHARTER_REGISTER_KIND, &r.permit, evidence.payload, evidence.now, bumps.receipt);
    emit!(CharterRegistered { charter: a.charter.key(), clan_id: r.clan_id, creation_intent_id: r.creation_intent_id, asset: a.asset.key(), leader: a.leader.key(),
        metadata_hash: evidence.metadata_hash, admission_commitment: r.admission_commitment, permit_id: r.permit.permit_id });
    Ok(())
}
#[event]
pub struct CharterConfigInitialized { pub config: Pubkey, pub admin: Pubkey, pub authority: Pubkey, pub collection: Pubkey }
#[event]
pub struct CharterRegistered { pub charter: Pubkey, pub clan_id: [u8;16], pub creation_intent_id: [u8;16], pub asset: Pubkey,
    pub leader: Pubkey, pub metadata_hash: [u8;32], pub admission_commitment: [u8;32], pub permit_id: [u8;16] }
