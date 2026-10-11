package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimOrderedPin
import kotlinx.serialization.json.*
internal object MiningOrderedFixtures {
 val raw=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-ordered-journal.json")).readText()).jsonObject
 val policy=MiningClaimsProtocolPolicy(9,1,120,200000)
 val p=MiningClaimPreparationView.from(raw.getValue("preparation").jsonObject,policy)
 val wires=raw.getValue("wires").jsonArray.map{v->val w=v.jsonObject;MiningClaimSavedWire(w.getValue("ordinal").jsonPrimitive.int,w.getValue("wire").jsonPrimitive.content,w.getValue("signature").jsonPrimitive.content)}
 val reviews=raw.getValue("reviews").jsonArray.map{MiningClaimOrdinalReview.from(it.jsonObject)}
 val continuation=MiningClaimContinuation.from(raw.getValue("continuation").jsonObject,policy)
 val pins=p.identity.let{MiningClaimSigningTrust(it.genesisHash,it.programId,it.configAddress,it.keepMint,it.reserveOwner,requireNotNull(p.format).expectedLookupTable.let{pin->MiningClaimOrderedPin(pin.address,pin.dataSha256)})}
 fun status()=MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1,1,1)),p.wallet,"shardkeep-economy",p.identity.programId,p.identity.keepMint,"ready",null,p.rootSequence,p.leaf.cumulativeKeepBaseUnits,"0",p.leaf.cumulativeKeepBaseUnits,9,150,"7200","7200",true,true,true,false,p.serverNow)
 fun claim(setup:Boolean=false,paid:Boolean=false,failed:Boolean=false):MiningClaimView {
  val txs=p.transactions.map{tx->val done=if(tx.ordinal==0)setup else paid;val fail=tx.ordinal==1&&failed;MiningClaimLanding(tx.ordinal,tx.kind,if(done||fail)wires[tx.ordinal].signature else null,if(fail)"failed" else if(done)"finalized" else "pending",if(done)if(tx.kind=="setup")"0" else p.leaf.cumulativeKeepBaseUnits else null,if(done||fail)p.serverNow else null,if(done||fail)p.serverNow else null)}
  return MiningClaimView(1,p.wallet,p.claimId,if(paid)"settled" else if(failed)"failed" else if(setup)"retained" else "prepared",if(paid)"finalized" else if(failed)"failed" else "pending",if(paid||failed)wires[1].signature else if(setup)wires[0].signature else null,if(paid)p.leaf.cumulativeKeepBaseUnits else null,txs,p.serverNow,false)
 }
 fun envelope(proof:MiningClaimContinuation?=continuation)=MiningClaimContinuationEnvelope(1,p.wallet,p.claimId,if(proof==null)"unknown" else "continued",proof,proof?.createdAt?:p.serverNow)
}
