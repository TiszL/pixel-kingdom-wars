package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class EconomyTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun overview(extra: String = "") = json("""{"day":"2026-09-13","cycleEndsAt":"2026-09-14T00:00:00Z","dailyEmissionKeep":100,
        "totalShards":"20","myShards":"10","myShardBalance":"50","goldforgeLevel":1,"myDailyCapShards":"40",
        "claimable":{"totalKeep":"3","count":1,"nextExpiresAt":null}$extra}""")
    @Test fun `wallet RPC failures stay unavailable and large decimal balances remain exact`() {
        val funds = WalletFunds.from(json("""{"sol":null,"tokens":{"KEEP":9007199254740993,"USDC":null},"asOf":1720000000000}"""))
        assertNull(funds.sol); assertNull(funds.tokens["USDC"]); assertEquals("9007199254740993", funds.tokens["KEEP"])
        assertThrows(IllegalArgumentException::class.java) { WalletFunds.from(json("""{"sol":-1,"tokens":{},"asOf":1}""")) }
    }
    // Production sends only well-formed catalogue rows. For those the decoder must give exactly what it gave before extra
    // rows existed (the previous mapValues decoder is kept here as the reference), in the same order.
    @Test fun `a production wallet read decodes exactly as before`() {
        val raw = json("""{"sol":0.84,"tokens":{"KEEP":9007199254740993,"SKR":0,"USDC":null,"USDT":"12.5"},"asOf":1}""")
        val previous = raw.getValue("tokens").jsonObject.mapValues { (_, v) -> if (v is JsonNull) null else v.jsonPrimitive.content }
        val funds = WalletFunds.from(raw)
        assertEquals(WalletFunds("0.84", previous, 1), funds)
        assertEquals(previous.keys.toList(), funds.tokens.keys.toList())
    }
    // K-night-A5: the QA chain lane's server adds a game-cluster row (test SKR) after the catalogue rows. Any symbol decodes,
    // in server order. One unparsable amount used to fail the whole read, so the player lost SKR, KEEP and SOL with it; a bad
    // row now costs only itself. The envelope (the token table, SOL, asOf) stays strict.
    @Test fun `a malformed token row is skipped, not fatal, and any symbol decodes`() {
        val funds = WalletFunds.from(json("""{"sol":"0.84","tokens":{"KEEP":312.5,"tBAD":"abc","tNEG":-1,"tOBJ":{},"tARR":[],"tYES":true,
            "tSKR":1000,"tNULL":null},"asOf":1}"""))
        assertEquals(linkedMapOf("KEEP" to "312.5", "tSKR" to "1000", "tNULL" to null), funds.tokens)
        assertEquals(listOf("KEEP", "tSKR", "tNULL"), funds.tokens.keys.toList())
        assertEquals("0.84", funds.sol)
        assertThrows(IllegalArgumentException::class.java) { WalletFunds.from(json("""{"sol":null,"asOf":1}""")) }
        assertThrows(IllegalArgumentException::class.java) { WalletFunds.from(json("""{"sol":null,"tokens":{},"asOf":-1}""")) }
    }
    @Test fun `allocation cursor must identify the final row and dates must descend`() {
        fun page(days: String, next: String) = json("""{"days":$days,"nextBefore":$next,"totals":{"keepClaimed":"0","keepClaimable":"3","keepExpired":"0"}}""")
        val row = """{"day":"2026-09-11","shards":"10","keepPaid":"3","status":"claimable"}"""
        assertEquals("2026-09-11", ForgeAllocations.from(page("[$row]", "\"2026-09-11\"")).nextBefore)
        assertThrows(IllegalArgumentException::class.java) { ForgeAllocations.from(page("[$row]", "\"2026-09-12\"")) }
        assertThrows(IllegalArgumentException::class.java) { ForgeAllocations.from(page("[$row,$row]", "null")) }
    }
    @Test fun `withdrawal receipt display refuses contradictory net and fee`() {
        fun row(net: String) = json("""{"withdrawals":[{"id":"withdrawal-1","status":"sent","amount":"100","feeBurned":"5","netAmount":"$net","destination":"wallet","createdAt":"2026-09-11T00:00:00Z","refundable":false}]}""")
        assertEquals("95", WithdrawalRecord.list(row("95")).single().net)
        assertThrows(IllegalArgumentException::class.java) { WithdrawalRecord.list(row("96")) }
    }
    @Test fun `economy uses currency-separated current fields instead of mixed legacy flow aliases`() {
        val stats = json("""{"pool":{"emissionPool":"1","circulating":"2","withdrawalEscrow":"3","forgePayoutEscrow":"4"},
            "keepFlows":{"emittedToday":"5","recycledTotal":"6"},"onchain":{"deposited":"7","withdrawnNet":"8"},
            "shards":{"circulating":"9","forgeEscrow":"10","flows":{"minedToday":"11","issuedTotal":"12"}},"flows":{"minedToday":"999"}}""")
        val rows = EconomyTotals.from(stats).metrics
        assertEquals("11", rows.single { it.label == "Mined today" }.amount)
        assertEquals("SHARDS", rows.single { it.label == "Mined today" }.currency)
        assertEquals("KEEP", rows.single { it.label == "Emitted today" }.currency)
    }
    @Test fun `forge optional web details preserve older servers and unknown future relic identifiers`() {
        val old = ForgeOverview.from(overview())
        assertNull(old.softCapShards); assertNull(old.cycleEndsInSec); assertNull(old.yesterday); assertTrue(old.drops.isEmpty())
        val current = ForgeOverview.from(overview(""", "softCapShards":"9007199254740993","serverNow":"2026-09-13T23:59:57Z",
            "cycleEndsInSec":3,"maxDailyShareBps":3000,"drops":{"independentDropBps":{"future_relic":125,"shield":0}},
            "yesterday":{"shards":"12","keepPaid":"7","shardsRefunded":"1","itemDropped":"legacy_relic",
            "itemsDropped":["future_relic","shield"],"status":"future_status"},"unknown":{"future":true}"""))
        assertEquals("9007199254740993", current.softCapShards); assertEquals(3, current.cycleEndsInSec)
        assertEquals(125, current.drops["future_relic"]); assertEquals(listOf("future_relic", "shield"), current.yesterday!!.items)
        assertEquals("future_status", current.yesterday!!.status)
        val legacy = ForgeOverview.from(overview(""", "yesterday":{"shards":"12","keepPaid":"7","shardsRefunded":"1","itemDropped":"legacy_relic","status":"claimed"}"""))
        assertEquals(listOf("legacy_relic"), legacy.yesterday!!.items)
    }
    @Test fun `forge supplied malformed details cannot become a zero estimate or false successful drop`() {
        listOf(""", "softCapShards":0""", """, "cycleEndsInSec":-1""", """, "maxDailyShareBps":10001""",
            """, "drops":{"independentDropBps":{"relic":10001}}""", """, "drops":[]""",
            """, "yesterday":{"shards":"1","keepPaid":"2","shardsRefunded":"0","itemsDropped":[true],"status":"claimed"}""").forEach { extra ->
            assertTrue("Malformed detail was accepted: $extra", runCatching { ForgeOverview.from(overview(extra)) }.isFailure)
        }
    }
    @Test fun `allocation extra totals stay exact and unavailable values are not fabricated`() {
        val old = json("""{"days":[],"nextBefore":null,"totals":{"keepClaimed":"1","keepClaimable":"2","keepExpired":"3"}}""")
        assertNull(ForgeAllocations.from(old).shardsBurned); assertNull(ForgeAllocations.from(old).itemsWon)
        val raw = JsonObject(old + ("totals" to JsonObject(old["totals"]!!.jsonObject + mapOf("shardsBurned" to JsonPrimitive("9007199254740993"), "itemsWon" to JsonPrimitive(2)))))
        assertEquals("9007199254740993", ForgeAllocations.from(raw).shardsBurned); assertEquals(2, ForgeAllocations.from(raw).itemsWon)
        assertThrows(IllegalArgumentException::class.java) { ForgeAllocations.from(JsonObject(raw + ("totals" to JsonObject(raw["totals"]!!.jsonObject + ("itemsWon" to JsonPrimitive(-1)))))) }
    }
    @Test fun `global no-cycle response is distinct from a settled result and does not expose extra fields`() {
        val empty = ForgeGlobal.from(json("""{"day":null,"settled":false,"totalShards":"0","distributedKeep":"0","contributors":0,"rows":[],"nextCursor":null,"me":null,"days":[]}"""))
        assertNull(empty.day); assertFalse(empty.settled)
        val row = """{"rank":1,"walletShort":"Abcd…Efgh","name":"Kingdom","seeker":true,"shards":"9007199254740993","keepPaid":"20","unknown":"ignored"}"""
        val global = ForgeGlobal.from(json("""{"day":"2026-09-12","settled":true,"totalShards":"9007199254740993","distributedKeep":"20","contributors":1,"rows":[$row],"nextCursor":null,"me":$row,"days":["2026-09-12"]}"""))
        assertEquals("9007199254740993", global.rows.single().shards); assertEquals("Abcd…Efgh", global.me!!.walletShort)
    }
    @Test fun `global malformed ranks open cycles and invalid cursor shape are refused`() {
        val row = """{"rank":1,"walletShort":"Abcd…Efgh","name":"Kingdom","seeker":false,"shards":"10","keepPaid":"2"}"""
        val raw = """{"day":"2026-09-12","settled":true,"totalShards":"10","distributedKeep":"2","contributors":2,"rows":[$row],"nextCursor":null,"me":null,"days":["2026-09-12"]}"""
        listOf(raw.replace("\"settled\":true", "\"settled\":false"), raw.replace("\"rank\":1", "\"rank\":0"),
            raw.replace("\"nextCursor\":null", "\"nextCursor\":\"bad cursor\""), raw.replace("[$row]", "[$row,$row]"),
            raw.replace("Abcd…Efgh", "FULL_UNABBREVIATED_WALLET"), raw.replace("2026-09-12", "2026-02-30")).forEach {
            assertTrue("Malformed public Forge response was accepted", runCatching { ForgeGlobal.from(json(it)) }.isFailure)
        }
    }
}
