import { WORLD_COPY } from '../copy';
import { HudIcon } from './HudPanel';

/**
 * The globe's header (native GlobeHud.kt F1 set): BASE, the "WORLD MAP" plate naming the selected realm or
 * "Shattered Realms", CAMPAIGN (gold), and the hint pill (`worldHint`: a notice, the intent, else the gestures).
 * There is no WORLD tool: the owner found it did nothing (code 29.1), native dropped it.
 */
export function WorldHeader({ realmName, hint, onBack, onCampaign }: {
  realmName?: string | null | undefined; hint?: string | null | undefined; onBack: () => void; onCampaign: () => void;
}): React.JSX.Element {
  const H = WORLD_COPY.header;
  return <header className="hud hud-scrim wv2-header">
    <button type="button" className="hud-btn hud-btn--sm" aria-label={H.backLabel} onClick={onBack}><HudIcon name="prev" />{H.back}</button>
    <h1 className="hud-pill wv2-title"><span className="hud-gold">{H.title}</span><small className="hud-cap">{realmName ?? H.subtitle}</small></h1>
    <button type="button" className="hud-btn hud-btn--sm hud-btn--gold" onClick={onCampaign}>{H.campaign}</button>
    {hint && <p className="hud-pill hud-pulse wv2-hint" role="status">{hint}</p>}
  </header>;
}
