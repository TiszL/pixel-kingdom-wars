/** Native tester flags do not admit the new web interface. */
export function phaseEWebEnabled(): boolean {
  return import.meta.env.VITE_PHASE_E_WEB_ENABLED === '1';
}

export function phaseEScreenHeld(screen: string): boolean {
  return !phaseEWebEnabled() && ['workshop', 'ordinary-crafting', 'starter-fleet',
    'starter-expeditions', 'harvesters', 'free-base-purchase'].includes(screen);
}

export function phaseEBuildingHeld(type: string): boolean {
  return !phaseEWebEnabled() && ['workshop', 'lodge', 'market', 'harvester', 'berth'].includes(type);
}
