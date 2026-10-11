# Approved fantasy globe artwork

Byte-identical selected runtime sources from the visually approved eight-realm concept, commit bec6fba6ce4da2f360d33877d36cc51663dcd371. Generation receipts and original studies remain with the visual review; this manifest pins every runtime image.

Pack inspection: geographic rasters are native pixels, not 2× game sprites. The coarse color/realm/surface maps are 768×384 and share equirectangular sampling. Island atlases contain 320px cells in a 1024px image with zero-based island positions; masks and authored coastlines are paired. Anchors are longitude/latitude on the sphere, not building footprints. There are eight realm identities, independent of gameplay building levels or wall tiers. Cloud banks are three 64×32 source banks in a 192×64 image. No sprite-key collisions: this pack uses /atlas/fantasy/globe/.

The asset generator validates SHA-256 and dimensions before byte-copying to the build-versioned atlas tree. Do not edit these masters to correct rendering.
