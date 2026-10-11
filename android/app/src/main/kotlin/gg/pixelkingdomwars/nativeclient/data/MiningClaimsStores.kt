package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Survives SessionGraph replacement: a late signature belongs to the same original CAS owner. */
class MiningClaimsStores(private val secret: (String, String, String) -> SecretStore) {
    private val stores = mutableMapOf<StarterIdentity, MiningClaimsStore>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): MiningClaimsStore {
        val url = origin.toHttpUrl()
        require(url.isHttps && url.encodedPath == "/" && url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val identity = StarterIdentity(url.toString().trimEnd('/'), cluster, wallet); identity.validate()
        return stores.getOrPut(identity) { MiningClaimsStore(secret(identity.origin, cluster, wallet), identity).also { it.read() } }
    }
}
