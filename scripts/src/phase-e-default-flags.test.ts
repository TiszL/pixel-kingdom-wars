import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, phaseEMiningEnabled, phaseESeekerEnabled, phaseEVehiclesEnabled, phaseECharterEnabled, keepEquipmentMarketEnabled } from '../../apps/api/src/config';

// WORKING-RULES S4: copying either operator example must leave every Phase E
// family dark. Pin the owner list independently so a missing flag cannot pass.
const FLAGS = [
  'GEMS_ENABLED',
  'PHASE_E_CATALOG_ENABLED',
  'PHASE_E_BUILDINGS_ENABLED',
  'PHASE_E_ART_ENABLED',
  'PHASE_E_MINING_ENABLED',
  'PHASE_E_SEEKER_ENABLED',
  'PHASE_E_VEHICLES_ENABLED',
  'PHASE_E_CHARTER_ENABLED',
  'KEEP_EQUIPMENT_MARKET_ENABLED',
  // Implemented child gates also remain dark when copying either example.
  'GEMS_WALLET_BUY_ENABLED',
  'DEVNET_WELCOME_GEMS_ENABLED',
  'FORGE_INGOTS_ENABLED',
  'ORDINARY_CRAFTING_ENABLED',
  'STARTER_EXPEDITIONS_ENABLED',
  'HARVESTERS_ENABLED',
  // M45 §2: copying an example must never advertise an APK to installed devices.
  'NATIVE_UPDATE_CHANNEL_ENABLED',
] as const;
const root = path.resolve(__dirname, '..', '..');

describe('Phase E production defaults', () => {
  it.each([
    { flag: 'PHASE_E_VEHICLES_ENABLED', parents: ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED'], read: phaseEVehiclesEnabled },
    { flag: 'PHASE_E_CHARTER_ENABLED', parents: ['MULTI_BASE_ENABLED'], read: phaseECharterEnabled },
  ])('requires every live prerequisite for $flag and observes pause without a restart', ({ flag, parents, read }) => {
    const env: NodeJS.ProcessEnv = {};
    expect(read(env)).toBe(false);
    env[flag] = 'true';
    expect(read(env)).toBe(false);
    for (const parent of parents) env[parent] = 'true';
    expect(read(env)).toBe(true);
    for (const key of [flag, ...parents]) {
      for (const value of [undefined, 'false', 'TRUE', '1', ' true ']) {
        env[key] = value;
        expect(read(env), `${key}=${value} must pause new admission`).toBe(false);
      }
      env[key] = 'true';
      expect(read(env)).toBe(true);
    }
    env[flag] = 'false';
    expect(read(env)).toBe(false);
  });
  it('requires stable bases and explicit KEEP market admission while retaining live pause semantics', () => {
    const env:NodeJS.ProcessEnv={};expect(keepEquipmentMarketEnabled(env)).toBe(false);
    env.KEEP_EQUIPMENT_MARKET_ENABLED='true';expect(keepEquipmentMarketEnabled(env)).toBe(false);
    env.MULTI_BASE_ENABLED='true';expect(keepEquipmentMarketEnabled(env)).toBe(true);
    for(const value of ['false','TRUE','1',' true ']){env.KEEP_EQUIPMENT_MARKET_ENABLED=value;expect(keepEquipmentMarketEnabled(env)).toBe(false);}
  });
  it('requires explicit Seeker opt-in and observes pause without a process restart', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(phaseESeekerEnabled(env)).toBe(false);
    for (const value of ['false', 'TRUE', '1', ' true ']) {
      env.PHASE_E_SEEKER_ENABLED = value;
      expect(phaseESeekerEnabled(env)).toBe(false);
    }
    env.PHASE_E_SEEKER_ENABLED = 'true';
    expect(phaseESeekerEnabled(env)).toBe(true);
    env.PHASE_E_SEEKER_ENABLED = 'false';
    expect(phaseESeekerEnabled(env)).toBe(false);
  });
  it('requires explicit mining opt-in and reads the pause live', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(phaseEMiningEnabled(env)).toBe(false);
    for (const value of ['false', 'TRUE', '1', ' true ']) {
      env.PHASE_E_MINING_ENABLED = value;
      expect(phaseEMiningEnabled(env)).toBe(false);
    }
    env.PHASE_E_MINING_ENABLED = 'true';
    expect(phaseEMiningEnabled(env)).toBe(true);
    env.PHASE_E_MINING_ENABLED = 'false';
    expect(phaseEMiningEnabled(env)).toBe(false);
  });
  it.each(['.env.example', 'infra/.env.prod.example'])('keeps every required flag explicitly false in %s', (file) => {
    const example = readFileSync(path.join(root, file), 'utf8');
    for (const flag of FLAGS) {
      const assignments = [...example.matchAll(new RegExp(`^${flag}=(.*)$`, 'gm'))].map(match => match[1]);
      expect(assignments, `${file}: ${flag} must appear once and remain dark`).toEqual(['false']);
    }
  });

  it('keeps implemented runtime defaults false when no rollout flags are supplied', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x:y@localhost:5433/example',
      JWT_SECRET: 'test-secret-test-secret-test-secret!',
      WEB_ORIGIN: 'http://localhost:5173',
      NODE_ENV: 'test',
    });
    // Every implemented family must be present; missing parser fields cannot
    // pass merely because the operator examples declare the right defaults.
    expect(config).toMatchObject({
      GEMS_ENABLED: 'false',
      PHASE_E_CATALOG_ENABLED: 'false',
      PHASE_E_BUILDINGS_ENABLED: 'false',
      PHASE_E_MINING_ENABLED: 'false',
      PHASE_E_SEEKER_ENABLED: 'false',
      PHASE_E_VEHICLES_ENABLED: 'false',
      PHASE_E_CHARTER_ENABLED: 'false',
    });
    for (const flag of FLAGS) {
      expect(Reflect.get(config, flag), `${flag} runtime default must be declared and remain dark`).toBe('false');
    }
  });
});
