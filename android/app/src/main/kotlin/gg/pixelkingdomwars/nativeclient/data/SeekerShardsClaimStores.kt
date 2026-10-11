package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsClaimStore
import gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsClaimsPolicy
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Process-shared actor journal. Its exact source remains frozen inside the command across base changes. */
class SeekerShardsClaimStores(policy: SeekerShardsClaimsPolicy, private val secret: (String, String, String) -> SecretStore) {
    private val policy = policy.copy().also { it.validate() }
    private val stores = mutableMapOf<StarterIdentity, SeekerShardsClaimStore>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): SeekerShardsClaimStore {
        val url = origin.toHttpUrl()
        require(url.isHttps && url.encodedPath == "/" && url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val identity = StarterIdentity(url.toString().trimEnd('/'), cluster, wallet); identity.validate()
        return stores.getOrPut(identity) { SeekerShardsClaimStore(secret(identity.origin, cluster, wallet), identity, policy).also { it.read() } }
    }
}
