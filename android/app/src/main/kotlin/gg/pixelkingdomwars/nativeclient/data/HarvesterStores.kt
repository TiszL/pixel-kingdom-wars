package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterIdentity
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterStore
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Process lifetime, outside SessionGraph: reauthentication shares the journal and its request lock. */
class HarvesterStores(private val secret: (String, String, String) -> SecretStore) {
    private val stores = mutableMapOf<HarvesterIdentity, HarvesterStore>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): HarvesterStore {
        val url = origin.toHttpUrl()
        require(url.isHttps && url.encodedPath == "/" && url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val identity = HarvesterIdentity(url.toString().trimEnd('/'), cluster, wallet); identity.validate()
        return stores.getOrPut(identity) { HarvesterStore(secret(identity.origin, cluster, wallet), identity).also { it.read() } }
    }
}
