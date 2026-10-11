package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.serialization.json.*

/** A session-bound, installed RPC relay. Server vehicle records cannot supply URLs. */
class VehicleSessionRpc(private val port:CharterHttpPort):VehicleRpcReads {
 override suspend fun request(method:String,params:JsonArray):JsonObject = port.vehicleRpcRequest(method,params,{})
}
class VehicleAppPorts(private val session:AccountSession,private val holder:AccountSessionHolder,
 override val transport:VehicleTransport,private val configured:()->VehicleSigningTrust?,private val catalogue:()->JsonObject?,
 private val lifecycle:()->CharterLifecycle,private val owned:(String)->Unit,private val rpc:VehicleRpcReads,
 private val wallet:VehicleWallet,private val monotonicMs:()->Long,private val refreshDomain:suspend ()->Unit):VehiclePorts {
 init {require(transport.identity.wallet==session.wallet&&transport.identity.origin==session.origin.trimEnd('/'))}
 override fun policy()=VehiclePolicy.catalogue(catalogue())
 override fun trust()=configured()
 override fun key()=UUID.randomUUID().toString()
 override fun now()=monotonicMs()
 override fun capture(fresh:Boolean):()->Unit {
  holder.requireCurrent(session);val page=lifecycle();val p=if(fresh)requireNotNull(policy()){"Vehicle content is unavailable."} else null;val pins=trust()
  val guard={holder.requireCurrent(session);val current=lifecycle();check(current.active&&current.visible&&current.viewEpoch==page.viewEpoch){"The vehicle view changed. Its original outcome is saved."}
   if(fresh)check(current.actionsAllowed&&current.contentReady&&!current.battleActive&&!current.contentIdentity.isNullOrBlank()&&current.contentIdentity==page.contentIdentity&&current.selectionIdentity==page.selectionIdentity&&policy()==p&&trust()==pins){"Vehicle admission changed. Review the original operation again."}}
  guard();return guard
 }
 override fun requireOwnedBase(base:String)=owned(base)
 override suspend fun live(client:JsonObject,prepared:PreparedVehicle,pins:VehicleSigningTrust,policy:VehiclePolicy,networkFeeLamports:String,guard:()->Unit):()->Unit {
  guard();require(prepared.wallet==session.wallet&&trust()==pins&&policy.sameBurnPolicy(this.policy()))
  val current=VehicleCurrent.verify(client,pins,policy,networkFeeLamports,rpc,guard,monotonicMs)
  return {guard();check(trust()==pins&&policy.sameBurnPolicy(this.policy()));current()}
 }
 override suspend fun ready(guard:()->Unit)=wallet.requireAvailable(guard)
 override suspend fun sign(prepared:PreparedVehicle,guard:()->Unit,beforeWallet:suspend ()->Unit,retain:suspend (JsonObject)->Unit){wallet.sign(prepared,retain,beforeWallet,guard)}
 override suspend fun hydrate(guard:()->Unit){guard();refreshDomain();guard()}
}
data class VehicleClient(val repository:VehicleRepository,val wallet:VehicleWallet,val configured:Boolean,val craft:VehicleCraftRepository,val policy:()->VehiclePolicy?)
/** Production pins deliberately remain absent. Original history is still readable. */
fun AppGraph.vehicleClient(session:SessionGraph,mwa:WalletLogin?,lifecycle:()->CharterLifecycle,independentPins:VehicleSigningTrust?=null):VehicleClient {
 holder.requireCurrent(session.session);val identity=StarterIdentity(origin.trimEnd('/'),cluster.id,session.session.wallet)
 val store=VehicleStore(EncryptedStore(application,storageNamespace(origin,"vehicle-${cluster.id}-${identity.wallet}")),identity)
 val external=mwa?.let{login->VehicleExternalSigner{prepared,chain,retain,beforeWallet,guard->login.signTransactionOnlyWithEvidence(prepared,chain,session.session.token,retain,beforeWallet){holder.requireCurrent(session.session);guard()}}}
 val wallet=VehicleWallet(session.session,holder,origin,cluster,socialBinding::isBoundForSecurity,::social,external)
 val port=gameApi.charterClientPort(identity,session.session.token)
 val ports=VehicleAppPorts(session.session,holder,VehicleTransport(VehicleHttpPort(port), captureDeparture = { base, guard -> session.fleetJourneyDepartures?.capture(base, guard) }),{independentPins},{content.state.value.catalogue},lifecycle,{base->
  holder.requireCurrent(session.session);val a=account.state.value;val directory=requireNotNull(a.directory)
  check(a.selectedBaseId==base&&directory.enabled&&directory.stableMutations&&directory.bases.any{it.id==base&&it.selectable}){"Select an owned active kingdom for a new vehicle action."}
 },VehicleSessionRpc(port),wallet,android.os.SystemClock::elapsedRealtime,{
  account.refreshDirectory();account.refreshIdentity()
  val a=account.state.value;if(a.directory?.bases?.any{it.id==a.selectedBaseId&&it.selectable}==true)session.base.refreshWithoutJourneys()
 })
 val craftStore=VehicleCraftStore(EncryptedStore(application,storageNamespace(origin,"vehicle-craft-${cluster.id}-${identity.wallet}")),identity)
 return VehicleClient(VehicleRepository(store,ports),wallet,independentPins!=null,VehicleCraftRepository(craftStore,ports)){VehiclePolicy.catalogue(content.state.value.catalogue)}
}
