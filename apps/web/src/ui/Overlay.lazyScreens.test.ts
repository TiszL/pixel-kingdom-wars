import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('first-paint screen boundaries', () => {
  it('keeps map, raid history, and the league ladder out of the eager Overlay graph', () => {
    const source = readFileSync(new URL('./Overlay.tsx', import.meta.url), 'utf8');

    // Neither screen is reachable before navigation, and together they carry
    // enough map/replay UI to breach the first-paint budget if statically linked.
    expect(source).not.toMatch(/import\s+\{[^}]*MapScreen[^}]*\}\s+from/);
    expect(source).not.toMatch(/import\s+\{[^}]*RaidLogScreen[^}]*\}\s+from/);
    expect(source).toContain("const MapScreen = lazy(() => import('./screens/map')");
    expect(source).toContain("const RaidLogScreen = lazy(() => import('./screens/raidlog')");
    expect(source).toContain("const LeaguesScreen = lazy(() => import('./screens/leagues')");
    expect(source).not.toMatch(/import\s+LeaguesScreen\s+from/);
    // Payment recovery is a destination flow, never required to show TITLE.
    expect(source).not.toMatch(/import\s+\{[^}]*EntryScreen[^}]*\}\s+from/);
    expect(source).toContain("const EntryScreen = lazy(() => import('./land/EntryScreen')");
    expect(source).not.toMatch(/import\s+\{[^}]*TutorialHost[^}]*\}\s+from/);
    expect(source).toContain("const TutorialHost = lazy(() => import('./tutorial/TutorialHost')");
    expect(source).not.toMatch(/import\s+\{[^}]*ActionSheet[^}]*\}\s+from/);
    expect(source).toContain("const ActionSheet = lazy(() => import('./sheets')");
    expect(source).toContain("const HeroProgressionProvider = lazy(() => import('./HeroProgression')");
    expect(source).toContain("const ResearchSpeedupProvider = lazy(() => import('./ResearchSpeedup')");
    expect(source).not.toMatch(/import\s+\{[^}]*ResearchSpeedupProvider[^}]*\}\s+from/);
    expect(source).not.toMatch(/import\s+\{[^}]*HeroProgressionProvider[^}]*\}\s+from/);
    expect(source).toContain("const TrainingFinishProvider = lazy(() => import('./TrainingFinish')");
    expect(source).not.toMatch(/import\s+\{[^}]*TrainingFinishProvider[^}]*\}\s+from/);
    expect(source).toContain("const BuilderJobSpeedupProvider = lazy(() => import('./BuilderJobSpeedup')");
    expect(source.match(/<BuilderJobSpeedupProvider /g)).toHaveLength(1);
    expect(source).not.toMatch(/import\s+\{[^}]*BuilderJobSpeedupProvider[^}]*\}\s+from/);
    // Battle controls/results must not delay title/login. Each battle owns its
    // controller lifetime so forced authority exits cannot retain old timers.
    expect(source).not.toMatch(/import\s+\{[^}]*RaidUI[^}]*\}\s+from/);
    expect(source).toContain("const RaidUI = lazy(() => import('./RaidUI')");
    // D184's lightweight host chooses the owned Divine session or the ordinary
    // raid. Both renderer branches remain lazy; ordinary authority exits still
    // replace the keyed RaidUI and retire its local timers.
    expect(source).toContain("<Suspense fallback={null}><PhaseEBattleHost actionsEnabled={baseActionsEnabled} ordinary={<RaidUI key={screen === 'battle' ? 'battle' : 'idle'} />} /></Suspense>");
    const controller = readFileSync(new URL('./RaidUI.tsx', import.meta.url), 'utf8');
    expect(controller).not.toMatch(/import\s+\{[^}]*reloadBase[^}]*\}\s+from ['"]\.\/sheets['"]/);
  });

  it('keeps the army roster out of the eager Overlay graph', () => {
    const source = readFileSync(new URL('./Overlay.tsx', import.meta.url), 'utf8');

    // D-096 put an ARMY button on the persistent HUD, which is eager by nature.
    // The screen it opens is not: screens/army carries the roster, the Codex
    // troop copy and both training trays — the chunk the camp sheet already
    // loads on demand. One static import would move all of it into first paint.
    expect(source).not.toMatch(/import\s+\{[^}]*ArmyScreen[^}]*\}\s+from/);
    expect(source).not.toMatch(/from\s+'\.\/screens\/army'/);
    expect(source).toContain("const ArmyScreen = lazy(() => import('./screens/army')");
  });

  it('keeps Phase E screens behind one lazy overlay registration', () => {
    const source = readFileSync(new URL('./Overlay.tsx', import.meta.url), 'utf8');
    const sheets = readFileSync(new URL('./sheets.tsx', import.meta.url), 'utf8');
    const registration = readFileSync(new URL('./phaseE/PhaseERegistration.tsx', import.meta.url), 'utf8');

    // A static feature import here would eagerly load controllers and catalogs.
    expect(source).toContain("const PhaseERegistration = lazy(() => import('./phaseE/PhaseERegistration')");
    expect(source.match(/<PhaseERegistration /g)).toHaveLength(1);
    // Only the D184 lifecycle adapter may enter the eager overlay. Its actual
    // battle screen stays lazy, like every other Phase E feature renderer.
    expect(source.split('\n').filter(line => /from\s+['"]\.\/phaseE\//.test(line))).toEqual([
      "import { PhaseEBattleHost } from './phaseE/PhaseEBattleHost';",
    ]);
    const battleHost = readFileSync(new URL('./phaseE/PhaseEBattleHost.tsx', import.meta.url), 'utf8');
    expect(battleHost).toContain("lazy(()=>import('./DivineTrialBattle')");
    expect(battleHost).not.toMatch(/from\s+['"]\.\/DivineTrialBattle['"]/);
    expect(sheets).toContain("const PhaseEBuildingDoor = lazy(() => import('./phaseE/PhaseERegistration')");
    expect(sheets.match(/<PhaseEBuildingDoor /g)).toHaveLength(1);
    expect(sheets).not.toMatch(/from\s+['"]\.\/phaseE\//);
    expect(registration).toContain("const RealmSalesEntry = lazy(() => import('./RealmSalesEntry')");
    expect(registration.match(/<RealmSalesEntry /g)).toHaveLength(1);
    const runtimeImports = registration.split('\n').filter(line => line.startsWith('import ') && !line.startsWith('import type '));
    // R0/F4: allow the tiny hold and the already-present store/access wiring.
    // Feature controllers and catalogs must still enter only through lazy screens.
    expect(runtimeImports).toEqual([
      "import { withPhaseEWebHold } from './webHold';",
      "import { lazy, Suspense } from 'react';",
      "import { PhaseEActionDock, PhaseEActionGroup } from './PhaseEActionDock';",
      "import { useApp, type Screen } from '../../state/store';",
      "import { hasBuildingActivityAccess } from '../../lib/phaseEActivity/access';",
    ]);
    for (const feature of ['OrdinaryCrafting', 'StarterFleet', 'StarterExpedition', 'Harvester']) {
      for (const suffix of ['Screen', 'Door']) {
        const name = `${feature}${suffix}`;
        expect(registration).toContain(`const ${name} = lazy(() => import('./${name}')`);
        expect(source).not.toContain(`import('./${name}')`);
        expect(sheets).not.toContain(`import('./${name}')`);
      }
    }
  });
});

it('holds the lazy call sites independently of each feature boundary', () => {
  const overlay = readFileSync(new URL('./Overlay.tsx', import.meta.url), 'utf8');
  const sheets = readFileSync(new URL('./sheets.tsx', import.meta.url), 'utf8');
  expect(overlay).toMatch(/phaseEWebEnabled\(\) && inBase && authed && <Suspense[^>]*><WorkshopDoor floating/);
  expect(overlay).toMatch(/phaseEWebEnabled\(\) && <Suspense[^>]*><PhaseERegistration /);
  expect(sheets).toMatch(/phaseEWebEnabled\(\) && b\.type === 'workshop' && !b\.underConstruction && <Suspense[^>]*><WorkshopDoor discover/);
  expect(sheets).toMatch(/phaseEWebEnabled\(\) && !b\.underConstruction && <Suspense[^>]*><PhaseEBuildingDoor /);
});
