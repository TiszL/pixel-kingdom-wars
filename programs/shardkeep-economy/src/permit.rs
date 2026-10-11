//! Native Ed25519 instruction evidence; no policy signer or fixture fallback.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};
use crate::{constants::*, state::*, EconomyError as E};
// A second declare_id! also emits an Anchor IDL address and can overwrite this
// program's generated identity. Native precompiles are constants, not our program.
const ED25519_PROGRAM_ID: Pubkey = Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
pub const CHARTER_REGISTER_KIND: u8 = 5;
pub const OPEN_KIND: u8 = 7;
pub const SETTLE_KIND: u8 = 8;
pub const MESSAGE_LEN: usize = 161;
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PermitArgs {
    pub permit_id: [u8; 16],
    pub expiry: i64,
    pub ed25519_instruction: u16,
}
pub fn message(authority: &SeekerAuthority, kind: u8, wallet: Pubkey, args: &PermitArgs, payload: [u8; 32]) -> [u8; MESSAGE_LEN] {
    let mut bytes = [0u8; MESSAGE_LEN];
    bytes[..8].copy_from_slice(b"SKPERMT2"); bytes[8..40].copy_from_slice(&authority.cluster_genesis);
    bytes[40..72].copy_from_slice(crate::ID.as_ref()); bytes[72] = kind;
    bytes[73..89].copy_from_slice(&args.permit_id); bytes[89..121].copy_from_slice(wallet.as_ref());
    bytes[121..129].copy_from_slice(&args.expiry.to_le_bytes()); bytes[129..].copy_from_slice(&payload); bytes
}
fn u16_at(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data.get(at..at.checked_add(2).ok_or(E::Arithmetic)?).ok_or(E::InvalidPermit)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}
fn range(offset: u16, size: usize, len: usize) -> Result<std::ops::Range<usize>> {
    let start = usize::from(offset); let end = start.checked_add(size).ok_or(E::Arithmetic)?;
    require!(start >= 16 && end <= len, E::InvalidPermit); Ok(start..end)
}
fn overlap(a: &std::ops::Range<usize>, b: &std::ops::Range<usize>) -> bool { a.start < b.end && b.start < a.end }
/// Public for byte-vector tests; native verification authenticates the signature.
pub fn parse_native(data: &[u8]) -> Result<(&[u8], &[u8])> {
    require!(data.len() >= 16 && data[0] == 1 && data[1] == 0, E::InvalidPermit);
    for at in [4, 8, 14] { require!(u16_at(data, at)? == u16::MAX, E::InvalidPermit); }
    require!(usize::from(u16_at(data, 12)?) == MESSAGE_LEN, E::InvalidPermit);
    let signature = range(u16_at(data, 2)?, 64, data.len())?;
    let key = range(u16_at(data, 6)?, 32, data.len())?;
    let msg = range(u16_at(data, 10)?, MESSAGE_LEN, data.len())?;
    require!(!overlap(&signature, &key) && !overlap(&signature, &msg) && !overlap(&key, &msg), E::InvalidPermit);
    Ok((&data[key], &data[msg]))
}
pub fn verify(authority: &SeekerAuthority, wallet: Pubkey, kind: u8, args: &PermitArgs,
    payload: [u8; 32], instructions: &AccountInfo, now: i64) -> Result<()> {
    require!(authority.version == VERSION, E::InvalidVersion);
    require!(now < args.expiry && args.expiry <= now.checked_add(MAX_POLICY_PERMIT_TTL_SEC).ok_or(E::Arithmetic)?, E::PermitExpired);
    let current = load_current_index_checked(instructions)?;
    require!(args.ed25519_instruction < current, E::InvalidPermit);
    let ix = load_instruction_at_checked(usize::from(args.ed25519_instruction), instructions)?;
    require!(ix.program_id == ED25519_PROGRAM_ID && ix.accounts.is_empty(), E::InvalidPermit);
    let (key, signed) = parse_native(&ix.data)?;
    let valid_key = key == authority.current_policy_key.as_ref()
        || (now < authority.previous_valid_until && authority.previous_policy_key.as_ref().is_some_and(|p| p.as_ref() == key));
    require!(valid_key && signed == message(authority, kind, wallet, args, payload), E::InvalidPermit);
    Ok(())
}
pub fn consume(receipt: &mut PermitReceipt, wallet: Pubkey, kind: u8, args: &PermitArgs, payload: [u8; 32], now: i64, bump: u8) {
    receipt.version = VERSION; receipt.kind = kind; receipt.wallet = wallet; receipt.permit_id = args.permit_id;
    receipt.expiry = args.expiry; receipt.consumed_at = now; receipt.payload_hash = payload; receipt.bump = bump;
}
#[derive(Accounts)]
pub struct ClosePermitReceipt<'info> {
    #[account(mut)] pub wallet: Signer<'info>,
    #[account(mut, close = wallet, has_one = wallet, seeds = [PERMIT_SEED, receipt.permit_id.as_ref()], bump = receipt.bump,
        constraint = receipt.version == VERSION @ E::InvalidVersion)]
    pub receipt: Account<'info, PermitReceipt>,
}
pub fn close(ctx: Context<ClosePermitReceipt>) -> Result<()> {
    let deadline = ctx.accounts.receipt.expiry.checked_add(PERMIT_RECEIPT_RETENTION_SEC).ok_or(E::Arithmetic)?;
    require!(Clock::get()?.unix_timestamp > deadline, E::PermitExpired); Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_program_id_never_replaces_our_program_identity() {
        assert_ne!(crate::ID, super::ED25519_PROGRAM_ID);
        assert_eq!(super::ED25519_PROGRAM_ID.to_string(), "Ed25519SigVerify111111111111111111111111111");
    }

    use super::*;
    fn native() -> Vec<u8> {
        let mut bytes = vec![0; 16 + 32 + 64 + MESSAGE_LEN]; bytes[0] = 1;
        for (at, value) in [(2, 48u16), (4, u16::MAX), (6, 16), (8, u16::MAX), (10, 112), (12, MESSAGE_LEN as u16), (14, u16::MAX)] {
            bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
        }
        bytes[16..48].fill(7); bytes[112..].fill(9); bytes
    }
    #[test]
    fn native_parser_reads_actual_current_instruction_key_and_message() {
        let bytes = native(); let (key, msg) = parse_native(&bytes).unwrap();
        assert_eq!(key, [7; 32]); assert_eq!(msg, [9; MESSAGE_LEN]);
    }
    #[test]
    fn cross_instruction_offsets_never_supply_policy_evidence() {
        for at in [4, 8, 14] { let mut bytes = native(); bytes[at..at + 2].copy_from_slice(&0u16.to_le_bytes()); assert!(parse_native(&bytes).is_err()); }
    }
    #[test]
    fn parser_rejects_overlap_truncation_and_wrong_message_size() {
        let mut bytes = native(); bytes[10..12].copy_from_slice(&48u16.to_le_bytes()); assert!(parse_native(&bytes).is_err());
        let mut bytes = native(); bytes.pop(); assert!(parse_native(&bytes).is_err());
        let mut bytes = native(); bytes[12..14].copy_from_slice(&160u16.to_le_bytes()); assert!(parse_native(&bytes).is_err());
    }
    #[test]
    fn extra_signature_or_padding_cannot_change_native_interpretation() {
        let mut bytes = native(); bytes[0] = 2; assert!(parse_native(&bytes).is_err());
        let mut bytes = native(); bytes[1] = 1; assert!(parse_native(&bytes).is_err());
    }
    #[test]
    fn permit_fixed_width_binds_every_action_domain() {
        let authority = SeekerAuthority { version: VERSION, admin: Pubkey::default(), pending_admin: None,
            guardian: Pubkey::default(), current_policy_key: Pubkey::default(), previous_policy_key: None,
            previous_valid_until: 0, cluster_genesis: [1; 32], admission_paused: true, bump: 0 };
        let args = PermitArgs { permit_id: [2; 16], expiry: 321, ed25519_instruction: 0 };
        let wallet = Pubkey::new_from_array([3; 32]); let bytes = message(&authority, OPEN_KIND, wallet, &args, [4; 32]);
        assert_eq!(&bytes[..8], b"SKPERMT2"); assert_eq!(&bytes[8..40], &[1; 32]);
        assert_eq!(&bytes[40..72], crate::ID.as_ref()); assert_eq!(bytes[72], OPEN_KIND);
        assert_eq!(&bytes[73..89], &args.permit_id); assert_eq!(&bytes[89..121], wallet.as_ref());
        assert_eq!(&bytes[121..129], &args.expiry.to_le_bytes()); assert_eq!(&bytes[129..], &[4; 32]);
        assert_ne!(bytes, message(&authority, SETTLE_KIND, wallet, &args, [4; 32]));
    }
}
