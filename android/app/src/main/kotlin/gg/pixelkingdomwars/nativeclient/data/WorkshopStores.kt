package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopIdentity
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopStore
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Process lifetime, outside SessionGraph. Reauthentication must share the exact journal CAS lock. */
class WorkshopStores(private val secret: (String, String, String) -> SecretStore) {
    private val stores = mutableMapOf<WorkshopIdentity, WorkshopStore>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): WorkshopStore {
        val url = origin.toHttpUrl(); require(url.isHttps && url.encodedPath == "/" && url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val identity = WorkshopIdentity(url.toString().trimEnd('/'), cluster, wallet); identity.validate()
        return stores.getOrPut(identity) { WorkshopStore(secret(identity.origin, cluster, wallet), identity).also { it.read() } }
    }
}
