package gg.pixelkingdomwars.nativeclient.network

import okhttp3.*
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.*
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class ApiConnectionsTest {
    @Test fun `lost order response sends exactly one POST even on a reusable connection`() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("warm"))
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setBody("must not replay"))
            server.start()
            val transport=ApiConnections(OkHttpClient.Builder().retryOnConnectionFailure(false).callTimeout(5,TimeUnit.SECONDS).build())
            transport.newCall(Request.Builder().url(server.url("/warm")).build()).execute().close()
            assertThrows(IOException::class.java) {
                transport.newCall(Request.Builder().url(server.url("/order")).post("{}".toRequestBody()).build()).execute().close()
            }
            assertEquals(2,server.requestCount)
            assertEquals("GET",server.takeRequest().method);assertEquals("POST",server.takeRequest().method)
        }
    }
    @Test fun `an interrupted read on a reused connection can recover without manual refresh`() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("warm"))
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setBody("authoritative state"))
            server.start()
            val transport=ApiConnections(OkHttpClient.Builder().retryOnConnectionFailure(false).callTimeout(5,TimeUnit.SECONDS).build())
            transport.newCall(Request.Builder().url(server.url("/warm")).build()).execute().close()
            transport.newCall(Request.Builder().url(server.url("/base")).build()).execute().use { assertEquals("authoritative state",it.body!!.string()) }
            assertEquals(3,server.requestCount)
        }
    }

    /** Cold-start measurement 2026-10-06 (QA chain lane): BOOT_HOME at 2.6 s, the Home's GET /base answered at 17 s. OkHttp
     *  runs at most 5 async calls per host; the raid-events stream holds one while open and the lane's Phase E reads answer
     *  503 only after seconds, so the Home read could queue behind them. A Home read must never wait for an optional read. */
    @Test fun `a Home read is never queued behind slow optional reads`() {
        MockWebServer().use { server ->
            server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse =
                    if (homeCriticalRead(request.requestUrl!!.encodedPath)) MockResponse().setBody("{}")
                    else MockResponse().setHeadersDelay(3, TimeUnit.SECONDS).setResponseCode(503).setBody("{}")
            }
            server.start()
            val transport = ApiConnections(OkHttpClient.Builder().retryOnConnectionFailure(false).callTimeout(10, TimeUnit.SECONDS).build())
            val optional = CountDownLatch(6)
            fun done(latch: CountDownLatch) = object : Callback {
                override fun onFailure(call: Call, e: IOException) = latch.countDown()
                override fun onResponse(call: Call, response: Response) { response.close(); latch.countDown() }
            }
            // More slow optional reads than the per-host limit: every shared slot is taken and one more waits.
            for (path in listOf("/api/vehicles/fleet", "/api/vehicles/client/assets", "/api/starter-fleet", "/api/seeker/auctions/current",
                "/api/devnet-faucet/skr/status", "/api/quests"))
                transport.newCall(Request.Builder().url(server.url(path)).build()).enqueue(done(optional))
            val home = CountDownLatch(3)
            for (path in listOf("/api/base?baseId=b", "/api/balances?baseId=b", "/api/tutorial?baseId=b"))
                transport.newCall(Request.Builder().url(server.url(path)).build()).enqueue(done(home))
            assertTrue("the Home read answers while every optional read is still held", home.await(1500, TimeUnit.MILLISECONDS))
            assertEquals("no optional read had answered yet", 6L, optional.count)
            assertTrue(optional.await(10, TimeUnit.SECONDS))
        }
    }

    @Test fun `only the reads the opening Home and sign-in wait for are critical, by exact path`() {
        for (path in listOf("/api/base", "/api/balances", "/api/tutorial", "/api/me", "/api/bases", "/api/auth/login/status",
            "/api/playtest/access", "/api/native/capabilities")) assertTrue(path, homeCriticalRead(path))
        for (path in listOf("/api/base/buildings/receipt", "/api/starter-fleet", "/api/vehicles/fleet", "/api/vehicles/client/assets",
            "/api/bases/b/raid-events", "/api/bases/b/active-raid", "/api/rpc/solana", "/api/seeker/auctions/current", "/api/quests"))
            assertFalse(path, homeCriticalRead(path))
    }
}
