import {useEffect,useState} from 'react';
import {LAMPORTS_PER_SOL} from '@solana/web3.js';
import {useRetirement} from '../../lib/charterRetirement/useRetirement';
import type {RetirementSigningTrust} from '../../lib/charterRetirement/signing';
import {useApp} from '../../state/store';
import {Btn,Icon} from '../primitives';
import {EconomyPanel} from './EconomyPanel';
import './charter-retirement.css';
const short=(value:string)=>value.slice(0,4)+'…'+value.slice(-4);
function sol(value:string){const n=BigInt(value),unit=BigInt(LAMPORTS_PER_SOL),fraction=(n%unit).toString().padStart(String(LAMPORTS_PER_SOL).length-1,'0').replace(/0+$/,'');return `${n/unit}${fraction?'.'+fraction:''}`;}
const controls={minHeight:48,whiteSpace:'normal' as const};
export function CharterRetirementScreen({clanId,actionsEnabled,trust=null,onClose}:{clanId:string|null;actionsEnabled:boolean;trust?:RetirementSigningTrust|null;onClose:()=>void}){
 const wallet=useApp(s=>s.wallet),{state,actionsAllowed,run,dismiss}=useRetirement(actionsEnabled,trust),[payoutConsent,setPayoutConsent]=useState(false),[dissolveConsent,setDissolveConsent]=useState(false);
 const j=state.journal,draft=j?.draft,op=draft?.operation,terminal=draft?.cancelled?'cancelled':op?.terminal?.outcome,busy=!state.loaded||state.busy;
 const reviewed=!!op?.preparation&&state.reviewedMessage===op.preparation.packet.messageSha256,signed=!!(j?.signed||op?.signed),paid=!!draft?.memberPayment;
 useEffect(()=>{setPayoutConsent(false);setDissolveConsent(false);},[draft?.id,op?.preparation?.packet.messageSha256]);
 const close=()=>{dismiss();onClose();},status=terminal==='completed'?'Clan dissolved':terminal==='cancelled'?'Dissolution cancelled':signed?'Signature saved':j?.signingStarted?'Approval unresolved':op?.preparation?'Ready for approval':op?.attempt?'Preparing approval':paid?'Members paid':'Review member payout';
 return <EconomyPanel title="Dissolve clan" eyebrow="CLAN LEADERSHIP" icon={<Icon name="quest" size={36}/>} onClose={close} error={state.error}>
  <div className="sk-retirement">
   {!actionsAllowed&&!terminal&&<p className="sk-retirement-note" role="status">New approvals are unavailable. Saved requests, cancellation checks and receipts remain accessible.</p>}
   {!draft&&<section className="sk-retirement-card">
    <p className="sk-retirement-kicker">PERMANENT CLAN CLOSURE</p><h3>A final decision for your clan</h3>
    <p>Settle the member chest first, then approve dissolution with your wallet. After confirmation, the clan closes and its members are released.</p>
    <ul><li>The Charter stays with its final leader as a retired collectible.</li><li>Members keep their paid shares and personal tournament rewards.</li><li>A dissolved clan cannot be restored with that Charter.</li></ul>
    {j?.request||j?.draftId?<><p role="status">Your request is saved. Check it before taking another action.</p><div className="sk-retirement-actions"><Btn variant="sec" style={controls} disabled={busy} onClick={()=>run(c=>c.load())}>Check saved request</Btn>{!j.draftId&&<Btn variant="sec" style={controls} disabled={busy||!actionsAllowed} onClick={()=>run(c=>c.retryOriginal())}>Retry this request</Btn>}</div></>
     :<><p className="sk-retirement-note">Reviewing freezes clan changes while you settle the chest. You can cancel before wallet approval.</p><Btn style={controls} disabled={busy||!actionsAllowed||!clanId} onClick={()=>clanId&&run(c=>c.begin({clanId,idempotencyKey:crypto.randomUUID()}))}>Freeze clan &amp; review payout</Btn>{!clanId&&<p>Select your clan in Charters to begin.</p>}</>}
   </section>}
   {draft&&<>
    <section className="sk-retirement-identity"><div className="sk-retirement-emblem" aria-hidden="true"><Icon name="quest" size={42}/></div><div><p className="sk-retirement-kicker">[{draft.clan.tag}] CLAN CHARTER</p><h3>{draft.clan.name}</h3><p>{status}</p></div><span className={'sk-retirement-status'+(terminal?' sk-retirement-status-terminal':'')}>{terminal==='completed'?'RETIRED':terminal==='cancelled'?'CANCELLED':'IN PROGRESS'}</span></section>
    <ol className="sk-retirement-steps" aria-label="Dissolution progress"><li className={paid?'is-complete':'is-current'}><span>1</span>Member payout</li><li className={signed?'is-complete':paid&&!terminal?'is-current':''}><span>2</span>Wallet approval</li><li className={terminal==='completed'?'is-complete':signed&&!terminal?'is-current':''}><span>3</span>Confirmation</li></ol>
    {terminal?<section className="sk-retirement-card" role="status"><h3>{terminal==='completed'?'Your clan is now dissolved':'Your clan remains active'}</h3><p>{terminal==='completed'?'The Charter is permanently retired. Former members can join another clan; their personal rewards and past receipts are preserved.':'This dissolution request is closed. Any member payout already made remains paid.'}</p><div className="sk-retirement-actions"><Btn variant="sec" style={controls} disabled={busy} onClick={()=>run(c=>c.archive())}>Keep receipt in history</Btn><Btn variant="sec" style={controls} onClick={close}>Back to Charters</Btn></div></section>
     :<>
      <section className="sk-retirement-card"><div className="sk-retirement-section-title"><h3>Member chest</h3><span>{paid?'PAID':'BEFORE DISSOLUTION'}</span></div><div className="sk-retirement-total"><strong>{BigInt(draft.totalShards).toLocaleString()}</strong><span>SHARDS {paid?'distributed':'to distribute'}</span></div>
       <details><summary>View {draft.shares.length} member shares</summary><ul className="sk-retirement-shares">{draft.shares.map(member=><li key={member.wallet}><span title={member.wallet}>{member.wallet===wallet?'You':short(member.wallet)}</span><strong>{BigInt(member.shards).toLocaleString()} SHARDS</strong></li>)}</ul></details>
       {!paid&&<>{draft.totalShards==='0'?<p>The chest is empty. No member payment is required.</p>:<label className="sk-retirement-consent"><input type="checkbox" checked={payoutConsent} disabled={busy} onChange={e=>setPayoutConsent(e.target.checked)}/><span>Distribute these shares now. Payments will remain with members if I later cancel dissolution.</span></label>}<Btn style={controls} disabled={busy||!actionsAllowed||draft.totalShards!=='0'&&!payoutConsent} onClick={()=>run(c=>c.command('pay-members'))}>{draft.totalShards==='0'?'Continue with empty chest':'Pay members'}</Btn></>}
       {paid&&!op&&<Btn style={controls} disabled={busy||!actionsAllowed} onClick={()=>run(c=>c.command('pay-members'))}>Continue after payout</Btn>}
      </section>
      {op&&!op.preparation&&<section className="sk-retirement-card"><h3>Prepare wallet approval</h3><p>{op.attempt?'The original approval request is saved. Recover it to continue.':'The member payout is complete. Prepare the exact transaction and review its network costs.'}</p><Btn style={controls} disabled={busy||!op.attempt&&!actionsAllowed} onClick={()=>run(c=>c.command(op.attempt?'recover-preparation':'prepare'))}>{op.attempt?'Recover prepared approval':'Prepare approval'}</Btn></section>}
      {op?.preparation&&<section className="sk-retirement-card"><h3>{signed?'Submit your saved approval':j?.signingStarted?'Check your approval outcome':'Review wallet approval'}</h3><dl className="sk-retirement-costs"><div><dt>Network fee</dt><dd>{sol(op.attempt!.quote.costs.networkFeeLamports)} SOL</dd></div><div><dt>Account rent</dt><dd>{sol(op.attempt!.quote.costs.rentLamports)} SOL</dd></div><div className="sk-retirement-cost-total"><dt>Total quoted</dt><dd>{sol(op.attempt!.quote.costs.totalLamports)} SOL</dd></div></dl>
       {signed?<><p>Your exact signed transaction is saved. Submitting it again uses the same approval.</p><Btn style={controls} disabled={busy||!actionsAllowed||!!j?.observed.length} onClick={()=>run(c=>c.deliver())}>Submit saved transaction</Btn></>
        :j?.signingStarted?<p role="status">A wallet approval may already exist. Check the saved outcome; another signature will not be requested.</p>
        :<><p className="sk-retirement-warning">Dissolution becomes permanent when this transaction is confirmed.</p><label className="sk-retirement-consent"><input type="checkbox" checked={dissolveConsent} disabled={busy} onChange={e=>setDissolveConsent(e.target.checked)}/><span>I understand that {draft.clan.name} will close permanently and its Charter will be retired.</span></label><Btn style={controls} disabled={busy||!actionsAllowed||!dissolveConsent||!!j?.observed.length} onClick={()=>run(c=>reviewed?c.sign():c.review())}>{reviewed?'Approve dissolution in wallet':'Review exact approval'}</Btn></>}
      </section>}
      <section className="sk-retirement-recovery"><div><h3>Keep your original request</h3><p>{op?.attempt?'Cancellation waits for the saved approval to expire and for chain checks to confirm it was unused.':'Cancelling releases the clan freeze. Any completed member payment stays paid.'}</p></div><div className="sk-retirement-actions"><Btn variant="sec" style={controls} disabled={busy} onClick={()=>run(c=>op?c.command('recover'):c.load())}>Check outcome</Btn><Btn variant="sec" style={controls} disabled={busy} onClick={()=>run(c=>c.command('cancel'))}>Cancel dissolution</Btn></div></section>
     </>}
    <details className="sk-retirement-receipt"><summary>Receipt details</summary><dl><dt>Clan ID</dt><dd>{draft.clan.id}</dd><dt>Request ID</dt><dd>{draft.id}</dd>{op?.signed&&<><dt>Transaction</dt><dd>{op.signed.signature}</dd></>}</dl></details>
   </>}
   {!!state.history.length&&<section className="sk-retirement-card"><h3>Saved receipts</h3>{state.history.map(row=><details key={row.revision}><summary>{row.draft?.clan.name} — {row.draft?.operation?.status==='completed'?'Dissolved':'Cancelled'}</summary><p>{BigInt(row.draft?.memberPayment?.totalShards??'0').toLocaleString()} SHARDS paid to members</p><p className="sk-retirement-reference">Request {row.draftId}</p></details>)}</section>}
   {state.busy&&<p className="sk-retirement-progress" role="status" aria-live="polite">Saving and checking your original request…</p>}
  </div>
 </EconomyPanel>;
}
