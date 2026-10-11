/**
 * First-run tutorial routes (M23 a6, owner 2026-08-15) — the contract these
 * tests pin, and WHY it matters:
 *
 *  1. THE SERVER OWNS THE STEP. The tutorial is game UI, but progress is state,
 *     and the client never decides state (CLAUDE.md hard rule). A client that
 *     could post step 9 from step 0 would make "completed the tutorial" a
 *     client claim — useless for the analytics/quests that will hang off it.
 *     So: only current+1 advances; further ahead is refused with a coded 409.
 *  2. RETRIES MUST BE HARMLESS. Mobile networks replay requests; a replayed
 *     advance of an already-taken step answers with the current truth instead
 *     of an error, so the overlay can never wedge on a flaky connection.
 *  3. REPLAYABLE IS A ROUTE (the owner asked for a REPLAYABLE tutorial):
 *     /tutorial/reset returns to step 0, clears completion, and the whole
 *     advance chain must work a second time — asserted end-to-end below.
 *  4. SKIP COMPLETES DIRECTLY (one request, documented choice in routes.ts),
 *     because a client-side loop of N advances would race its own responses.
 *  5. THE GUIDED FLOW IS SKIPPABLE AND THE SKIP PERSISTS (owner 2026-08-29:
 *     players "should be able to skip tutorial if they dont want to"). Every
 *     exact-shape assertion below now carries `guideSkipped` — the field is a
 *     WIRE CONTRACT the client renders on, so an answer that stopped sending it
 *     should fail here rather than silently put a skipper back in the flow.
 *
 * Tier membership (free group, both flag states) is asserted by
 * test/land-gate.test.ts's derived route table, not here.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import type { FastifyInstance } from 'fastify';
import { QUESTS, TUTORIAL_STEPS } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The routes register on the `free` group; with the flag unset that group
// carries the land gate and every request here would 402 before the handler.
// The free tier is the tutorial's audience, so the suite exercises it directly.
process.env['FREE_ONBOARDING'] = 'true';

import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { progressQuest } from '../src/game/quests';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const FINAL = TUTORIAL_STEPS.count - 1;

let app: FastifyInstance;

/** A real signed session, the way the client gets one (land-gate.test.ts). */
async function signIn(): Promise<{ cookie: string; wallet: string }> {
  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const { message } = ch.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  expect(verify.statusCode).toBe(200);
  // The WALLET comes back too since 2026-08-28: the onboarding-chain tests tick
  // quest progress through the game's own wallet-keyed entry point, which is the
  // only way to prove the chain rides the real quest machinery.
  return { cookie: verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value, wallet };
}

interface StateDto { step: number; completedAt: string | null; guideSkipped: boolean }
interface OnboardingStepDto {
  questId: string; templateCode: string; target: number; rewardShards: number;
  progress: number; completed: boolean; claimed: boolean;
}
type ProbeDto = StateDto & { onboarding: OnboardingStepDto | null };

const probe = async (cookie: string): Promise<ProbeDto> => {
  const res = await app.inject({ method: 'GET', url: '/tutorial', cookies: { [SESSION_COOKIE]: cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as ProbeDto;
};

/**
 * Just the CARD-DECK half of the probe.
 *
 * The probe grew an `onboarding` field on 2026-08-28 (the quest-driven
 * onboarding chain rides the same request — see routes.ts). The deck's own
 * contract did not change, so these assertions stay EXACT rather than becoming
 * `objectContaining`: a deck that started returning a fourth field should still
 * fail here. The chain half has its own describe block at the bottom.
 */
const get = async (cookie: string): Promise<StateDto> => {
  const { onboarding: _onboarding, ...deck } = await probe(cookie);
  return deck;
};
const post = (cookie: string, path: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: path, cookies: { [SESSION_COOKIE]: cookie }, payload });

beforeAll(async () => {
  app = await buildApp(TEST_CONFIG, db);
});

afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

describe('GET /tutorial', () => {
  it('a fresh wallet has not started: step 0, no completion, no row needed', async () => {
    const { cookie } = await signIn();
    expect(await get(cookie)).toEqual({ step: 0, completedAt: null, guideSkipped: false });
  });
});

describe('POST /tutorial/advance', () => {
  it('advances one step at a time and a replayed advance is an idempotent no-op', async () => {
    const { cookie } = await signIn();
    const first = await post(cookie, '/tutorial/advance', { step: 1 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ step: 1, completedAt: null, guideSkipped: false });

    // The retry a mobile network makes: same step again → current truth, not
    // a second advance and not an error.
    const replay = await post(cookie, '/tutorial/advance', { step: 1 });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ step: 1, completedAt: null, guideSkipped: false });
    expect(await get(cookie)).toEqual({ step: 1, completedAt: null, guideSkipped: false });
  });

  it('refuses to skip ahead by more than one, with a coded 409', async () => {
    const { cookie } = await signIn();
    const jump = await post(cookie, '/tutorial/advance', { step: 3 });
    expect(jump.statusCode).toBe(409);
    expect((jump.json() as { error: { code?: string } }).error.code)
      .toBe('TUTORIAL_STEP_OUT_OF_ORDER');
    // And the refusal changed nothing.
    expect(await get(cookie)).toEqual({ step: 0, completedAt: null, guideSkipped: false });
  });

  it('rejects steps outside the shared TUTORIAL_STEPS order at the validator', async () => {
    const { cookie } = await signIn();
    for (const step of [0, -1, FINAL + 1]) {
      const res = await post(cookie, '/tutorial/advance', { step });
      expect(res.statusCode, `step ${step} must not reach the handler`).toBe(400);
    }
  });

  it('walking every step stamps completedAt exactly on the final advance', async () => {
    const { cookie } = await signIn();
    for (let step = 1; step < FINAL; step++) {
      const res = await post(cookie, '/tutorial/advance', { step });
      expect(res.statusCode).toBe(200);
      expect((res.json() as StateDto).completedAt, `step ${step} is not completion`).toBeNull();
    }
    const last = await post(cookie, '/tutorial/advance', { step: FINAL });
    expect(last.statusCode).toBe(200);
    const done = last.json() as StateDto;
    expect(done.step).toBe(FINAL);
    expect(done.completedAt).not.toBeNull();
    expect(await get(cookie)).toEqual(done);
  });
});

describe('POST /tutorial/skip', () => {
  it('completes directly in one request', async () => {
    const { cookie } = await signIn();
    const res = await post(cookie, '/tutorial/skip');
    expect(res.statusCode).toBe(200);
    const state = res.json() as StateDto;
    expect(state.step).toBe(FINAL);
    expect(state.completedAt).not.toBeNull();
    expect(await get(cookie)).toEqual(state);
  });
});

/**
 * SKIPPING THE GUIDED FLOW (owner 2026-08-29). Four properties, and each one is
 * a way the feature could be shipped broken while every other test still passed:
 *
 *  - IT PERSISTS. A client-side flag would be undone by the next page load and
 *    put the player straight back into the flow they dismissed. So the skip is a
 *    column, and a fresh GET is what proves it.
 *  - IT DOES NOT EAT THE QUESTS. The owner drew this line explicitly: a skipper
 *    keeps the five objectives and their rewards on the board and can still claim
 *    them. Only the hand-holding stops.
 *  - IT IS REVERSIBLE, because SKIP sits on a strip a new player is looking at
 *    anyway and will be pressed by accident.
 *  - IT IS IDEMPOTENT, like every other write on this route.
 */
describe('POST /tutorial/guide/skip — the guided flow is skippable', () => {
  it('records the skip, and a fresh read still reports it — this is what survives a reload', async () => {
    const { cookie } = await signIn();
    const res = await post(cookie, '/tutorial/guide/skip');
    expect(res.statusCode).toBe(200);
    expect((res.json() as StateDto).guideSkipped).toBe(true);
    // The client's next cold start is exactly this request.
    expect((await get(cookie)).guideSkipped).toBe(true);
  });

  it('ends the card deck too — from the player\'s chair SKIP is one thing', async () => {
    // A SKIP that silenced the coach marks but left three cards standing would
    // be read as a bug, not as a distinction between two systems.
    const { cookie } = await signIn();
    const state = (await post(cookie, '/tutorial/guide/skip')).json() as StateDto;
    expect(state.step).toBe(FINAL);
    expect(state.completedAt).not.toBeNull();
  });

  it('leaves the onboarding quests on the board, claimable and paying', async () => {
    const { cookie, wallet } = await signIn();
    expect((await post(cookie, '/tutorial/guide/skip')).statusCode).toBe(200);

    const template = QUESTS.onboardingTemplates[0]!;
    const { onboarding } = await probe(cookie);
    expect(onboarding, 'a skipper still has their chain step').not.toBeNull();
    expect(onboarding!.templateCode).toBe(template.id);

    await progressQuest(db, wallet, template.id, template.target);
    const claim = await post(cookie, `/quests/${onboarding!.questId}/claim`);
    expect(claim.statusCode).toBe(200);
    expect((claim.json() as { reward: number }).reward).toBe(template.rewardShards);
  });

  it('resumes from settings, and reversing does not replay the card deck', async () => {
    const { cookie } = await signIn();
    await post(cookie, '/tutorial/guide/skip');
    const resumed = (await post(cookie, '/tutorial/guide/resume')).json() as StateDto;
    expect(resumed.guideSkipped).toBe(false);
    // The deck stays finished: resuming drops the player back on the chain step
    // they are actually on, not in front of three cards they already read.
    // REPLAY TUTORIAL is the control that rewinds the deck.
    expect(resumed.step).toBe(FINAL);
    expect(resumed.completedAt).not.toBeNull();
    expect((await get(cookie)).guideSkipped).toBe(false);
  });

  it('is idempotent in both directions — mobile networks replay requests', async () => {
    const { cookie } = await signIn();
    const a = (await post(cookie, '/tutorial/guide/skip')).json() as StateDto;
    const b = (await post(cookie, '/tutorial/guide/skip')).json() as StateDto;
    expect(b).toEqual(a);
    expect((await post(cookie, '/tutorial/guide/resume')).statusCode).toBe(200);
    expect((await post(cookie, '/tutorial/guide/resume')).statusCode).toBe(200);
    expect((await get(cookie)).guideSkipped).toBe(false);
  });

  it('REPLAY TUTORIAL un-skips guidance — a replayed tutorial that shows nothing is not one', async () => {
    const { cookie } = await signIn();
    await post(cookie, '/tutorial/guide/skip');
    const reset = (await post(cookie, '/tutorial/reset')).json() as StateDto;
    expect(reset.guideSkipped).toBe(false);
    expect(reset.step).toBe(0);
  });
});

describe('POST /tutorial/reset — the REPLAYABLE requirement', () => {
  it('restores step 0 and the full run works a second time', async () => {
    const { cookie } = await signIn();
    // First run, skipped — completion exists.
    expect((await post(cookie, '/tutorial/skip')).statusCode).toBe(200);

    const reset = await post(cookie, '/tutorial/reset');
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ step: 0, completedAt: null, guideSkipped: false });
    expect(await get(cookie)).toEqual({ step: 0, completedAt: null, guideSkipped: false });

    // Second run must behave exactly like the first: monotonic advances, no
    // skipping, completion stamped fresh at the end.
    const jump = await post(cookie, '/tutorial/advance', { step: 2 });
    expect(jump.statusCode).toBe(409);
    for (let step = 1; step <= FINAL; step++) {
      expect((await post(cookie, '/tutorial/advance', { step })).statusCode).toBe(200);
    }
    const done = await get(cookie);
    expect(done.step).toBe(FINAL);
    expect(done.completedAt).not.toBeNull();
  });
});

/**
 * THE ONBOARDING CHAIN rides the tutorial probe (owner 2026-08-28: onboarding
 * "should be quest driven"). What these pin, and why each one is worth a test:
 *
 *  - THE CHAIN IS ORDERED AND STARTS AT THE FIRST STEP. The whole design is that
 *    a new player is shown exactly one next thing; if the probe answered with an
 *    arbitrary chain member the strip would send players to the wrong screen.
 *  - PROGRESS TICKS THROUGH THE REAL QUEST MACHINERY. The step must complete
 *    from the same progressQuest call the game systems already make — that is
 *    the difference between reusing the quest system and having built a second,
 *    parallel progress system nobody maintains.
 *  - CLAIMING ADVANCES THE CHAIN. `claimed`, not `completed`, is what moves the
 *    player on, because the reward is part of the step.
 *  - IT ENDS. A finished chain answers null, which is what lets the base-screen
 *    strip disappear for a veteran instead of sitting there forever.
 */
describe('the onboarding chain on GET /tutorial', () => {
  it('starts on the FIRST chain step, in QUESTS.onboardingTemplates order', async () => {
    const { cookie } = await signIn();
    const { onboarding } = await probe(cookie);
    expect(onboarding).not.toBeNull();
    expect(onboarding!.templateCode).toBe(QUESTS.onboardingTemplates[0]!.id);
    expect(onboarding!.progress).toBe(0);
    expect(onboarding!.completed).toBe(false);
    expect(onboarding!.claimed).toBe(false);
    // The reward shown is the one constants.ts authored — never a server guess.
    expect(onboarding!.rewardShards).toBe(QUESTS.onboardingTemplates[0]!.rewardShards);
    expect(onboarding!.target).toBe(QUESTS.onboardingTemplates[0]!.target);
  });

  it('walks the whole chain in order as each step is progressed and CLAIMED', async () => {
    const { cookie, wallet } = await signIn();
    for (const template of QUESTS.onboardingTemplates) {
      const { onboarding } = await probe(cookie);
      expect(onboarding, `chain should be on ${template.id}`).not.toBeNull();
      expect(onboarding!.templateCode).toBe(template.id);

      // The SAME entry point the game systems use (base.ts on a finished build,
      // raids.ts on a settled raid, deposits.ts on a land payment). If this ever
      // stops completing the step, those hooks are dead too.
      await progressQuest(db, wallet, template.id, template.target);

      // Completed but UNCLAIMED must still be the live step: the reward is part
      // of the step, so the strip stays on it offering CLAIM.
      const completed = await probe(cookie);
      expect(completed.onboarding!.templateCode).toBe(template.id);
      expect(completed.onboarding!.completed).toBe(true);
      expect(completed.onboarding!.progress).toBe(template.target);

      const claim = await post(cookie, `/quests/${completed.onboarding!.questId}/claim`);
      expect(claim.statusCode, `claiming ${template.id}`).toBe(200);
      expect((claim.json() as { reward: number }).reward).toBe(template.rewardShards);
    }
    // Chain finished → nothing to show. This is what makes the base-screen strip
    // vanish for everyone who is past onboarding.
    expect((await probe(cookie)).onboarding).toBeNull();
  });

  it('pays the chain WITHOUT paying the all-three daily bonus', async () => {
    // The chain has five claimable steps and the daily bonus fires on the third
    // DAILY claim. Sharing the quests table is only safe because claimQuest
    // counts `scope = 'daily'` rows — a chain claim must never trip it, or a new
    // player would mint the bonus for doing the tutorial.
    const { cookie, wallet } = await signIn();
    for (const template of QUESTS.onboardingTemplates.slice(0, QUESTS.dailyBonusAt + 1)) {
      const { onboarding } = await probe(cookie);
      await progressQuest(db, wallet, template.id, template.target);
      const claim = await post(cookie, `/quests/${onboarding!.questId}/claim`);
      expect(claim.statusCode).toBe(200);
      expect((claim.json() as { bonusPaid: boolean }).bonusPaid,
        `${template.id} must not pay the DAILY bonus`).toBe(false);
    }
  });
});
