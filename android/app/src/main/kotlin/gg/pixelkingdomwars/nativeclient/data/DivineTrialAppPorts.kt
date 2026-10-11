package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.util.UUID
import kotlinx.serialization.json.JsonObject

class DivineTrialAppPorts(private val session:AccountSession,private val holder:AccountSessionHolder,
 override val transport:DivineTransport,private val catalogue:()->JsonObject?,private val lifecycle:()->CharterLifecycle,
 private val requireOwned:(String)->Unit,private val refresh:suspend ()->Unit):DivineTrialPorts {
 init{require(transport.identity.wallet==session.wallet&&transport.identity.origin==session.origin.trimEnd('/'))}
 override fun rules()=DivineRules.catalogue(catalogue())
 override fun key()=UUID.randomUUID().toString()
 override fun owned(base:String)=requireOwned(base)
 override fun capture(fresh:Boolean):()->Unit {holder.requireCurrent(session);val initial=lifecycle();val r=rules();val guard={holder.requireCurrent(session);val c=lifecycle();check(c.active&&c.visible&&c.viewEpoch==initial.viewEpoch){"Trial view changed. Its originals are preserved."};if(fresh)check(c.actionsAllowed&&c.contentReady&&!c.battleActive&&!c.contentIdentity.isNullOrBlank()&&c.contentIdentity==initial.contentIdentity&&c.selectionIdentity==initial.selectionIdentity&&r!=null&&rules()==r){"Trial admission changed. Review before continuing."}};guard();return guard}
 override suspend fun hydrate(guard:()->Unit){guard();refresh();guard()}
}
fun AppGraph.divineTrialClient(session:SessionGraph,lifecycle:()->CharterLifecycle):DivineTrialRepository {
 holder.requireCurrent(session.session);val id=StarterIdentity(origin.trimEnd('/'),cluster.id,session.session.wallet)
 val store=DivineTrialStore(EncryptedStore(application,storageNamespace(origin,"divine-trials-${cluster.id}-${id.wallet}")),id)
 val port=DivineTrialAppPorts(session.session,holder,DivineTransport(DivineHttpPort(gameApi.charterClientPort(id,session.session.token))),{content.state.value.catalogue},lifecycle,{base->holder.requireCurrent(session.session);val a=account.state.value;val directory=requireNotNull(a.directory);check(a.selectedBaseId==base&&directory.enabled&&directory.stableMutations&&directory.bases.any{it.id==base&&it.selectable}){"Choose a currently owned kingdom."}},{account.refreshDirectory();account.refreshIdentity();val a=account.state.value;if(a.directory?.bases?.any{it.id==a.selectedBaseId&&it.selectable}==true)session.base.refreshWithoutJourneys()})
 return DivineTrialRepository(store,port)
}
