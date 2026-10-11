# Realm Harvester source bank

This literal subset preserves 256 PNGs, 96 grid JSONs and the complete authored
manifest from the locked Phase E production delivery, plus PLAN.md and QA.md
verbatim. provenance.json records every byte/hash and original runtime-index
path; its hash is pinned before the loader follows any source path. No masters,
rejected alternatives, raw frame directories or prepacked game output are imported.
Source `runtimeReady:false` and pending owner art approval remain unchanged.

Integration is source preparation only. The standalone `meta.peHarvesters` and
`pe_harvesters.manifest.json` advertise 32 optional groups, 224 clips and 992 cells.
Each exact source realm × visual tier keeps its own group and hashed complete
binding. `seeker-reach` displays **Solana Reach**, not the special Seeker island.

The pack is native **1×**: 112×112 cells with a 2×2 footprint. Full bottom seat
(56,112) goes on footprint south; authored contact (56,104) stays eight pixels
above it. Source frame indices are **zero-based**; runtime keys are **one-based**.
The four tiers are visual tiers, not levels or a new economic mapping.

Each appearance has four static clips (idle, damaged, ready, destroyed) and three
nine-cell grids (working, construction, collapse). Grids are 344×344, with two
pixels of outer/intercell padding. Working plays 0–7 at 8 fps; retained cell 8 is
the repeated endpoint. Construction/collapse play 0–8 once and hold the last cell.
Construction begins at its tier scaffold and ends at its own realm/tier idle;
collapse begins at its own damaged sprite and ends at its tier rubble. The
construction static is a pinned endpoint, not an eighth clip. Rubble aliases
destroyed. Source scaffold/rubble copies remain literal for provenance simplicity.

Ready already composes the shared craft-success star at source offset (24,-12).
No second overlay, fresh FX or gameplay completion event is implied. Existing
Workshop/Lodge, Market and fleet contracts remain independent and unchanged.
There is no eager boot registration, renderer, gameplay activation, native pack,
owner art approval or release authority in this bank.
