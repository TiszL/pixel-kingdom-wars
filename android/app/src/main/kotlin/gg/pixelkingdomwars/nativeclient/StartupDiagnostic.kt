package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import kotlinx.coroutines.CancellationException

internal enum class StartupPhase {
    START, PREPARING_BUNDLE, READING_BUNDLE, RESTORING_CONTENT, CONTENT_READY,
    RESTORING_SESSION, LOGIN_STATUS_REQUEST, LOGIN_STATUS_RECEIVED,
    ACCOUNT_IDENTITY_REQUEST, ACCOUNT_IDENTITY_RECEIVED, ACCOUNT_READY, COMPLETE
}

/** The vocabulary is deliberately closed: no credentials, paths, URLs or exception text. */
internal fun startupFailureDiagnostic(phase:StartupPhase,error:Exception?):String = "${phase.name}:"+when(error) {
    null -> "INTERRUPTED"
    is SessionSupersededException -> "SESSION_SUPERSEDED"
    is CancellationException -> "CANCELLED"
    else -> "FAILED"
}
