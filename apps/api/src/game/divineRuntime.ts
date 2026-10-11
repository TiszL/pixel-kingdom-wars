/** Process-owned Divine composition. Explicit operator commands remain outside
 * AppDeps; player capabilities never choose funding, enrollment or outcomes. */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { createDivineTrials, type DivineTrialOptions, type DivineTrialHistoryOptions, type DivineTrialProvider } from './divineTrials';
import { createDivineFragments, createDivineFragmentHistory, assertFragmentSource, fragmentFail, fragmentId } from './divineFragments';
import { createDivineFragmentTermSource } from './divineFragmentTermReader';
import { createSeekerFragmentClaims } from './seekerFragmentClaims';
import type { DivineFragmentRouteProvider } from './divineFragmentRoutes';
import type { SeekerGameplaySources } from '../seeker/realmSaleRuntime';

export interface DivineRuntimeOptions {
  readonly trial?: DivineTrialOptions | null;
  readonly history?: DivineTrialHistoryOptions;
  readonly term?: SeekerGameplaySources['term'] | null;
}
export function createDivineRuntime(db: Db, options: DivineRuntimeOptions = {}) {
  if ('rollback' in db) throw Error('DIVINE_RUNTIME_TOP_LEVEL');
  const destination = options.trial ?? options.history ?? {};
  const trials = createDivineTrials(db, destination);
  const termSource = options.term ? createDivineFragmentTermSource(options.term.connect, options.term.policy) : null;
  const accounting = options.trial && termSource ? createDivineFragments(db, { ...options.trial, termSource }) : null;
  const fragments = accounting ?? createDivineFragmentHistory(db, destination), seeker = createSeekerFragmentClaims(db, destination);
  const divineTrialProvider: DivineTrialProvider = Object.freeze({
    enter: async (wallet, eventId, command) => {
      // Exact accepted retries survive pause and missing current source. New
      // entry must never race ahead of prospective fragment enrollment.
      const prior = await trials.participant(wallet, eventId);
      if (!prior.entry) {
        await assertFragmentSource(db);
        const [enrolled] = await db.execute<{ source_kind: string }>(sql`select source_kind from public.divine_fragment_enrollments where event_id=${eventId}::uuid`);
        if (enrolled?.source_kind !== 'individual') fragmentFail('NOT_ENROLLED', 503);
      }
      return trials.enter(wallet, eventId, command);
    },
    admit: trials.admit, submit: trials.submit, abandon: trials.abandon, claim: trials.claim,
    participant: trials.participant, events: trials.events, read: trials.read,
  });
  const divineFragmentProvider: DivineFragmentRouteProvider = Object.freeze({
    fragments: Object.freeze({ policy: fragments.policy, award: fragments.award, awards: fragments.awards,
      deliver: fragments.deliver, deliveryRead: fragments.deliveryRead, stock: fragments.stock }),
    seeker: Object.freeze({ terms: seeker.terms, term: seeker.term, claim: seeker.claim, claimRead: seeker.claimRead }),
  });
  // The caller must explicitly supply the configured sponsor, original event
  // ID, base, schedule and budget. Mounting never selects or funds an event.
  // Funding and enrollment are independently durable: if enrollment is held,
  // replay this exact command before entry opens; no second debit is possible.
  const operator = accounting ? Object.freeze({
    fundAndEnroll: async (...args: Parameters<typeof trials.fund>) => {
      const event = await trials.fund(...args); await accounting.enroll(event.id); return event;
    },
    enroll: (eventId: string) => accounting.enroll(fragmentId.parse(eventId)),
    closeAndSettle: async (eventId: string) => {
      const event = await trials.close(fragmentId.parse(eventId));
      const settlement = await accounting.settle(event.id); return { event, settlement };
    },
  }) : null;
  return Object.freeze({ deps: Object.freeze({ divineTrialProvider, divineFragmentProvider }), operator });
}
