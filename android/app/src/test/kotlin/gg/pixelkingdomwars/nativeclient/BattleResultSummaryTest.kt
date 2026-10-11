package gg.pixelkingdomwars.nativeclient

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BattleResultSummaryTest {
    private fun read(json:String)=BattleResultSummary.read(Json.parseToJsonElement(json).jsonObject)

    @Test fun `zero loot is a confirmed value while absent historical loot stays unknown`() {
        assertEquals("0",read("""{"lootShards":0}""").lootShards)
        assertNull(read("{}").lootShards)
        assertNull(read("""{"lootShards":null}""").lootShards)
    }

    @Test fun `large wire amounts never round through floating point`() {
        val amount="900719925474099312345678901234567890"
        assertEquals(amount,read("""{"lootShards":"$amount"}""").lootShards)
        assertEquals(amount,read("""{"lootShards":$amount}""").lootShards)
    }

    @Test fun `transferred deed redaction takes precedence over an accidentally retained amount`() {
        val result=read("""{"lootShards":777,"lootRedacted":true}""")
        assertTrue(result.lootRedacted)
        assertNull(result.lootShards)
    }

    @Test fun `restored server result retains exact reward and retreat details`() {
        val original=Json.parseToJsonElement("""{"stars":2,"destructionPct":71.25,"lootShards":321,"attackerTrophyDelta":-7,"retreated":true}""").jsonObject
        val restored=Json.parseToJsonElement(original.toString()).jsonObject
        assertEquals(BattleResultSummary.read(original),BattleResultSummary.read(restored))
        assertEquals("321",BattleResultSummary.read(restored).lootShards)
        assertEquals("-7",BattleResultSummary.read(restored).trophyDelta)
        assertTrue(BattleResultSummary.read(restored).retreated)
    }

    @Test fun `malformed rewards are unavailable rather than substituted from stars`() {
        for(value in listOf("-1","true","{}","[]","\"unknown\"","1.5")) {
            assertNull(read("""{"stars":3,"destructionPct":100,"lootShards":$value}""").lootShards)
        }
        assertEquals("19",read("""{"lootShards":"19","futureCompatibleField":{}}""").lootShards)
    }

    @Test fun `the verdict is a victory only with a star and the keep fall is read from the result`() {
        val won = BattleResultSummary.read(kotlinx.serialization.json.Json.parseToJsonElement("""{"stars":1,"destructionPct":52,"keepDestroyed":true,"lootShards":40,"attackerTrophyDelta":12}""").jsonObject)
        assertTrue(won.won); assertTrue(won.keepDestroyed)
        val lost = BattleResultSummary.read(kotlinx.serialization.json.Json.parseToJsonElement("""{"stars":0,"destructionPct":49,"keepDestroyed":false,"lootShards":0,"attackerTrophyDelta":-8,"retreated":true}""").jsonObject)
        assertFalse(lost.won); assertTrue(lost.retreated); assertEquals("-8", lost.trophyDelta)
    }
}
