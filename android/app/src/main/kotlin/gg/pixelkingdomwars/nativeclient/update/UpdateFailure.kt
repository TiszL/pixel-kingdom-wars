package gg.pixelkingdomwars.nativeclient.update

import android.content.Context
import gg.pixelkingdomwars.nativeclient.telemetry.NativeError

/** Typed update failures (M45 §5); each maps to exactly one closed telemetry code. */
enum class UpdateFailureKind(val telemetry: NativeError, val retryable: Boolean) {
    NETWORK(NativeError.UPDATE_FAILED_NETWORK, true),
    STORAGE(NativeError.UPDATE_FAILED_STORAGE, true),
    // The published file or its channel row is wrong: downloading it again cannot help.
    ORIGIN(NativeError.UPDATE_FAILED_ORIGIN, false),
    HASH(NativeError.UPDATE_FAILED_HASH, true),
    PACKAGE(NativeError.UPDATE_FAILED_PACKAGE, false),
    SIGNER(NativeError.UPDATE_FAILED_SIGNER, false),
    VERSION(NativeError.UPDATE_FAILED_VERSION, false),
    PERMISSION(NativeError.UPDATE_FAILED_PERMISSION, true),
    INSTALL(NativeError.UPDATE_FAILED_INSTALL, true),
}

/** A system screen the Activity starts (the install confirmation or the unknown-sources setting). Opaque so the
 * state machine and its JVM tests never construct an Android Intent. */
fun interface SystemPrompt { fun launch(context: Context) }

/** [telemetry] refines the kind's code where the platform said more (an install status); every value is one closed code. */
class UpdateFailure(val kind: UpdateFailureKind, message: String, val prompt: SystemPrompt? = null,
                    val telemetry: NativeError = kind.telemetry) : Exception(message)
