package gg.pixelkingdomwars.nativeclient.telemetry

import android.app.Application
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.network.EncryptedStore
import gg.pixelkingdomwars.nativeclient.network.storageNamespace

/** Anonymous, same-origin reporting: no game session, wallet SDK, Firebase or vendor SDK access. */
internal object NativeTelemetryRuntime {
    @Volatile private var telemetry: NativeTelemetry? = null
    @Synchronized fun start(application: Application, offline: Boolean) {
        if (offline || telemetry != null) return
        runCatching {
            val transport = NativeTelemetryTransport(BuildConfig.API_ORIGIN)
            val reporter = NativeTelemetry(EncryptedStore(application, storageNamespace(BuildConfig.API_ORIGIN, "native-telemetry")),
                TelemetryBuild(BuildConfig.NATIVE_BUILD_SHA, "${BuildConfig.VERSION_NAME}:${BuildConfig.VERSION_CODE}"), { true }, transport::send)
            telemetry = reporter
            Thread.getDefaultUncaughtExceptionHandler()?.let { previous ->
                Thread.setDefaultUncaughtExceptionHandler(telemetryCrashHandler({ reporter.record(NativeError.UNCAUGHT, it) }, previous))
            }
        }
    }
    fun record(error: NativeError, failure: Throwable? = null) { telemetry?.record(error, failure) }
    suspend fun flush() { telemetry?.flush() }
}
