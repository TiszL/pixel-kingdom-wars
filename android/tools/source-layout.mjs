// Committed source inputs the exporter depends on, as git pathspecs relative to the pinned
// native-backend checkout. Used by the dirty-source gate in export-client-pack.mjs.
// A pathspec that no longer exists silently passes `git status --porcelain --`, so every
// entry must name a live path; source-layout.test.mjs pins that against PKW_NATIVE_SOURCE.
// Owner art masters were consolidated under art/source/ by source PR #83 (docs/ASSET_PIPELINE.md
// "Current source roots"); the entries below are the byte-preserving renames of the former roots.
export const sourcePaths = ['apps/web/src/ui/screens/results.tsx', 'apps/web/src/ui/icons.ts', 'apps/web/src/ui/primitives.tsx', 'apps/web/src/ui/RaidUI.tsx', 'apps/web/src/lib/audio.ts', 'apps/web/src/lib/juice.ts', 'apps/web/package.json', 'pnpm-lock.yaml', 'packages/shared', 'packages/sim', 'scripts', 'art', 'apps/web/src/game', 'apps/web/src/ui/copy.ts',
  'apps/web/src/ui/fantasy/runtime', 'apps/web/src/ui/fantasy/art-manifest.json', 'apps/web/src/ui/fantasy/campaign-presentation.json',
  'art/source/assets-v2', 'art/source/assets-v3', 'art/source/expanded-assets', 'art/source/defense-rework', 'art/source/inventory',
  'art/source/troops-rework-core', 'art/source/troops-rework-expanded', 'art/source/buildings-rework',
  'art/source/brand-wave2', 'art/source/soundtrack', 'art/source/walls-five-tier', 'art/source/builder-workman',
  'apps/api/src/native', 'apps/api/src/game/raidReplayHealth.ts', 'apps/api/src/game/trainingSchedule.ts', 'apps/api/src/game/researchConsent.ts',
  'apps/api/src/game/trainingRecovery.ts', 'apps/api/src/game/constructionReceipt.ts', 'apps/api/src/game/trainingCancellationReceipt.ts',
  'apps/api/src/game/heroConsent.ts', 'apps/api/src/game/heroReceipt.ts', 'apps/api/src/game/heroes.ts',
  'apps/api/src/game/routes.ts', 'apps/api/src/routes-alpha.ts'];
