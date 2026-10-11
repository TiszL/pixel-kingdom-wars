import { CHAT } from '@shardkeep/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Btn, Chip, COLORS as C } from '../primitives';

interface Report {
  id: string; messageId: string; reporterWallet: string; reason: string;
  evidenceText: string; evidenceAuthorWallet: string; createdAt: string;
  evidenceAuthorName: string; evidenceSeekerVerified: boolean;
  resolvedAt: string | null; resolution: 'dismissed' | 'redacted' | null;
}
interface Page { reports: Report[]; nextBefore: string | null }

export default function AdminChatPanel(): React.JSX.Element {
  const [reports, setReports] = useState<Report[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [muteHours, setMuteHours] = useState<number | null>(CHAT.muteDurationHours[1]);

  const load = (before?: string): void => {
    setLoading(true); setError('');
    void api.get<Page>(`/admin/chat/reports?state=unresolved&limit=${CHAT.pageSize}${before ? `&before=${encodeURIComponent(before)}` : ''}`)
      .then((page) => { setReports((current) => before ? [...current, ...page.reports] : page.reports); setNext(page.nextBefore); })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'REPORTS COULD NOT LOAD'))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    void api.get<{ enabled: boolean }>('/admin/chat/status').then((value) => setEnabled(value.enabled))
      .catch(() => setError('CHAT STATUS COULD NOT LOAD'));
  }, []);

  const toggleEnabled = (): void => {
    const why = reason.trim();
    if (!why || enabled === null) { setError('ENTER A MODERATION REASON'); return; }
    setBusy('status'); setError('');
    void api.put<{ enabled: boolean }>('/admin/chat/status', { enabled: !enabled, reason: why })
      .then((value) => { setEnabled(value.enabled); setReason(''); })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'CHAT STATUS COULD NOT CHANGE'))
      .finally(() => setBusy(null));
  };

  const act = (report: Report, action: 'redact' | 'dismiss' | 'mute' | 'unmute'): void => {
    const why = reason.trim();
    if (!why) { setError('ENTER A MODERATION REASON'); return; }
    setBusy(`${report.id}:${action}`); setError('');
    const request = action === 'redact'
      ? api.postRaw<void>(`/admin/chat/messages/${encodeURIComponent(report.messageId)}/redact`, { reason: why })
      : action === 'dismiss'
        ? api.postRaw<void>(`/admin/chat/reports/${encodeURIComponent(report.id)}/resolve`, { resolution: 'dismissed', reason: why })
      : action === 'mute'
        ? api.postRaw<void>('/admin/chat/mutes', {
          wallet: report.evidenceAuthorWallet,
          mutedUntil: muteHours === null ? null : new Date(Date.now() + muteHours * 60 * 60 * 1_000).toISOString(), reason: why,
        })
        : api.delRaw<void>(`/admin/chat/mutes/${encodeURIComponent(report.evidenceAuthorWallet)}`, { reason: why });
    void request.then(() => { setReason(''); load(); })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'MODERATION ACTION FAILED'))
      .finally(() => setBusy(null));
  };

  return <section aria-label="Global chat moderation" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Chip style={{ alignItems: 'center', gap: 8 }}>
      <span>GLOBAL CHAT: {enabled === null ? 'UNKNOWN' : enabled ? 'ENABLED' : 'DISABLED'}</span>
      <Btn variant={enabled ? 'sec' : 'gold'} disabled={busy !== null || enabled === null} onClick={toggleEnabled}
        style={{ marginLeft: 'auto', minHeight: 44 }}>{enabled ? 'DISABLE CHAT' : 'ENABLE CHAT'}</Btn>
    </Chip>
    <label style={{ color: C.textFaint }}>MODERATION REASON
      <textarea value={reason} onChange={(event) => setReason(event.currentTarget.value)} maxLength={CHAT.maxGraphemes}
        style={{ display: 'block', width: '100%', minHeight: 72, boxSizing: 'border-box', marginTop: 5,
          color: C.text, background: C.card, border: `2px solid ${C.borderLt}`, font: 'inherit', fontSize: 16 }} />
    </label>
    <div role="group" aria-label="Mute duration" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {CHAT.muteDurationHours.map((hours) => <Btn key={hours} variant={muteHours === hours ? 'gold' : 'sec'}
        onClick={() => setMuteHours(hours)} style={{ minHeight: 44 }}>{hours === 168 ? '7 DAYS' : `${hours} HOUR${hours === 1 ? '' : 'S'}`}</Btn>)}
      <Btn variant={muteHours === null ? 'gold' : 'sec'} onClick={() => setMuteHours(null)}
        style={{ minHeight: 44 }}>PERMANENT</Btn>
    </div>
    {error && <div role="alert" style={{ color: C.danger }}>{error.toUpperCase()}</div>}
    {loading && reports.length === 0 && <div role="status">LOADING REPORTS…</div>}
    {!loading && reports.length === 0 && <div>NO CHAT REPORTS</div>}
    {reports.map((report) => <Chip key={report.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 7 }}>
      <div style={{ color: C.goldHi }}>REPORT · {report.reason.toUpperCase()}</div>
      <div style={{ color: C.textDim }}>{report.evidenceAuthorName}{report.evidenceSeekerVerified ? ' · SEEKER VERIFIED' : ''}</div>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: C.textDim }}>{report.evidenceText}</div>
      <div style={{ color: C.textFaint, fontSize: 12 }}>MESSAGE {report.messageId} · {new Date(report.createdAt).toLocaleString()}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(['redact', 'dismiss', 'mute', 'unmute'] as const).map((action) => <Btn key={action} variant="sec"
          disabled={busy !== null} onClick={() => act(report, action)} fontSize={14}
          style={{ minHeight: 44, flex: '1 1 88px', padding: '5px 8px' }}>{action.toUpperCase()}</Btn>)}
      </div>
    </Chip>)}
    {next && <Btn variant="sec" disabled={loading} onClick={() => load(next)} style={{ minHeight: 44 }}>
      {loading ? 'LOADING…' : 'LOAD EARLIER REPORTS'}
    </Btn>}
    {error && <Btn variant="sec" onClick={() => load()} style={{ minHeight: 44 }}>RETRY</Btn>}
  </section>;
}
