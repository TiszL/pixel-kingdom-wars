//! Local byte-fixture CLI only. No RPC, signing or program entrypoint.
//! Fixed argv: --asset PATH --collection PATH --asset-key BASE58
//! --collection-key BASE58 --owner BASE58 --freeze-authority BASE58
//! --collection-authority BASE58
//!
//! The loopback runner must independently verify each real fetched account's key,
//! Core owner and nonexecutable flag. Those runtime facts are supplied here as
//! local test facts; they are NOT authenticated by the binary files themselves.
use anchor_lang::prelude::{AccountInfo, Pubkey};
use shardkeep_economy::charter_core::{verify_charter_core, CharterCoreError, CharterCoreTrust, CORE_PROGRAM_ID};
use std::{ffi::OsString, io::Read, path::PathBuf, str::FromStr};

const MAX_BYTES: usize = 4096;
const USAGE: &str = "--asset PATH --collection PATH --asset-key BASE58 --collection-key BASE58 --owner BASE58 --freeze-authority BASE58 --collection-authority BASE58";

#[derive(Debug)]
struct Input { asset: PathBuf, collection: PathBuf, trust: CharterCoreTrust }
#[derive(Debug, PartialEq, Eq)]
enum Failure { Arguments, Read(String), TooLarge, Decode(CharterCoreError) }

fn parse_args(args: &[OsString]) -> Result<Input, Failure> {
    let flags = ["--asset", "--collection", "--asset-key", "--collection-key", "--owner", "--freeze-authority", "--collection-authority"];
    if args.len() != flags.len() * 2 || flags.iter().enumerate().any(|(i, flag)| args[i * 2] != *flag) {
        return Err(Failure::Arguments);
    }
    if args[1].is_empty() || args[3].is_empty() { return Err(Failure::Arguments); }
    let key = |index: usize| -> Result<Pubkey, Failure> {
        let raw = args[index].to_str().ok_or(Failure::Arguments)?;
        let value = Pubkey::from_str(raw).map_err(|_| Failure::Arguments)?;
        if value.to_string() != raw { return Err(Failure::Arguments); }
        Ok(value)
    };
    Ok(Input { asset: PathBuf::from(&args[1]), collection: PathBuf::from(&args[3]),
        trust: CharterCoreTrust { asset: key(5)?, collection: key(7)?, owner: key(9)?,
            freeze_authority: key(11)?, collection_authority: key(13)? } })
}
fn read_bounded(reader: impl Read) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::with_capacity(MAX_BYTES + 1);
    reader.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|e| Failure::Read(e.to_string()))?;
    if bytes.len() > MAX_BYTES { return Err(Failure::TooLarge); }
    Ok(bytes)
}
fn verify_bytes(asset: &mut [u8], collection: &mut [u8], trust: &CharterCoreTrust) -> Result<(), Failure> {
    let mut asset_lamports = 1; let mut collection_lamports = 1;
    // Local test metadata only: runner checks actual RPC owner/key/executable
    // fields before invoking this binary. Raw file contents cannot prove them.
    let asset = AccountInfo::new(&trust.asset, false, false, &mut asset_lamports, asset, &CORE_PROGRAM_ID, false, 0);
    let collection = AccountInfo::new(&trust.collection, false, false, &mut collection_lamports, collection, &CORE_PROGRAM_ID, false, 0);
    verify_charter_core(&asset, &collection, trust).map_err(Failure::Decode)
}

fn run() -> Result<(), Failure> {
    // Reject excess arguments without accumulating an unbounded argument list.
    let args: Vec<_> = std::env::args_os().skip(1).take(15).collect();
    let input = parse_args(&args)?;
    let mut asset = read_bounded(std::fs::File::open(&input.asset).map_err(|e| Failure::Read(format!("asset: {e}")))?)?;
    let mut collection = read_bounded(std::fs::File::open(&input.collection).map_err(|e| Failure::Read(format!("collection: {e}")))?)?;
    verify_bytes(&mut asset, &mut collection, &input.trust)
}

fn main() {
    match run() {
        Ok(()) => println!("ACCEPTED local fixture bytes; runtime account metadata supplied by loopback runner"),
        Err(error) => {
            match error {
                Failure::Decode(reason) => { eprintln!("CHARTER_CORE_REJECTED:{reason:?}"); std::process::exit(2); },
                other => {
                    eprintln!("CHARTER_CORE_INPUT_ERROR:{other:?}");
                    if other == Failure::Arguments { eprintln!("Usage: charter_core_fixture {USAGE}"); }
                    std::process::exit(3);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(dead_code)]
    mod fixture { include!("../../test-fixtures/charter-core/vectors.rs"); }
    fn trust() -> CharterCoreTrust {
        CharterCoreTrust { asset: Pubkey::new_from_array(fixture::ASSET), collection: Pubkey::new_from_array(fixture::COLLECTION),
            owner: Pubkey::new_from_array(fixture::OWNER), freeze_authority: Pubkey::new_from_array(fixture::FREEZE_AUTHORITY),
            collection_authority: Pubkey::new_from_array(fixture::COLLECTION_AUTHORITY) }
    }
    fn args() -> Vec<OsString> {
        let t = trust(); ["--asset".to_owned(),"asset.bin".to_owned(),"--collection".to_owned(),"collection.bin".to_owned(),
            "--asset-key".to_owned(),t.asset.to_string(),"--collection-key".to_owned(),t.collection.to_string(),
            "--owner".to_owned(),t.owner.to_string(),"--freeze-authority".to_owned(),t.freeze_authority.to_string(),
            "--collection-authority".to_owned(),t.collection_authority.to_string()].into_iter().map(OsString::from).collect()
    }
    #[test]
    fn requires_exact_arguments_and_all_five_explicit_trusted_keys() {
        let original=args(); let parsed=parse_args(&original).unwrap();
        assert_eq!(parsed.asset,PathBuf::from("asset.bin")); assert_eq!(parsed.collection,PathBuf::from("collection.bin"));
        assert_eq!(parsed.trust.asset,trust().asset); assert_eq!(parsed.trust.collection,trust().collection);
        assert_eq!(parsed.trust.owner,trust().owner); assert_eq!(parsed.trust.freeze_authority,trust().freeze_authority);
        assert_eq!(parsed.trust.collection_authority,trust().collection_authority);
        for n in 0..original.len() { assert!(matches!(parse_args(&original[..n]),Err(Failure::Arguments))); }
        let mut extra=original.clone(); extra.push("--proof".into()); assert!(matches!(parse_args(&extra),Err(Failure::Arguments)));
        let mut duplicate=original.clone(); duplicate[10]="--owner".into(); assert!(matches!(parse_args(&duplicate),Err(Failure::Arguments)));
        for index in [5,7,9,11,13] { let mut invalid=original.clone(); invalid[index]="not-a-public-key".into(); assert!(matches!(parse_args(&invalid),Err(Failure::Arguments))); }
    }
    #[test]
    fn reads_at_most_one_over_limit_to_detect_oversize_without_unbounded_io() {
        assert_eq!(read_bounded(&[7u8;MAX_BYTES][..]).unwrap().len(),MAX_BYTES);
        struct Infinite(usize);
        impl Read for Infinite { fn read(&mut self,out:&mut [u8])->std::io::Result<usize> { self.0+=out.len(); out.fill(7); Ok(out.len()) } }
        let mut infinite=Infinite(0); assert_eq!(read_bounded(&mut infinite),Err(Failure::TooLarge));
        assert_eq!(infinite.0,MAX_BYTES+1);
    }
    #[test]
    fn reports_read_failure_instead_of_accepting_partial_bytes() {
        struct Broken;
        impl Read for Broken { fn read(&mut self,_:&mut [u8])->std::io::Result<usize> { Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied,"fixture read denied")) } }
        assert!(matches!(read_bounded(Broken),Err(Failure::Read(message)) if message.contains("fixture read denied")));
    }
    #[test]
    fn executes_the_production_decoder_and_preserves_its_explicit_failure() {
        let mut asset=fixture::ASSET_NONE.to_vec(); let mut collection=fixture::COLLECTION_BYTES.to_vec();
        assert_eq!(verify_bytes(&mut asset,&mut collection,&trust()),Ok(()));
        asset[fixture::PLUGIN_START+1]=0;
        assert_eq!(verify_bytes(&mut asset,&mut collection,&trust()),Err(Failure::Decode(CharterCoreError::NotFrozen)));
        asset[fixture::PLUGIN_START+1]=1; let mut wrong=trust(); wrong.owner=Pubkey::new_from_array([90;32]);
        assert_eq!(verify_bytes(&mut asset,&mut collection,&wrong),Err(Failure::Decode(CharterCoreError::OwnerMismatch)));
    }
}
