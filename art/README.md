# Art source layout

Current source masters live under `art/source/` and the versioned terrain and
`game-v4/` directories. Runtime atlases, audio and brand files are generated from
these validated inputs. [Source layout and provenance](SOURCE_LAYOUT.md) maps
historical delivery names to their current paths; each complete pack is preserved
without editing its bytes.

See [the asset pipeline](../docs/ASSET_PIPELINE.md) for the current inputs,
precedence rules, generated outputs, and verification commands.

## Preserved reference artwork

Original integrated deliveries, review labs and full-resolution terrain studies
are preserved in private history and the verified encrypted recovery archive.
The [archived source index](ARCHIVED_SOURCES.md) records the exact paths, counts,
provenance and recovery procedure. These reference directories are absent from
the active checkout and do not feed current runtime producers.

Do not copy archived material back into a producer merely because it looks newer.
A promotion must follow [the asset-pack integration procedure](../docs/ASSET-PACK-INTEGRATION.md),
including collision, scale, frame-index, anchor and tier checks.
