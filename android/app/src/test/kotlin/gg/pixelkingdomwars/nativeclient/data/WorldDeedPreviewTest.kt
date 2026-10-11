package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class WorldDeedPreviewTest {
    private fun fixture(block:suspend (MockWebServer,WorldDeedPreview)->Unit)=runBlocking {
        val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server=MockWebServer().apply{useHttps(tls.sslSocketFactory(),false);start()}
        val client=OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).cookieJar(object:CookieJar{
            override fun saveFromResponse(url:HttpUrl,cookies:List<Cookie>){}
            override fun loadForRequest(url:HttpUrl)=listOf(Cookie.Builder().name("session").value("private").domain(url.host).build())
        }).build()
        try{block(server,WorldDeedPreview(server.url("/").toString(),client))}finally{server.shutdown()}
    }
    @Test fun `canonical relative images remain under api prefix and unsafe URL schemes are refused`()=fixture {server,preview->
        assertEquals(server.url("/api/deed/asset/a.png"),preview.imageUrl("/deed/asset/a.png"))
        for(url in listOf("//other.test/a.png","http://other.test/a.png","javascript:alert(1)","https://user:password@other.test/a.png"))assertNull(preview.imageUrl(url))
    }
    @Test fun `failed canonical image falls back once to the selected stable asset without cookies`()=fixture {server,preview->
        server.enqueue(MockResponse().setResponseCode(404));server.enqueue(MockResponse().setHeader("Content-Type","image/png").setBody("pixels"))
        assertEquals("pixels",preview.load("https://localhost:${server.port}/missing.png","owner","deed-two").decodeToString())
        assertEquals("/missing.png",server.takeRequest().path)
        val fallback=server.takeRequest();assertEquals("/api/deed/asset/deed-two.png",fallback.path);assertNull(fallback.getHeader("Cookie"));assertEquals(2,server.requestCount)
    }
    @Test fun `malformed image falls back once then remains unavailable without an endless retry`()=fixture {server,preview->
        repeat(2){server.enqueue(MockResponse().setHeader("Content-Type","image/png").setBody("bad"))}
        try {preview.load("/canonical.png","owner",null){false};fail("invalid image must not publish")}catch(_:java.io.IOException){}
        assertEquals("/api/canonical.png",server.takeRequest().path);assertEquals("/api/deed/owner.png",server.takeRequest().path);assertEquals(2,server.requestCount)
    }
    @Test fun `leaving inspector cancels an in flight image without starting its fallback`()=fixture {server,preview->
        server.enqueue(MockResponse().setHeader("Content-Type","image/png").setBody("pixels").setBodyDelay(4,TimeUnit.SECONDS))
        coroutineScope {
            val job=launch{preview.load("/canonical.png","owner","asset")}
            withContext(Dispatchers.IO){assertNotNull(server.takeRequest(2,TimeUnit.SECONDS))}
            withTimeout(1_000){job.cancelAndJoin()}
        }
        assertEquals(1,server.requestCount)
    }
    @Test fun `Core artwork reads the exact public URL without cookies or a wallet deed fallback`()=fixture {server,preview->
        server.enqueue(MockResponse().setHeader("Content-Type","image/png").setBody("pixels"))
        assertEquals("pixels",preview.loadImage(server.url("/core/cosmetic.png").toString()).decodeToString())
        val request=server.takeRequest();assertEquals("/core/cosmetic.png",request.path);assertNull(request.getHeader("Cookie"))
        server.enqueue(MockResponse().setResponseCode(404))
        assertTrue(runCatching{preview.loadImage(server.url("/core/missing.png").toString())}.isFailure)
        assertEquals(2,server.requestCount)
    }
    @Test fun `Core artwork refuses redirects invalid decoded dimensions and oversized bodies`()=fixture {server,preview->
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location",server.url("/redirect.png")))
        assertTrue(runCatching{preview.loadImage(server.url("/core.png").toString())}.isFailure)
        server.enqueue(MockResponse().setHeader("Content-Type","image/png").setBody("invalid"))
        assertTrue(runCatching{preview.loadImage(server.url("/core.png").toString()){false}}.isFailure)
        server.enqueue(MockResponse().setHeader("Content-Type","image/png").setBody(okio.Buffer().write(ByteArray(8*1024*1024+1))))
        assertTrue(runCatching{preview.loadImage(server.url("/core.png").toString())}.isFailure)
        assertEquals(3,server.requestCount)
    }
}
