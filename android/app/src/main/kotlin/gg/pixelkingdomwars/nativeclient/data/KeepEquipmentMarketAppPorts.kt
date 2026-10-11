package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.serialization.json.*

class KeepEquipmentMarketAppPorts(private val session:AccountSession,private val holder:AccountSessionHolder,
 override val transport:KeepEquipmentMarketTransport,private val configured:()->KeepEquipmentMarketSigningTrust?,
 private val lifecycle:()->CharterLifecycle,private val selected:()->String?,private val owned:(String)->Unit,
 private val rpc:KeepEquipmentMarketRpcReads,private val wallet:VehicleWallet,private val monotonicMs:()->Long,private val refresh:suspend()->Unit):KeepEquipmentMarketPorts {
 init{require(transport.identity.wallet==session.wallet&&transport.identity.origin==session.origin.trimEnd('/'))}
 override fun trust()=configured()
 override fun key()=UUID.randomUUID().toString()
 override fun now()=monotonicMs()
 override fun selectedBase()=selected()
 override fun requireOwnedBase(base:String){holder.requireCurrent(session);owned(base)}
 override fun capture(fresh:Boolean):()->Unit {holder.requireCurrent(session);val page=lifecycle();val pins=trust()?.toJson();val guard={holder.requireCurrent(session);val current=lifecycle();check(current.active&&current.visible&&current.viewEpoch==page.viewEpoch){"The market view changed. Your original request is saved"};if(fresh)check(current.actionsAllowed&&current.contentReady&&!current.battleActive&&!current.contentIdentity.isNullOrBlank()&&current.contentIdentity==page.contentIdentity&&current.selectionIdentity==page.selectionIdentity&&trust()?.toJson()==pins){"Market admission changed. Check your saved request"}};guard();return guard}
 override suspend fun live(purchase:JsonObject,prepared:PreparedKeepEquipmentMarket,pins:KeepEquipmentMarketSigningTrust,policy:JsonObject,review:JsonObject,guard:()->Unit):()->Unit {guard();require(prepared.wallet==session.wallet&&trust()?.toJson()==pins.toJson());val live=KeepEquipmentMarketCurrent.verify(purchase,pins,policy,review,rpc,guard,monotonicMs);return{guard();check(trust()?.toJson()==pins.toJson());live()}}
 override suspend fun ready(guard:()->Unit)=wallet.requireAvailable(guard)
 override suspend fun sign(prepared:PreparedKeepEquipmentMarket,guard:()->Unit,beforeWallet:suspend()->Unit,retain:suspend(JsonObject)->Unit){wallet.sign(prepared.signingPacket,retain,beforeWallet,guard)}
 override suspend fun hydrate(guard:()->Unit){guard();refresh();guard()}
}
data class KeepEquipmentMarketClient(val repository:KeepEquipmentMarketRepository,val wallet:VehicleWallet,val configured:Boolean)
/** The caller obtains the port from the same GameApi session. Production pins
 * remain absent; discovery and original history never require a signing key. */
fun AppGraph.keepEquipmentMarketClient(session:SessionGraph,mwa:WalletLogin?,port:KeepEquipmentMarketHttpPort,lifecycle:()->CharterLifecycle,independentPins:KeepEquipmentMarketSigningTrust?=null):KeepEquipmentMarketClient {
 holder.requireCurrent(session.session);val identity=StarterIdentity(origin.trimEnd('/'),cluster.id,session.session.wallet);port.requireCurrent(identity,session.session.token)
 val store=KeepEquipmentMarketStore(EncryptedStore(application,storageNamespace(origin,"keep-equipment-market-${cluster.id}-${identity.wallet}")),identity)
 val external=mwa?.let{login->VehicleExternalSigner{prepared,chain,retain,beforeWallet,guard->login.signTransactionOnlyWithEvidence(prepared,chain,session.session.token,retain,beforeWallet){holder.requireCurrent(session.session);guard()}}}
 val wallet=VehicleWallet(session.session,holder,origin,cluster,socialBinding::isBoundForSecurity,::social,external)
 val ports=KeepEquipmentMarketAppPorts(session.session,holder,KeepEquipmentMarketTransport(port),{independentPins},lifecycle,{account.state.value.selectedBaseId},{base->
  val a=account.state.value;val directory=requireNotNull(a.directory);check(a.selectedBaseId==base&&directory.enabled&&directory.stableMutations&&directory.bases.any{it.id==base&&it.selectable}){"Select an owned active kingdom for this stock command"}
 },KeepEquipmentMarketRpcReads{method,params->port.rpc(method,params){holder.requireCurrent(session.session)}},wallet,android.os.SystemClock::elapsedRealtime,{
  account.refreshDirectory();account.refreshIdentity();val a=account.state.value;if(a.directory?.bases?.any{it.id==a.selectedBaseId&&it.selectable}==true)session.base.refreshWithoutJourneys()
 })
 return KeepEquipmentMarketClient(KeepEquipmentMarketRepository(store,ports),wallet,independentPins!=null)
}
