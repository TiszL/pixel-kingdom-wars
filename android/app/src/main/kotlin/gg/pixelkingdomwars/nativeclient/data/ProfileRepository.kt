package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.io.InputStream

data class PlayerProfile(val wallet: String, val name: String?, val avatarUrl: String?, val avatarUpdatedAt: String?, val cooldownDays: Int) {
    companion object {
        fun from(raw: JsonObject) = PlayerProfile(requireNotNull(raw.string("wallet")), raw.string("name"), raw.string("avatarUrl"),
            raw.string("avatarUpdatedAt"), requireNotNull(raw.string("nameCooldownDays")?.toIntOrNull()).also { require(it >= 0) })
    }
}
data class NameAvailability(val input: String, val normalized: String, val available: Boolean, val reason: String?)
data class ProfileState(val profile: PlayerProfile? = null, val availability: NameAvailability? = null, val needsRefresh: Boolean = false)
data class ProfileBounds(val maxUploadBytes: Int, val maxImageBytes: Int, val imageSize: Int, val renameCooldownDays: Int) {
    companion object {
        fun from(catalogue: JsonObject?): ProfileBounds {
            val constants = requireNotNull(catalogue?.get("constants") as? JsonObject) { "Profile rules are not loaded" }
            val avatar = constants["PROFILE_AVATAR"]!!.jsonObject
            val names = constants["USERNAMES"]!!.jsonObject
            fun number(obj: JsonObject, key: String) = requireNotNull(obj.string(key)?.toIntOrNull()).also { require(it > 0) }
            return ProfileBounds(number(avatar, "maxUploadBytes"), number(avatar, "maxNormalizedBytes"), number(avatar, "outputSizePx"), number(names, "changeCooldownDays"))
        }
    }
}

/** Account identity only: selling/switching a deed cannot redirect a profile write. A failed
 * mutation requires a new GET before another write; no automatic replay or success inference. */
class LiveProfileRepository(private val api: ApiClient, private val wallet: String, private val requireCurrent: () -> Unit,
                            private val refreshIdentity: suspend () -> Unit) {
    private val mutable = MutableStateFlow(ProfileState())
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    suspend fun refresh() = admission.withLock { refreshCurrent() }
    private suspend fun refreshCurrent() {
        requireCurrent()
        val profile = PlayerProfile.from(api.get("/me"))
        requireCurrent(); require(profile.wallet == wallet) { "Profile belongs to another account" }
        mutable.value = ProfileState(profile = profile)
    }
    suspend fun checkName(input: String) = admission.withLock {
        requireCurrent()
        val raw = api.get("/username/check", mapOf("name" to input))
        requireCurrent()
        val available = requireNotNull((raw["available"] as? JsonPrimitive)?.booleanOrNull)
        mutable.update { it.copy(availability = NameAvailability(input, requireNotNull(raw.string("normalized")), available, raw.string("reason"))) }
    }
    suspend fun rename(input: String) = mutate {
        val checked = mutable.value.availability
        require(checked?.input == input && checked.available) { "Check this name's availability first" }
        val raw = api.patch("/me", jsonBody("name" to input))
        require(raw.string("wallet") == wallet && raw.string("name") == checked.normalized) { "Unexpected profile response" }
    }
    suspend fun upload(bytes: ByteArray, contentType: String, bounds: ProfileBounds) = mutate {
        require(bytes.isNotEmpty() && bytes.size <= bounds.maxUploadBytes) { "Choose an image within the upload limit" }
        api.upload("/me/avatar", "PATCH", bytes, contentType)
    }
    suspend fun clearAvatar() = mutate { api.delete("/me/avatar") }
    private suspend fun mutate(action: suspend () -> Unit) = admission.withLock {
        requireCurrent()
        check(mutable.value.profile != null && !mutable.value.needsRefresh) { "Reload your current profile before making another change" }
        mutable.update { it.copy(needsRefresh = true) }
        try {
            action(); requireCurrent()
            refreshIdentity(); requireCurrent()
            refreshCurrent()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { requireCurrent(); throw error }
    }
}

/** Bounds a picker/provider stream before an image decoder or HTTP transport receives it. */
internal fun readProfileImage(input: InputStream, limit: Int, checkActive: () -> Unit = {}): ByteArray {
    require(limit > 0)
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
        checkActive()
        val count = input.read(buffer)
        if (count < 0) break
        require(count <= limit - output.size()) { "Selected image exceeds the upload limit" }
        output.write(buffer, 0, count)
    }
    require(output.size() > 0) { "Selected image is empty" }
    return output.toByteArray()
}
