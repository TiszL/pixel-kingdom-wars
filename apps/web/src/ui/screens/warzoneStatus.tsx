import { WARZONE, fmtDur } from '@shardkeep/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Btn, Chip, COLORS as C, Icon, Panel9, Sp } from '../primitives';
import { useFetch } from '../useFetch';

export interface WarzoneStatusDto {
  mode: 'off' | 'scheduled' | 'purge' | 'unknown';
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  nextStartsAt: string | null;
  remainingMs: number | null;
}

const LEGACY_OFF_STATUS: WarzoneStatusDto = {
  mode: 'off', active: false, startsAt: null, endsAt: null,
  nextStartsAt: null, remainingMs: null,
};

const LEGACY_ACTIVE_STATUS: WarzoneStatusDto = {
  mode: 'unknown', active: true, startsAt: null, endsAt: null,
  nextStartsAt: null, remainingMs: null,
};

type RollingWarzoneStatus = Partial<WarzoneStatusDto> & Pick<WarzoneStatusDto, 'active'>;

function normalizeWarzoneStatus(status: RollingWarzoneStatus | undefined): WarzoneStatusDto {
  if (status && (status.mode === 'off' || status.mode === 'scheduled' || status.mode === 'purge')
    && 'startsAt' in status && 'endsAt' in status && 'nextStartsAt' in status
    && 'remainingMs' in status) {
    return status as WarzoneStatusDto;
  }
  return status?.active === true ? LEGACY_ACTIVE_STATUS : LEGACY_OFF_STATUS;
}

export function warzoneRemaining(deadline: string | null, now = Date.now()): string | null {
  if (!deadline) return null;
  const ms = Date.parse(deadline) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // Same d/h/m vocabulary as every other countdown ("1D 12H", "12H 30M", "1M 1S").
  return fmtDur(Math.ceil(ms / 1000)).toUpperCase();
}

export function warzoneHeading(status: WarzoneStatusDto, now = Date.now()): {
  title: string;
  timer: string;
  boundary: string | null;
} {
  if (status.mode === 'off') return { title: 'WARZONES OFF', timer: 'NO ACTIVE WINDOW', boundary: null };
  if (status.active) {
    const left = warzoneRemaining(status.endsAt, now);
    return {
      title: status.mode === 'purge' ? 'PURGE WARZONE ACTIVE' : 'WARZONE ACTIVE',
      timer: left ? `${left} REMAINING` : status.endsAt ? 'ENDING NOW' : 'END TIME UNAVAILABLE',
      boundary: status.endsAt,
    };
  }
  if (status.mode === 'purge') {
    return { title: 'NO WARZONE ACTIVE', timer: 'PURGES ARE UNANNOUNCED', boundary: null };
  }
  const start = status.startsAt ?? status.nextStartsAt;
  const left = warzoneRemaining(start, now);
  return {
    title: 'NEXT WARZONE',
    timer: left ? `STARTS IN ${left}` : 'STARTING NOW',
    boundary: start,
  };
}

export function WarzoneDetails({ onShop }: { onShop(): void }): React.JSX.Element {
  const { data, error, loading, reload } = useFetch<{ warzone?: RollingWarzoneStatus }>(
    () => api.get<{ warzone?: RollingWarzoneStatus }>('/economy/stats'),
  );
  const status = normalizeWarzoneStatus(data?.warzone);
  const boundary = status.active
    ? status.endsAt
    : status.mode === 'scheduled'
      ? status.startsAt ?? status.nextStartsAt
      : null;
  const remainingMs = Math.max(0, status.remainingMs ?? 0);
  const statusFingerprint = `${status.mode}:${status.active}:${boundary ?? ''}:${remainingMs}`;
  const clockRef = useRef({ fingerprint: '', at: 0, serverNow: 0 });
  if (clockRef.current.fingerprint !== statusFingerprint) {
    clockRef.current = {
      fingerprint: statusFingerprint,
      at: performance.now(),
      serverNow: boundary ? Date.parse(boundary) - remainingMs : Date.now(),
    };
  }
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, performance.now() - clockRef.current.at));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [statusFingerprint]);
  const boundaryKey = `${status.mode}:${status.active}:${boundary ?? ''}`;
  const refreshedBoundary = useRef<string | null>(null);
  useEffect(() => {
    if (!data || loading) return undefined;
    const pollMs = WARZONE.currentPhasePollSec * 1_000;
    const boundaryEligible = boundary !== null
      && status.remainingMs !== null
      && refreshedBoundary.current !== boundaryKey;
    const boundaryMs = boundaryEligible ? remainingMs + 250 : Number.POSITIVE_INFINITY;
    const delay = Math.min(pollMs, boundaryMs);
    // One timer chooses the earlier exact boundary/current-state heartbeat, so
    // coincident clocks cannot launch duplicate requests. Loading gates the next
    // one-shot timer, bounding the loop to one request in flight.
    const timer = window.setTimeout(() => {
      if (boundaryEligible && boundaryMs <= pollMs) {
        refreshedBoundary.current = boundaryKey;
      }
      reload();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [boundary, boundaryKey, data, loading, reload, remainingMs, status.remainingMs]);

  if (loading && !data) return <div role="status" style={{ padding: 14, color: C.textFaint }}>READING WARZONE STATUS…</div>;
  if (error || !data) {
    return <div role="alert" style={{ padding: 14, color: C.danger }}>
      WARZONE STATUS UNAVAILABLE · {error ?? 'TRY AGAIN'}
      <Btn variant="sec" fontSize={15} style={{ width: '100%', marginTop: 8 }} onClick={reload}>TRY AGAIN</Btn>
    </div>;
  }
  const now = clockRef.current.serverNow + elapsed;
  const heading = warzoneHeading(status, now);
  const localBoundary = heading.boundary
    ? new Date(heading.boundary).toLocaleString([], {
      weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    })
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: 10 }}>
      <Panel9 style={{ padding: 11, background: status.active ? '#34221F' : C.card }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="shield" size={27} />
          <div>
            <div style={{ color: status.active ? C.danger : C.goldHi, fontSize: 21 }}>{heading.title}</div>
            <div style={{ color: C.text, fontSize: 17 }}>{heading.timer}</div>
          </div>
        </div>
        {localBoundary && <div style={{ color: C.textFaint, fontSize: 13, marginTop: 5 }}>
          {status.active ? 'ENDS' : 'STARTS'} · {localBoundary}
        </div>}
      </Panel9>

      <Chip style={{ alignItems: 'flex-start', padding: 9 }}>
        <Icon name="info" size={19} />
        <span style={{ color: C.text, fontSize: 15, lineHeight: 1.3 }}>
          {status.active
            ? `ORDINARY LOSS AND PURCHASE SHIELDS ARE SUPPRESSED. ONLY A WARZONE SHIELD PROTECTS. A DEFENDER CAN BE HIT AGAIN AFTER ${WARZONE.attackCooldownHours}H.`
            : 'ORDINARY SHIELDS PROTECT NORMALLY. DURING A WARZONE THEY KEEP COUNTING DOWN BUT DO NOT BLOCK ATTACKS.'}
        </span>
      </Chip>
      <Chip style={{ alignItems: 'flex-start', padding: 9 }}>
        <Icon name="attack" size={19} />
        <span style={{ color: C.textDim, fontSize: 14, lineHeight: 1.3 }}>
          RAID LOOT, STARS, TROPHIES, AND DAMAGE RULES DO NOT CHANGE. A LOSS SHIELD EARNED DURING THE WINDOW ONLY PROTECTS AFTERWARD IF TIME REMAINS.
        </span>
      </Chip>
      {status.active && <Btn fontSize={17} onClick={onShop}>
        <Icon name="shield" size={19} /> WARZONE SHIELD OPTIONS
      </Btn>}
      <div style={{ display: 'flex', alignItems: 'center', color: C.textFaint, fontSize: 12 }}>
        <span>{status.mode === 'scheduled' ? 'WEEKLY SCHEDULE' : status.mode === 'purge' ? 'PURGE MODE' : status.mode === 'unknown' ? 'LIVE STATUS' : 'DISABLED'}</span>
        <Sp />
        <button className="interactive" type="button" onClick={reload}
          style={{ border: 0, padding: 5, background: 'transparent', color: C.textFaint, fontFamily: 'inherit' }}>
          REFRESH
        </button>
      </div>
    </div>
  );
}
