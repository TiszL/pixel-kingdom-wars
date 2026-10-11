// @generated projection target: scripts/src/generate-league-constants.ts.
// Source: packages/shared/src/constants.ts; regenerate after accepted policy composition.
pub const LEAGUE_SKR_MAX_PLACES: u16 = 500;
pub const LEAGUE_BITMAP_BYTES: usize = 63;
pub const LEAGUE_SETTLEMENT_DELAY_SEC: i64 = 900;
pub const LEAGUE_CLAIM_WINDOW_SEC: i64 = 2419200;
pub const LEAGUE_CLAIM_WINDOW_MAX_SEC: i64 = 4838400;

// Bitmap width must track the generated place limit at compile time.
const _: () = assert!(LEAGUE_BITMAP_BYTES == (LEAGUE_SKR_MAX_PLACES as usize + 7) / 8);
