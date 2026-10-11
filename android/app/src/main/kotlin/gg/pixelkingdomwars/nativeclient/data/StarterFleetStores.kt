package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetStore
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Process lifetime, outside SessionGraph: reauthentication shares the journal and its request lock. */
class StarterFleetStores(private val secret: (String, String, String) -> SecretStore) {
    private val stores = mutableMapOf<StarterIdentity, StarterFleetStore>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): StarterFleetStore {
        val url = origin.toHttpUrl()
        require(url.isHttps && url.encodedPath == "/" && url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val identity = StarterIdentity(url.toString().trimEnd('/'), cluster, wallet); identity.validate()
        return stores.getOrPut(identity) { StarterFleetStore(secret(identity.origin, cluster, wallet), identity).also { it.read() } }
    }
}
