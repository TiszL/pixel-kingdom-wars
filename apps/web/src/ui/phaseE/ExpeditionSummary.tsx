import type { StarterExpeditionCommand } from '../../lib/starterExpedition/journal';
import type { StarterExpeditionView } from '@shardkeep/shared/starterExpeditionApi';
import { fmtDur } from '@shardkeep/shared';
import { REALM_NAMES } from '@shardkeep/shared/baseVisual';

const label = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ');
const whole = (value: string | number) => BigInt(value).toLocaleString('en-US');

/** Display only the server's frozen route amounts; never predict return stock. */
export function ExpeditionRouteSummary({ route }: { route: StarterExpeditionCommand['route'] }): React.JSX.Element {
  const realm = REALM_NAMES[route.realmId];
  const routeName = route.routeId.startsWith('paid_') ? 'Realm expedition' : route.routeId.startsWith('common_') ? 'Common expedition' : label(route.routeId).replace(/\b[a-z]/g, char => char.toUpperCase());
  return <div><strong>{routeName} · {realm}</strong>
    <p>{'access' in route ? route.access.kind === 'paid_realm' ? 'Paid realm route' : 'Common route' : 'Home route'} · {fmtDur(route.durationSec)}</p>
    <dl className="sk-economy-values" aria-label="Cargo outcome">
      <div><dt>Gross cargo</dt><dd>{whole(route.grossQuantity)} {label(route.resourceId)}</dd></div>
      <div><dt>Island pool</dt><dd>{whole(route.islandPoolQuantity)} {label(route.resourceId)}</dd></div>
      <div><dt>To kingdom</dt><dd>{whole(route.netQuantity)} {label(route.resourceId)}</dd></div>
    </dl>
    {route.secondaryOutput && <><p>Survey cargo · {label(route.secondaryOutput.resourceId)}</p><dl className="sk-economy-values" aria-label="Survey cargo outcome">
      <div><dt>Gross cargo</dt><dd>{whole(route.secondaryOutput.grossQuantity)} {label(route.secondaryOutput.resourceId)}</dd></div>
      <div><dt>Island pool</dt><dd>{whole(route.secondaryOutput.islandPoolQuantity)} {label(route.secondaryOutput.resourceId)}</dd></div>
      <div><dt>To kingdom</dt><dd>{whole(route.secondaryOutput.netQuantity)} {label(route.secondaryOutput.resourceId)}</dd></div>
    </dl></>}
    {route.fitting && <p>Fitted equipment: {label(route.fitting.itemId)}</p>}
    <details><summary>Route details</summary><p>Route version {route.routeCatalogueVersion} · Reward version {route.rewardTableVersion}</p></details>
  </div>;
}

export function ExpeditionStock({ view }: { view: StarterExpeditionView }): React.JSX.Element {
  return <details><summary>Current kingdom stock</summary><dl className="sk-economy-values" aria-label="Current raw resource stock">
    {view.rawStock.map(stock => <div key={stock.resourceId}><dt>{label(stock.resourceId)}</dt><dd>{whole(stock.available)} available · {whole(stock.reserved)} reserved · {whole(stock.total)} total</dd></div>)}
  </dl><p>Kingdom: {view.baseId} · Observed {view.serverNow} (UTC).</p></details>;
}
