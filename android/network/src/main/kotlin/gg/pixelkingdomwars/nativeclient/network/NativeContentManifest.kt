package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import okhttp3.HttpUrl
import java.security.MessageDigest

data class NativeContentFile(val path: String, val sha256: String, val size: Long, val tier: String)
data class NativeContentManifest(val sourceCommit: String, val simVersion: Int, val contentVersion: String,
                                 val files: List<NativeContentFile>)

/** Identity matches tools/pack.mjs; metadata locations cannot redirect runtime reads to unhashed files. */
fun nativeContentManifest(value: JsonObject, supportedSimVersion: Int): NativeContentManifest {
    require(value["schemaVersion"]?.jsonPrimitive?.intOrNull == 1) { "Unsupported content format" }
    val commit = requireNotNull(value.string("sourceCommit"))
    val version = requireNotNull(value.string("contentVersion"))
    val sim = requireNotNull(value["simVersion"]?.jsonPrimitive?.intOrNull)
    require(commit.matches(Regex("[a-f0-9]{40}")) && version.matches(Regex("[a-f0-9]{64}")))
    require(sim == supportedSimVersion) { "This content requires a compatible app update" }
    val entries = requireNotNull(value["files"] as? JsonArray)
    require(entries.size in 1..20_000)
    var total = 0L
    var previous = ""
    val files = entries.map { item ->
        val entry = item.jsonObject
        val path = requireNotNull(entry.string("path"))
        require(path.split('/').all { it.matches(Regex("[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]*")) && it != "." && it != ".." })
        require(path > previous && path != "manifest.json") { "Duplicate or unordered content" }
        previous = path
        val size = requireNotNull(entry["size"]?.jsonPrimitive?.longOrNull)
        require(size >= 0 && size <= 512L * 1024 * 1024 - total) { "Content exceeds device installation budget" }
        total += size
        val hash = requireNotNull(entry.string("sha256"))
        val tier = requireNotNull(entry.string("tier"))
        require(hash.matches(Regex("[a-f0-9]{64}")) && tier in setOf("core","optional"))
        NativeContentFile(path,hash,size,tier)
    }
    val locations = mapOf("cataloguePath" to "catalogue.json", "renderCataloguePath" to "render-catalog.json",
        "atlasMetadataPath" to "atlas/meta.json", "contractPath" to "contracts.json", "kotlinModelsPath" to "kotlin/NativeContracts.kt")
    locations.forEach { (key,path) -> require(value.string(key) == path && files.any { it.path == path && it.tier == "core" }) }
    val identity = buildJsonObject {
        put("schemaVersion",1); put("sourceCommit",commit); put("simVersion",sim); put("files",entries)
    }.toString().toByteArray(Charsets.UTF_8)
    require(MessageDigest.getInstance("SHA-256").digest(identity).joinToString("") { "%02x".format(it) } == version) { "Content manifest identity mismatch" }
    return NativeContentManifest(commit,sim,version,files)
}

/** Content requests carry no session cookies and cannot follow an advertised URL to another host. */
fun sameOriginContentUrl(origin: HttpUrl, url: HttpUrl): HttpUrl {
    require(url.isHttps && url.host == origin.host && url.port == origin.port &&
        url.username.isEmpty() && url.password.isEmpty() && url.fragment == null && url.query == null) {
        "Content must be served by this game's trusted HTTPS origin"
    }
    return url
}
