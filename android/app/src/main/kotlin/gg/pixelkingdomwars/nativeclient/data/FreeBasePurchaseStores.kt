package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.freebase.FreeBasePurchaseStore
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Process-shared actor journal. Its exact source remains frozen inside the command across base changes. */
class FreeBasePurchaseStores(private val secret: (String, String, String) -> SecretStore) {
    private val stores = mutableMapOf<StarterIdentity, FreeBasePurchaseStore>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): FreeBasePurchaseStore {
        val url = origin.toHttpUrl()
        require(url.isHttps && url.encodedPath == "/" && url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val identity = StarterIdentity(url.toString().trimEnd('/'), cluster, wallet); identity.validate()
        return stores.getOrPut(identity) { FreeBasePurchaseStore(secret(identity.origin, cluster, wallet), identity).also { it.read() } }
    }
}
