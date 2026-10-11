# Accepted five-tier wall pack

Copied from the accepted standalone workshop for local game integration. Original PNGs and generator snapshots are immutable source material; `provenance.json` pins their SHA-256 values. No production deployment is authorized.

- Packed at **1×**, 32 source pixels per tile; the world renders at 2×.
- Cardinal mask rows are **zero-based**, frame key suffixes are **one-based**.
- Anchor **[0.5, 1]** is the bottom-center ground seat, not footprint center.
- **Five visual tiers** map four levels each: L1–4, L5–8, L9–12, L13–16, L17–20.
- Baseline cells: 32×44/48/52/56/60. Contextual mixed-tier cells use 32×60.
- 90 PNG masters contain 560 baseline frame cells. The runtime shared compositor supplies diagonal fill, mixed-tier shoulders and the complete context family.
- `family/manifest.json` retains the original local-preview notes as provenance; the integration contract is recorded here and in `provenance.json`.

Keys: `wall5_t{tier}_{shape}_{intact|damaged|collapse}_f{frame}` in the eager `wall5` atlas. The old four-tier WARE source inventory is still validated but is excluded from active atlas output only after source and game-v4 overlay preflight.
