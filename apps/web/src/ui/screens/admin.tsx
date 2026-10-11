/**
 * Closed-alpha application review — OWNER-ONLY screen.
 *
 * Reachability: the HUD renders its ADMIN entry only after `useIsAdmin()` has
 * probed GET /admin/alpha/stats once for the session wallet. A 403/404 answer
 * means "not an admin" and NO admin UI exists anywhere — players never see a
 * dead menu item, and the server (ADMIN_WALLETS) stays the only authority.
 *
 * Rendering: application cards show EVERY answer the form collected. The
 * quality-filter answers are the whole point of manual review, so the card is
 * NOT keyed to a fixed field list — `applicationAnswers` walks whatever the
 * server sends and only meta fields with dedicated chrome are excluded. When
 * the landing form gains a question, it shows up here with zero client changes.
 *
 * The pure helpers up top are the tested surface (admin.test.tsx) — the JSX is
 * a thin render over them, per the army.helpers convention.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { api, ApiError, idemKey } from '../../lib/api';
import { bus } from '../../lib/events';
import { useApp } from '../../state/store';
import { Btn, Chip, COLORS as C, ScrollPage, Sp } from '../primitives';
import { useFetch } from '../useFetch';

const toast = (msg: string): void => bus.emit('ui:toast', { msg });
const AdminChatPanel = lazy(() => import('./AdminChatPanel'));
const AdminFeedbackPanel = lazy(() => import('./AdminFeedbackPanel'));
const AdminCampaignPanel = lazy(() => import('../campaigns/AdminCampaignPanel'));

// ===========================================================================
// Pure helpers (tested in admin.test.tsx — no React involved)
// ===========================================================================

export type AlphaAppStatus = 'pending' | 'approved' | 'rejected';
export const APP_STATUSES: AlphaAppStatus[] = ['pending', 'approved', 'rejected'];

/** Fields the card renders with dedicated chrome (header/footer), so the
 *  answer walk must not repeat them — duplicates would bury the real answers. */
const META_KEYS = new Set([
  'id', 'status', 'email', 'createdAt', 'updatedAt',
  'approvedAt', 'rejectedAt', 'reviewedAt', 'reviewedBy',
  // invitedAt/redeemedWallet/redeemedAt: the real alpha_applications columns
  // (db/schema.ts); the extra aliases keep the walk safe against DTO renames.
  'inviteCode', 'invitedAt', 'reviewerNote',
  'redeemedAt', 'redeemedWallet', 'redeemedBy', 'redeemedByWallet',
]);

export interface AnswerField { label: string; value: string }

/** snake_case / camelCase key → spaced UPPER label ("whyPlay" → "WHY PLAY"). */
export function fieldLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toUpperCase()
    .trim();
}

/** One answer value → display string. Blank is '—', never dropped: an answer
 *  someone left empty is itself review signal. */
function fieldValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.trim() === '' ? '—' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Every reviewable answer on an application, in server order. Handles both an
 * `answers` bag (object OR array of {question, answer}) and loose top-level
 * fields, so the card cannot silently hide what the form collected if the API
 * shapes the row differently than guessed.
 */
export function applicationAnswers(app: Record<string, unknown>): AnswerField[] {
  const out: AnswerField[] = [];
  const answers = app['answers'];
  if (Array.isArray(answers)) {
    for (const entry of answers) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        out.push({
          label: fieldValue(e['question'] ?? e['label'] ?? e['q']).toUpperCase(),
          value: fieldValue(e['answer'] ?? e['value'] ?? e['a']),
        });
      } else {
        out.push({ label: 'ANSWER', value: fieldValue(entry) });
      }
    }
  } else if (answers && typeof answers === 'object') {
    for (const [k, v] of Object.entries(answers)) out.push({ label: fieldLabel(k), value: fieldValue(v) });
  }
  for (const [k, v] of Object.entries(app)) {
    if (k === 'answers' || META_KEYS.has(k)) continue;
    out.push({ label: fieldLabel(k), value: fieldValue(v) });
  }
  return out;
}

/** Tab counts, tolerant of shape drift ({pending,...} or nested under `counts`;
 *  missing keys read 0 — a tab bar must never render NaN). */
export function normalizeStats(raw: unknown): Record<AlphaAppStatus, number> {
  const src = (raw && typeof raw === 'object' && 'counts' in (raw as object)
    ? (raw as { counts: unknown }).counts
    : raw) as Record<string, unknown> | null | undefined;
  const n = (k: string): number => {
    const v = src?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return { pending: n('pending'), approved: n('approved'), rejected: n('rejected') };
}

/** The list payload, whether the server sends a bare array or {applications}. */
export function applicationList(raw: unknown): Array<Record<string, unknown>> {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { applications?: unknown }).applications)
      ? (raw as { applications: unknown[] }).applications
      : [];
  return arr.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object');
}

/** The invite code out of an approve response, wherever it rides. Null when
 *  absent — the card then says "code emailed" instead of showing garbage. */
export function inviteCodeFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  for (const k of ['inviteCode', 'code']) {
    if (typeof r[k] === 'string' && (r[k] as string).length > 0) return r[k] as string;
  }
  const nested = r['application'];
  if (nested && typeof nested === 'object') {
    const code = (nested as Record<string, unknown>)['inviteCode'];
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
}

export const INVITE_COUNT_PRESETS = [1, 10, 20, 50] as const;

export function parseInviteCount(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw)) return null;
  const count = Number(raw);
  return Number.isInteger(count) && count >= 1 && count <= 100 ? count : null;
}

export interface InviteHistoryRow {
  id: string;
  source: 'generated' | 'application';
  code: string;
  createdAt: string;
  batchId: string | null;
  createdByWallet: string | null;
  email: string | null;
  redeemedWallet: string | null;
  redeemedAt: string | null;
}

export function inviteHistoryList(raw: unknown): InviteHistoryRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const invites = (raw as { invites?: unknown }).invites;
  if (!Array.isArray(invites)) return [];
  return invites.filter((row): row is InviteHistoryRow => {
    if (!row || typeof row !== 'object') return false;
    const r = row as Record<string, unknown>;
    return typeof r['id'] === 'string'
      && (r['source'] === 'generated' || r['source'] === 'application')
      && typeof r['code'] === 'string'
      && typeof r['createdAt'] === 'string';
  });
}

/** Exact clipboard payload: one redeemable code per line, no labels or JSON. */
export function inviteCodesForClipboard(rows: Array<{ code: string }>): string {
  return rows.map(({ code }) => code).join('\n');
}

interface PendingInviteRequest {
  wallet: string;
  count: number;
  key: string;
}

const PENDING_INVITE_REQUEST_KEY = 'shardkeep:admin-invite-generation:v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pendingInviteStorageKey(wallet: string): string {
  return `${PENDING_INVITE_REQUEST_KEY}:${wallet}`;
}

/** A response can be lost after the server commits. Keep the UUID across a
 *  panel remount/reload so retrying cannot accidentally mint a second batch. */
export function pendingInviteRequestFromStorage(raw: string | null, wallet: string): PendingInviteRequest | null {
  if (raw === null || wallet === '') return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingInviteRequest>;
    return value.wallet === wallet
      && typeof value.count === 'number'
      && value.count >= 1
      && value.count <= 100
      && Number.isInteger(value.count)
      && typeof value.key === 'string'
      && UUID_RE.test(value.key)
      ? value as PendingInviteRequest
      : null;
  } catch {
    return null;
  }
}

function loadPendingInviteRequest(wallet: string): PendingInviteRequest | null {
  if (wallet === '') return null;
  try {
    return pendingInviteRequestFromStorage(sessionStorage.getItem(pendingInviteStorageKey(wallet)), wallet);
  } catch {
    return null;
  }
}

function savePendingInviteRequest(wallet: string, request: PendingInviteRequest | null): boolean {
  if (wallet === '') return request === null;
  try {
    const key = pendingInviteStorageKey(wallet);
    if (request === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(request));
    return true;
  } catch {
    return false;
  }
}

/** Short date for card metadata; raw value when unparsable (never "Invalid Date"). */
export function fmtWhen(v: unknown): string {
  if (typeof v !== 'string' || v === '') return '—';
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? v : t.toISOString().slice(0, 16).replace('T', ' ');
}

// ===========================================================================
// Screen
// ===========================================================================

export default function AdminScreen(): React.JSX.Element {
  const setScreen = useApp((s) => s.setScreen);
  const [tab, setTab] = useState<AlphaAppStatus>('pending');
  const [section, setSection] = useState<'alpha' | 'codes' | 'chat' | 'feedback' | 'campaigns'>('campaigns');
  const { data: statsRaw, reload: reloadStats } = useFetch<unknown>(() => api.get('/admin/alpha/stats'));
  const stats = normalizeStats(statsRaw);
  const accessOpen = !!statsRaw && typeof statsRaw === 'object' && (statsRaw as { accessOpen?: boolean }).accessOpen === true;
  const accessKnown = statsRaw !== null;
  const { data: listRaw, error, loading, reload } = useFetch<unknown>(
    () => api.get(`/admin/alpha/applications?status=${tab}`), [tab]);
  const apps = applicationList(listRaw);
  // An action changed a row's status → counts are stale; the LIST is left alone
  // on approve so the freshly minted invite code stays on screen to copy/DM.
  const afterAction = (): void => { reloadStats(); };

  return (
    <ScrollPage viewportSafe title="PLAYTEST ADMIN" onClose={() => setScreen('base')}
      tabs={<>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '8px 10px 0', background: C.card }}>
          <Btn variant={section === 'campaigns' ? 'gold' : 'ghost'} onClick={() => setSection('campaigns')} fontSize={15} style={{ flex: 1, minHeight: 44 }}>CAMPAIGNS</Btn>
          <Btn variant={section === 'alpha' ? 'gold' : 'ghost'} onClick={() => setSection('alpha')}
            fontSize={15} style={{ flex: 1, minHeight: 44 }}>REQUESTS</Btn>
          <Btn variant={section === 'codes' ? 'gold' : 'ghost'} onClick={() => setSection('codes')}
            fontSize={15} style={{ flex: 1, minHeight: 44 }}>CODES</Btn>
          <Btn variant={section === 'chat' ? 'gold' : 'ghost'} onClick={() => setSection('chat')}
            fontSize={15} style={{ flex: 1, minHeight: 44 }}>CHAT</Btn>
          <Btn variant={section === 'feedback' ? 'gold' : 'ghost'} onClick={() => setSection('feedback')}
            fontSize={15} style={{ flex: 1, minHeight: 44 }}>FEEDBACK</Btn>
        </div>
        {section === 'alpha' && <div style={{ display: 'flex', gap: 4, padding: '4px 10px 0', background: C.card }}>
          {APP_STATUSES.map((t) => (
            <Btn key={t} variant={tab === t ? 'gold' : 'ghost'} fontSize={17}
              style={{ flex: 1, padding: '6px 0 8px' }}
              // Re-tapping the active tab is the refresh — the screen has no
              // other chrome to hang a reload control on.
              onClick={() => { if (tab === t) { reload(); reloadStats(); } else setTab(t); }}>
              {t.toUpperCase()} {stats[t]}
            </Btn>
          ))}
        </div>
        }</>}>
      {section === 'campaigns' ? <Suspense fallback={<div role="status">LOADING CAMPAIGNS…</div>}><AdminCampaignPanel /></Suspense> :
      section === 'feedback' ? <Suspense fallback={<div role="status">LOADING FEEDBACK…</div>}><AdminFeedbackPanel /></Suspense> :
      section === 'chat' ? <Suspense fallback={<div role="status">LOADING MODERATION…</div>}><AdminChatPanel /></Suspense> :
      section === 'codes' ? <InviteCodesPanel readOnly={accessOpen || !accessKnown} /> :
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Verified stats shape (game/alpha.ts alphaStats) also carries redeemed/
            access — the two numbers that say whether approvals CONVERT. */}
        {accessOpen && <p role="status">OPEN PLAYTEST — admission is open; invite controls are unavailable here. Existing records remain available for review.</p>}
        <RedemptionLine raw={statsRaw} />
        {loading && <div style={{ color: C.textFaint, fontSize: 16 }}>LOADING…</div>}
        {error && (
          <>
            <div style={{ color: C.danger, fontSize: 15 }}>{error.toUpperCase()}</div>
            <Btn variant="sec" fontSize={16} onClick={reload}>RETRY</Btn>
          </>
        )}
        {!loading && !error && apps.length === 0 && (
          <div style={{ color: C.textFaint, fontSize: 16 }}>NO {tab.toUpperCase()} APPLICATIONS</div>
        )}
        {apps.map((a, i) => (
          <AppCard key={String(a['id'] ?? i)} app={a} onActed={afterAction} readOnly={accessOpen || !accessKnown} />
        ))}
      </div>}
    </ScrollPage>
  );
}

interface GeneratedInviteBatch {
  batchId: string;
  count: number;
  createdAt: string;
  createdByWallet: string;
  codes: Array<{
    id: string;
    code: string;
    ordinal: number;
    redeemedWallet: string | null;
    redeemedAt: string | null;
  }>;
}

interface InviteHistoryPage {
  invites: InviteHistoryRow[];
  nextOffset: number | null;
}

function InviteCodesPanel({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const wallet = useApp((s) => s.wallet) ?? '';
  const [countInput, setCountInput] = useState(() => String(loadPendingInviteRequest(wallet)?.count ?? 1));
  const [busy, setBusy] = useState(false);
  const [newBatch, setNewBatch] = useState<GeneratedInviteBatch | null>(null);
  // Preserve the request UUID after an unknown network outcome: retrying the
  // same count then asks the server for the same batch instead of minting more.
  const [retryRequest, setRetryRequest] = useState<PendingInviteRequest | null>(
    () => loadPendingInviteRequest(wallet),
  );
  const [olderRows, setOlderRows] = useState<InviteHistoryRow[]>([]);
  const [olderNext, setOlderNext] = useState<number | null | undefined>(undefined);
  const [olderBusy, setOlderBusy] = useState(false);
  const count = parseInviteCount(countInput);
  const { data: history, error, loading, reload } = useFetch<InviteHistoryPage>(
    () => api.get('/admin/alpha/invites?limit=100&offset=0'),
  );
  const firstRows = inviteHistoryList(history);
  const seen = new Set<string>();
  const rows = [...firstRows, ...olderRows].filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  const nextOffset = olderNext === undefined ? history?.nextOffset ?? null : olderNext;

  useEffect(() => {
    const pending = loadPendingInviteRequest(wallet);
    setRetryRequest(pending);
    if (pending !== null) setCountInput(String(pending.count));
  }, [wallet]);

  const copyCodes = (codes: Array<{ code: string }>, label: string): void => {
    const value = inviteCodesForClipboard(codes);
    if (value === '') return;
    let write: Promise<void> | undefined;
    try {
      write = navigator.clipboard?.writeText(value);
    } catch {
      toast('COPY FAILED — SELECT THE CODES BELOW');
      return;
    }
    if (!write) { toast('COPY UNAVAILABLE — SELECT THE CODES BELOW'); return; }
    void write
      .then(() => toast(`${label} COPIED`))
      .catch(() => toast('COPY FAILED — SELECT THE CODES BELOW'));
  };

  const generate = (): void => {
    if (readOnly) return;
    if (count === null || busy) { toast('ENTER A COUNT FROM 1 TO 100'); return; }
    if (wallet === '') { toast('SESSION EXPIRED — SIGN IN AGAIN'); return; }
    const request = retryRequest?.wallet === wallet && retryRequest.count === count
      ? retryRequest
      : { wallet, count, key: idemKey() };
    // Persist before sending. If storage is unavailable, do not create a batch
    // whose lost response could turn a reload-and-retry into extra live codes.
    if (!savePendingInviteRequest(wallet, request)) {
      toast('SESSION STORAGE UNAVAILABLE — RELOAD AND TRY AGAIN');
      return;
    }
    setRetryRequest(request);
    setBusy(true);
    void api.post<GeneratedInviteBatch>('/admin/alpha/invites', {
      count,
      idempotencyKey: request.key,
    }).then((batch) => {
      setNewBatch(batch);
      setRetryRequest(null);
      savePendingInviteRequest(wallet, null);
      setOlderRows([]);
      setOlderNext(undefined);
      reload();
      toast(`${batch.count} INVITE ${batch.count === 1 ? 'CODE' : 'CODES'} GENERATED`);
    }).catch((cause: unknown) => {
      // A 4xx definitively rejected this body. Network failures and 5xx can
      // happen after commit but before a usable response, so retain the UUID.
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        setRetryRequest(null);
        savePendingInviteRequest(wallet, null);
      }
      // If the response vanished after commit, the new batch is already in
      // history. Refreshing gives the admin a recovery path without guessing.
      reload();
      toast(cause instanceof ApiError ? cause.message.toUpperCase() : 'GENERATION FAILED — RETRY');
    }).finally(() => setBusy(false));
  };

  const loadOlder = (): void => {
    if (nextOffset === null || olderBusy) return;
    setOlderBusy(true);
    void api.get<InviteHistoryPage>(`/admin/alpha/invites?limit=100&offset=${nextOffset}`)
      .then((page) => {
        setOlderRows((current) => [...current, ...inviteHistoryList(page)]);
        setOlderNext(page.nextOffset);
      })
      .catch((cause: unknown) => toast(cause instanceof ApiError ? cause.message.toUpperCase() : 'HISTORY LOAD FAILED'))
      .finally(() => setOlderBusy(false));
  };

  const discardRetry = (): void => {
    const confirmed = window.confirm(
      'This request may already have generated live codes. Check history before creating another batch. Discard its retry key?',
    );
    if (!confirmed) return;
    if (!savePendingInviteRequest(wallet, null)) {
      toast('COULD NOT CLEAR THE PENDING RETRY');
      return;
    }
    setRetryRequest(null);
    reload();
    toast('PENDING RETRY DISCARDED — CHECK HISTORY');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {readOnly && <p role="status">Invite issuance is unavailable. Existing code history is preserved.</p>}
      {!readOnly && <Chip accent={C.goldDp} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <div style={{ color: C.goldHi, fontSize: 18 }}>GENERATE INVITE CODES</div>
        <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.35 }}>
          ONE-TIME PLAYTEST ACCESS · 1–100 PER BATCH
        </div>
        {retryRequest !== null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div role="status" style={{ flex: 1, color: C.goldHi, fontSize: 13, lineHeight: 1.35 }}>
              RECOVERING AN UNCONFIRMED {retryRequest.count}-CODE REQUEST · RETRY TO REUSE THE SAME BATCH
            </div>
            <Btn variant="ghost" fontSize={12} disabled={busy} onClick={discardRetry}>DISCARD RETRY</Btn>
          </div>
        )}
        <div style={{ display: 'flex', gap: 5 }}>
          {INVITE_COUNT_PRESETS.map((preset) => (
            <Btn key={preset} variant={count === preset ? 'gold' : 'sec'} fontSize={16}
              disabled={busy || retryRequest !== null} style={{ flex: 1, padding: '6px 0 8px' }}
              onClick={() => setCountInput(String(preset))}>{preset}</Btn>
          ))}
        </div>
        <input className="interactive" type="text" inputMode="numeric" pattern="[0-9]*"
          aria-label="Number of invite codes" value={countInput} disabled={busy || retryRequest !== null}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (/^\d{0,3}$/.test(value)) setCountInput(value.replace(/^0+(?=\d)/, ''));
          }}
          style={{
            fontFamily: 'inherit', fontSize: 24, textAlign: 'center', background: C.surface,
            color: C.text, border: `2px solid ${count === null ? C.danger : C.border}`,
            padding: '7px 8px 9px',
          }} />
        <Btn disabled={busy || count === null} onClick={generate}>
          {busy ? 'GENERATING…' : retryRequest !== null ? `RETRY ${retryRequest.count}`
            : count === null ? 'ENTER 1–100' : `GENERATE ${count}`}
        </Btn>
      </Chip>}

      {newBatch && (
        <Chip accent={C.success} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: C.success, fontSize: 17 }}>NEW BATCH · {newBatch.count}</span>
            <Sp />
            <Btn variant="sec" fontSize={14} onClick={() => copyCodes(newBatch.codes, 'NEW BATCH')}>COPY ALL</Btn>
          </div>
          <CodeRows rows={newBatch.codes} onCopy={copyCodes} />
        </Chip>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: C.textDim, fontSize: 17 }}>CODE HISTORY</span>
        <Sp />
        {rows.length > 0 && <Btn variant="ghost" fontSize={13} onClick={() => copyCodes(rows, 'LOADED CODES')}>COPY LOADED</Btn>}
        <Btn variant="ghost" fontSize={13} onClick={() => {
          setOlderRows([]); setOlderNext(undefined); reload();
        }}>REFRESH</Btn>
      </div>
      {loading && <div role="status" style={{ color: C.textFaint }}>LOADING CODES…</div>}
      {error && <div role="alert" style={{ color: C.danger }}>{error.toUpperCase()}</div>}
      {!loading && !error && rows.length === 0 && <div style={{ color: C.textFaint }}>NO CODES GENERATED YET</div>}
      {rows.map((row) => (
        <Chip key={`${row.source}:${row.id}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: C.textFaint, fontSize: 12, letterSpacing: '1px' }}>
              {row.source === 'application' ? `REQUEST · ${row.email ?? 'UNKNOWN EMAIL'}` : 'ADMIN BATCH'}
            </span>
            <Sp />
            <span style={{ color: row.redeemedAt ? C.success : C.gold, fontSize: 12 }}>
              {row.redeemedAt ? 'REDEEMED' : 'UNUSED'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="copyable-all" style={{
              minWidth: 0, flex: 1, color: C.goldHi, fontFamily: 'monospace',
              fontSize: 15, overflowWrap: 'anywhere', userSelect: 'all',
            }}>{row.code}</span>
            <Btn variant="sec" fontSize={13} onClick={() => copyCodes([row], 'CODE')}>COPY</Btn>
          </div>
          <div style={{ color: C.textFaint, fontSize: 12 }}>
            {fmtWhen(row.createdAt)}
            {row.redeemedWallet ? ` · ${row.redeemedWallet.slice(0, 4)}…${row.redeemedWallet.slice(-4)}` : ''}
          </div>
        </Chip>
      ))}
      {nextOffset !== null && (
        <Btn variant="sec" disabled={olderBusy} onClick={loadOlder}>
          {olderBusy ? 'LOADING…' : 'LOAD OLDER CODES'}
        </Btn>
      )}
    </div>
  );
}

function CodeRows({
  rows, onCopy,
}: {
  rows: Array<{ id: string; code: string }>;
  onCopy: (rows: Array<{ code: string }>, label: string) => void;
}): React.JSX.Element {
  return <>{rows.map((row) => (
    <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="copyable-all" style={{
        minWidth: 0, flex: 1, color: C.goldHi, fontFamily: 'monospace',
        fontSize: 15, overflowWrap: 'anywhere', userSelect: 'all',
      }}>{row.code}</span>
      <Btn variant="sec" fontSize={13} onClick={() => onCopy([row], 'CODE')}>COPY</Btn>
    </div>
  ))}</>;
}

/** "REDEEMED n · ACCESS ROWS n" when the stats carry them; nothing otherwise. */
function RedemptionLine({ raw }: { raw: unknown }): React.JSX.Element | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { redeemed?: unknown; access?: unknown };
  if (typeof r.redeemed !== 'number' || typeof r.access !== 'number') return null;
  return (
    <div style={{ color: C.textFaint, fontSize: 14, letterSpacing: '1px' }}>
      CODES REDEEMED {r.redeemed} · ACCESS LIST {r.access}
    </div>
  );
}

/** Local echo of an approve/reject so the verdict (and the invite code) stays
 *  on screen without refetching the list out from under the reviewer. */
type Acted = { kind: 'approved'; code: string | null; emailFailed: boolean } | { kind: 'rejected' };

function AppCard({ app, onActed, readOnly }: { app: Record<string, unknown>; onActed: () => void; readOnly: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [acted, setActed] = useState<Acted | null>(null);

  const status = acted?.kind ?? (typeof app['status'] === 'string' ? (app['status'] as string) : 'pending');
  const pending = status === 'pending';
  const answers = applicationAnswers(app);
  const email = fieldValue(app['email']);
  const inviteCode = acted?.kind === 'approved' ? acted.code : typeof app['inviteCode'] === 'string' ? (app['inviteCode'] as string) : null;
  const reviewerNote = typeof app['reviewerNote'] === 'string' && app['reviewerNote'] !== '' ? (app['reviewerNote'] as string) : null;
  const redeemedWallet = typeof app['redeemedWallet'] === 'string' ? (app['redeemedWallet'] as string) : null;
  const redeemed = app['redeemedAt'] ?? redeemedWallet;
  const emailFailed = acted?.kind === 'approved' && acted.emailFailed;

  const act = (kind: 'approve' | 'reject'): void => {
    if (readOnly) return;
    setBusy(kind);
    const id = String(app['id'] ?? '');
    // Routes verified against apps/api/src/routes-alpha.ts: POST
    // /admin/alpha/:id/approve → {id,email,inviteCode,emailSent}; reject takes
    // an OPTIONAL note (omitted when blank so the row stores null, not '').
    const trimmedNote = note.trim();
    const req = kind === 'approve'
      ? api.postRaw<unknown>(`/admin/alpha/${id}/approve`)
      : api.postRaw<unknown>(`/admin/alpha/${id}/reject`, trimmedNote === '' ? {} : { note: trimmedNote });
    void req
      .then((r) => {
        if (kind === 'approve') {
          const code = inviteCodeFrom(r);
          // emailSent:false = the invite email failed but the approval stood —
          // the owner must DM the code, so say so instead of a happy toast.
          const emailFailed = !!r && typeof r === 'object' && (r as { emailSent?: unknown }).emailSent === false;
          setActed({ kind: 'approved', code, emailFailed });
          toast(emailFailed ? 'APPROVED — EMAIL FAILED, DM THE CODE' : 'APPROVED — CODE EMAILED');
        } else {
          setActed({ kind: 'rejected' });
          toast('REJECTED');
        }
        onActed();
      })
      .catch((e: unknown) => toast(e instanceof ApiError ? e.message.toUpperCase() : `${kind.toUpperCase()} FAILED — TRY AGAIN`))
      .finally(() => setBusy(null));
  };

  const copyCode = (): void => {
    if (!inviteCode) return;
    void navigator.clipboard?.writeText(inviteCode)
      .then(() => toast('CODE COPIED'))
      .catch(() => toast('COPY FAILED — LONG-PRESS THE CODE'));
  };

  const statusColor = status === 'approved' ? C.success : status === 'rejected' ? C.danger : C.gold;

  return (
    <Chip accent={pending ? C.goldDp : undefined} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 19, color: C.goldHi, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>
        <Sp />
        <span style={{ fontSize: 14, color: statusColor, letterSpacing: '1px', flex: 'none' }}>{status.toUpperCase()}</span>
      </div>
      <div style={{ fontSize: 13, color: C.textFaint }}>SUBMITTED {fmtWhen(app['createdAt'])}</div>

      {/* EVERY answer — the review IS reading these. */}
      {answers.map((f, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, color: C.textFaint, letterSpacing: '1px' }}>{f.label}</span>
          <span style={{ fontSize: 15, color: C.textDim, lineHeight: 1.3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{f.value}</span>
        </div>
      ))}

      {/* Approved: the one-time code, visible so the owner can also DM it. */}
      {status === 'approved' && (
        <div onClick={copyCode} className="interactive" style={{
          background: C.surface, border: `2px solid ${C.goldDp}`, padding: '8px 10px',
          display: 'flex', flexDirection: 'column', gap: 4, cursor: inviteCode ? 'pointer' : 'default',
        }}>
          <span style={{ fontSize: 13, color: emailFailed ? C.danger : C.textFaint, letterSpacing: '1px' }}>
            {emailFailed ? 'INVITE CODE — EMAIL FAILED, DM IT' : 'INVITE CODE (EMAILED)'}{inviteCode ? ' — TAP TO COPY' : ''}
          </span>
          <span style={{ fontSize: 17, color: C.gold, fontFamily: 'monospace', wordBreak: 'break-all', userSelect: 'all' }}>
            {inviteCode ?? 'SENT BY EMAIL — NOT RETURNED BY THE SERVER'}
          </span>
          {!!redeemed && (
            <span style={{ fontSize: 13, color: C.success }}>
              REDEEMED {fmtWhen(app['redeemedAt'])}
              {redeemedWallet ? ` · ${redeemedWallet.slice(0, 4)}…${redeemedWallet.slice(-4)}` : ''}
            </span>
          )}
        </div>
      )}

      {status === 'rejected' && reviewerNote && (
        <div style={{ fontSize: 14, color: C.textFaint }}>
          <span style={{ color: C.danger }}>NOTE: </span>{reviewerNote}
        </div>
      )}

      {pending && !readOnly && (
        <>
          {/* Stored with a rejection for the re-review pass — the API sends the
              applicant NOTHING on reject (game/alpha.ts, owner-locked). */}
          <input className="interactive" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="REVIEWER NOTE (KEPT ON REJECT — NEVER EMAILED)" maxLength={1000}
            style={{ fontFamily: 'inherit', fontSize: 15, background: C.surface, color: C.text, border: `2px solid ${C.border}`, padding: '6px 8px' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn fontSize={17} disabled={busy !== null} style={{ flex: 1, padding: '8px 0 10px' }} onClick={() => act('approve')}>
              {busy === 'approve' ? 'APPROVING…' : 'APPROVE'}
            </Btn>
            <Btn variant="ghost" fontSize={17} disabled={busy !== null}
              style={{ flex: 1, padding: '8px 0 10px', color: C.blood, border: `2px solid ${C.blood}` }}
              onClick={() => act('reject')}>
              {busy === 'reject' ? 'REJECTING…' : 'REJECT'}
            </Btn>
          </div>
        </>
      )}
    </Chip>
  );
}
