package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore

/** Process lifetime, outside SessionGraph: a late wallet reply must share the original CAS lock. */
class GemsBuyStores(private val secret: (String, String, String) -> SecretStore) {
    private val stores = mutableMapOf<Triple<String, String, String>, GemsBuyStore>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): GemsBuyStore =
        stores.getOrPut(Triple(origin, cluster, wallet)) {
            GemsBuyStore(secret(origin, cluster, wallet), wallet, origin, cluster)
        }
}
