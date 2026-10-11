//! Tests authored before the state machine. Execution belongs to Cedar3.
use super::*;
use crate::{constants::*, state::*};

fn error_code<T>(result: Result<T>) -> u32 {
    match result.err().expect("the operation must fail") {
        anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
        other => panic!("expected an exact Anchor error, got {other:?}"),
    }
}

fn week() -> LeagueWeek {
    LeagueWeek {
        version: VERSION, config: Pubkey::new_from_array([1; 32]),
        week_start: MONDAY_OFFSET_SEC, root: [2; 32], total_raw: 100,
        leaf_count: 2, allocation_hash: [3; 32], vault: Pubkey::new_from_array([4; 32]),
        claimed_raw: 0, claimed_count: 0, claimed_bitmap: [0; LEAGUE_BITMAP_BYTES],
        opened_at: 1_000_000, claim_deadline: 1_000_100,
        swept: false, swept_raw: 0, bump: 254, vault_bump: 253,
    }
}

#[test]
fn a15_calendar_protocol_is_monday_utc() {
    assert_eq!(LEAGUE_WEEK_SEC, 7 * 86_400);
    assert_eq!(MONDAY_OFFSET_SEC, 4 * 86_400); // 1970-01-05, first Monday after epoch.
    assert!(validate_week_start(1_791_158_400).is_ok()); // 2026-10-05 00:00 UTC.
    assert_eq!(error_code(validate_week_start(1_791_158_399)), 6008);
    assert_eq!(error_code(validate_week_start(1_791_158_401)), 6008);
}

#[test]
fn c16_a11_a12_reject_invalid_calendar_starts() {
    // -259200 is Monday-aligned; only the positivity guard can reject it.
    // Zero is retained as an admission case but is also rejected by alignment.
    let negative_monday = MONDAY_OFFSET_SEC - LEAGUE_WEEK_SEC;
    assert_eq!(negative_monday, -259_200);
    assert_eq!((negative_monday - MONDAY_OFFSET_SEC).rem_euclid(LEAGUE_WEEK_SEC), 0);
    for start in [negative_monday, 0, -1, i64::MIN, MONDAY_OFFSET_SEC - 1, MONDAY_OFFSET_SEC + 1] {
        assert_eq!(error_code(validate_week_start(start)), 6008, "InvalidWeekStart");
    }
}

#[test]
fn c15_open_boundary_includes_exact_settlement_delay() {
    let closed = MONDAY_OFFSET_SEC + LEAGUE_WEEK_SEC + LEAGUE_SETTLEMENT_DELAY_SEC;
    assert_eq!(error_code(validate_open(closed - 1, MONDAY_OFFSET_SEC, &[1;32], 1, 1)), 6009);
    assert!(validate_open(closed, MONDAY_OFFSET_SEC, &[1;32], 1, 1).is_ok());
}

#[test]
fn a03_week_validation_has_no_monotonic_cursor() {
    let newer = MONDAY_OFFSET_SEC + LEAGUE_WEEK_SEC;
    let now = newer + LEAGUE_WEEK_SEC + LEAGUE_SETTLEMENT_DELAY_SEC;
    assert!(validate_open(now, newer, &[1;32], 1, 1).is_ok());
    assert!(validate_open(now, MONDAY_OFFSET_SEC, &[2;32], 1, 1).is_ok());
}

#[test]
fn c20_open_rejects_empty_commitments() {
    let now = i64::MAX;
    assert_eq!(error_code(validate_open(now, MONDAY_OFFSET_SEC, &[0;32], 1, 1)), 6010);
    assert_eq!(error_code(validate_open(now, MONDAY_OFFSET_SEC, &[1;32], 1, 0)), 6011);
    assert_eq!(error_code(validate_open(now, MONDAY_OFFSET_SEC, &[1;32], 1, LEAGUE_SKR_MAX_PLACES + 1)), 6011);
    assert_eq!(error_code(validate_open(now, MONDAY_OFFSET_SEC, &[1;32], 0, 1)), 6012);
}

#[test]
fn c48_calendar_and_deadline_overflow_are_errors() {
    let latest_monday = i64::MAX - (i64::MAX - MONDAY_OFFSET_SEC).rem_euclid(LEAGUE_WEEK_SEC);
    assert_eq!(error_code(week_close(latest_monday)), 6013);
    assert_eq!(error_code(initial_deadline(i64::MAX, 1)), 6013);
}

#[test]
fn initialize_window_is_positive_and_bounded() {
    for value in [i64::MIN, -1, 0, LEAGUE_CLAIM_WINDOW_MAX_SEC + 1] {
        assert_eq!(error_code(validate_window(value)), 6003);
    }
    assert!(validate_window(LEAGUE_CLAIM_WINDOW_SEC).is_ok());
    assert!(validate_window(LEAGUE_CLAIM_WINDOW_MAX_SEC).is_ok());
}

#[test]
fn c25_c26_bitmap_commits_once_after_transfer() {
    let mut value = week();
    let (raw, count) = validate_claim(&value, value.claim_deadline - 1, 0, 40).unwrap();
    assert_eq!((value.claimed_raw, value.claimed_count), (0, 0));
    record_claim(&mut value, 0, raw, count);
    assert_eq!((value.claimed_raw, value.claimed_count, value.claimed_bitmap[0]), (40, 1, 1));
    assert_eq!(error_code(validate_claim(&value, value.claim_deadline - 1, 0, 40)), 6015);
}

#[test]
fn c37_sparse_indexes_use_max_places_not_leaf_count() {
    let mut value = week(); value.leaf_count = 1;
    let index = LEAGUE_SKR_MAX_PLACES - 1;
    let (raw, count) = validate_claim(&value, value.claim_deadline - 1, index, 100).unwrap();
    record_claim(&mut value, index, raw, count);
    assert_ne!(value.claimed_bitmap[usize::from(index / 8)] & (1 << (index % 8)), 0);
    assert_eq!(error_code(validate_claim(&week(), 1_000_001, LEAGUE_SKR_MAX_PLACES, 1)), 6014);
}

#[test]
fn c34_claim_deadline_is_exclusive() {
    let value = week();
    assert!(validate_claim(&value, value.claim_deadline - 1, 0, 1).is_ok());
    assert_eq!(error_code(validate_claim(&value, value.claim_deadline, 0, 1)), 6019);
    assert_eq!(error_code(validate_claim(&value, value.claim_deadline + 1, 0, 1)), 6019);
}

#[test]
fn c35_swept_precedes_expiry_error() {
    let mut value = week(); value.swept = true;
    assert_eq!(error_code(validate_claim(&value, value.claim_deadline, 0, 1)), 6020);
}

#[test]
fn c38_zero_claim_is_invalid_amount() {
    assert_eq!(error_code(validate_claim(&week(), 1_000_001, 0, 0)), 6012);
}

#[test]
fn c39_a14_claim_accounting_never_uses_donated_vault_balance() {
    let mut value = week(); value.claimed_raw = 90; value.claimed_count = 1;
    assert_eq!(error_code(validate_claim(&value, 1_000_001, 1, 11)), 6018);
    let (raw, count) = validate_claim(&value, 1_000_001, 1, 10).unwrap();
    assert_eq!((raw, count), (100, 2));
    value.claimed_count = value.leaf_count;
    assert_eq!(error_code(validate_claim(&value, 1_000_001, 1, 1)), 6018);
}

#[test]
fn c48_claim_raw_overflow_is_explicit() {
    let mut value = week(); value.total_raw = u64::MAX; value.claimed_raw = u64::MAX;
    assert_eq!(error_code(validate_claim(&value, 1_000_001, 1, 1)), 6013);
}

#[test]
fn c41_c42_sweep_boundary_and_replay() {
    let mut value = week();
    assert_eq!(error_code(validate_sweep(&value, value.claim_deadline - 1)), 6021);
    assert!(validate_sweep(&value, value.claim_deadline).is_ok());
    value.swept = true;
    assert_eq!(error_code(validate_sweep(&value, value.claim_deadline)), 6020);
}

#[test]
fn a05_a06_a07_extension_is_forward_bounded_and_unswept() {
    let mut value = week();
    for deadline in [value.claim_deadline - 1, value.claim_deadline] {
        assert_eq!(error_code(validate_extension(&value, deadline)), 6022);
    }
    let ceiling = value.opened_at + LEAGUE_CLAIM_WINDOW_MAX_SEC;
    assert!(validate_extension(&value, ceiling).is_ok());
    assert_eq!(error_code(validate_extension(&value, ceiling + 1)), 6022);
    value.swept = true;
    assert_eq!(error_code(validate_extension(&value, ceiling)), 6020);
}

#[test]
fn a08_extension_restores_claim_time() {
    let mut value = week(); let old = value.claim_deadline;
    validate_extension(&value, old + 100).unwrap(); value.claim_deadline = old + 100;
    assert!(validate_claim(&value, old + 50, 0, 1).is_ok());
}

#[test]
fn c48_extension_ceiling_uses_checked_math() {
    let mut value = week(); value.opened_at = i64::MAX;
    assert_eq!(error_code(validate_extension(&value, i64::MAX)), 6013);
}

#[test]
fn c24_c25_c42_transfer_checks_are_exact_deltas_not_balances() {
    assert!(verify_deltas(200, 160, 77, 117, 40).is_ok());
    assert!(verify_deltas(0, 0, 77, 77, 0).is_ok());
    assert_eq!(error_code(verify_deltas(200, 161, 77, 117, 40)), 6023);
    assert_eq!(error_code(verify_deltas(200, 160, 77, 116, 40)), 6023);
    assert_eq!(error_code(verify_deltas(0, 1, 0, 1, 1)), 6013);
    assert_eq!(error_code(verify_deltas(1, 0, 1, 0, 1)), 6013);
}

#[test]
fn c10_strict_final_i64_rejects_legacy_layout_and_all_trailing_bytes() {
    let normal = LEAGUE_CLAIM_WINDOW_SEC.to_le_bytes();
    assert_eq!(StrictClaimWindow::try_from_slice(&normal).unwrap().value, LEAGUE_CLAIM_WINDOW_SEC);
    // Anchor invokes deserialize_reader through the instruction struct, not try_from_slice.
    let mut legacy = MONDAY_OFFSET_SEC.to_le_bytes().to_vec(); legacy.extend(normal);
    assert!(StrictClaimWindow::deserialize_reader(&mut legacy.as_slice()).is_err());
    let mut tail = normal.to_vec(); tail.push(0);
    assert!(StrictClaimWindow::deserialize_reader(&mut tail.as_slice()).is_err());
    assert!(StrictClaimWindow::deserialize_reader(&mut &normal[..7]).is_err());
    assert_eq!(StrictClaimWindow::deserialize_reader(&mut i64::MAX.to_le_bytes().as_slice()).unwrap().value, i64::MAX);
}

#[test]
fn account_allocations_cover_some_and_none_admin_options() {
    assert_eq!(LeagueConfig::INIT_SPACE + 8, 277);
    assert_eq!(LeagueWeek::INIT_SPACE + 8, 192 + LEAGUE_BITMAP_BYTES);
    assert_eq!(LEAGUE_BITMAP_BYTES, (usize::from(LEAGUE_SKR_MAX_PLACES) + 7) / 8);
}
