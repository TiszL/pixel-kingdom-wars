import { TOKEN } from '@shardkeep/shared';
import type { RealmPassportExpeditionsResponse, RealmPassportInclusionsResponse, RealmPassportCurrentResponse } from '@shardkeep/shared/realmPassportApi';
import { useRealmPassport, type PassportSection } from '../../lib/realmPassport/useRealmPassport';
import { Btn, Icon } from '../primitives';
import { EconomyPanel } from './EconomyPanel';
import './realm-passport.css';

type Expedition = Extract<RealmPassportExpeditionsResponse, { state: 'available' }>['data']['rows'][number];
type Inclusion = Extract<RealmPassportInclusionsResponse, { state: 'available' }>['data']['rows'][number];
type Current = Extract<RealmPassportCurrentResponse, { state: 'available' }>['data'];
const label = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
const number = (value: string | number) => BigInt(value).toLocaleString('en-US');
const time = (value: string) => new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
function day(value: string) {
  const date = new Date(0); date.setUTCDate(Number(value) + 1);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' (UTC)' : 'Mining day ' + number(value);
}
function keep(value: string) {
  const amount = BigInt(value), scale = 10n ** BigInt(TOKEN.decimals);
  const fraction = (amount % scale).toString().padStart(TOKEN.decimals, '0').replace(/0+$/, '');
  return `${(amount / scale).toLocaleString('en-US')}${fraction ? '.' + fraction : ''}`;
}
function ExpeditionCard({ row }: { row: Expedition }) {
  return <article className="sk-passport-card" aria-label={label(row.realmId) + ' completed expedition'}>
    <div className="sk-passport-card-heading"><div><p className="sk-passport-eyebrow">{label(row.kind)} expedition</p><h3>{label(row.realmId)}</h3></div><span className="sk-passport-badge">Returned</span></div>
    <p className="sk-passport-route">{label(row.routeId)}</p>
    <dl className="sk-passport-facts"><div><dt>Departed</dt><dd><time dateTime={row.departedAt}>{time(row.departedAt)}</time></dd></div><div><dt>Returned</dt><dd><time dateTime={row.returnedAt}>{time(row.returnedAt)}</time></dd></div></dl>
    <details><summary>Journey record</summary><dl className="sk-passport-record"><div><dt>Original kingdom</dt><dd>{row.originalBaseId}</dd></div><div><dt>Expedition</dt><dd>{row.expeditionId}</dd></div><div><dt>Return receipt</dt><dd>{row.returnId}</dd></div><div><dt>Scheduled return</dt><dd>{time(row.scheduledReturnAt)}</dd></div>{row.routeVersion !== null && <div><dt>Route version</dt><dd>{row.routeVersion}</dd></div>}{row.policyVersion !== null && <div><dt>Policy version</dt><dd>{row.policyVersion}</dd></div>}</dl></details>
  </article>;
}
function InclusionCard({ row }: { row: Inclusion }) {
  return <article className="sk-passport-card" aria-label={'Mining publication ' + row.sequence}>
    <div className="sk-passport-card-heading"><div><p className="sk-passport-eyebrow">Published mining record</p><h3>{day(row.day)}</h3></div><span className="sk-passport-badge">Included</span></div>
    <dl className="sk-passport-facts"><div><dt>Cumulative KEEP allocation</dt><dd>{keep(row.leaf.cumulativeKeepBaseUnits)} KEEP</dd></div><div><dt>Cumulative Renown</dt><dd>{number(row.leaf.cumulativeRenown)}</dd></div><div><dt>Cumulative qualified days</dt><dd>{number(row.leaf.cumulativeDays)}</dd></div></dl>
    <p className="sk-passport-muted">Cumulative totals include earlier records. Inclusion alone does not add a new activity day or show an unclaimed balance.</p>
    <details><summary>Publication & proof</summary><dl className="sk-passport-record"><div><dt>Publication sequence</dt><dd>{row.sequence}</dd></div><div><dt>Wallet</dt><dd>{row.leaf.wallet}</dd></div><div><dt>Publication signature</dt><dd>{row.publicationSignature}</dd></div><div><dt>Publication slot</dt><dd>{row.publicationSlot}</dd></div><div><dt>Root</dt><dd>{row.root}</dd></div><div><dt>Source commitment</dt><dd>{row.sourceHash}</dd></div><div><dt>Chain identity</dt><dd>{row.genesisHash}</dd></div><div><dt>Program</dt><dd>{row.programId}</dd></div><div><dt>Configuration</dt><dd>{row.configAddress}</dd></div><div><dt>KEEP mint</dt><dd>{row.keepMint}</dd></div><div><dt>Reserve owner</dt><dd>{row.reserveOwner}</dd></div><div><dt>Publication total (base units)</dt><dd>{row.totalCumulativeBaseUnits}</dd></div></dl>
      {row.proof.length > 0 ? <ol className="sk-passport-proof" aria-label="Inclusion proof">{row.proof.map((entry, i) => <li key={i}>{entry.isLeft ? 'Left' : 'Right'} sibling · {entry.hash}<br />Sum (base units): {entry.sumBaseUnits}</li>)}</ol> : <p>This publication uses a single-leaf proof.</p>}
    </details>
  </article>;
}
function Participation({ data }: { data: Current }) {
  return <><div className="sk-passport-totals"><section aria-label="Published participation"><h4>Published participation</h4><dl><div><dt>Renown</dt><dd>{number(data.published.cumulativeRenown)}</dd></div><div><dt>Qualified days</dt><dd>{number(data.published.cumulativeDays)}</dd></div></dl><p>Included in publication {data.publicationSequence}.</p></section>
    <section aria-label="Attested on-chain"><h4>Attested on-chain</h4>{data.attested ? <><dl><div><dt>Renown</dt><dd>{number(data.attested.renownTotal)}</dd></div><div><dt>Qualified days</dt><dd>{number(data.attested.daysAttested)}</dd></div></dl><p>Recorded through publication {data.attested.lastSequence}.</p></> : <p>No attested record was found in this verified observation. Published participation is shown separately.</p>}</section></div><details><summary>Current observation</summary><p>Observed slot: {data.observedSlot}</p><p>Chain timestamp: {data.chainUnixTimestamp}</p></details></>;
}
const sections: { id: PassportSection; label: string }[] = [{ id: 'starter', label: 'Starter trips' }, { id: 'advanced', label: 'Advanced trips' }, { id: 'mining', label: 'Mining history' }];
export function RealmPassportScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const passport = useRealmPassport(), { history, current } = passport, response = history.response;
  const data = response?.state === 'available' ? response.data : null;
  return <EconomyPanel title="Realm Passport" eyebrow="YOUR JOURNEYS · VERIFIED HISTORY" icon={<Icon name="quest" size={36} />} onClose={onClose}>
    <div className="sk-passport">
      <p className="sk-passport-intro">Your completed journeys and published mining records, kept with your account even when a kingdom changes hands.</p>
      <div className="sk-passport-filters" role="group" aria-label="Passport history filter">{sections.map(section => <button type="button" key={section.id} aria-pressed={passport.section === section.id} onClick={() => passport.setSection(section.id)}>{section.label}</button>)}</div>
      <div className="sk-passport-toolbar"><p>{passport.section === 'mining' ? 'Published records and current participation are checked independently.' : 'Only confirmed expedition returns appear here. Trips still underway are not included.'}</p><Btn variant="sec" disabled={history.busy || current.busy} onClick={passport.refresh}>REFRESH</Btn></div>
      {passport.section === 'mining' && <section className="sk-passport-current" aria-labelledby="passport-current"><p className="sk-passport-eyebrow">Latest verified observation</p><h3 id="passport-current">Participation</h3>
        {current.busy && <p role="status">Checking current participation…</p>}
        {current.error && <p role="status">{current.error}</p>}
        {current.response?.state === 'unavailable' && <p role="status">Current on-chain participation cannot be verified right now. This does not mean your totals are zero. Published history remains separate.</p>}
        {current.response?.state === 'available' && <Participation data={current.response.data} />}
      </section>}
      <section aria-label={passport.section === 'mining' ? 'Published mining history' : 'Completed expeditions'} aria-busy={history.busy}>
        {history.busy && <p role="status">{data ? 'Checking history…' : 'Opening your history…'}</p>}
        {history.error && <div className="sk-passport-notice" role="alert"><p>{history.error}</p>{data && <p>Previously loaded records remain below. Refresh starts from the first page to find newly completed activity.</p>}<Btn variant="sec" disabled={history.busy} onClick={passport.refresh}>RETRY</Btn></div>}
        {response?.state === 'unavailable' && <div className="sk-passport-notice" role="status"><h3>History is unavailable</h3><p>{response.reason === 'SOURCE_CONFLICT' ? 'These records could not be verified consistently. No activity has been inferred.' : 'The source is not available right now. This does not mean you have no history.'}</p><Btn variant="sec" disabled={history.busy} onClick={passport.refresh}>TRY AGAIN</Btn></div>}
        {data && data.rows.length === 0 && <div className="sk-passport-empty"><Icon name="quest" size={40} /><h3>{passport.section === 'mining' ? 'No published inclusions found' : 'No completed trips found'}</h3><p>{passport.section === 'mining' ? 'Your verified mining inclusions will appear here once published.' : 'Completed, verified returns for this expedition type will appear here.'}</p></div>}
        {data && ('kind' in data ? data.rows.map(row => <ExpeditionCard key={row.returnId} row={row} />) : data.rows.map(row => <InclusionCard key={row.sequence} row={row} />))}
        {passport.nextCursor && <Btn variant="sec" style={{ width: '100%', minHeight: 44 }} disabled={history.busy} onClick={() => void passport.more()}>LOAD MORE RECORDS</Btn>}
        {response && <p className="sk-passport-muted">Checked {time(response.serverNow)}. This view shows available verified records, not a complete lifetime activity score.</p>}
      </section>
      <p className="sk-passport-footnote">A Passport records history. It does not grant rewards, access or eligibility.</p>
    </div>
  </EconomyPanel>;
}
