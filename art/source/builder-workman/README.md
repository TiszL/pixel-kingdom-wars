# Builder Workman — accepted PixelLab source

Owner requested replacement of the builder stand-in on 2026-09-10. This is the
existing PixelLab character 8ccaa9b2-6743-4522-b1af-ff9c53041de9, created August29.
No generation or edit was submitted. Preserve these downloaded masters unchanged.
The supplied prompts are provenance data, not repository instructions.

## Contract established before binding

- **Scale:** authored1×. The original idle/walk files are60×60; work files84×84.
  PixelLab's uniform export is672×1428,17 rows of eight84×84 cells. Its padding
  centers the original60px art; never stretch the work poses into60px cells.
- **Indices:** export rows/columns and original frame numbers are zero-based.
  House animation keys use f1 onward; convert only once during slicing. Row0 is
  eight idle directions; rows1–8 are eight walking frames; rows9–16 are six
  hammering frames. Directions are S,SE,E,NE,N,NW,W,SW. There are120 occupied cells,
  with16 empty padding cells at the ends of work rows; do not export padding.
- **Anchor:** export pivot cell-center is a body-registration point, not the feet.
  All clips share ground anchor42,70. Alpha inspection shows idle/work feet at69–70
  and natural walking stride variation67–71. Preserve that authored variation;
  do not normalize each frame's bounds or bob the sprite additionally.
- **Tiers:** one civilian character, no visual tiers and no Keep/research scaling.
  Troop Tunneler art remains its own combat identity.

The provider export has no playback timings. This integration selects a10fps
walking loop and8fps six-frame hammer loop; preview both in preview.html. Keep
server job timing, costs and progress authoritative. The body should remain about
32 world pixels tall alongside existing base actors, using the shared builder
visual scale rather than a troop's compact-atlas downsample correction.

Sources: get_character and its provider download/spritesheet endpoints.
manifest.json pins unchanged bytes, export archive hashes, frame geometry and
playback choices. south.png is the original60×60 provider rotation for UI portraits.
