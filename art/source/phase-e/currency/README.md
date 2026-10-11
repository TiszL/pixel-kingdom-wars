# Gems currency — admitted dark

D-153 selects existing PixelLab candidate 0, the emerald step-cut gemstone. The
64px original is byte-identical. PixelLab rendered the 24/32/48px chips natively;
no downscaling, image repair or master repainting was performed. The three jobs
used three generation units. `manifest.json` records hashes, dimensions, alpha
bounds and job IDs; `provenance.json` records the source and delegated review.

Pack integration answers: **1× native UI rasters**, **zero-based candidate index**
(no animation frames), **cell-centre alignment**, **no tiers or levels**. Choose the
authored size matching the display. The icons have transparent margins and dark
edges. They are not world sprites and do not enter the Phaser atlas or affect sim
version, building anchors, realm art or historical deed images.

`scripts/src/phase-e-currency.ts` validates the four-size set before the raster
pipeline clears output, then emits byte-identical files to
`apps/web/public/items/pe/gem-{24,32,48,64}.png`. Web uses versioned public URLs;
native copies the same bytes into `drawable-nodpi/gem_{24,32,48,64}.png`.

The additive external archive is pinned by `docs/phase-e/asset-package.lock.json`.
All 2,059 entries of the prior archive were compared byte-for-byte. The old review
manifest remains historical; `production-assets/currency/admitted-v2/manifest.json`
is the current currency selection. Admission does not approve or integrate the
other Phase E art families, activate Gems, or deploy either client.
