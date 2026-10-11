/** Global-chat author card contract subpath; avoid a new first-paint import.
 *
 * Owner 2026-09-18: tapping a player in chat shows a small profile — how many
 * kingdoms they hold and their highest Keep — "but do not overdo it". The card
 * is resolved from a MESSAGE id, so no wallet ever crosses the API boundary in
 * either direction (the ChatAuthor rule in types.ts).
 *
 * STRICT on purpose: the API parses its own response through this schema, so a
 * field that is not listed here (a wallet, a base id, a coordinate, a shield or
 * presence time) fails the request loudly instead of reaching another player. */
import { z } from 'zod';
import { BASE_OWNERSHIP } from './constants';

export const ChatAuthorCardSchema = z.object({
  version: z.literal(1),
  /** The name the tapped MESSAGE was sent under — byte-for-byte the string that
   * message already shows — NEVER the current profile name. World search finds
   * a player by their current name only, so a card that followed a rename would
   * undo a rename made to escape harassment. The fields below are current. */
  name: z.string(),
  avatarUrl: z.string().nullable(),
  seekerVerified: z.boolean(),
  /** Kingdoms on the public world map: paid land in an active slot that this
   * player still owns. A count only — never a list, an id or a place. */
  bases: z.number().int().min(0).max(BASE_OWNERSHIP.maxActive),
  /** Highest Keep across those kingdoms; for a landless player the free
   * starter base's Keep; null only when the player holds no base at all. */
  highestKeepLevel: z.number().int().min(1).nullable(),
  /** Highest trophy count across the same bases (the map's per-base number). */
  trophies: z.number().int().min(0),
  clan: z.object({ name: z.string(), tag: z.string() }).strict().nullable(),
}).strict();
export type ChatAuthorCard = z.infer<typeof ChatAuthorCardSchema>;
