// Stub for @solana-program/memo. Privy's Solana bundle imports
// `getAddMemoInstruction` (for attaching an on-chain memo) — a path our social
// sign-in never exercises (we only sign the SIWS message). The real package
// version-conflicts with Privy's pinned @solana/kit, so we alias this stub in
// vite.config.ts to satisfy the import without pulling it in. Revisit if a later
// phase (on-ramp/funding) actually needs memo instructions.
export function getAddMemoInstruction(): never {
  throw new Error('getAddMemoInstruction: memo instructions are not used by SHARDKEEP social sign-in');
}
