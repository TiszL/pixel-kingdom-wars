package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val clansJson = Json { ignoreUnknownKeys = true }
@Serializable data class ClanMember(val wallet: String, val joinedAt: String, val name: String?, val keepLevel: Int, val trophies: Int, val seeker: Boolean) {
    init { require(wallet.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}"))); Instant.parse(joinedAt); require(keepLevel > 0 && trophies >= 0) }
}
@Serializable data class MyClan(val id: String, val name: String, val tag: String, val inviteMode: String, val leaderWallet: String,
    val inviteCode: String?, val roster: List<ClanMember>) {
    init { require(UUID.fromString(id).toString() == id.lowercase()); require(name.isNotBlank() && tag.isNotBlank()); require(inviteMode in setOf("open", "invite"))
        require(roster.map { it.wallet }.distinct().size == roster.size && roster.any { it.wallet == leaderWallet }) }
}
@Serializable data class ClanMembership(val clan: MyClan?) { companion object { fun from(raw: JsonObject): ClanMembership = clansJson.decodeFromJsonElement(raw) } }
@Serializable data class ClanRank(val id: String, val name: String, val tag: String, val inviteMode: String, val members: Int, val trophies: Int) {
    init { require(UUID.fromString(id).toString() == id.lowercase()); require(name.isNotBlank() && tag.isNotBlank()); require(inviteMode in setOf("open", "invite") && members >= 0 && trophies >= 0) }
}
@Serializable data class ClanBoard(val clans: List<ClanRank>) { init { require(clans.map { it.id }.distinct().size == clans.size) }; companion object { fun from(raw: JsonObject): ClanBoard = clansJson.decodeFromJsonElement(raw) } }
