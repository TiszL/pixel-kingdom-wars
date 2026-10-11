package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ResponseContractsTest {
    private fun obj(value:String)=Json.parseToJsonElement(value).jsonObject
    @Test fun `full login remains compatible without pending-only expiry`() {
        val full=obj("""{"wallet":"existing-wallet","entryPaid":true,"futureCapability":true}""")
        assertSame(full,validateResponseContract("/auth/verify","POST",full))
        val pending=obj("""{"wallet":"existing-wallet","loginRequired":true,"expiresAt":"2026-09-06T12:00:00Z"}""")
        assertSame(pending,validateResponseContract("/auth/login/verify","POST",pending))
    }
    @Test fun `pending sign-in cannot become a full session because its wallet or expiry is absent`() {
        assertThrows(ApiCompatibilityException::class.java) { validateResponseContract("/auth/login/status","GET",obj("""{"loginRequired":true}""")) }
        assertThrows(ApiCompatibilityException::class.java) { validateResponseContract("/auth/verify","POST",obj("""{"wallet":"existing-wallet","loginRequired":true}""")) }
    }
    @Test fun `base validation retains future fields and exact decimal balances`() {
        // Contract 13: production /base always carries the realm scenery context (D-128).
        val base=obj("""{"baseId":null,"visualContext":{"version":1,"realmId":"crownlands","artVersion":2},"player":{"wallet":"owner","shards":"9007199254740993123"},"claim":{"min":4},"buildings":[{"id":"keep","type":"keep","level":2,"tx":7,"ty":8,"underConstruction":false,"futureArt":"new"}],"jobs":[],"army":[],"freeBuilders":1,"future":{"balance":"9007199254740993123"}}""")
        val result=validateResponseContract("/base","GET",base)
        assertSame(base,result)
        assertEquals("9007199254740993123",result["player"]!!.jsonObject.string("shards"))
        assertEquals("new",result.objects("buildings").single().string("futureArt"))
        assertEquals(base["future"],result["future"])
    }
    @Test fun `a base without its realm scenery context is incompatible rather than silently drawn as Crownlands`() {
        val base=obj("""{"baseId":null,"player":{"wallet":"owner"},"claim":{"min":4},"buildings":[],"jobs":[],"army":[],"freeBuilders":1}""")
        val exception=assertThrows(ApiCompatibilityException::class.java) { validateResponseContract("/base","GET",base) }
        assertEquals("/base",exception.route)
    }
    @Test fun `incompatible base shape produces a controlled error without response data`() {
        val exception=assertThrows(ApiCompatibilityException::class.java) { validateResponseContract("/base","GET",obj("""{"secret":"must-not-appear"}""")) }
        assertFalse(exception.message.orEmpty().contains("must-not-appear"))
        assertEquals("/base",exception.route)
    }
    @Test fun `unstamped local server version allows null build time`() {
        val version=obj("""{"version":"0.0.0-dev","gitSha":"dev","builtAt":null,"simVersion":14}""")
        assertSame(version,validateResponseContract("/version","GET",version))
    }
    @Test fun `challenge must preserve the server nonce message and timestamp contract`() {
        val challenge=buildJsonObject { put("nonce","a".repeat(48));put("message","exact server message");put("expiresAt","2026-09-06T12:00:00Z") }
        assertSame(challenge,validateResponseContract("/auth/challenge","GET",challenge))
        assertThrows(ApiCompatibilityException::class.java) { validateResponseContract("/auth/challenge","GET",JsonObject(challenge-("message"))) }
    }
    @Test fun `uncovered endpoint fields stay opaque including decimal strings`() {
        val balances=obj("""{"KEEP":"999999999999999999999999","SHARDS":"1234"}""")
        assertSame(balances,validateResponseContract("/balances","GET",balances))
    }
}
