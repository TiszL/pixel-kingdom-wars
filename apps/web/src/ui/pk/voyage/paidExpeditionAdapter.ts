import type {PaidStarterExpeditionView} from '@shardkeep/shared/paidStarterExpeditionApi';
import type {StarterExpeditionSnapshot} from '../../../lib/starterExpedition/snapshot';
import type {StarterExpeditionOperation} from '../../../lib/starterExpedition/journal';

/** Advisory current observation only; beginPaidDeparture/confirm reread admission. */
export function paidDepartureModel(snapshot:StarterExpeditionSnapshot|null,paid:PaidStarterExpeditionView|null,wallet:string|null,baseId:string|null,realm:number|null,busy:boolean,pending:boolean) {
  const current=snapshot?.view.wallet===wallet&&snapshot.view.baseId===baseId?snapshot:null;
  const selected=paid?.wallet===wallet&&paid.baseId===baseId&&paid.realm===realm?paid:null;
  const view=current?.view;
  const reason=pending?'Check the saved departure first.':busy?'Checking the selected route.':!current?'Refresh current kingdom stock and fleet.':realm===null?'Choose a destination realm.':!selected?'Check current destination coverage.':
    !current.enabled||!view?.acceptingDepartures||!view.home||!view.installation||!view.lodgeCompletedAt||view.flight?'The starter is not ready to depart.':
    !selected.acceptingDepartures?'New paid realm departures are paused.':selected.coverage.status==='unavailable'?'Current coverage is unavailable.':
    selected.coverage.status==='blocked'?(selected.coverage.reason==='EXPIRED'?'Paid coverage has expired.':'Active paid coverage is required.'):null;
  return {canReview:reason===null,reason,route:selected?.route??null,coverage:selected?.coverage??null,currentView:view??null,departurePrice:null};
}
/** A due timestamp is never proof of return. */
export function expeditionReceiptStage(operation:StarterExpeditionOperation) {
  if(operation.proof?.status==='accepted')return operation.proof.return?'RETURNED':'ACCEPTED';
  if(operation.refusal)return 'REFUSED';
  return operation.attemptRevision===null?'DRAFT':'CHECKING';
}
export const isPaidOperation=(operation:StarterExpeditionOperation)=>'access' in operation.command.route&&operation.command.route.access.kind==='paid_realm';
