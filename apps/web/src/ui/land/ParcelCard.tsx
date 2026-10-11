/**
 * THE PARCEL CARD — the visual centre of the land screen.
 *
 * D-007: land identity must READ. Before a reservation the card is an empty
 * pixel frame ("no parcel yet"); a globe pick shows the drafted cell; the
 * server's reservation shows the land AS LAND — country name, cell, sovereign,
 * the frozen price and the frozen-price footnote — before any wallet prompt
 * (D-103, owner: "land visible on secure random cell"); a credited payment
 * shows the deed art through the same helpers the globe inspector uses.
 *
 * The reserved/minted card sits on the KEEP plate and the empty/drafted one on
 * the shard plate: the two materials are how the HUD already says "ordinary"
 * vs "precious", and a frozen 0.2 SOL parcel is the precious one.
 */
import { REALM_NAMES } from '@shardkeep/shared/baseVisual';
import type { LandReservation } from '../../auth/useEntry';
import { hudChipStyle } from '../hudChrome';
import { COLORS as C, Icon } from '../primitives';
import { recoverDeedImage } from '../screens/globe/parcelDetail';

export type ParcelView =
  | { kind: 'empty' }
  | { kind: 'drafted'; earthCell: number }
  | { kind: 'fantasy-drafted'; tileId: number }
  | { kind: 'reserved'; reservation: LandReservation }
  | { kind: 'paid'; reservation: LandReservation }
  | { kind: 'minted'; reservation: LandReservation; imageUrl: string | null };

/** What the card names the land: the registry name the server froze, the
 *  code if an older API sent none, and EARTH if it sent neither. */
export function parcelCountry(r: Pick<LandReservation, 'countryName' | 'countryA3' | 'fantasyLocation'>): string {
  return r.fantasyLocation ? REALM_NAMES[r.fantasyLocation.realmId] : r.countryName ?? r.countryA3 ?? 'EARTH';
}

export const FROZEN_PRICE_NOTE = 'THIS EXACT CELL AND PRICE ARE FROZEN BEFORE WALLET APPROVAL.';

export function ParcelCard({ view }: { view: ParcelView }): React.JSX.Element {
  const precious = view.kind === 'reserved' || view.kind === 'paid' || view.kind === 'minted';
  return (
    <section aria-label="Your parcel" data-parcel={view.kind} style={{
      ...hudChipStyle(precious ? 'keep' : 'shard'),
      padding: '14px 12px', minHeight: 172, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 6, textAlign: 'center',
    }}>
      {view.kind === 'empty' && (
        <>
          <div aria-hidden="true" style={{
            width: 104, height: 68, border: `2px dashed ${C.borderLt}`, display: 'grid', placeItems: 'center',
          }}>
            <Icon name="map" size={30} style={{ opacity: 0.55 }} />
          </div>
          <div style={{ color: C.textDim, fontSize: 19, letterSpacing: '2px' }}>NO PARCEL YET</div>
          <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.35, maxWidth: 280 }}>
            {import.meta.env.VITE_FEATURE_FANTASY_WORLD === '1' ? 'YOUR PLACE IN THE FANTASY WORLD — PICK IT ON THE GLOBE OR TAKE A SECURE RANDOM TILE.' : 'A REAL SPOT ON THE PIXEL EARTH — PICK IT ON THE GLOBE OR TAKE A SECURE RANDOM CELL.'}
          </div>
        </>
      )}
      {(view.kind === 'drafted' || view.kind === 'fantasy-drafted') && (
        <>
          <div style={{ color: C.textFaint, fontSize: 13, letterSpacing: '2px' }}>CHOSEN ON THE GLOBE</div>
          <div style={{ color: C.goldHi, fontSize: 32, letterSpacing: '2px', lineHeight: 1 }}>{view.kind === 'fantasy-drafted' ? `TILE ${view.tileId}` : `CELL ${view.earthCell}`}</div>
          <div style={{ color: C.textDim, fontSize: 13, lineHeight: 1.35 }}>NOT RESERVED YET — THE SERVER CHECKS IT NEXT.</div>
        </>
      )}
      {(view.kind === 'reserved' || view.kind === 'paid' || view.kind === 'minted') && (
        <>
          <div style={{ color: C.textFaint, fontSize: 13, letterSpacing: '2px' }}>
            {view.kind === 'minted' ? 'LAND DEED READY' : view.kind === 'paid' ? 'PAYMENT CONFIRMED · DEED MINTING' : 'RESERVED FOR YOU'}
          </div>
          {view.kind === 'paid' && <div role="status" style={{ color: C.textDim, fontSize: 14, lineHeight: 1.4 }}>
            YOUR LAND IS SECURED. YOU CAN PLAY WHILE YOUR DEED FINISHES MINTING.
          </div>}
          {view.kind === 'minted' && view.imageUrl && (
            <img src={view.imageUrl} alt="Your Land Deed" width={128} height={128}
              style={{ imageRendering: 'pixelated', width: 128, maxWidth: '60%', height: 'auto' }}
              onError={(e) => recoverDeedImage(e.currentTarget, view.imageUrl ?? '')} />
          )}
          <div style={{
            color: C.goldHi, fontSize: 28, letterSpacing: '2px', lineHeight: 1.1, textTransform: 'uppercase',
            overflowWrap: 'anywhere',
          }}>
            {parcelCountry(view.reservation)}
          </div>
          <div style={{ color: C.text, fontSize: 18, letterSpacing: '1px' }}>
            {view.reservation.landAddress?.kind === 'fantasy' ? `TILE ${view.reservation.landAddress.tileId} · FANTASY LAND` : `CELL ${view.reservation.earthCell} · SOVEREIGN LAND`}
          </div>
          {view.kind === 'reserved' && (
            <>
              <div style={{ color: C.gold, fontSize: 22, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="sol" size={18} />
                {(view.reservation.amountLamports / 1e9).toFixed(2)} SOL · FROZEN
              </div>
              <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.35 }}>{FROZEN_PRICE_NOTE}</div>
            </>
          )}
        </>
      )}
    </section>
  );
}
