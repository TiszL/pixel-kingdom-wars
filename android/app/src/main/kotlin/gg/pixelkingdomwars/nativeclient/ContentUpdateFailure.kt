package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import kotlinx.coroutines.CancellationException

internal enum class ContentUpdateStage { CAPABILITIES, MANIFEST_DOWNLOAD, MANIFEST_VALIDATION, ASSET_DOWNLOAD, INSTALL, COMPATIBILITY, RETAIN }
internal class ContentHttpFailure(val status: Int) : IOException("Content request failed")
internal class ContentUpdateFailure(val stage: ContentUpdateStage, cause: Exception) : IOException("Content update failed",cause)

/** Fixed diagnostic vocabulary only: never copy URLs, paths, response bodies or exception messages. */
internal fun contentUpdateDiagnostic(error: Exception): String {
    val stage=(error as? ContentUpdateFailure)?.stage ?: ContentUpdateStage.CAPABILITIES
    val cause=if(error is ContentUpdateFailure) error.cause else error
    val status=when(cause) { is ContentHttpFailure -> cause.status; is ApiException -> cause.status; else -> null }
    val reason=when {
        status != null && status in 100..599 -> "HTTP_$status"
        cause is IOException -> "IO"
        cause is IllegalArgumentException -> "INVALID_DATA"
        cause is IllegalStateException -> "INVALID_STATE"
        else -> "UNEXPECTED"
    }
    return "${stage.name}:$reason"
}

internal inline fun <T> contentUpdateStep(stage: ContentUpdateStage, block: () -> T): T = try { block() }
catch(e: CancellationException) { throw e }
catch(e: ContentUpdateFailure) { throw e }
catch(e: Exception) { throw ContentUpdateFailure(stage,e) }
