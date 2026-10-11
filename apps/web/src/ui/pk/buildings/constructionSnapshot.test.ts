import { describe, expect, it } from 'vitest';
import type { BuildingMarkerUi, PxRect } from '../types';
import { MAX_WORLD_MARKERS } from './buildingsLogic';
import {
  constructionSitesFromBase, constructionSnapshot,
  type ConstructionBaseFacts, type ConstructionSnapshotInput, type ConstructionSnapshotVisibility,
} from './constructionSnapshot';

// Timestamp/quantity fixtures only. Production receives one coherent server snapshot and an existing owner's clock.
const nowMs = Date.parse('2026-10-04T10:00:00.000Z');
const anchor = (x: number): PxRect => ({ left: x - 10, top: 90, right: x + 10, bottom: 110 });
const job = (buildingId: string, kind = 'build', finishesAt: string | null = '2026-10-04T10:01:00.000Z') => ({
  id: `${buildingId}-job`, buildingId, kind, startedAt: '2026-10-04T09:59:00.000Z', finishesAt,
});
const marker = (buildingId: string, kind: BuildingMarkerUi['kind'] = 'READY'): Omit<BuildingMarkerUi, 'anchor'> => ({
  buildingId, kind, icon: 'shards', text: '+server amount', progress: null, description: `${buildingId}: server readiness description`,
});
const base = (): ConstructionBaseFacts => ({
  buildings: [{ id: 'workshop', type: 'workshop' }, { id: 'mine', type: 'mine' }, { id: 'tower', type: 'archertower' }],
  jobs: [job('workshop')],
});
const visibility = (): ConstructionSnapshotVisibility => ({
  homeVisible: true, selected: false, placing: false, buildTrayOpen: false, layoutEditorOpen: false,
});
const input = (): ConstructionSnapshotInput => ({
  base: base(), nowMs, names: new Map([['workshop', 'WORKSHOP'], ['mine', 'MINE'], ['tower', 'ARCHER TOWER']]),
  anchors: new Map([['workshop', anchor(50)], ['mine', anchor(60)], ['tower', anchor(70)]]),
  markerFacts: [], visibility: visibility(), cameraCenter: { x: 50, y: 100 },
});

describe('constructionSitesFromBase', () => {
  it('construction plates show builds and upgrades, soonest first, unknown never zero', () => {
    const facts = input();
    facts.base = { ...base(), jobs: [job('workshop', 'upgrade', '2026-10-04T11:12:00.000Z'),
      job('tower', 'build', '2026-10-04T10:00:09.000Z'), job('mine', 'upgrade', null),
      { ...job('tower', 'repair'), id: 'repair-job' }] };
    const sites = constructionSitesFromBase(facts.base, nowMs, facts.names);
    expect(sites.map(site => site.buildingId)).toEqual(['tower', 'workshop', 'mine']);
    expect(sites[0]?.description).toBe('Archer Tower: being built, 9s left');
    expect(sites[1]?.timeLeft).toBe('1h 12m');
    expect(sites[2]?.description).toBe('Mine: upgrading, time unknown');
    expect(sites[2]?.progress).toBeNull();
    expect(sites[2]?.secondsLeft).toBeNull();
  });

  it('associates jobs with real buildings in this base and ignores other job kinds', () => {
    const facts = input();
    facts.base = { ...base(), jobs: [job('missing'), { ...job('mine'), buildingId: null }, job('tower', 'repair'), job('workshop')] };
    const sites = constructionSitesFromBase(facts.base, nowMs, facts.names);
    expect(sites.map(site => site.buildingId)).toEqual(['workshop']);
  });

  it('keeps zero-second jobs until the server removes them and never invents collection readiness', () => {
    const facts = input();
    facts.base = { ...base(), jobs: [job('workshop', 'build', '2026-10-04T09:59:30.000Z')] };
    const snapshot = constructionSnapshot(facts);
    expect(snapshot.construction.sites[0]?.timeLeft).toBe('0s');
    expect(snapshot.construction.sites[0]?.secondsLeft).toBe(0);
    expect(snapshot.construction.sites[0]?.progress).toBe(1);
    expect(snapshot.markers.markers).toEqual([]);
    expect(constructionSnapshot({ ...facts, base: { ...facts.base, jobs: [] } }).construction.sites).toEqual([]);
  });

  it('uses a supplied clock snapshot and rounds fractional remaining milliseconds upward', () => {
    const facts = input();
    facts.base = { ...base(), jobs: [job('workshop', 'build', '2026-10-04T10:00:00.001Z')] };
    expect(constructionSitesFromBase(facts.base, nowMs, facts.names)[0]?.timeLeft).toBe('1s');
    expect(constructionSitesFromBase(facts.base, nowMs + 1, facts.names)[0]?.timeLeft).toBe('0s');
    facts.base = { ...base(), jobs: [job('workshop', 'build', '2026-10-04T12:00:00.001+02:00')] };
    expect(constructionSitesFromBase(facts.base, nowMs, facts.names)[0]?.timeLeft).toBe('1s');
  });

  it.each([null, '', 'not a timestamp', '0', '2026-02-30T10:00:00Z', '2026-10-04T10:00:00'])
  ('keeps an unreadable deadline (%s) unknown rather than formatting zero', finishesAt => {
    const facts = input();
    facts.base = { ...base(), jobs: [job('workshop', 'build', finishesAt)] };
    const site = constructionSitesFromBase(facts.base, nowMs, facts.names)[0];
    expect(site?.timeLeft).toBeNull();
    expect(site?.secondsLeft).toBeNull();
    expect(site?.progress).toBeNull();
    expect(site?.description).toBe('Workshop: being built, time unknown');
  });

  it.each([null, NaN, Infinity, 0.5])('keeps supplied unknown or invalid current time (%s) unknown', suppliedNow => {
    const facts = input();
    const site = constructionSitesFromBase(facts.base, suppliedNow, facts.names)[0];
    expect(site?.timeLeft).toBeNull();
    expect(site?.secondsLeft).toBeNull();
    expect(site?.progress).toBeNull();
  });

  it('derives progress only from valid chronological start and finish facts', () => {
    const facts = input();
    expect(constructionSitesFromBase(facts.base, nowMs, facts.names)[0]?.progress).toBe(0.5);
    facts.base = { ...base(), jobs: [{ ...job('workshop'), startedAt: null }] };
    expect(constructionSitesFromBase(facts.base, nowMs, facts.names)[0]?.progress).toBeNull();
    expect(constructionSitesFromBase(facts.base, nowMs, facts.names)[0]?.timeLeft).toBe('1m');
    facts.base = { ...base(), jobs: [{ ...job('workshop'), startedAt: '2026-10-04T10:02:00.000Z' }] };
    expect(constructionSitesFromBase(facts.base, nowMs, facts.names)[0]?.progress).toBeNull();
  });

  it('matches zero-duration and outside-interval progress without changing job lifecycle', () => {
    const facts = input();
    facts.base = { ...base(), jobs: [{ ...job('workshop'), startedAt: '2026-10-04T10:01:00.000Z' }] };
    expect(constructionSitesFromBase(facts.base, nowMs, facts.names)[0]?.progress).toBe(0);
    expect(constructionSitesFromBase(facts.base, nowMs + 60_000, facts.names)[0]?.progress).toBe(1);
    expect(constructionSitesFromBase(base(), nowMs - 120_000, facts.names)[0]?.progress).toBe(0);
    expect(constructionSitesFromBase(base(), nowMs + 120_000, facts.names)[0]?.progress).toBe(1);
  });

  it('retains stable ordering for tied deadlines and keeps only one job plate per building', () => {
    const facts = input();
    facts.base = { ...base(), jobs: [job('mine'), job('tower'), job('workshop'),
      { ...job('mine', 'upgrade', '2026-10-04T10:00:09.000Z'), id: 'duplicate-mine-job' }] };
    const sites = constructionSitesFromBase(facts.base, nowMs, facts.names);
    expect(sites.map(site => site.buildingId)).toEqual(['mine', 'tower', 'workshop']);
    expect(sites[0]?.secondsLeft).toBe(9);
  });

  it('uses supplied display labels and leaves a missing label honestly unknown', () => {
    const facts = input();
    facts.names = new Map();
    expect(constructionSitesFromBase(facts.base, nowMs, facts.names)[0]?.description).toBe('…: being built, 1m left');
  });
});

describe('constructionSnapshot', () => {
  it('only anchored sites are drawn, and none while something else owns the screen', () => {
    const facts = input();
    facts.base = { ...base(), jobs: [job('workshop'), job('mine')] };
    facts.anchors = new Map([['workshop', anchor(50)]]);
    const snapshot = constructionSnapshot(facts);
    expect(snapshot.construction.sites.map(site => site.buildingId)).toEqual(['workshop']);
    expect(snapshot.construction.sites[0]?.anchor).toEqual(anchor(50));
    expect(snapshot.construction.visible).toBe(true);
    expect(constructionSnapshot({ ...facts, visibility: { ...facts.visibility, selected: true } }).construction.visible).toBe(false);
  });

  it.each(['selected', 'placing', 'buildTrayOpen', 'layoutEditorOpen', 'homeVisible'] as const)
  ('hides both layers when the existing owner supplies %s visibility', key => {
    const facts = input();
    facts.markerFacts = [marker('mine')];
    facts.visibility = { ...facts.visibility, [key]: key !== 'homeVisible' };
    const snapshot = constructionSnapshot(facts);
    expect(snapshot.markers.visible).toBe(false);
    expect(snapshot.construction.visible).toBe(false);
  });

  it('anchors only explicitly supplied marker facts from the current base without inferring READY or NOTICE', () => {
    const facts = input();
    facts.markerFacts = [marker('mine'), marker('tower', 'NOTICE'), marker('other-base')];
    facts.anchors = new Map([...facts.anchors, ['other-base', anchor(50)]]);
    const snapshot = constructionSnapshot(facts);
    expect(snapshot.markers.markers.map(item => item.buildingId)).toEqual(['mine', 'tower']);
    expect(snapshot.markers.markers[0]?.text).toBe('+server amount');
    expect(snapshot.markers.markers[1]?.description).toBe('tower: server readiness description');
    expect(constructionSnapshot({ ...facts, markerFacts: [] }).markers.markers).toEqual([]);
  });

  it('applies one shared nearest-camera budget across both anchored layers', () => {
    const facts = input();
    facts.base = { ...base(), buildings: [...base().buildings, { id: 'far', type: 'market' }] };
    facts.anchors = new Map([...facts.anchors, ['far', anchor(500)]]);
    facts.markerFacts = [marker('far', 'NOTICE'), marker('tower'), marker('mine')];
    const snapshot = constructionSnapshot(facts);
    expect(snapshot.construction.sites.map(site => site.buildingId)).toEqual(['workshop']);
    expect(snapshot.markers.markers.map(item => item.buildingId)).toEqual(['mine', 'tower']);
    expect(snapshot.markers.markers.length + snapshot.construction.sites.length).toBe(MAX_WORLD_MARKERS);
  });

  it('replaces same-building ordinary timers with selectable construction plates before budgeting', () => {
    const facts = input();
    facts.markerFacts = [marker('workshop', 'CONSTRUCTION'), marker('mine')];
    const snapshot = constructionSnapshot(facts);
    expect(snapshot.markers.markers.map(item => item.buildingId)).toEqual(['mine']);
    expect(snapshot.construction.sites.map(site => site.buildingId)).toEqual(['workshop']);
  });

  it('omits nonfinite or inverted anchors rather than floating a marker at the origin', () => {
    const facts = input();
    facts.markerFacts = [marker('mine')];
    facts.anchors = new Map([['workshop', { ...anchor(50), top: NaN }], ['mine', { left: 30, right: 10, top: 20, bottom: 40 }]]);
    const snapshot = constructionSnapshot(facts);
    expect(snapshot.markers.markers).toEqual([]);
    expect(snapshot.construction.sites).toEqual([]);
  });

  it('draws neither layer without a coherent supplied base or finite camera position', () => {
    const facts = input();
    facts.markerFacts = [marker('mine')];
    for (const snapshot of [constructionSnapshot({ ...facts, base: null }), constructionSnapshot({ ...facts, cameraCenter: { x: NaN, y: 100 } })]) {
      expect(snapshot.markers.markers).toEqual([]);
      expect(snapshot.construction.sites).toEqual([]);
      expect(snapshot.markers.visible).toBe(false);
      expect(snapshot.construction.visible).toBe(false);
    }
  });

  it('does not mutate supplied rows, marker facts, names, anchors or visibility and is deterministic', () => {
    const facts = input();
    facts.markerFacts = [marker('mine')];
    const before = JSON.stringify({ ...facts, names: [...facts.names], anchors: [...facts.anchors] });
    expect(constructionSnapshot(facts)).toEqual(constructionSnapshot(facts));
    expect(JSON.stringify({ ...facts, names: [...facts.names], anchors: [...facts.anchors] })).toBe(before);
  });
});
