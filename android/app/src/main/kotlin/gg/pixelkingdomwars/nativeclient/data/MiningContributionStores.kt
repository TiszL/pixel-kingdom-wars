package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.miningcontribution.MiningContributionIdentity
import gg.pixelkingdomwars.nativeclient.miningcontribution.MiningContributionStore
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Process lifetime, outside SessionGraph: reauthentication shares the journal and its request lock. */
class MiningContributionStores(private val secret: (String, String, String) -> SecretStore) {
    private val stores = mutableMapOf<MiningContributionIdentity, MiningContributionStore>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): MiningContributionStore {
        val url = origin.toHttpUrl()
        require(url.isHttps && url.encodedPath == "/" && url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val identity = MiningContributionIdentity(url.toString().trimEnd('/'), cluster, wallet); identity.validate()
        return stores.getOrPut(identity) { MiningContributionStore(secret(identity.origin, cluster, wallet), identity).also { it.read() } }
    }
}
