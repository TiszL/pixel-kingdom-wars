package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.generated.*
import kotlinx.serialization.json.*
import java.io.IOException
import java.time.Instant

class ApiCompatibilityException(val route: String) : IOException(
    "The server response for $route requires a compatible native client. Update the app or retry after the server update."
)

private val contractJson = Json { ignoreUnknownKeys = true }

/** Validate the generated core contract, then preserve the original tree (including future fields
 * and exact decimal-string balances). Never echo auth payloads in a decoding failure. */
fun validateResponseContract(path: String, method: String, value: JsonObject): JsonObject {
    try {
        when ("$method $path") {
            "GET /version" -> contractJson.decodeFromJsonElement<VersionDto>(value)
            "GET /auth/challenge" -> contractJson.decodeFromJsonElement<AuthChallengeDto>(value).also {
                require(it.nonce.matches(Regex("[0-9a-f]{48}")) && it.message.isNotBlank())
                Instant.parse(it.expiresAt)
            }
            "GET /auth/login/status" -> contractJson.decodeFromJsonElement<LoginStatusDto>(value).also {
                require(!it.loginRequired || !it.wallet.isNullOrBlank())
            }
            "POST /auth/verify", "POST /auth/login/verify", "POST /auth/social" ->
                contractJson.decodeFromJsonElement<AuthSessionDto>(value).also {
                    require(it.wallet.isNotBlank())
                    if (it.loginRequired == true) Instant.parse(requireNotNull(it.expiresAt))
                    else require(it.entryPaid != null)
                }
            "GET /base" -> contractJson.decodeFromJsonElement<BaseDto>(value)
        }
    } catch (_: Exception) { throw ApiCompatibilityException(path) }
    return value
}
