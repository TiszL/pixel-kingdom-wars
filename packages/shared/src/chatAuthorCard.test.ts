import { describe, expect, it } from 'vitest';
import { ChatAuthorCardSchema } from './chatAuthorCard';
import { BASE_OWNERSHIP } from './constants';

const card = {
  version: 1, name: 'Aldric', avatarUrl: null, seekerVerified: false,
  bases: 2, highestKeepLevel: 9, trophies: 340, clan: { name: 'Iron Crest', tag: 'IRON' },
};

describe('chat author card contract', () => {
  it('is a closed allowlist so identity or location can never ride along', () => {
    expect(ChatAuthorCardSchema.parse(card)).toEqual(card);
    // The API parses its own response through this schema: each of these is a
    // field a raider could use to identify, find or time an attack on a chatter.
    for (const leak of [
      { wallet: '11111111111111111111111111111111' }, { baseIds: [] }, { earthCell: 1 },
      { shieldedUntil: null }, { lastSeenAt: null },
      // `name` is the name at send; the current one is a world-search key.
      { currentName: 'Renamed' },
    ]) {
      expect(ChatAuthorCardSchema.safeParse({ ...card, ...leak }).success).toBe(false);
    }
    expect(ChatAuthorCardSchema.safeParse({ ...card, clan: { ...card.clan, id: 'x' } }).success).toBe(false);
  });

  it('counts only active kingdoms and lets a player with no base have no Keep', () => {
    expect(ChatAuthorCardSchema.safeParse({ ...card, bases: BASE_OWNERSHIP.maxActive }).success).toBe(true);
    expect(ChatAuthorCardSchema.safeParse({ ...card, bases: BASE_OWNERSHIP.maxActive + 1 }).success).toBe(false);
    expect(ChatAuthorCardSchema.safeParse({ ...card, bases: 0, highestKeepLevel: null, clan: null }).success).toBe(true);
    expect(ChatAuthorCardSchema.safeParse({ ...card, highestKeepLevel: 0 }).success).toBe(false);
    // A future shape must be a new version, never a silent reinterpretation.
    expect(ChatAuthorCardSchema.safeParse({ ...card, version: 2 }).success).toBe(false);
  });
});
