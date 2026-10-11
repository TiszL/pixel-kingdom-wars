/**
 * Pure view-model helpers of the closed-alpha admin screen (admin.tsx). The
 * screen is a thin render over these (no React harness here); each test pins
 * WHY the rule exists:
 *
 * - the review's entire purpose is READING the quality-filter answers, so the
 *   answer walk must be shape-agnostic: a renderer keyed to a fixed field list
 *   would silently hide whatever the landing form starts collecting next;
 * - meta fields (status, invite code, timestamps…) have dedicated card chrome,
 *   so duplicating them into the answers would bury the real answers;
 * - approve returns a one-time invite code the owner may need to DM by hand —
 *   losing it to a shape mismatch means a needless DB dig.
 */
import { describe, expect, it } from 'vitest';
import {
  applicationAnswers, applicationList, fieldLabel, fmtWhen, inviteCodeFrom,
  inviteCodesForClipboard, inviteHistoryList, INVITE_COUNT_PRESETS, normalizeStats,
  parseInviteCount, pendingInviteRequestFromStorage,
} from './admin';

describe('applicationAnswers — every collected answer surfaces, whatever the shape', () => {
  it('renders an answers OBJECT in server order (form order = reading order)', () => {
    const out = applicationAnswers({
      id: 'a1', email: 'x@y.z', status: 'pending',
      answers: { whyPlay: 'I love base builders', solana_experience: 'since 2021' },
    });
    expect(out).toEqual([
      { label: 'WHY PLAY', value: 'I love base builders' },
      { label: 'SOLANA EXPERIENCE', value: 'since 2021' },
    ]);
  });

  it('renders an answers ARRAY of {question, answer} rows', () => {
    const out = applicationAnswers({
      answers: [{ question: 'Why?', answer: 'because' }, { question: 'How long?', answer: '2y' }],
    });
    expect(out).toEqual([
      { label: 'WHY?', value: 'because' },
      { label: 'HOW LONG?', value: '2y' },
    ]);
  });

  it('surfaces unknown top-level fields — a new form question must never be silently hidden', () => {
    const out = applicationAnswers({ id: '1', email: 'a@b.c', discordHandle: 'tin#1', region: 'EU' });
    expect(out).toEqual([
      { label: 'DISCORD HANDLE', value: 'tin#1' },
      { label: 'REGION', value: 'EU' },
    ]);
  });

  it('excludes meta fields that already have dedicated card chrome', () => {
    const out = applicationAnswers({
      id: '1', status: 'approved', email: 'a@b.c', createdAt: '2026-08-01T00:00:00Z',
      inviteCode: 'SECRET', reviewerNote: 'ok', redeemedAt: null, approvedAt: '2026-08-02T00:00:00Z',
    });
    expect(out).toEqual([]); // nothing left over — and the code never renders twice
  });

  it('handles the REAL alpha_applications row (api db/schema.ts): handle/socials are answers, the rest is chrome', () => {
    const out = applicationAnswers({
      id: 'u1', email: 'p@q.r', handle: 'tin', socials: 'x.com/tin',
      answers: { whyPlay: 'raids' }, status: 'approved',
      inviteCode: 'ABCDE', invitedAt: '2026-08-05T00:00:00Z',
      redeemedWallet: 'So11111111111111111111111111111111111111112',
      redeemedAt: '2026-08-05T01:00:00Z', reviewerNote: null, createdAt: '2026-08-04T00:00:00Z',
    });
    // The invite code / redeemed wallet must NOT leak into the answers walk —
    // they render in the approved-chrome block; handle+socials are review input.
    expect(out).toEqual([
      { label: 'WHY PLAY', value: 'raids' },
      { label: 'HANDLE', value: 'tin' },
      { label: 'SOCIALS', value: 'x.com/tin' },
    ]);
  });

  it("keeps blank answers as '—': a question someone left empty is review signal, not noise", () => {
    const out = applicationAnswers({ answers: { whyPlay: '', clanPlans: null } });
    expect(out).toEqual([
      { label: 'WHY PLAY', value: '—' },
      { label: 'CLAN PLANS', value: '—' },
    ]);
  });
});

describe('normalizeStats — tab counts that can never render NaN', () => {
  it('reads flat {pending, approved, rejected}', () => {
    expect(normalizeStats({ pending: 3, approved: 10, rejected: 2 }))
      .toEqual({ pending: 3, approved: 10, rejected: 2 });
  });

  it('reads counts nested under `counts` and defaults missing keys to 0', () => {
    expect(normalizeStats({ counts: { pending: 5 } }))
      .toEqual({ pending: 5, approved: 0, rejected: 0 });
  });

  it('survives null/garbage — the tabs must render before/despite the stats fetch', () => {
    expect(normalizeStats(null)).toEqual({ pending: 0, approved: 0, rejected: 0 });
    expect(normalizeStats({ pending: 'many' })).toEqual({ pending: 0, approved: 0, rejected: 0 });
  });
});

describe('applicationList — bare array or {applications}, junk rows dropped', () => {
  it('accepts both payload shapes', () => {
    const rows = [{ id: '1' }, { id: '2' }];
    expect(applicationList(rows)).toEqual(rows);
    expect(applicationList({ applications: rows })).toEqual(rows);
  });

  it('returns [] (not a crash) on an unexpected payload', () => {
    expect(applicationList({ apps: [] })).toEqual([]);
    expect(applicationList(undefined)).toEqual([]);
  });
});

describe('inviteCodeFrom — the one-time code survives response-shape drift', () => {
  it('finds the code at the shapes an approve endpoint plausibly returns', () => {
    expect(inviteCodeFrom({ inviteCode: 'AAAA-BBBB' })).toBe('AAAA-BBBB');
    expect(inviteCodeFrom({ code: 'AAAA-BBBB' })).toBe('AAAA-BBBB');
    expect(inviteCodeFrom({ application: { inviteCode: 'AAAA-BBBB' } })).toBe('AAAA-BBBB');
  });

  it('returns null when absent so the card says "emailed" instead of rendering garbage', () => {
    expect(inviteCodeFrom({ ok: true })).toBeNull();
    expect(inviteCodeFrom({ inviteCode: '' })).toBeNull();
    expect(inviteCodeFrom(null)).toBeNull();
  });
});

describe('labels & dates', () => {
  it('fieldLabel spaces snake_case and camelCase into readable UPPER', () => {
    expect(fieldLabel('solana_experience')).toBe('SOLANA EXPERIENCE');
    expect(fieldLabel('whyPlay')).toBe('WHY PLAY');
  });

  it("fmtWhen never shows 'Invalid Date' — raw value beats a lying formatter", () => {
    expect(fmtWhen('2026-08-01T12:34:56.000Z')).toBe('2026-08-01 12:34');
    expect(fmtWhen('yesterday-ish')).toBe('yesterday-ish');
    expect(fmtWhen(undefined)).toBe('—');
  });
});

describe('standalone invite generator view model', () => {
  it('pins the owner presets while allowing every custom integer through 100', () => {
    expect(INVITE_COUNT_PRESETS).toEqual([1, 10, 20, 50]);
    for (const value of ['1', '10', '20', '37', '50', '100']) {
      expect(parseInviteCount(value)).toBe(Number(value));
    }
    for (const value of ['', '0', '-1', '1.5', '101', 'ten', '0100']) {
      expect(parseInviteCount(value)).toBeNull();
    }
  });

  it('keeps only well-shaped generated/application history rows', () => {
    const valid = {
      id: 'i1', source: 'generated', code: 'A'.repeat(26),
      createdAt: '2026-08-24T00:00:00Z', batchId: 'b1', createdByWallet: 'wallet',
      email: null, redeemedWallet: null, redeemedAt: null,
    };
    expect(inviteHistoryList({ invites: [valid, null, { id: 'bad' }] })).toEqual([valid]);
    expect(inviteHistoryList({ applications: [valid] })).toEqual([]);
  });

  it('copies bulk/history codes as directly-pasteable newline text', () => {
    expect(inviteCodesForClipboard([{ code: 'FIRST' }, { code: 'SECOND' }, { code: 'THIRD' }]))
      .toBe('FIRST\nSECOND\nTHIRD');
    expect(inviteCodesForClipboard([])).toBe('');
  });

  it('restores only this admin wallet\'s valid pending request after a lost response', () => {
    const pending = {
      wallet: 'admin-wallet', count: 50,
      key: '123e4567-e89b-42d3-a456-426614174000',
    };
    const raw = JSON.stringify(pending);
    expect(pendingInviteRequestFromStorage(raw, 'admin-wallet')).toEqual(pending);
    expect(pendingInviteRequestFromStorage(raw, 'different-wallet')).toBeNull();
    expect(pendingInviteRequestFromStorage('{bad-json', 'admin-wallet')).toBeNull();
    expect(pendingInviteRequestFromStorage(JSON.stringify({ ...pending, count: 101 }), 'admin-wallet')).toBeNull();
    expect(pendingInviteRequestFromStorage(JSON.stringify({ ...pending, key: 'not-a-uuid' }), 'admin-wallet')).toBeNull();
  });
});
