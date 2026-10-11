package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Public deed artwork carries no session cookies. The single fallback is scoped to its stable
 * asset when available, so two deeds held by one keeper cannot show each other's picture. */
class WorldDeedPreview(origin:String,transport:OkHttpClient=OkHttpClient()) {
    private val base=origin.toHttpUrl().newBuilder().encodedPath("/api/").build().also {require(it.isHttps)}
    private val client=transport.newBuilder().cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
        .callTimeout(20,TimeUnit.SECONDS).build()
    fun imageUrl(raw:String?):HttpUrl? {
        val text=raw?.trim()?.takeIf {it.isNotEmpty() && !it.startsWith("//")} ?: return null
        val url=text.toHttpUrlOrNull() ?: base.resolve(text.trimStart('/')) ?: return null
        return url.takeIf {it.isHttps && it.username.isEmpty() && it.password.isEmpty()}
    }
    fun fallback(wallet:String,assetId:String?):HttpUrl = base.newBuilder().apply {
        addPathSegment("deed")
        if(!assetId.isNullOrBlank()){addPathSegment("asset");addPathSegment("$assetId.png")} else addPathSegment("$wallet.png")
    }.build()
    /** A Core collection row names its own public artwork. Unlike a world deed preview,
     * cosmetics and DAS rows must never fall back to another wallet/deed image. */
    suspend fun loadImage(raw:String,valid:(ByteArray)->Boolean={true}):ByteArray {
        val bytes=read(requireNotNull(imageUrl(raw)) {"Asset artwork URL is unavailable"})
        require(valid(bytes)) {"Asset artwork is unavailable"}
        return bytes
    }
    suspend fun load(raw:String?,wallet:String,assetId:String?,valid:(ByteArray)->Boolean={true}):ByteArray {
        val fallback=fallback(wallet,assetId)
        val urls=listOfNotNull(imageUrl(raw),fallback).distinct()
        var failure:Exception?=null
        for(url in urls)try {
            val bytes=read(url)
            if(!valid(bytes))throw IOException("Deed preview is unavailable")
            return bytes
        } catch(error:kotlinx.coroutines.CancellationException){throw error}
        catch(error:Exception){failure=error}
        throw failure ?: IOException("Deed preview is unavailable")
    }
    private suspend fun read(url:HttpUrl):ByteArray=suspendCancellableCoroutine { continuation ->
        val call=client.newCall(Request.Builder().url(url).get().build())
        continuation.invokeOnCancellation {call.cancel()}
        call.enqueue(object:Callback {
            override fun onFailure(call:Call,e:IOException){if(continuation.isActive)continuation.resumeWithException(e)}
            override fun onResponse(call:Call,response:Response) {
                try {
                    val bytes=response.use {
                        if(!it.isSuccessful)throw IOException("Deed preview unavailable (${it.code})")
                        val body=it.body ?: throw IOException("Deed preview is empty")
                        if(body.contentType()?.type!="image")throw IOException("Deed preview is not an image")
                        val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(16*1024)
                        body.byteStream().use { input -> while(true) {
                            val count=input.read(buffer);if(count<0)break
                            if(output.size()+count>8*1024*1024)throw IOException("Deed preview is too large")
                            output.write(buffer,0,count)
                        } }
                        output.toByteArray()
                    }
                    if(continuation.isActive)continuation.resume(bytes)
                } catch(error:Exception){if(continuation.isActive)continuation.resumeWithException(error)}
            }
        })
    }
}
