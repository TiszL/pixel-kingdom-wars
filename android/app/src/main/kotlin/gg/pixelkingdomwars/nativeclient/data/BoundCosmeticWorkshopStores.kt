package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticIdentity
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticStore
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticMode
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.sync.Mutex
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Keep one encrypted journal/request mutex per account outside replaceable session graphs. */
class BoundCosmeticWorkshopStores private constructor(private val secret: (String, String, String) -> SecretStore,
    private val wakeSecret: ((String, String, String) -> SecretStore)?) {
    constructor(secret: (String, String, String) -> SecretStore) : this(secret, null)
    private val stores = mutableMapOf<Pair<BoundCosmeticIdentity, BoundCosmeticMode>, BoundCosmeticStore>()
    private val requests = mutableMapOf<BoundCosmeticIdentity, Mutex>()
    @Synchronized fun forIdentity(origin: String, cluster: String, wallet: String): BoundCosmeticStore =
        store(origin, cluster, wallet, BoundCosmeticMode.AWNING, secret)
    @Synchronized fun forWakeIdentity(origin: String, cluster: String, wallet: String): BoundCosmeticStore =
        store(origin, cluster, wallet, BoundCosmeticMode.WAKE, requireNotNull(wakeSecret) { "Wake storage is not configured" })
    private fun store(origin: String, cluster: String, wallet: String, mode: BoundCosmeticMode,
        open: (String, String, String) -> SecretStore): BoundCosmeticStore {
        val url = origin.toHttpUrl()
        require(url.isHttps && url.encodedPath == "/" && url.query == null && url.fragment == null && url.username.isEmpty() && url.password.isEmpty())
        val identity = BoundCosmeticIdentity(url.toString().trimEnd('/'), cluster, wallet); identity.validate()
        return stores.getOrPut(identity to mode) {
            BoundCosmeticStore(open(identity.origin, cluster, wallet), identity, mode, requests.getOrPut(identity) { Mutex() }).also { it.read() }
        }
    }
    companion object {
        /** Purpose names are fixed here; callers cannot merge or reinterpret the two journals. */
        fun withWakeStores(open: (String, String) -> SecretStore): BoundCosmeticWorkshopStores = BoundCosmeticWorkshopStores(
            { origin, cluster, wallet -> open(origin, "bound-cosmetics-$cluster-$wallet") },
            { origin, cluster, wallet -> open(origin, "bound-cosmetic-wake-v1-$cluster-$wallet") })
    }
}
