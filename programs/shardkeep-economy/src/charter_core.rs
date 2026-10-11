//! Strict, SDK-free Charter Core profile. Synthetic codec tests do not establish
//! compatibility with a deployed Core executable. No registration/CPI authority.
use anchor_lang::prelude::{AccountInfo, Pubkey};

pub const CORE_PROGRAM_ID: Pubkey = Pubkey::from_str_const("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

// Technical scan bound for this deliberately narrow profile, not a game number
// or a claim about Core's metadata limits. Larger legitimate accounts are held.
const MAX_PROFILE_ACCOUNT_BYTES: usize = 4096;

/// These keys must come from authenticated configuration/derivation, never from
/// the submitted account data. The caller owns canonical craft PDA derivation.
#[derive(Clone, Copy, Debug)]
pub struct CharterCoreTrust {
    pub asset: Pubkey,
    pub collection: Pubkey,
    pub owner: Pubkey,
    pub freeze_authority: Pubkey,
    pub collection_authority: Pubkey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CharterCoreError {
    InvalidTrust, AccountIdentity, AccountBorrow, Malformed, UnsupportedProfile,
    OwnerMismatch, CollectionMismatch, FreezeAuthority, CollectionAuthority, NotFrozen,
}

/// Accept only a Collection-linked AssetV1 with one contiguous asset-local,
/// frozen PermanentFreezeDelegate controlled by the explicitly trusted address.
/// The CollectionV1 has no plugins/adapters and an independently pinned update
/// authority. Reject all padding, unknown/additional/duplicate plugin records.
/// This authenticates present account bytes, not future collection governance:
/// its authority could later install a lifecycle override. The future admission
/// caller must establish control of both authorities and reviewed Core code.
pub fn verify_charter_core(asset: &AccountInfo<'_>, collection: &AccountInfo<'_>,
    trust: &CharterCoreTrust) -> Result<(), CharterCoreError> {
    let keys = [trust.asset, trust.collection, trust.owner, trust.freeze_authority, trust.collection_authority];
    if keys.iter().any(|k| *k == Pubkey::default() || *k == CORE_PROGRAM_ID) || trust.asset == trust.collection {
        return Err(CharterCoreError::InvalidTrust);
    }
    if asset.key != &trust.asset || collection.key != &trust.collection
        || asset.owner != &CORE_PROGRAM_ID || collection.owner != &CORE_PROGRAM_ID
        || asset.executable || collection.executable {
        return Err(CharterCoreError::AccountIdentity);
    }
    let asset_data = asset.try_borrow_data().map_err(|_| CharterCoreError::AccountBorrow)?;
    let collection_data = collection.try_borrow_data().map_err(|_| CharterCoreError::AccountBorrow)?;
    if asset_data.len() > MAX_PROFILE_ACCOUNT_BYTES || collection_data.len() > MAX_PROFILE_ACCOUNT_BYTES {
        return Err(CharterCoreError::UnsupportedProfile);
    }
    verify_collection(&collection_data, trust)?;
    verify_asset(&asset_data, trust)
}

// Raw mpl-core 1.10.0 generated Borsh codecs; see test-fixtures/charter-core.
// Do not use the JS hooked registry's unknown-record filtering as a specification.
fn verify_collection(data: &[u8], trust: &CharterCoreTrust) -> Result<(), CharterCoreError> {
    let mut r = Cursor { data, at: 0 };
    r.tag(5)?; // CollectionV1
    if r.key()? != trust.collection_authority { return Err(CharterCoreError::CollectionAuthority); }
    r.string()?; r.string()?;
    let minted = r.u32()?; let size = r.u32()?;
    if size == 0 || size > minted { return Err(CharterCoreError::Malformed); }
    // This also excludes inherited PermanentTransfer/BurnDelegate overrides.
    r.end()
}

fn verify_asset(data: &[u8], trust: &CharterCoreTrust) -> Result<(), CharterCoreError> {
    let mut r = Cursor { data, at: 0 };
    r.tag(1)?; // AssetV1, not a compressed/hashed asset
    if r.key()? != trust.owner { return Err(CharterCoreError::OwnerMismatch); }
    r.tag(2)?; // BaseUpdateAuthority::Collection
    if r.key()? != trust.collection { return Err(CharterCoreError::CollectionMismatch); }
    r.string()?; r.string()?;
    match r.byte()? { 0 => {}, 1 => { r.u64()?; }, _ => return Err(CharterCoreError::Malformed) }
    r.tag(3)?; // PluginHeaderV1
    let registry_offset = r.u64()?;
    let plugin_offset = r.at;
    // One supported payload, in-place. No jumping to attacker-provided offsets.
    r.tag(5)?; // Plugin::PermanentFreezeDelegate
    match r.byte()? { 1 => {}, 0 => return Err(CharterCoreError::NotFrozen), _ => return Err(CharterCoreError::Malformed) }
    if registry_offset != r.at as u64 { return Err(CharterCoreError::Malformed); }
    r.tag(4)?; // PluginRegistryV1
    if r.u32()? != 1 { return Err(CharterCoreError::UnsupportedProfile); }
    r.tag(5)?; // registry PluginType::PermanentFreezeDelegate
    r.tag(3)?; // BasePluginAuthority::Address, never Owner/UpdateAuthority/None
    if r.key()? != trust.freeze_authority { return Err(CharterCoreError::FreezeAuthority); }
    if r.u64()? != plugin_offset as u64 { return Err(CharterCoreError::Malformed); }
    if r.u32()? != 0 { return Err(CharterCoreError::UnsupportedProfile); } // no external adapters
    r.end()
}

/// Allocation-free checked cursor. All offsets remain inside the bounded input;
/// lengths are checked before slicing/UTF-8 scans and never determine allocation.
struct Cursor<'a> { data: &'a [u8], at: usize }
impl<'a> Cursor<'a> {
    fn take(&mut self, size: usize) -> Result<&'a [u8], CharterCoreError> {
        let end = self.at.checked_add(size).ok_or(CharterCoreError::Malformed)?;
        let value = self.data.get(self.at..end).ok_or(CharterCoreError::Malformed)?;
        self.at = end; Ok(value)
    }
    fn byte(&mut self) -> Result<u8, CharterCoreError> { Ok(self.take(1)?[0]) }
    fn tag(&mut self, expected: u8) -> Result<(), CharterCoreError> {
        if self.byte()? != expected { return Err(CharterCoreError::UnsupportedProfile); } Ok(())
    }
    fn u32(&mut self) -> Result<u32, CharterCoreError> {
        let mut bytes = [0;4]; bytes.copy_from_slice(self.take(4)?); Ok(u32::from_le_bytes(bytes))
    }
    fn u64(&mut self) -> Result<u64, CharterCoreError> {
        let mut bytes = [0;8]; bytes.copy_from_slice(self.take(8)?); Ok(u64::from_le_bytes(bytes))
    }
    fn key(&mut self) -> Result<Pubkey, CharterCoreError> {
        let mut bytes = [0;32]; bytes.copy_from_slice(self.take(32)?); Ok(Pubkey::new_from_array(bytes))
    }
    fn string(&mut self) -> Result<(), CharterCoreError> {
        let size = usize::try_from(self.u32()?).map_err(|_| CharterCoreError::Malformed)?;
        core::str::from_utf8(self.take(size)?).map_err(|_| CharterCoreError::Malformed)?; Ok(())
    }
    fn end(&self) -> Result<(), CharterCoreError> {
        if self.at != self.data.len() { return Err(CharterCoreError::UnsupportedProfile); } Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    mod fixture { include!("../../test-fixtures/charter-core/vectors.rs"); }
    use fixture::*;

    fn trust() -> CharterCoreTrust {
        CharterCoreTrust { asset: Pubkey::new_from_array(ASSET), collection: Pubkey::new_from_array(COLLECTION),
            owner: Pubkey::new_from_array(OWNER), freeze_authority: Pubkey::new_from_array(FREEZE_AUTHORITY),
            collection_authority: Pubkey::new_from_array(COLLECTION_AUTHORITY) }
    }
    fn accounts<T>(a: &[u8], c: &[u8], f: impl FnOnce(&AccountInfo<'_>, &AccountInfo<'_>) -> T) -> T {
        let t = trust(); let mut ab = a.to_vec(); let mut cb = c.to_vec();
        let mut al = 1; let mut cl = 1;
        let asset = AccountInfo::new(&t.asset, false, false, &mut al, &mut ab, &CORE_PROGRAM_ID, false, 0);
        let collection = AccountInfo::new(&t.collection, false, false, &mut cl, &mut cb, &CORE_PROGRAM_ID, false, 0);
        f(&asset, &collection)
    }
    fn check(a: &[u8], c: &[u8]) -> Result<(), CharterCoreError> {
        accounts(a, c, |a,c| verify_charter_core(a,c,&trust()))
    }
    fn valid() { assert_eq!(check(ASSET_NONE, COLLECTION_BYTES), Ok(())); }
    fn rejects(a: &[u8], c: &[u8]) { assert!(check(a,c).is_err()); }
    fn mutate(index: usize, value: u8) -> Vec<u8> { let mut b = ASSET_NONE.to_vec(); b[index] = value; b }

    #[test]
    fn accepts_only_the_explicit_asset_local_frozen_profile_and_both_sequence_forms() {
        valid(); assert_eq!(check(ASSET_SOME, COLLECTION_BYTES), Ok(()));
        // A maximum sequence is an opaque codec field, not a fabricated lifecycle counter.
        assert_eq!(ASSET_SOME.len(), ASSET_NONE.len() + 8);
    }
    #[test]
    fn authenticates_runtime_accounts_not_just_plausible_payload_bytes() {
        valid(); const WRONG: Pubkey = Pubkey::new_from_array([90;32]);
        accounts(ASSET_NONE,COLLECTION_BYTES,|a,c| {
            let mut fake = a.clone(); fake.owner = &WRONG;
            assert_eq!(verify_charter_core(&fake,c,&trust()),Err(CharterCoreError::AccountIdentity));
            fake = a.clone(); fake.key = &WRONG;
            assert_eq!(verify_charter_core(&fake,c,&trust()),Err(CharterCoreError::AccountIdentity));
            fake = a.clone(); fake.executable = true;
            assert_eq!(verify_charter_core(&fake,c,&trust()),Err(CharterCoreError::AccountIdentity));
            let mut fake = c.clone(); fake.owner = &WRONG;
            assert_eq!(verify_charter_core(a,&fake,&trust()),Err(CharterCoreError::AccountIdentity));
            fake = c.clone(); fake.key = &WRONG;
            assert_eq!(verify_charter_core(a,&fake,&trust()),Err(CharterCoreError::AccountIdentity));
            fake = c.clone(); fake.executable = true;
            assert_eq!(verify_charter_core(a,&fake,&trust()),Err(CharterCoreError::AccountIdentity));
            assert!(verify_charter_core(c,a,&trust()).is_err());
        });
    }
    #[test]
    fn requires_nonzero_trusted_keys_distinct_accounts_and_exact_payload_bindings() {
        valid();
        for index in 0..5 { for value in [Pubkey::default(),CORE_PROGRAM_ID] {
            let mut t = trust(); let fields = [&mut t.asset,&mut t.collection,&mut t.owner,&mut t.freeze_authority,&mut t.collection_authority];
            *fields.into_iter().nth(index).unwrap() = value;
            accounts(ASSET_NONE,COLLECTION_BYTES,|a,c| assert_eq!(verify_charter_core(a,c,&t),Err(CharterCoreError::InvalidTrust)));
        }}
        let mut t = trust(); t.collection = t.asset;
        accounts(ASSET_NONE,COLLECTION_BYTES,|a,c| assert_eq!(verify_charter_core(a,c,&t),Err(CharterCoreError::InvalidTrust)));
        // Both explicitly trusted controls may safely be the same craft PDA.
        let mut t = trust(); t.collection_authority = t.freeze_authority;
        let mut c = COLLECTION_BYTES.to_vec(); c[1..33].copy_from_slice(t.freeze_authority.as_ref());
        accounts(ASSET_NONE,&c,|a,c| assert_eq!(verify_charter_core(a,c,&t),Ok(())));
        assert_eq!(check(&mutate(1,90),COLLECTION_BYTES),Err(CharterCoreError::OwnerMismatch));
        assert_eq!(check(&mutate(34,90),COLLECTION_BYTES),Err(CharterCoreError::CollectionMismatch));
        let mut c = COLLECTION_BYTES.to_vec(); c[1] = 90;
        assert_eq!(check(ASSET_NONE,&c),Err(CharterCoreError::CollectionAuthority));
    }
    #[test]
    fn rejects_all_truncations_without_panicking() {
        valid();
        for n in 0..ASSET_NONE.len() { rejects(&ASSET_NONE[..n],COLLECTION_BYTES); }
        for n in 0..ASSET_SOME.len() { rejects(&ASSET_SOME[..n],COLLECTION_BYTES); }
        for n in 0..COLLECTION_BYTES.len() { rejects(ASSET_NONE,&COLLECTION_BYTES[..n]); }
    }
    #[test]
    fn rejects_wrong_account_and_update_authority_discriminants() {
        valid();
        for tag in [0,2,3,4,5,6,255] { rejects(&mutate(0,tag),COLLECTION_BYTES); }
        for tag in [0,1,3,255] { rejects(&mutate(33,tag),COLLECTION_BYTES); }
        for tag in [0,1,2,3,4,6,255] { let mut c=COLLECTION_BYTES.to_vec(); c[0]=tag; rejects(ASSET_NONE,&c); }
    }
    #[test]
    fn requires_canonical_frozen_boolean_and_sequence_option() {
        valid();
        for tag in [0,2,255] { rejects(&mutate(PLUGIN_START+1,tag),COLLECTION_BYTES); }
        for tag in [2,255] { rejects(&mutate(SEQ_TAG,tag),COLLECTION_BYTES); }
        // Changing None to Some without the eight bytes cannot move the plugin header safely.
        rejects(&mutate(SEQ_TAG,1),COLLECTION_BYTES);
    }
    #[test]
    fn rejects_owner_update_none_or_wrong_explicit_freeze_authorities() {
        valid();
        for tag in [0,1,2,4,255] { rejects(&mutate(REGISTRY_START+6,tag),COLLECTION_BYTES); }
        assert_eq!(check(&mutate(REGISTRY_START+7,90),COLLECTION_BYTES),Err(CharterCoreError::FreezeAuthority));
    }
    #[test]
    fn rejects_missing_duplicate_unknown_and_additional_plugins_and_adapters() {
        valid(); rejects(&ASSET_NONE[..BASE_END],COLLECTION_BYTES);
        for n in [0u32,2,u32::MAX] { let mut a=ASSET_NONE.to_vec(); a[REGISTRY_START+1..REGISTRY_START+5].copy_from_slice(&n.to_le_bytes()); rejects(&a,COLLECTION_BYTES); }
        for tag in [0,1,7,8,16,255] { rejects(&mutate(REGISTRY_START+5,tag),COLLECTION_BYTES); rejects(&mutate(PLUGIN_START,tag),COLLECTION_BYTES); }
        let mut a=ASSET_NONE.to_vec(); let end=a.len(); a[end-4..].copy_from_slice(&1u32.to_le_bytes()); rejects(&a,COLLECTION_BYTES);
        // An actual duplicate registry record is rejected, not normalized to one plugin.
        let mut a=ASSET_NONE.to_vec(); let end=a.len(); let record=a[REGISTRY_START+5..end-4].to_vec();
        a.splice(end-4..end-4,record); a[REGISTRY_START+1..REGISTRY_START+5].copy_from_slice(&2u32.to_le_bytes()); rejects(&a,COLLECTION_BYTES);
    }
    #[test]
    fn rejects_registry_and_payload_offsets_into_any_other_region_or_past_end() {
        valid();
        for offset in [0,1,BASE_END as u64,(PLUGIN_START-1) as u64,PLUGIN_START as u64,(REGISTRY_START+1) as u64,ASSET_NONE.len() as u64,u64::MAX] {
            let mut a=ASSET_NONE.to_vec(); a[BASE_END+1..BASE_END+9].copy_from_slice(&offset.to_le_bytes()); rejects(&a,COLLECTION_BYTES);
        }
        for offset in [0,BASE_END as u64,(PLUGIN_START-1) as u64,(PLUGIN_START+1) as u64,REGISTRY_START as u64,ASSET_NONE.len() as u64,u64::MAX] {
            let mut a=ASSET_NONE.to_vec(); a[REGISTRY_START+39..REGISTRY_START+47].copy_from_slice(&offset.to_le_bytes()); rejects(&a,COLLECTION_BYTES);
        }
        for (index,tag) in [(BASE_END,4),(REGISTRY_START,3)] { rejects(&mutate(index,tag),COLLECTION_BYTES); }
    }
    #[test]
    fn rejects_padding_gaps_and_trailing_bytes_even_when_offsets_are_repaired() {
        valid();
        let mut a=ASSET_NONE.to_vec(); a.push(0); rejects(&a,COLLECTION_BYTES);
        let mut a=ASSET_NONE.to_vec(); a.insert(PLUGIN_START,0); a[BASE_END+1..BASE_END+9].copy_from_slice(&((REGISTRY_START+1) as u64).to_le_bytes());
        a[REGISTRY_START+40..REGISTRY_START+48].copy_from_slice(&((PLUGIN_START+1) as u64).to_le_bytes()); rejects(&a,COLLECTION_BYTES);
    }
    #[test]
    fn validates_string_lengths_and_utf8_without_allocating_from_untrusted_lengths() {
        valid();
        for index in [NAME_LENGTH,URI_LENGTH] { let mut a=ASSET_NONE.to_vec(); a[index..index+4].copy_from_slice(&u32::MAX.to_le_bytes()); rejects(&a,COLLECTION_BYTES); }
        rejects(&mutate(NAME_START,255),COLLECTION_BYTES); rejects(&mutate(URI_LENGTH+4,255),COLLECTION_BYTES);
        let mut c=COLLECTION_BYTES.to_vec(); c[33..37].copy_from_slice(&u32::MAX.to_le_bytes()); rejects(ASSET_NONE,&c);
        let mut c=COLLECTION_BYTES.to_vec(); c[37]=255; rejects(ASSET_NONE,&c);
        let mut a=ASSET_NONE.to_vec(); a.resize(4097,0); rejects(&a,COLLECTION_BYTES);
        let mut c=COLLECTION_BYTES.to_vec(); c.resize(4097,0); rejects(ASSET_NONE,&c);
    }
    #[test]
    fn collection_cannot_supply_or_hide_a_lifecycle_override() {
        valid();
        // Even an empty plugin registry is outside the supported plugin-free collection profile.
        let mut c=COLLECTION_BYTES.to_vec(); let offset=(c.len()+9) as u64;
        c.push(3); c.extend_from_slice(&offset.to_le_bytes()); c.extend_from_slice(&[4,0,0,0,0,0,0,0,0]); rejects(ASSET_NONE,&c);
        let mut c=COLLECTION_BYTES.to_vec(); c.push(0); rejects(ASSET_NONE,&c);
        let mut c=COLLECTION_BYTES.to_vec(); let end=c.len(); c[end-4..].copy_from_slice(&2u32.to_le_bytes()); rejects(ASSET_NONE,&c);
        let mut c=COLLECTION_BYTES.to_vec(); let end=c.len(); c[end-4..].copy_from_slice(&0u32.to_le_bytes()); rejects(ASSET_NONE,&c);
        // Putting the valid asset plugin region on the collection does not prove an asset-local freeze.
        let mut c=COLLECTION_BYTES.to_vec(); c.extend_from_slice(&ASSET_NONE[BASE_END..]); rejects(&ASSET_NONE[..BASE_END],&c);
    }
    #[test]
    fn borrowed_data_fails_closed_and_success_never_mutates_accounts() {
        valid(); accounts(ASSET_NONE,COLLECTION_BYTES,|a,c| {
            let hold=a.try_borrow_mut_data().unwrap(); assert_eq!(verify_charter_core(a,c,&trust()),Err(CharterCoreError::AccountBorrow)); drop(hold);
            let hold=c.try_borrow_mut_data().unwrap(); assert_eq!(verify_charter_core(a,c,&trust()),Err(CharterCoreError::AccountBorrow)); drop(hold);
            assert_eq!(verify_charter_core(a,c,&trust()),Ok(()));
            assert_eq!(&**a.try_borrow_data().unwrap(),ASSET_NONE); assert_eq!(&**c.try_borrow_data().unwrap(),COLLECTION_BYTES);
        });
    }
}
