# Starter fleet source subset

Byte-identical runtime source from the locked Phase E production asset package. `provenance.json` and `../shared-fx/starter-provenance.json` pin the finite import, package zip, source index and documentation commit. Full family manifests and composition tracks are inert source records; only starter, starter-berth, departure and return references are admitted. Provider roots, fleet prepacked atlases, presentations and unrelated fleet families are not imported or traversed.

The eleven PNGs supply 42 native-density cells for one on-demand `pe_fleet_starter` group: vehicle idle/docked/travel, berth intact/damaged/destroyed/ambient, two eight-frame gate effects and their two separate reduced-motion stills. FX atlas cells represent provider indices 1–8; their separate `frame-00.png` is the unchanged provider input, not atlas cell zero. Runtime strip indices stay zero-based; sprite suffixes are one-based.

Berth geometry retains full-cell bottom [56,112], ground contact [56,93], attachment [56,78] and tidal gate [56,28]. Starter contact [56,105] docks at that attachment with authored [0,-27] offset. Track keyframes, opacity, fps, reduced-motion instructions and `sharedFxRef: departure` remain authored source data. There is no Aurora attachment or fabricated frame event.

Import and packing are source preparation only. They do not establish runtime rendering, owner art acceptance, new gameplay numbers, application readiness, activation or release. The source manifest still reports `readyForRuntime: false`.

## Advanced fleet source subset

`advanced-provenance.json` separately admits exactly 80 original PNGs: four family
berths and all four authored tiers of Survey Balloon, Cargo Cutter, Courier
Airship and Expedition Barge. Their 268 native cells remain in 20 optional 1x
groups: one per berth family and one per vehicle family/tier. Source dash names
are retained in metadata; runtime keys use explicit underscore family names.
The original manifest, composition tracks and starter provenance remain unchanged.

Only vehicle idle/docked/travel/exhausted and berth intact/damaged/destroyed/ambient
pixels are banked. Provider roots, precomposed 192px presentations, prepacked
atlases and individual provider frames are not traversed. Runtime strip indices
are zero-based and sprite suffixes one-based; provider docked indices 1,3,5,7 and
travel/ambient indices 1–8 remain distinct metadata.

Each vehicle keeps its own contact and dock offset, including tier differences.
The dock offset is attachment minus contact and is applied once, not added again
after aligning those points. Aerial and nautical attachments differ. The original
four family tracks remain source data; shared gate references are not new copied
effects, Aurora attachments or invented events. Separate `peAdvancedFleet` metadata
and `pe_advanced_fleet.manifest.json` bind every cell and group without changing
starter, service-building or Market contracts. Candidate status remains
`readyForRuntime:false`; this bank does not authorize rendering, application,
spending, native activation or owner visual acceptance.
