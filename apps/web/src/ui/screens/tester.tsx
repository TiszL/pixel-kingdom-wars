import { useLayoutEffect } from 'react';
import { useFeedbackPages } from '../feedback/useFeedbackPages';
/**
 * TESTER screen (owner 2026-08-21; Founding Kingdoms rebuild D-103, 2026-09-04):
 * the playtest program inside the game.
 *
 *   MY PROGRESS — points and rank in FOUR buckets (MILESTONES · DAILY ·
 *                 REFERRALS · FEEDBACK), the campaign card (name, reward
 *                 sentence, day X of 14 when the window is set), TODAY's ledger
 *                 (every daily source: what fired, what is left, the streak),
 *                 the "how to get listed" line for an unlisted wallet, and the
 *                 one-time milestone checklist. Opening this tab runs the
 *                 server's bounded recompute and toasts newly earned points —
 *                 "+25 TESTER POINTS — ATTACK ANOTHER PLAYER" — for milestones
 *                 and daily keys alike (testerDaily.ts owns that read).
 *   LEADERBOARD — a compact top ten plus the link to the full public board on
 *                 the site, where the statistics live.
 *   FEEDBACK    — submit a private report with this wallet, follow up in its
 *                 conversation, and see points awarded after team review.
 *
 * Everything rendered here comes from the server (HUD values are never
 * hardcoded); the catalog copy (titles, hints, points) rides on /tester/me so
 * the screen cannot drift from the API's TESTER_PROGRAM / TESTER_DAILY. The
 * shared constants are read only for labels and the reward sentence, and this
 * screen is lazy, so the catalog objects never enter first paint.
 */
import { PLAYTEST_CAMPAIGN, PLAYTEST_COMPETITIONS, TESTER_DAILY, TESTER_PROGRAM } from '@shardkeep/shared';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { EVENTS, track } from '../../lib/analytics';
import {
  api, ApiError, type TesterBoardDto, type TesterCampaignDto, type TesterDailyCatalogEntryDto,
  type TesterMeDto, type TesterMilestoneDto,
} from '../../lib/api';
import { bus } from '../../lib/events';
import { BUILD } from '../../lib/version';
import { useApp } from '../../state/store';
import { Btn, Chip, COLORS as C, LinkBtn, ScrollPage, fmtN } from '../primitives';
import { earnedToast, useTesterMe } from '../testerDaily';
import { useFetch } from '../useFetch';
import FeedbackThread from '../feedback/FeedbackThread';
import KnownIssueSuggestions from '../feedback/KnownIssueSuggestions';
import FeedbackScreenshotPicker, { type FeedbackScreenshotDraft } from '../feedback/FeedbackScreenshotPicker';
import { FeedbackPrivateImage } from '../feedback/FeedbackThreadScreenshots';
import { deliverFeedbackReport } from '../feedback/feedbackReportDelivery';
import { advanceFeedbackSubmission, clearFeedbackSubmission, readFeedbackSubmission, saveFeedbackSubmission } from '../feedback/feedbackSubmission';

/** The toast wording lives with the shared read now; re-exported so the
 *  screen's test keeps pinning it from here. */
export { earnedToast };

/** The full public board — same rows as the in-game tab, plus the playtest
 *  statistics (D-103). Opened in a new tab so the game session stays put. */
export const SITE_LEADERBOARD_URL = 'https://pixelkingdomwars.com/leaderboard';

const PlayerCampaignPanel = lazy(() => import('../campaigns/PlayerCampaignPanel'));
type Tab = 'MY PROGRESS' | 'LEADERBOARD' | 'FEEDBACK' | 'CAMPAIGNS';

interface FeedbackRow {
  id: string; category: string; title: string; body: string; status: string;
  importance: string | null; points: number; adminNote: string | null; createdAt: string;
  unread?: boolean; fixedAt?: string | null; fixedRef?: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  first_steps: 'FIRST STEPS', progression: 'PROGRESSION', army: 'ARMY & HEROES', combat: 'COMBAT',
  economy: 'ECONOMY', web3: 'LAND & MONEY', social: 'SOCIAL',
  daily: TESTER_DAILY.categoryLabels.daily.toUpperCase(),
  referral: TESTER_DAILY.categoryLabels.referral.toUpperCase(),
};
const CATEGORY_ORDER = ['first_steps', 'progression', 'army', 'combat', 'economy', 'web3', 'social', 'daily', 'referral'];
const FEEDBACK_LABEL: Record<string, string> = {
  bug: 'BUG', balance: 'BALANCE', ux: 'UX / CONFUSING', idea: 'IDEA', other: 'OTHER',
};

export function groupMilestones(list: readonly TesterMilestoneDto[]): Array<{ category: string; label: string; items: TesterMilestoneDto[]; earned: number; total: number }> {
  // Known categories in catalog order, then any category this client does not
  // know yet, in first-seen order. A category is never DROPPED: the server's
  // catalog is the truth, and a milestone the client silently hides is a
  // milestone the tester cannot earn on purpose.
  const unknown = list.map((m) => m.category).filter((c, i, all) => !CATEGORY_ORDER.includes(c) && all.indexOf(c) === i);
  return [...CATEGORY_ORDER, ...unknown]
    .map((category) => {
      const items = list.filter((m) => m.category === category);
      return {
        category, label: CATEGORY_LABEL[category] ?? category.toUpperCase(), items,
        earned: items.reduce((s, m) => s + (m.achievedAt ? m.points : 0), 0),
        total: items.reduce((s, m) => s + m.points, 0),
      };
    })
    .filter((g) => g.items.length > 0);
}

/** One line of TODAY's ledger: a daily source with what it paid so far. */
export interface LedgerRow {
  key: string; title: string; hint: string; unit: number; cap: number; count: number; earned: number; done: boolean;
}

/**
 * TODAY's ledger from the server's daily rows. The catalog on /tester/me is
 * preferred (it is the API's own table); TESTER_DAILY is the fallback for an
 * API cut that has daily rows but no catalog. Every source is listed — the
 * ones still open are the point of the screen ("what is left today").
 */
export function todayLedger(data: Pick<TesterMeDto, 'daily'>): { rows: LedgerRow[]; streaks: LedgerRow[] } {
  const byKey = new Map((data.daily?.byKey ?? []).map((r) => [r.key, r]));
  const row = (s: TesterDailyCatalogEntryDto): LedgerRow => {
    const hit = byKey.get(s.key);
    return {
      key: s.key, title: s.title, hint: s.hint, unit: s.points, cap: s.cap ?? 1,
      count: hit?.count ?? 0, earned: hit?.points ?? 0, done: (hit?.count ?? 0) > 0,
    };
  };
  const sources: readonly TesterDailyCatalogEntryDto[] = data.daily?.catalog?.sources ?? TESTER_DAILY.sources;
  const streaks: readonly TesterDailyCatalogEntryDto[] = data.daily?.catalog?.streaks ?? TESTER_DAILY.streaks;
  return { rows: sources.map(row), streaks: streaks.map(row) };
}

/** "DAY 3 OF 14" when the window is set and today falls inside it; "TBA"
 *  otherwise (D-103: no start date yet — the window only changes presentation). */
export function campaignDayLabel(campaign: TesterCampaignDto | undefined): string {
  const total = campaign?.totalDays ?? PLAYTEST_CAMPAIGN.totalDays;
  const day = campaign?.dayIndex;
  // Owner 2026-09-04: the competition starts on an announced date and runs 14
  // days; until then the label is TBA while everything keeps running.
  if (typeof day !== 'number') return 'TBA';
  if (day < 1) return 'OPENS SOON';
  if (day > total) return 'CLOSED';
  return `DAY ${day} OF ${total}`;
}

/** The four buckets under the total. All-time daily and referral points are
 *  the leaderboard's `dailyPoints` / `referralPoints`; an API cut without them
 *  still sums correctly (total − milestones − feedback) and shows the referral
 *  COUNT where the points would be, never a fabricated number. */
export function pointBuckets(data: TesterMeDto): Array<{ label: string; value: string; sub: string }> {
  const earnedCount = data.milestones.filter((m) => m.achievedAt).length;
  const referralPoints = data.referralPoints ?? null;
  const dailyPoints = data.dailyPoints
    ?? Math.max(0, data.points - data.milestonePoints - data.feedbackPoints - (referralPoints ?? 0));
  const r = data.referrals;
  return [
    { label: 'MILESTONES', value: `${fmtN(data.milestonePoints)} PTS`, sub: `${earnedCount}/${data.milestones.length}` },
    { label: 'DAILY', value: `${fmtN(dailyPoints)} PTS`, sub: data.daily ? `+${data.daily.todayPoints} TODAY` : '' },
    {
      label: 'REFERRALS',
      value: referralPoints != null ? `${fmtN(referralPoints)} PTS` : r ? `${r.qualified} QUALIFIED` : '—',
      sub: r ? `${r.invited} INVITED · ${r.activeToday} ACTIVE TODAY` : '',
    },
    { label: 'FEEDBACK', value: `${fmtN(data.feedbackPoints)} PTS`, sub: `${data.feedbackCount} REPORTS` },
  ];
}

/** The board rule in one sentence when the server did not send its own. */
function listedFallback(data: TesterMeDto): string {
  const founding = data.milestones.find((m) => m.key === TESTER_PROGRAM.board.requiredMilestone)?.title ?? 'Found your base';
  return `${founding}, earn one more milestone and sign in once — then your name joins the public board.`;
}

/** The server names WHY a wallet is off the public board with a short code
 *  (game/tester.ts ListedReason); players read a sentence, never the code. A
 *  code this build does not know falls back to the generic rule. */
const LISTED_REASON_COPY: Record<string, string> = {
  no_base: 'Found your Keep — then your name joins the public board.',
  no_action: 'Do one more thing beyond founding — collect, build, train or raid — and your name joins the public board.',
  no_session: 'Sign in once with your wallet and your name joins the public board.',
  hidden: 'This wallet is not shown on the public board.',
  internal: 'Team wallets are never listed on the public board.',
};

function listedCopy(data: TesterMeDto): string {
  const reason = data.listedReason;
  if (!reason) return listedFallback(data);
  return LISTED_REASON_COPY[reason] ?? (/^[a-z_]+$/.test(reason) ? listedFallback(data) : reason);
}

const home = (): void => useApp.getState().setScreen('base');

export default function TesterScreen({ ownerBridge }: { ownerBridge?: FeedbackOwnerBridge } = {}): React.JSX.Element {
  const wallet = useApp((s) => s.wallet);
  const [tab, setTab] = useState<Tab>('MY PROGRESS');
  const tabs: Tab[] = ['MY PROGRESS', 'LEADERBOARD', 'CAMPAIGNS', 'FEEDBACK'];
  useEffect(() => { track(EVENTS.TESTER_SCREEN_OPENED); }, []);
  return (
    <ScrollPage
      viewportSafe
      title="TESTER PROGRAM"
      onClose={home}
      tabs={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '8px 10px 0', background: C.card }}>
          {tabs.map((t) => (
            <Btn key={t} variant={tab === t ? 'gold' : 'ghost'} fontSize={16}
              style={{ flex: 1, padding: '6px 0 8px', minHeight: 44 }} onClick={() => setTab(t)}>{t}</Btn>
          ))}
        </div>
      }>
      {tab === 'MY PROGRESS' && <ProgressTab />}
      {tab === 'LEADERBOARD' && <LeaderboardTab />}
      {tab === 'CAMPAIGNS' && <Suspense fallback={<p role="status">LOADING CAMPAIGNS…</p>}><PlayerCampaignPanel /></Suspense>}
      {tab === 'FEEDBACK' && wallet && <FeedbackTab key={wallet} wallet={wallet} {...(ownerBridge ? { ownerBridge } : {})} />}
    </ScrollPage>
  );
}

const header = { display: 'flex', justifyContent: 'space-between', color: C.gold, fontSize: 15, letterSpacing: 1, padding: '4px 2px 0' } as const;

function CampaignCard({ campaign, landOwner }: { campaign: TesterCampaignDto | undefined; landOwner: boolean | undefined }): React.JSX.Element {
  return (
    <Chip style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4, border: `2px solid ${C.goldDp}` }} accent={C.goldDp}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ color: C.goldHi, fontSize: 18 }}>{(campaign?.name ?? PLAYTEST_CAMPAIGN.name).toUpperCase()}</span>
        <span data-testid="campaign-day" style={{ color: C.text, fontSize: 14, flex: 'none' }}>{campaignDayLabel(campaign)}</span>
      </div>
      <div style={{ color: C.textDim, fontSize: 14, lineHeight: 1.4 }}>Open CAMPAIGNS for current dates, independent scores, eligibility and rewards. Lifetime points continue throughout.</div>
      {typeof landOwner === 'boolean' && (
        <div data-testid="wl-eligibility" style={{ color: landOwner ? C.success : C.goldHi, fontSize: 13, lineHeight: 1.4 }}>
          {landOwner
            ? `WHITELIST: Land Deed held. The first ${PLAYTEST_COMPETITIONS.founderSpots} verified original minters have guaranteed spots; another ${PLAYTEST_COMPETITIONS.rankedSpots} use campaign scores and deed eligibility at close. See CAMPAIGNS.`
            : 'WHITELIST: An active Land Deed is needed for a ranked spot at close. Previously guaranteed first-minter spots are retained after selling. See CAMPAIGNS.'}
        </div>
      )}
    </Chip>
  );
}

function LedgerLine({ r }: { r: LedgerRow }): React.JSX.Element {
  const right = r.cap > 1
    ? `${r.count}/${r.cap} · +${r.earned}`
    : r.done ? `+${r.earned}` : r.unit > 0 ? `+${r.unit}` : '—';
  return (
    <Chip style={{ alignItems: 'flex-start', gap: 10, opacity: r.done ? 1 : 0.85 }}>
      <span aria-label={r.done ? 'done' : 'not yet'} data-testid={`daily-${r.key}`}
        style={{ width: 22, textAlign: 'center', color: r.done ? C.goldHi : C.textFaint, fontSize: 18, flex: 'none' }}>
        {r.done ? '✓' : '○'}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        <span style={{ color: r.done ? C.text : C.textDim, fontSize: 16 }}>{r.title.toUpperCase()}</span>
        <span style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.35 }}>{r.hint}</span>
      </span>
      <span style={{ color: r.done ? C.goldHi : C.textDim, fontSize: 15, flex: 'none' }}>{right}</span>
    </Chip>
  );
}

function ProgressTab(): React.JSX.Element {
  const { data, error, loading, reload } = useTesterMe();
  const groups = useMemo(() => groupMilestones(data?.milestones ?? []), [data]);
  const ledger = useMemo(() => (data ? todayLedger(data) : null), [data]);
  if (loading && !data) return <div style={{ color: C.textFaint, fontSize: 16 }}>CHECKING YOUR PROGRESS…</div>;
  if (error && !data) return (<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div style={{ color: C.danger, fontSize: 15 }}>{error.toUpperCase()}</div>
    <Btn variant="sec" fontSize={16} onClick={reload}>RETRY</Btn>
  </div>);
  if (!data) return <div />;
  const buckets = pointBuckets(data);
  const streak = data.daily?.streakDays ?? 0;
  const streakTarget = (data.daily?.catalog?.streaks ?? TESTER_DAILY.streaks).find((s) => (s.days ?? 0) > streak);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Chip style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ color: C.goldHi, fontSize: 28 }}>{fmtN(data.points)} <span style={{ fontSize: 14, color: C.textDim }}>POINTS</span></span>
          <span style={{ color: C.text, fontSize: 16 }}>{data.rank ? `RANK #${data.rank}` : 'UNRANKED'}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6 }}>
          {buckets.map((b) => (
            <div key={b.label} data-testid={`bucket-${b.label.toLowerCase()}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.surface, border: `2px solid ${C.border}`, padding: '4px 8px' }}>
              <span style={{ color: C.textFaint, fontSize: 12, letterSpacing: 1 }}>{b.label}</span>
              <span style={{ color: C.text, fontSize: 16 }}>{b.value}</span>
              {b.sub && <span style={{ color: C.textDim, fontSize: 12 }}>{b.sub}</span>}
            </div>
          ))}
        </div>
        {data.listed === false && (
          <div role="note" data-testid="listed-hint" style={{ color: C.gold, fontSize: 13, lineHeight: 1.4 }}>
            HOW TO GET LISTED: {listedCopy(data)}
          </div>
        )}
        <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>
          Points reward real, verified actions during the playtest — one-time milestones, daily play, qualified friends and
          feedback all add to one all-time total. The public board shows your name and a shortened wallet only.
        </div>
      </Chip>

      <CampaignCard campaign={data.campaign} landOwner={data.landOwner} />

      {ledger && data.daily && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={header}>
            <span>TODAY</span><span style={{ color: C.textDim }}>+{data.daily.todayPoints} PTS</span>
          </div>
          <div data-testid="streak-line" style={{ color: streak > 0 ? C.goldHi : C.textDim, fontSize: 14, padding: '0 2px' }}>
            🔥 {streak}-DAY STREAK
            {streakTarget && <span style={{ color: C.textFaint }}> · {streakTarget.title.toUpperCase()} PAYS +{streakTarget.points}</span>}
          </div>
          {ledger.streaks.filter((s) => s.done).map((s) => <LedgerLine key={s.key} r={s} />)}
          {ledger.rows.map((r) => <LedgerLine key={r.key} r={r} />)}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.category} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={header}>
            <span>{g.label}</span><span style={{ color: C.textDim }}>{g.earned}/{g.total} PTS</span>
          </div>
          {g.items.map((m) => (
            <Chip key={m.key} style={{ alignItems: 'flex-start', gap: 10, opacity: m.achievedAt ? 1 : 0.85 }}>
              <span aria-label={m.achievedAt ? 'done' : 'not yet'} data-testid={`milestone-${m.key}`}
                style={{ width: 22, textAlign: 'center', color: m.achievedAt ? C.goldHi : C.textFaint, fontSize: 18, flex: 'none' }}>
                {m.achievedAt ? '✓' : '○'}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                <span style={{ color: m.achievedAt ? C.text : C.textDim, fontSize: 16 }}>{m.title.toUpperCase()}</span>
                <span style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.35 }}>{m.hint}</span>
              </span>
              <span style={{ color: m.achievedAt ? C.goldHi : C.textDim, fontSize: 15, flex: 'none' }}>+{m.points}</span>
            </Chip>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Rows the in-game tab shows; the site carries the whole board. */
export const BOARD_PREVIEW_ROWS = 10;

function LeaderboardTab(): React.JSX.Element {
  const { data, error, loading, reload } = useFetch<TesterBoardDto>(() => api.get<TesterBoardDto>('/tester/leaderboard'));
  const myWallet = useApp((s) => s.wallet);
  const myShort = myWallet ? `${myWallet.slice(0, 4)}…${myWallet.slice(-4)}` : null;
  if (loading && !data) return <div style={{ color: C.textFaint, fontSize: 16 }}>LOADING THE BOARD…</div>;
  if (error) return (<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div style={{ color: C.danger, fontSize: 15 }}>{error.toUpperCase()}</div>
    <Btn variant="sec" fontSize={16} onClick={reload}>RETRY</Btn>
  </div>);
  if (!data) return <div />;
  const preview = data.entries.slice(0, BOARD_PREVIEW_ROWS);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <CampaignCard campaign={data.campaign} landOwner={undefined} />
      <div style={{ color: C.textDim, fontSize: 14 }}>
        {data.totals.testers} TESTERS · {fmtN(data.totals.points)} POINTS · {data.totals.feedback} REPORTS
      </div>
      <LinkBtn href={SITE_LEADERBOARD_URL} target="_blank" variant="gold" fontSize={16}
        style={{ textAlign: 'center', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        FULL BOARD &amp; PLAYTEST STATS · PIXELKINGDOMWARS.COM ↗
      </LinkBtn>
      {preview.length === 0 && <div style={{ color: C.textFaint, fontSize: 16 }}>NO POINTS YET — BE THE FIRST.</div>}
      {preview.length > 0 && <div style={header}><span>TOP {preview.length}</span></div>}
      {preview.map((e) => {
        const mine = myShort !== null && e.wallet === myShort;
        const extra = [
          ...(e.dailyPoints != null ? [`DAILY ${fmtN(e.dailyPoints)}`] : []),
          ...(e.referralPoints != null ? [`REFERRALS ${fmtN(e.referralPoints)}`] : []),
        ];
        return (
          <Chip key={`${e.rank}-${e.wallet}`} style={{ gap: 10, border: mine ? `2px solid ${C.goldDp}` : undefined }}>
            <span style={{ width: 34, color: e.rank <= 3 ? C.goldHi : C.textDim, fontSize: 18, flex: 'none' }}>#{e.rank}</span>
            <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
              <span style={{ color: C.text, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(e.name ?? 'KEEPER').toUpperCase()}{mine ? ' (YOU)' : ''}
              </span>
              <span style={{ color: C.textFaint, fontSize: 13, fontFamily: 'monospace' }}>
                {[e.wallet, `${e.milestones} MILESTONES`, ...extra, `${e.feedback} REPORTS`].join(' · ')}
              </span>
            </span>
            <span style={{ color: C.goldHi, fontSize: 18, flex: 'none' }}>{fmtN(e.points)}</span>
          </Chip>
        );
      })}
    </div>
  );
}

function FeedbackTab({ wallet, ownerBridge }: { wallet: string; ownerBridge?: FeedbackOwnerBridge }): React.JSX.Element {
  const cfg = TESTER_PROGRAM.feedback;
  const screen = useApp((s) => s.screen);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const [recovered] = useState(() => { try { return { request: readFeedbackSubmission(wallet), error: null }; }
    catch (cause) { return { request: null, error: (cause as Error).message }; } });
  const [pending, setPending] = useState(recovered.request);
  const [category, setCategory] = useState<string>(pending?.category ?? 'bug');
  const [title, setTitle] = useState(pending?.title ?? '');
  const [body, setBody] = useState(pending?.body ?? '');
  const [evidenceIssue, setEvidenceIssue] = useState<{ id: string; title: string; status: string; category: string } | null>(pending?.evidence ? { id: pending.evidence.issueId, title: pending.title, category: pending.category, status: pending.evidence.mode === 'recurrence' ? 'fixed' : 'active' } : null);
  const [recurrence, setRecurrence] = useState(pending?.evidence?.mode === 'recurrence');
  const recurrenceNeeded = evidenceIssue?.status === 'fixed' || evidenceIssue?.status === 'closed';
  const [opened, setOpened] = useState<string | null>(null);
  const [images, setImages] = useState<FeedbackScreenshotDraft[]>([]);
  const imageScope = `${wallet}:new-report`;
  const titleInput = useRef<HTMLInputElement>(null);
  const unfilled = pending?.screenshots?.files.filter(f => !f.attachmentId) ?? [];
  const missingImages = unfilled.filter(f => !images.some(i => i.id === f.requestId));
  const changeImages = (next: FeedbackScreenshotDraft[]): void => {
    if (busy || pending?.screenshots?.replyPending) return;
    if (!pending) { setImages(next); return; }
    const remaining = pending.screenshots?.files.filter(f => !f.attachmentId) ?? [];
    if (next.length > remaining.length) { setNotice({ kind: 'err', msg: 'Reattach only the original missing screenshots. Add other images later in the conversation.' }); return; }
    const available = remaining.filter(f => !next.some(item => item.id === f.requestId));
    setImages(next.map(item => ({ ...item, id: remaining.some(f => f.requestId === item.id) ? item.id : available.shift()!.requestId })));
  };
  const clearMissing = (): void => {
    if (!pending?.screenshots || busy || pending.screenshots.replyPending) return;
    try { setPending(advanceFeedbackSubmission(wallet, pending, { ...pending.screenshots, files: pending.screenshots.files.filter(f => f.attachmentId || images.some(i => i.id === f.requestId)) })); }
    catch (cause) { setNotice({ kind: 'err', msg: (cause as Error).message }); }
  };
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(recovered.error ? { kind: 'err', msg: recovered.error } : null);
  const mine = useFeedbackPages<FeedbackRow>(wallet, '/tester/feedback/page');

  const submit = (): void => {
    if (busy || useApp.getState().wallet !== wallet) return;
    const t = title.trim();
    const b = body.trim();
    if (!pending && recurrenceNeeded && !recurrence) { setNotice({ kind: 'err', msg: 'CONFIRM A NEW RECURRENCE BEFORE SENDING EVIDENCE FOR A RESOLVED ISSUE.' }); return; }
    if (t.length === 0) { setNotice({ kind: 'err', msg: 'GIVE IT A SHORT TITLE' }); return; }
    if (b.length < cfg.bodyMinLen) { setNotice({ kind: 'err', msg: `TELL US A LITTLE MORE (${cfg.bodyMinLen}+ CHARACTERS)` }); return; }
    const request = pending ?? { requestId: crypto.randomUUID(), category, title: t, body: b,
      context: { screen, build: BUILD.gitSha.slice(0, 7), platform: /android/i.test(navigator.userAgent) ? 'android' : /iphone|ipad/i.test(navigator.userAgent) ? 'ios' : 'desktop',
        ...(selectedBaseId ? { baseId: selectedBaseId } : {}) },
      ...(evidenceIssue ? { evidence: { issueId: evidenceIssue.id, mode: recurrence ? 'recurrence' as const : 'evidence' as const } } : {}),
      ...(images.length ? { screenshots: { replyRequestId: crypto.randomUUID(), files: images.map(i => ({ requestId: i.id })) } } : {}) };
    try { saveFeedbackSubmission(wallet, request); }
    catch (cause) { setNotice({ kind: 'err', msg: (cause as Error).message }); return; }
    setPending(request);
    const controller = new AbortController(); operation.current = controller;
    setBusy(true);
    setNotice(null);
    void deliverFeedbackReport(wallet, request, new Map(images.map(i => [i.id, i.file])), controller.signal,
      () => useApp.getState().wallet === wallet, (next, phase) => { setPending(next); setNotice({ kind: 'ok', msg: phase }); })
      .then((r) => {
        if (controller.signal.aborted || useApp.getState().wallet !== wallet) return;
        clearFeedbackSubmission(wallet, r.request); setPending(null); setImages([]);
        // (No client event here: the server emits the authoritative
        // tester_feedback_submitted at its commit point — audit PA-06.)
        setTitle(''); setBody(''); setEvidenceIssue(null); setRecurrence(false);
        setNotice({ kind: 'ok', msg: 'REPORT SENT PRIVATELY — THE TEAM WILL REVIEW IT. POINTS ARE AWARDED AFTER REVIEW.' });
        bus.emit('ui:toast', { msg: r.basePoints > 0 ? `+${r.basePoints} TESTER POINTS — FEEDBACK SENT` : 'FEEDBACK SENT — THANK YOU' });
        mine.reload();
        setOpened(r.id);
      })
      .catch(async (e: unknown) => {
        if (controller.signal.aborted || useApp.getState().wallet !== wallet) return;
        let savedReportId: string | undefined;
        try { savedReportId = readFeedbackSubmission(wallet)?.screenshots?.reportId; }
        catch (storageCause) { setNotice({ kind: 'err', msg: (storageCause as Error).message }); return; }
        if (!savedReportId && e instanceof ApiError && [400, 403, 404, 409, 413, 422].includes(e.status)) {
          try { clearFeedbackSubmission(wallet, request); setPending(null); } catch { /* Preserve recovery until storage works again. */ }
        }
        if (!savedReportId && request.evidence && e instanceof ApiError && ['FEEDBACK_RECURRENCE_REQUIRED','FEEDBACK_ISSUE_CHANGED'].includes(e.code ?? '')) {
          try { const issue = await api.get<{id:string;title:string;status:string;category:string}>(`/tester/issues/${request.evidence.issueId}`, { signal: controller.signal });
            if (controller.signal.aborted || useApp.getState().wallet !== wallet) return; setEvidenceIssue(issue); setRecurrence(false);
          } catch { /* Keep evidence text; server will require confirmation again. */ }
        }
        setNotice({ kind: 'err', msg: e instanceof Error ? e.message.toUpperCase() : 'COULD NOT SEND — TRY AGAIN' });
      })
      .finally(() => { if (!controller.signal.aborted && useApp.getState().wallet === wallet) setBusy(false); });
  };


  // Additive projection before either existing return, so the same instance survives opened threads.
  const ownerBirth = useRef(ownerBridge ? { wallet, sessionKey: ownerBridge.sessionKey } : null);
  const ownerAlive = useRef(false);
  const ownerCommit = useRef<{ wallet: string; bridge: FeedbackOwnerBridge; view: FeedbackOwnerProjection } | null>(null);
  const readOwner = useMemo(() => (): FeedbackOwnerProjection | null => {
    const committed = ownerCommit.current; const birth = ownerBirth.current;
    if (!ownerAlive.current || !committed || !birth || committed.wallet !== birth.wallet
      || committed.bridge.wallet !== birth.wallet || committed.bridge.sessionKey !== birth.sessionKey) return null;
    try { return useApp.getState().wallet === birth.wallet && committed.bridge.isCurrent() === true ? committed.view : null; }
    catch { return null; }
  }, []);
  useLayoutEffect(() => {
    if (!ownerBridge) { ownerCommit.current = null; return; }
    const invoke = (callback: () => void): boolean => {
      if (readOwner() !== view) return false;
      callback(); return true;
    };
    // This latch belongs to this committed projection, not a second journal/owner.
    let submitted = false;
    const editDraft = (callback: () => void): boolean => !busy && !pending && !submitted && invoke(callback);
    const submitOnce = (): boolean => {
      // The original submit validates current text even when retrying a saved request.
      if (submitted || busy || !title.trim() || body.trim().length < cfg.bodyMinLen
        || (!pending && recurrenceNeeded && !recurrence)) return false;
      return invoke(() => { submitted = true; submit(); });
    };
    const view: FeedbackOwnerProjection = Object.freeze({
      wallet, sessionKey: ownerBridge.sessionKey,
      data: feedbackOwnerCopy({ category, title, body, pending, busy, recoveryError: recovered.error, notice,
        evidenceIssue, recurrence, recurrenceNeeded, opened, imageScope, missingImageIds: missingImages.map(image => image.requestId),
        reports: mine.data?.feedback ?? null, loading: mine.loading, error: mine.error, nextCursor: mine.nextCursor, limits: cfg }),
      images: Object.freeze(images.map(image => Object.freeze({ ...image }))), titleInput,
      actions: Object.freeze({
        setCategory: (value: string) => editDraft(() => setCategory(value)),
        setTitle: (value: string) => editDraft(() => { setTitle(value); setNotice(old => old?.kind === 'ok' ? null : old); }),
        setBody: (value: string) => editDraft(() => { setBody(value); setNotice(old => old?.kind === 'ok' ? null : old); }),
        setRecurrence: (value: boolean) => editDraft(() => setRecurrence(value)),
        setEvidenceIssue: (value: { id: string; title: string; status: string; category: string } | null) => editDraft(() => setEvidenceIssue(value)),
        setOpened: (id: string | null) => invoke(() => setOpened(id)),
        changeImages: (next: FeedbackScreenshotDraft[]) => !busy && !submitted && !pending?.screenshots?.replyPending && invoke(() => changeImages(next)),
        clearMissing: () => !busy && !submitted && !!pending?.screenshots && !pending.screenshots.replyPending && invoke(clearMissing),
        submit: submitOnce,
        reloadReports: () => invoke(mine.reload), moreReports: () => !!mine.nextCursor && !mine.loading && invoke(mine.more),
      }),
    });
    ownerCommit.current = { wallet, bridge: ownerBridge, view };
    return () => { if (ownerCommit.current?.view === view) ownerCommit.current = null; };
  });
  useLayoutEffect(() => {
    if (!ownerBridge) return;
    ownerAlive.current = true;
    let release: (() => void) | undefined;
    try { release = ownerBridge.attach(readOwner); } catch { ownerAlive.current = false; }
    return () => { ownerAlive.current = false; ownerCommit.current = null; release?.(); };
  }, [ownerBridge?.attach, ownerBridge?.wallet, ownerBridge?.sessionKey, readOwner]);

  const input = { fontFamily: 'inherit', fontSize: 17, background: C.surface, color: C.text, border: `2px solid ${C.borderLt}`, padding: '8px 10px' } as const;
  if (opened) return <FeedbackThread wallet={wallet} mode="reporter" reportId={opened} onBack={() => { setOpened(null); mine.reload(); }} onChanged={mine.reload} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Chip style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <div style={{ color: C.textDim, fontSize: 14, lineHeight: 1.4 }}>
          Only you and the support team can see your report, replies and screenshots. Points are awarded after review; submitting or replying does not automatically earn points.
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {cfg.categories.map((c) => (
            <Btn key={c} variant={category === c ? 'gold' : 'ghost'} fontSize={14} style={{ flex: 1, minWidth: 90, minHeight: 40 }}
              disabled={busy || !!pending} onClick={() => setCategory(c)}>{FEEDBACK_LABEL[c] ?? c.toUpperCase()}</Btn>
          ))}
        </div>
        {!pending && <KnownIssueSuggestions wallet={wallet} query={title} category={category} onDifferent={() => { setEvidenceIssue(null); setRecurrence(false); titleInput.current?.focus(); titleInput.current?.scrollIntoView?.({ block: 'nearest' }); }} onEvidence={issue => { setEvidenceIssue(issue); setRecurrence(false); setCategory(issue.category); if (!title.trim()) setTitle(issue.title); titleInput.current?.focus(); titleInput.current?.scrollIntoView?.({ block: 'nearest' }); }} />}
        {evidenceIssue && <div role="status">PRIVATE EVIDENCE FOR: {evidenceIssue.title}
          <div>Sending adds your evidence to your existing private conversation when available. Only a new report uses a daily report slot. It earns no points automatically.</div>
          {recurrenceNeeded && <label className="interactive" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}><input type="checkbox" checked={recurrence} disabled={busy || !!pending} onChange={e => setRecurrence(e.target.checked)} />THIS FIXED OR CLOSED ISSUE IS HAPPENING AGAIN — NEW RECURRENCE</label>}
          {!pending && <Btn variant="ghost" onClick={() => { setEvidenceIssue(null); setRecurrence(false); }}>REPORT A DIFFERENT PROBLEM</Btn>}
        </div>}
        <input ref={titleInput} className="interactive" disabled={busy || !!pending} value={title} maxLength={cfg.titleMaxLen} placeholder="TITLE"
          aria-label="Feedback title" style={input} onChange={(e) => { setTitle(e.target.value); setNotice(old => old?.kind === 'ok' ? null : old); }} />
        <textarea className="interactive" disabled={busy || !!pending} value={body} maxLength={cfg.bodyMaxLen} rows={5}
          placeholder="WHAT HAPPENED? WHAT DID YOU EXPECT? (STEPS HELP A LOT)"
          aria-label="Feedback details" style={{ ...input, resize: 'vertical' }} onChange={(e) => { setBody(e.target.value); setNotice(old => old?.kind === 'ok' ? null : old); }} />
        {pending?.screenshots?.files.filter(f => f.attachmentId).map(f => <FeedbackPrivateImage key={f.attachmentId} wallet={wallet}
          path={`/tester/feedback/${pending.screenshots!.reportId}`} attachment={{ id: f.attachmentId!, expired: false, width: null, height: null, byteLength: null, contentType: null }} />)}
        <FeedbackScreenshotPicker scopeKey={imageScope} items={images.filter(i => !pending?.screenshots?.files.some(f => f.requestId === i.id && f.attachmentId))}
          onChange={changeImages} disabled={busy || !!pending?.screenshots?.replyPending} />
        {missingImages.length > 0 && <div role="status">{missingImages.length} LOCAL SCREENSHOTS NEED REATTACHING. SELECT THE ORIGINAL FILES IN THE SAME ORDER.
          <Btn disabled={busy} onClick={clearMissing} style={{ minHeight: 44 }}>CLEAR MISSING FILES</Btn></div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ color: C.textFaint, fontSize: 13 }}>{body.trim().length}/{cfg.bodyMaxLen}</span>
          <Btn variant="gold" fontSize={18} disabled={busy} onClick={submit}>{busy ? 'SENDING…' : pending?.screenshots?.reportId ? 'RETRY SCREENSHOTS' : pending ? 'RETRY SAVED REPORT' : evidenceIssue ? 'SEND PRIVATE EVIDENCE' : 'SEND FEEDBACK'}</Btn>
        </div>
        {notice && <div role="status" style={{ color: notice.kind === 'ok' ? C.goldHi : C.danger, fontSize: 14, lineHeight: 1.4 }}>{notice.msg}</div>}
        {pending && <div role="status">{pending.screenshots?.reportId ? pending.screenshots.replyPending ? 'REPORT SAVED. SCREENSHOTS AWAIT ATTACHMENT CONFIRMATION.' : 'REPORT SAVED. SCREENSHOTS STILL NEED UPLOADING.' : 'A SAVED REPORT AWAITS CONFIRMATION. RETRY TO RECOVER THE SAME REPORT.'}</div>}
      </Chip>
      <div style={{ color: C.gold, fontSize: 15, letterSpacing: 1, padding: '4px 2px 0' }}>MY REPORTS</div>
      {mine.loading && !mine.data && <div style={{ color: C.textFaint, fontSize: 15 }}>LOADING…</div>}
      {mine.error && <div role="alert">{mine.error}<Btn onClick={mine.reload}>RETRY REPORTS</Btn></div>}
      {mine.data && mine.data.feedback.length === 0 && <div style={{ color: C.textFaint, fontSize: 15 }}>NOTHING SENT YET.</div>}
      {mine.data?.feedback.map((f) => (
        <Chip key={f.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: C.text, fontSize: 16 }}>{f.title.toUpperCase()}</span>
            <span style={{ color: C.goldHi, fontSize: 15, flex: 'none' }}>+{f.points}</span>
          </div>
          <div style={{ color: C.textFaint, fontSize: 13 }}>
            {(FEEDBACK_LABEL[f.category] ?? f.category.toUpperCase())} · {f.fixedAt ? 'FIXED' : f.status.toUpperCase()}{f.importance ? ` · ${f.importance.toUpperCase()}` : ''} · {f.createdAt.slice(0, 10)}
          </div>
          <div style={{ color: C.textDim, fontSize: 14, lineHeight: 1.35, whiteSpace: 'pre-wrap' }}>{f.body}</div>
          {f.adminNote && <div style={{ color: C.gold, fontSize: 13, lineHeight: 1.35 }}>TEAM: {f.adminNote}</div>}
          {f.unread === true && <div>UNREAD TEAM UPDATES</div>}
          {f.fixedRef && <div>FIX REFERENCE: {f.fixedRef}</div>}
          <Btn fontSize={18} style={{ minHeight: 44 }} onClick={() => setOpened(f.id)}>OPEN REPORT</Btn>
        </Chip>
      ))}
      {mine.nextCursor && <Btn disabled={mine.loading} onClick={mine.more}>LOAD MORE REPORTS</Btn>}
    </div>
  );
}


/** Same existing wallet-keyed FeedbackTab lifetime. No new request, journal or storage owner.
 * Keep attach stable; its cleanup releases only that attachment. isCurrent is a pure host lease read.
 * Callbacks refuse stale committed views; true means invoked, never delivery success.
 */
export type FeedbackOwnerReadonly<T> = T extends readonly (infer U)[] ? readonly FeedbackOwnerReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: FeedbackOwnerReadonly<T[K]> } : T;
export interface FeedbackOwnerProjection {
  readonly wallet: string; readonly sessionKey: string;
  readonly data: FeedbackOwnerReadonly<{
    category: string; title: string; body: string; pending: ReturnType<typeof readFeedbackSubmission>;
    busy: boolean; recoveryError: string | null; notice: { kind: 'ok' | 'err'; msg: string } | null;
    evidenceIssue: { id: string; title: string; status: string; category: string } | null;
    recurrence: boolean; recurrenceNeeded: boolean; opened: string | null;
    imageScope: string; missingImageIds: string[]; reports: FeedbackRow[] | null;
    loading: boolean; error: string | null; nextCursor: string | null; limits: typeof TESTER_PROGRAM.feedback;
  }>;
  /** File objects remain original local files; wrapper/items are frozen copies, never public URLs. */
  readonly images: readonly Readonly<FeedbackScreenshotDraft>[];
  readonly titleInput: { current: HTMLInputElement | null };
  readonly actions: {
    setCategory(value: string): boolean; setTitle(value: string): boolean; setBody(value: string): boolean;
    setRecurrence(value: boolean): boolean;
    setEvidenceIssue(value: { id: string; title: string; status: string; category: string } | null): boolean;
    setOpened(id: string | null): boolean; changeImages(next: FeedbackScreenshotDraft[]): boolean;
    clearMissing(): boolean; submit(): boolean; reloadReports(): boolean; moreReports(): boolean;
  };
}
export interface FeedbackOwnerBridge {
  readonly wallet: string; readonly sessionKey: string;
  isCurrent(): boolean;
  attach(readCurrent: () => FeedbackOwnerProjection | null): () => void;
}
function feedbackOwnerCopy<T>(value: T): FeedbackOwnerReadonly<T> {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy); return copy as FeedbackOwnerReadonly<T>;
}
// Test-only export. Production attaches through TesterScreen's existing wallet-keyed mount.
export { FeedbackTab };
