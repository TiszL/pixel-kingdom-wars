import type { FantasyChain, FantasyExploration } from '../../types';
import { WORLD_COPY } from '../copy';
import { HudPanel } from './HudPanel';

/**
 * An exploration chain on the globe (the host's EXPLORE panel, in the HUD's frame): its name and lore, its islands
 * (each focuses on the globe through the host), and the locked dispatch. The 7 chains are gameplay destinations that
 * cannot be owned; nothing here reads or writes land. [explore] is the host's destination ('list' = every chain).
 */
export function ExplorePanel({ explore, chains, portrait, onPick, onClose }: {
  explore: FantasyExploration | 'list'; chains: readonly FantasyChain[]; portrait?: boolean | undefined;
  onPick: (destination: FantasyExploration) => void; onClose: () => void;
}): React.JSX.Element {
  const E = WORLD_COPY.explore;
  const chain = explore === 'list' ? null : chains.find(c => c.id === explore.chainId) ?? null;
  const title = chain?.name ?? E.title;
  const foot = <button type="button" className="hud-btn" disabled>{E.locked}</button>;
  return <HudPanel accent="#8fd0c8" label={title} portrait={portrait} onClose={onClose} foot={foot} className="wv2-explore">
    <p className="hud-kicker">{E.kicker}</p>
    <h2 className="hud-display">{title}</h2>
    <p className="hud-body">{chain?.lore ?? E.lore(chains.length)}</p>
    <div className="wv2-explore-list">{chain
      ? <>
        <button type="button" className="hud-row wv2-row" onClick={() => onPick({ chainId: chain.id, islandId: null })}>{E.overview}</button>
        {chain.islands.map((_, i) => {
          const islandId = `${chain.id}-${i + 1}`;
          return <button type="button" key={islandId} className="hud-row wv2-row" aria-pressed={explore !== 'list' && explore.islandId === islandId}
            onClick={() => onPick({ chainId: chain.id, islandId })}>{E.island(chain.name, i + 1)}</button>;
        })}</>
      : chains.map(c => <button type="button" key={c.id} className="hud-row wv2-row" onClick={() => onPick({ chainId: c.id, islandId: null })}>
        <span className="wv2-row-name">{c.name}<small className="hud-cap">{E.chain(c.islands.length)}</small></span></button>)}
    </div>
    <p className="hud-cap hud-dim">{E.noDeeds}</p>
  </HudPanel>;
}
