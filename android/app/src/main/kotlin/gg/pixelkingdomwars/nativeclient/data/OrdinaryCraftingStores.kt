package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingIdentity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingStore
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Process lifetime, outside SessionGraph: reauthentication shares the journal and its request lock. */
class OrdinaryCraftingStores(private val secret: (String, String, String) -> SecretStore) {
    private val stores = mutableMapOf<OrdinaryCraftingIdentity, OrdinaryCraftingStore>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): OrdinaryCraftingStore {
        val url = origin.toHttpUrl()
        require(url.isHttps && url.encodedPath == "/" && url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val identity = OrdinaryCraftingIdentity(url.toString().trimEnd('/'), cluster, wallet); identity.validate()
        return stores.getOrPut(identity) { OrdinaryCraftingStore(secret(identity.origin, cluster, wallet), identity).also { it.read() } }
    }
}
