package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import java.util.UUID
import kotlinx.serialization.json.JsonObject

class EquipmentAppPorts(private val session:AccountSession,private val holder:AccountSessionHolder,
 override val transport:EquipmentTransport,private val catalogue:()->JsonObject?,private val lifecycle:()->CharterLifecycle,
 private val selected:()->String?,private val owned:(String)->Unit,private val refresh:suspend()->Unit):EquipmentPorts {
 init{require(transport.identity.wallet==session.wallet&&transport.identity.origin==session.origin.trimEnd('/'))}
 override fun policy()=EquipmentPolicy.catalogue(catalogue())
 override fun vehiclePolicy()=VehiclePolicy.catalogue(catalogue())
 override fun selectedBase()=selected()
 override fun key()=UUID.randomUUID().toString()
 override fun requireOwnedBase(base:String){holder.requireCurrent(session);owned(base)}
 override fun capture(fresh:Boolean):()->Unit{holder.requireCurrent(session);val page=lifecycle();val policy=if(fresh)requireNotNull(policy()){"equipment content is unavailable."}else null
  val guard={holder.requireCurrent(session);val current=lifecycle();check(current.active&&current.visible&&current.viewEpoch==page.viewEpoch&&current.selectionIdentity==page.selectionIdentity){"The equipment view or selected kingdom changed. The original is saved."}
   if(fresh)check(current.actionsAllowed&&current.contentReady&&!current.battleActive&&!current.contentIdentity.isNullOrBlank()&&current.contentIdentity==page.contentIdentity&&policy()==policy){"New equipment orders are paused or their content changed."}}
  guard();return guard}
 override suspend fun hydrate(guard:()->Unit){guard();refresh();guard()}
}
fun AppGraph.equipmentClient(session:SessionGraph,lifecycle:()->CharterLifecycle):EquipmentRepository {
 holder.requireCurrent(session.session);val identity=StarterIdentity(origin.trimEnd('/'),cluster.id,session.session.wallet)
 val store=EquipmentStore(EncryptedStore(application,storageNamespace(origin,"ordinary-equipment-${cluster.id}-${identity.wallet}")),identity)
 val ports=EquipmentAppPorts(session.session,holder,EquipmentTransport(EquipmentHttpPort(gameApi.charterClientPort(identity,session.session.token)), captureDeparture = { base, guard -> session.fleetJourneyDepartures?.capture(base, guard) }),{content.state.value.catalogue},lifecycle,{account.state.value.selectedBaseId},{base->
  val a=account.state.value;val directory=requireNotNull(a.directory);check(a.selectedBaseId==base&&directory.enabled&&directory.stableMutations&&directory.bases.any{it.id==base&&it.selectable}){"Select an owned active kingdom for a new equipment order."}
 },{account.refreshDirectory();account.refreshIdentity();val a=account.state.value;if(a.directory?.bases?.any{it.id==a.selectedBaseId&&it.selectable}==true)session.base.refreshWithoutJourneys()})
 return EquipmentRepository(store,ports)
}
