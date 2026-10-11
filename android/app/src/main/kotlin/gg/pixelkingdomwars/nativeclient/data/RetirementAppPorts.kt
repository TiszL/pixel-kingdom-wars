package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.retirement.*
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.serialization.json.*

class RetirementAppPorts(private val charter:CharterPorts,override val transport:RetirementTransport,private val catalogue:()->JsonObject?):RetirementPorts {
 override fun capture(newAction:Boolean)=charter.capture(newAction)
 override fun trust()=charter.trust()
 override fun cryptoPolicy()=charter.cryptoPolicy()
 override fun key()=UUID.randomUUID().toString()
 override fun validate(draft:JsonObject){val d=RetirementProtocol.draft(draft);val c=requireNotNull(catalogue()).charterObject("constants").charterObject("CLANS");val clan=d.charterObject("clan")
  fun n(key:String)=CharterGrammar.number(c.getValue(key))
  require(clan.charterText("name").length.toLong() in n("nameMinLen")..n("nameMaxLen")&&clan.charterText("tag").length.toLong() in n("tagMinLen")..n("tagMaxLen"));require(d.getValue("shares").jsonArray.size.toLong() in 1..n("rosterCap"))
 }
 override suspend fun live(prepared:PreparedCharter,operation:JsonObject,guard:()->Unit):()->Unit {val q=operation.charterObject("attempt").charterObject("quote");return charter.live(prepared,buildJsonObject{put("context",q.getValue("context"));put("lastValidBlockHeight",q.charterObject("packetInput").getValue("lastValidBlockHeight"))},guard)}
 override suspend fun ready(guard:()->Unit)=charter.ready(guard)
 override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend(SignedCharter)->Unit)=charter.sign(prepared,guard,retain)
 override suspend fun hydrate(guard:()->Unit)=charter.hydrate(guard)
}
data class RetirementClient(val repository:RetirementRepository,val wallet:CharterWallet,val configured:Boolean)
fun AppGraph.retirementClient(session:SessionGraph,mwa:WalletLogin?,lifecycle:()->CharterLifecycle,independentPins:CharterSigningTrust?=null):RetirementClient {
 holder.requireCurrent(session.session);val identity=StarterIdentity(origin.trimEnd('/'),cluster.id,session.session.wallet)
 val store=RetirementStore(EncryptedStore(application,storageNamespace(origin,"charter-retirement-${cluster.id}-${identity.wallet}")),identity)
 val external=mwa?.let{login->CharterExternalSigner{p,chain,retain,guard->login.signTransactionOnlyWithEvidence(p,chain,session.session.token,retain){holder.requireCurrent(session.session);guard()}}}
 val wallet=CharterWallet(session.session,holder,origin,cluster,socialBinding::isBoundForSecurity,::social,external)
 val port=gameApi.charterClientPort(identity,session.session.token)
 val ordinary=CharterAppPorts(session.session,holder,CharterTransport(port),{independentPins},{content.state.value.catalogue},lifecycle,CharterSessionRpc(session.api,cluster),wallet,android.os.SystemClock::elapsedRealtime,{session.clans.refresh();session.base.refreshWithoutJourneys()})
 return RetirementClient(RetirementRepository(store,RetirementAppPorts(ordinary,RetirementTransport(RetirementHttpPort(port))){content.state.value.catalogue}),wallet,independentPins!=null)
}
