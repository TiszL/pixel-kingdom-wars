package gg.pixelkingdomwars.nativeclient.scene.world

import android.content.Context
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.network.storageNamespace

/**
 * The server's kill switch for the GL30 world (D-NEXT, N5; backend PR #143: `GET /native/capabilities` always carries
 * `worldV2: { enabled }`, default on). The owner turns it off to send every native client back to the legacy globe
 * without a release, so the client remembers the last value it READ and [WorldEngineAdmission] consults that:
 *
 * - every decoded capabilities response is offered to [onCapabilities] (the content check and the update channel, AppGraph);
 * - a present `worldV2` replaces the cached value; an absent or malformed one (decoded as null) keeps it;
 * - a failed read never reaches [onCapabilities], so the cached value stands;
 * - nothing cached, or a store that cannot be read, is ON (the server's own default).
 *
 * Admission reads it once per World composition (`rememberWorldEngine`): a switch-off read while the World tab is open
 * takes effect at the next World visit or app start; a GL30 world already on screen is never torn down mid-visit.
 * Stored per API origin, like the app's other stores: a candidate's switch never answers for production.
 */
class WorldV2Switch(private val read: (String) -> String?, private val write: (String, String) -> Unit) {
    val enabled: Boolean get() = runCatching { read(KEY) }.getOrNull() != OFF

    fun onCapabilities(capabilities: NativeCapabilities) {
        val switch = capabilities.worldV2 ?: return
        runCatching { write(KEY, if (switch.enabled) ON else OFF) }
    }

    companion object {
        const val KEY = "enabled"
        const val ON = "1"
        const val OFF = "0"

        fun storeName(origin: String): String = storageNamespace(origin, "world-v2")

        /** The app's switch (SharedPreferences, application context). Writes are `apply()`: off the caller's thread. The
         *  preferences open on first use, inside the guarded read and write: nothing here can throw into a capabilities
         *  read (the content check and the update channel share it) or into the World tab's admission. */
        fun of(context: Context): WorldV2Switch {
            val app = context.applicationContext
            val prefs by lazy { app.getSharedPreferences(storeName(BuildConfig.API_ORIGIN), Context.MODE_PRIVATE) }
            return WorldV2Switch({ prefs.getString(it, null) }, { key, value -> prefs.edit().putString(key, value).apply() })
        }
    }
}
