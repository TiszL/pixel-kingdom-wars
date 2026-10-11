package gg.pixelkingdomwars.nativeclient.network

import okhttp3.HttpUrl.Companion.toHttpUrl
import java.security.MessageDigest

/** Preserve existing production storage names; local clients must never replay its cookies/receipts. */
fun storageNamespace(origin: String, name: String): String {
    val url = origin.toHttpUrl()
    require(url.isHttps && url.encodedPath == "/" && url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null)
    if(url == "https://play.pixelkingdomwars.com/".toHttpUrl()) return name
    val digest = MessageDigest.getInstance("SHA-256").digest(url.toString().toByteArray()).joinToString("") { "%02x".format(it) }
    return "$name-${digest.take(24)}"
}
