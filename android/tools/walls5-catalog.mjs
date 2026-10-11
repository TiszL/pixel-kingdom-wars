// Five-tier wall contract (source D-126). The web draws walls with the pure
// compositor in packages/shared/src/wallRender.ts and shows the wall5 atlas cells
// only as the preparation baseline and in portraits. This section exports every
// data input a Kotlin port needs, plus goldens computed by executing the canonical
// compositor, so the port is verified pixel-for-pixel rather than described.
import { createHash } from 'node:crypto';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(`Wall contract: ${message}`); };

/** Probe the canonical damage-stage helper at both sides of each threshold. */
export function captureWallDamageStages(wallDamageStage, wallArt) {
  const maxHp = 4000;
  const expect = (hp, stage) => { if (wallDamageStage(hp, maxHp) !== stage) fail(`damage stage rule changed at hp ${hp}/${maxHp}`); };
  expect(maxHp, 0); expect(maxHp * wallArt.lightDamageBelow, 0); expect(maxHp * wallArt.lightDamageBelow - 1, 1);
  expect(maxHp * wallArt.heavyDamageBelow, 1); expect(maxHp * wallArt.heavyDamageBelow - 1, 2); expect(1, 2); expect(0, 3);
  if (wallDamageStage(10, 0) !== 0 || wallDamageStage(Number.NaN, maxHp) !== 0) fail('damage stage must fall back to intact for unknown health');
  return {
    intact: { stage: 0, when: `hp >= maxHp * ${wallArt.lightDamageBelow}` },
    light: { stage: 1, below: wallArt.lightDamageBelow, frame: 1 },
    heavy: { stage: 2, below: wallArt.heavyDamageBelow, frame: 2 },
    collapsed: { stage: 3, when: 'hp <= 0' },
  };
}

export function buildWalls5Section({ constants, wallArt, wallRender, wallConnect, meta, index, atlasFrames, levelCount, expressions }) {
  const WALL_ART = constants.WALL_ART;
  const { SHAPES, TILE, TIER_HEIGHTS, CONTEXT_FRAME_HEIGHT, COLLAPSE_DURATION } = wallRender;
  if (SHAPES.length !== 16 || TIER_HEIGHTS.length !== WALL_ART.tiers) fail('shape or tier vocabulary changed');
  if (TILE !== WALL_ART.sourceTileSize || CONTEXT_FRAME_HEIGHT !== WALL_ART.contextFrameHeight) fail('tile geometry no longer comes from WALL_ART');
  if (COLLAPSE_DURATION !== 1000 * WALL_ART.collapseFrames / WALL_ART.collapseFps) fail('collapse clock no longer comes from WALL_ART');
  // The gameplay mask table (wallConnect) and the render table (wallRender) must agree.
  for (let mask = 0; mask < 16; mask++) {
    const shape = wallConnect.wallShape({ n: !!(mask & 1), e: !!(mask & 2), s: !!(mask & 4), w: !!(mask & 8) });
    if (shape !== SHAPES[mask]) fail(`mask ${mask} selects ${shape} for gameplay but ${SHAPES[mask]} for rendering`);
  }
  const tierOfLevel = Array.from({ length: levelCount }, (_, i) => wallArt.wallTierOfLevel(i + 1));
  if (tierOfLevel.some((tier) => !Number.isInteger(tier) || tier < 1 || tier > WALL_ART.tiers)) fail('wall tier mapping out of range');
  const atlasPaths = new Set();
  const frames = {};
  const frameCounts = { intact: 1, damaged: 2, collapse: WALL_ART.collapseFrames };
  for (let tier = 1; tier <= WALL_ART.tiers; tier++) {
    frames[tier] = {};
    for (const shape of SHAPES) {
      frames[tier][shape] = {};
      for (const [state, count] of Object.entries(frameCounts)) {
        const keys = Array.from({ length: count }, (_, i) => wallArt.wallFrameKey(tier * WALL_ART.levelsPerTier, shape, state, i + 1));
        const family = meta.families[`wall5_t${tier}_${shape}_${state}`];
        if (JSON.stringify(family?.sequence ?? family?.frames) !== JSON.stringify(keys)) fail(`family wall5_t${tier}_${shape}_${state} does not match the frame vocabulary`);
        for (const key of keys) {
          const atlasPath = index.get(key);
          const cell = atlasFrames.get(atlasPath)?.get(key);
          const sprite = meta.sprites[key];
          if (!atlasPath || !cell) fail(`missing atlas cell ${key}`);
          if (cell.w !== TILE || cell.h !== TIER_HEIGHTS[tier - 1]) fail(`cell ${key} is ${cell.w}x${cell.h}, expected ${TILE}x${TIER_HEIGHTS[tier - 1]}`);
          if (JSON.stringify(sprite?.anchor) !== '[0.5,1]' || JSON.stringify(sprite?.footprint) !== '[1,1]' || (sprite?.sourceScale ?? 1) !== 1) fail(`sprite metadata changed for ${key}`);
          atlasPaths.add(atlasPath);
        }
        frames[tier][shape][state] = keys;
      }
    }
  }
  if (atlasPaths.size !== 1) fail('wall5 frames split across atlases');
  const [atlasPath] = atlasPaths;
  const damageStages = captureWallDamageStages(wallArt.wallDamageStage, WALL_ART);
  const { PALETTES, DIR, DIAG, edgeWeight } = expressions;
  if (!Array.isArray(PALETTES) || PALETTES.length !== WALL_ART.tiers || PALETTES.some((p) => Object.values(p).some((c) => !/^#[0-9a-f]{6}$/.test(c)))) fail('palette table changed shape');
  const maskBits = Object.fromEntries(Object.entries(DIR).map(([d, [, , bit]]) => [d, bit]));
  if (JSON.stringify(maskBits) !== JSON.stringify({ n: 1, e: 2, s: 4, w: 8 })) fail('mask bit assignment changed');
  const shoulderEdgeWeights = Array.from({ length: TILE }, (_, px) => edgeWeight(px));
  if (shoulderEdgeWeights.some((w) => !Number.isFinite(w) || w < 0)) fail('shoulder weights invalid');
  // Radius classes are decided inside resolveWall; probe them instead of restating.
  const cell = (tier, damageStage) => ({ tier, ...(damageStage ? { damage: true, damageStage } : {}) });
  const grid = (cells) => new Map(cells.map(([x, y, tier, stage]) => [`${x},${y}`, cell(tier, stage)]));
  const radius = {
    isolated: wallRender.resolveWall(grid([[0, 0, 2]]), 0, 0).radius,
    straight: wallRender.resolveWall(grid([[-1, 0, 2], [0, 0, 2], [1, 0, 2]]), 0, 0).radius,
    corner: wallRender.resolveWall(grid([[0, 0, 2], [0, -1, 2], [1, 0, 2]]), 0, 0).radius,
    filledCorner: wallRender.resolveWall(grid([[0, 0, 2], [0, -1, 2], [1, 0, 2], [1, -1, 2], [-1, 0, 2], [-1, -1, 2]]), 0, 0).radius,
    cross: wallRender.resolveWall(grid([[0, 0, 2], [0, -1, 2], [1, 0, 2], [0, 1, 2], [-1, 0, 2]]), 0, 0).radius,
  };
  const vectors = [];
  const compose = (name, cells, x, y) => {
    const g = grid(cells);
    const frame = wallRender.composeWall(g, x, y);
    if (!frame || frame.width !== TILE || frame.height !== CONTEXT_FRAME_HEIGHT || frame.anchorX !== TILE / 2 || frame.anchorY !== CONTEXT_FRAME_HEIGHT) fail(`compositor frame geometry changed for ${name}`);
    vectors.push({ name, kind: 'compose', grid: cells, cell: [x, y], width: frame.width, height: frame.height, anchor: [frame.anchorX, frame.anchorY],
      commands: frame.commands.length, rgbaSha256: sha256(frame.data), renderKey: wallRender.wallRenderKey(g, x, y) });
  };
  for (let tier = 1; tier <= WALL_ART.tiers; tier++) compose(`post_t${tier}`, [[0, 0, tier]], 0, 0);
  compose('straight_run_t3', [[-1, 0, 3], [0, 0, 3], [1, 0, 3]], 0, 0);
  compose('ns_run_t2', [[0, -1, 2], [0, 0, 2], [0, 1, 2]], 0, 0);
  compose('mixed_join_t1_side', [[0, 0, 1], [1, 0, 5]], 0, 0);
  compose('mixed_join_t5_side', [[0, 0, 1], [1, 0, 5]], 1, 0);
  compose('corner_sw_t2', [[0, 0, 2], [0, -1, 2], [1, 0, 2]], 0, 0);
  compose('tee_n_t4', [[0, 0, 4], [-1, 0, 4], [1, 0, 4], [0, -1, 4]], 0, 0);
  compose('cross_t4', [[0, 0, 4], [-1, 0, 4], [1, 0, 4], [0, -1, 4], [0, 1, 4]], 0, 0);
  compose('dense_3x3_center_t3', [[-1, -1, 3], [0, -1, 3], [1, -1, 3], [-1, 0, 3], [0, 0, 3], [1, 0, 3], [-1, 1, 3], [0, 1, 3], [1, 1, 3]], 0, 0);
  compose('world_phase_t3', [[6, 9, 3], [7, 9, 3], [8, 9, 3]], 7, 9);
  compose('light_damage_t3', [[-1, 0, 3], [0, 0, 3, 1], [1, 0, 3]], 0, 0);
  compose('heavy_damage_t3', [[-1, 0, 3], [0, 0, 3, 2], [1, 0, 3]], 0, 0);
  compose('timber_damage_t1', [[0, 0, 1, 2]], 0, 0);
  for (const tier of [1, 3]) {
    const cells = [[-1, 0, tier], [0, 0, tier], [1, 0, tier]];
    const snapshot = wallRender.captureCollapse(grid(cells), 0, 0, 0);
    if (!snapshot) fail('collapse capture failed');
    for (const progress of [0, 0.5, 1]) {
      const frame = wallRender.composeCollapse(snapshot, progress * COLLAPSE_DURATION);
      vectors.push({ name: `collapse_t${tier}_p${progress}`, kind: 'collapse', grid: cells, cell: [0, 0], timeMs: progress * COLLAPSE_DURATION,
        width: frame.width, height: frame.height, anchor: [frame.anchorX, frame.anchorY], commands: frame.commands.length, rgbaSha256: sha256(frame.data) });
    }
  }
  return {
    version: 1,
    source: { render: 'packages/shared/src/wallRender.ts', art: 'packages/shared/src/wallArt.ts', connect: 'packages/shared/src/wallConnect.ts' },
    atlasPath,
    constants: WALL_ART,
    seat: { anchor: [0.5, 1], scale: WALL_ART.drawScale, offsetX: 0, offsetY: 0, contextFrame: { width: TILE, height: CONTEXT_FRAME_HEIGHT } },
    tierOfLevel,
    maskBits,
    shapesByMask: [...SHAPES],
    cells: Object.fromEntries(TIER_HEIGHTS.map((height, i) => [i + 1, { width: TILE, height }])),
    frameCounts,
    frames,
    damageStages,
    collapse: { frames: WALL_ART.collapseFrames, fps: WALL_ART.collapseFps, durationMs: COLLAPSE_DURATION },
    compositor: {
      tile: TILE, tierHeights: [...TIER_HEIGHTS], bodyHeights: TIER_HEIGHTS.map((h) => h - WALL_ART.sourceBodyOffset), contextFrameHeight: CONTEXT_FRAME_HEIGHT,
      palettes: PALETTES, directions: DIR, diagonals: DIAG, radius, shoulderEdgeWeights,
      renderKey: 'x,y followed by the 3x3 neighbourhood signatures tier:damage:stage (- when empty); frames keyed this way are reusable across scenes',
      codeOnly: ['resolveWall (steps, filledCorners, radius selection)', 'footprintAt (union mating footprint)', 'buildField sample (edge/merlon/damage chips)',
        'drawWall masonry courses, timberFace, timberDeck, materialCollar', 'drawCollapses squash and rubble', 'commandsToRgba'],
      vectors,
    },
  };
}
