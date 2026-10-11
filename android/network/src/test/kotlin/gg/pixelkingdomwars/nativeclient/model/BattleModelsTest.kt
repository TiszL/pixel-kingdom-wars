package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** Deed directory capabilities, history rows and pending marches decode to the shapes the PvP screens act on. */
class BattleModelsTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test fun `the deed selector and the raid interlock follow the server's capabilities not the flag alone`() {
        val stable = BaseDirectory.from(json("""{"enabled":true,"worldId":"fantasy-v1","maxActive":5,"capabilities":{"baseScopedReads":true,"baseScopedMutations":true,"cellReservations":true},"bases":[{"id":"a","status":"active","keepLevel":3,"slot":1,"landPaidAt":"2026-09-01T00:00:00Z","fantasyLocation":{"realmId":"sunscar","tileId":42}},{"id":"b","status":"inactive","keepLevel":1,"slot":null}]}"""))
        assertTrue(stable.selectorAvailable); assertTrue(stable.stableMutations)
        assertEquals(listOf("a"), stable.activeBases.map { it.id }); assertEquals(listOf("b"), stable.inactiveBases.map { it.id })
        assertEquals("sunscar", stable.activeBases.single().fantasyRealmId); assertEquals("42", stable.activeBases.single().fantasyTileId)
        val readOnly = BaseDirectory.from(json("""{"enabled":true,"maxActive":5,"capabilities":{"baseScopedReads":true,"baseScopedMutations":false,"cellReservations":false},"bases":[]}"""))
        assertTrue(readOnly.selectorAvailable); assertFalse("Activation and the interlock need base-scoped mutations", readOnly.stableMutations)
        val legacy = BaseDirectory.from(json("""{"enabled":false,"maxActive":1,"bases":[]}"""))
        assertFalse(legacy.selectorAvailable)
    }
    @Test fun `a history row replays through the authority it was listed under and keeps exact settled text`() {
        val page = BattleHistory.from(json("""{"battles":[{"baseId":"deed-1","raidId":"r1","role":"defender","mode":"pvp","opponentLabel":null,"result":"defeat","stars":2,"destructionPct":63,"lootDeltaShards":"-9007199254740993","settledAmount":"-9007199254740993","settledCurrency":"SHARDS","lootRedacted":false,"opponent":{"baseId":"deed-9","wallet":"AttackerWallet","name":"Kane","seeker":true},"createdAt":"2026-09-10T10:00:00Z"}],"nextCursor":"abc"}"""))
        val row = page.battles.single()
        assertEquals("-9007199254740993", row.settledAmount); assertEquals("SHARDS", row.settledCurrency); assertEquals("63", row.destructionPct)
        assertEquals("/bases/deed-1/battles/r1/replay", row.replayPath)
        assertEquals("/battles/participated/r1/replay", row.copy(replayAccess = "participant").replayPath)
        assertEquals("abc", page.nextCursor); assertTrue(row.opponent!!.seeker)
    }
    @Test fun `pending marches keep the identity a resume or history continuation needs`() {
        val pending = PendingMarches.from(json("""{"raids":[{"id":"r1","attackerBaseId":"deed","defenderWallet":"w","defenderBaseId":"enemy","campaignStage":null,"simVersion":14,"ordersDeadlineAt":"2026-09-11T00:00:30Z","snapshot":{},"armySnapshot":{}}]}"""))
        val march = pending.raids.single()
        assertEquals("enemy", march.defenderBaseId); assertNull(march.campaignStage); assertEquals(14, march.simVersion)
    }
    @Test fun `a scout report needs the server's preview window and keep level and keeps trophies as text`() {
        val report = ScoutReport.from(json("""{"wallet":"w","name":"Kane","keepLevel":7,"trophies":1234,"previewSec":30,"buildings":[],"obstacles":[],"claimMin":8,"claimMax":22,"visualContext":{"version":1,"realmId":"sunscar","artVersion":2}}"""))
        assertEquals("Kane", report.name); assertEquals(7, report.keepLevel); assertEquals("1234", report.trophies); assertEquals(30, report.previewSec)
        assertEquals("sunscar", report.head.visualContext!!.realmId)
        assertThrows(IllegalArgumentException::class.java) { ScoutReport.from(json("""{"name":"x","keepLevel":1,"trophies":0}""")) }
    }
}
