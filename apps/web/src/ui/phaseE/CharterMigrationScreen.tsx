import {useEffect,useRef,useState} from 'react';
import {LAMPORTS_PER_SOL} from '@solana/web3.js';
import {useMigration} from '../../lib/charterMigration/useMigration';
import type {CharterSigningTrust} from '../../lib/charter/signing';
import {Btn,Icon} from '../primitives';
import {EconomyPanel} from './EconomyPanel';
import './charter-retirement.css';
function sol(value:string){const n=BigInt(value),unit=BigInt(LAMPORTS_PER_SOL),fraction=(n%unit).toString().padStart(String(LAMPORTS_PER_SOL).length-1,'0').replace(/0+$/,'');return `${n/unit}${fraction?'.'+fraction:''}`;}
const controls={minHeight:48,whiteSpace:'normal' as const};
export function CharterMigrationScreen({clanId,requestId=null,actionsEnabled,trust=null,onClose}:{clanId:string|null;requestId?:string|null;actionsEnabled:boolean;trust?:CharterSigningTrust|null;onClose:()=>void}){
 const {state,actionsAllowed,run,dismiss}=useMigration(actionsEnabled,trust),[consent,setConsent]=useState(false);
 const j=state.journal,m=j?.migration,terminal=m?.terminal?.outcome,busy=!state.loaded||state.busy,signing=m?.signing,signed=!!(j?.signed||m?.wire),held=!!j?.observed.length;
 const opened=useRef<string|null>(null);
 useEffect(()=>{if(!requestId||!state.loaded||state.busy||opened.current===requestId)return;opened.current=requestId;run(c=>c.open(requestId));},[requestId,state.loaded,state.busy,run]);
 const reviewed=!!signing&&state.reviewedMessage===signing.packet.messageSha256;
 useEffect(()=>setConsent(false),[m?.id,signing?.packet.messageSha256]);
 const close=()=>{dismiss();onClose();};
 return <EconomyPanel title="Your clan Charter" eyebrow="EXISTING CLAN" icon={<Icon name="quest" size={36}/>} onClose={close} error={state.error}>
  <div className="sk-retirement">
   {!actionsAllowed&&!terminal&&<p className="sk-retirement-note" role="status">New approvals are unavailable. Your saved request and outcome checks remain accessible.</p>}
   {!m&&<section className="sk-retirement-card"><p className="sk-retirement-kicker">KEEP THE CLAN YOU BUILT</p><h3>Give your clan its Charter</h3>
    <p>Your clan keeps its name, members, chest and earned rewards. The Charter puts its leadership under your wallet’s control.</p><ul><li>No second clan-creation SHARDS payment.</li><li>Your wallet pays the quoted SOL network and collectible costs.</li><li>Your existing member rights and outstanding obligations stay with the clan.</li></ul>
    {j?.request||j?.migrationId?<><p role="status">Your original request is saved. Recover it to continue.</p><div className="sk-retirement-actions"><Btn variant="sec" style={controls} disabled={busy} onClick={()=>run(c=>c.load())}>Check saved request</Btn>{!j.migrationId&&<Btn variant="sec" style={controls} disabled={busy||!actionsAllowed||held} onClick={()=>run(c=>c.retryOriginal())}>Retry this request</Btn>}</div></>
     :<><p className="sk-retirement-note">Reviewing holds clan changes until this request is confirmed or safely cancelled. Your wallet has not approved a payment yet.</p><Btn style={controls} disabled={busy||!actionsAllowed||!clanId} onClick={()=>clanId&&run(c=>c.begin({clanId,idempotencyKey:crypto.randomUUID()}))}>Review existing clan</Btn>{!clanId&&<p>Only the current leader of an existing clan can begin.</p>}</>}
   </section>}
   {m&&<>
    <section className="sk-retirement-identity"><div className="sk-retirement-emblem" aria-hidden="true"><Icon name="quest" size={42}/></div><div><p className="sk-retirement-kicker">[{m.snapshot.clan.tag}] CLAN CHARTER</p><h3>{m.snapshot.clan.name}</h3><p>{terminal==='controlled'?'Charter active':terminal==='cancelled'?'Request cancelled':signed?'Signature saved':j?.signingStarted?'Approval unresolved':signing?'Ready for approval':'Clan review saved'}</p></div><span className={'sk-retirement-status'+(terminal?' sk-retirement-status-terminal':'')}>{terminal==='controlled'?'ACTIVE':terminal==='cancelled'?'CANCELLED':'IN PROGRESS'}</span></section>
    <ol className="sk-retirement-steps" aria-label="Charter progress"><li className="is-complete"><span>1</span>Clan review</li><li className={signed?'is-complete':!terminal?'is-current':''}><span>2</span>Wallet approval</li><li className={terminal==='controlled'?'is-complete':signed&&!terminal?'is-current':''}><span>3</span>Charter active</li></ol>
    <section className="sk-retirement-card"><div className="sk-retirement-section-title"><h3>Your existing clan</h3><span>RETAINED</span></div><dl className="sk-retirement-costs"><div><dt>Members</dt><dd>{m.snapshot.memberCount}</dd></div><div><dt>Member chest</dt><dd>{BigInt(m.snapshot.chestShards).toLocaleString()} SHARDS</dd></div><div><dt>Creation SHARDS</dt><dd>No repeat payment</dd></div></dl><p>Existing rewards and obligations are preserved. This request does not distribute the chest or clear outstanding claims.</p></section>
    {terminal?<section className="sk-retirement-card" role="status"><h3>{terminal==='controlled'?'Your Charter is ready':'Your clan remains unchanged'}</h3><p>{terminal==='controlled'?'Your clan now uses its Charter for controlled leadership changes. Members, balances and earned rewards remain intact.':'This original request is closed. No replacement Charter was issued by cancelling it.'}</p><div className="sk-retirement-actions"><Btn variant="sec" style={controls} disabled={busy} onClick={()=>run(c=>c.archive())}>Keep receipt in history</Btn><Btn variant="sec" style={controls} onClick={close}>Back to Charters</Btn></div></section>
     :<>
      {!signing&&<section className="sk-retirement-card"><h3>Review the exact wallet costs</h3><p>{m.status==='issuing'?'Your original approval is being recovered. It will not be replaced with another request.':'Prepare your clan’s Charter transaction to see its network, rent and collectible creation costs.'}</p><Btn style={controls} disabled={busy||m.status!=='issuing'&&(!actionsAllowed||held)} onClick={()=>run(c=>c.command(m.status==='issuing'?'recover-preparation':'prepare'))}>{m.status==='issuing'?'Recover prepared approval':'Prepare wallet review'}</Btn></section>}
      {signing&&<section className="sk-retirement-card"><h3>{signed?'Submit your saved approval':j?.signingStarted?'Check the saved outcome':'Exact wallet costs'}</h3><dl className="sk-retirement-costs"><div><dt>Network fee</dt><dd>{sol(signing.costs.networkFeeLamports)} SOL</dd></div><div><dt>Account rent</dt><dd>{sol(signing.costs.rentLamports)} SOL</dd></div><div><dt>Collectible creation</dt><dd>{sol(signing.costs.coreCreateFeeLamports)} SOL</dd></div><div className="sk-retirement-cost-total"><dt>Total quoted</dt><dd>{sol(signing.costs.totalLamports)} SOL</dd></div></dl>
       {signed?<><p>Your exact signed transaction is saved. Submitting it again uses the same approval.</p><Btn style={controls} disabled={busy||!actionsAllowed||held} onClick={()=>run(c=>c.deliver())}>Submit saved transaction</Btn></>
        :j?.signingStarted?<p role="status">A wallet approval may already exist. Check its outcome; another signature will not be requested.</p>
        :<><label className="sk-retirement-consent"><input type="checkbox" checked={consent} disabled={busy||held} onChange={e=>setConsent(e.target.checked)}/><span>Issue this Charter for {m.snapshot.clan.name} and pay the quoted SOL costs. Keep the clan’s members, chest and existing obligations.</span></label><Btn style={controls} disabled={busy||!actionsAllowed||!consent||held} onClick={()=>run(c=>reviewed?c.sign():c.review())}>{reviewed?'Approve Charter in wallet':'Review exact approval'}</Btn></>}
      </section>}
      <section className="sk-retirement-recovery"><div><h3>Keep your original request</h3><p>Cancellation waits for any exposed approval to expire and for checks to confirm that no Charter was issued. An uncertain result keeps the request open.</p></div><div className="sk-retirement-actions"><Btn variant="sec" style={controls} disabled={busy} onClick={()=>run(c=>c.command('recover'))}>Check outcome</Btn><Btn variant="sec" style={controls} disabled={busy} onClick={()=>run(c=>c.command('cancel'))}>Cancel request</Btn></div></section>
     </>}
    <details className="sk-retirement-receipt"><summary>Receipt details</summary><dl><dt>Clan ID</dt><dd>{m.original.clanId}</dd><dt>Request ID</dt><dd>{m.id}</dd>{m.wire&&<><dt>Transaction</dt><dd>{m.wire.signature}</dd></>}</dl></details>
   </>}
   {!!state.history.length&&<section className="sk-retirement-card"><h3>Saved receipts</h3>{state.history.map(row=><details key={row.revision}><summary>{row.migration?.snapshot.clan.name} — {row.migration?.status==='controlled'?'Charter active':'Cancelled'}</summary><p className="sk-retirement-reference">Request {row.migrationId}</p></details>)}</section>}
   {state.busy&&<p className="sk-retirement-progress" role="status" aria-live="polite">Saving and checking your clan Charter…</p>}
  </div>
 </EconomyPanel>;
}
