package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** D153.285/.286 and Beacon718d2c50: optional server rewards never recalculate
 * locally or make an otherwise valid legacy overview undecodable. */
class LeagueOverviewV2Test {
    private val base = "10000000-0000-4000-8000-000000000001"
    private val otherBase = "20000000-0000-4000-8000-000000000002"
    private val wallet = "11111111111111111111111111111111"
    private val exact = "18446744073709551615"

    private fun legacy(): JsonObject = Json.parseToJsonElement("""{
      "week":{"startsAt":"2026-09-28T00:00:00Z","closesAt":"2026-10-05T00:00:00Z","settlesAt":"2026-10-05T00:15:00Z"},
      "rewards":{"status":"active","firstSettlementAt":"2026-09-14T00:15:00Z","minRatedAttacks":3,"maxRewardedBasesPerWallet":1},
      "trophyModel":"cumulative",
      "you":{"baseId":"$base","trophies":3500,"tier":"sol","currentWeekRatedAttacks":4,"participationMet":true,"rewardCandidate":true,"blockedByHigherBase":false},
      "board":[{"rank":1,"baseId":"$base","name":"Selected","trophies":3500,"tier":"sol","you":true}],
      "lastSettlement":{"week":"2026-09-21","tier":"gold","trophies":100,"keepLevel":7,"cacheShards":"9007199254740993","items":[{"itemId":"keg_of_haste","qty":1}],"settledAt":"2026-09-28T00:15:00Z"}
    }""").jsonObject

    private fun JsonObject.with(key: String, value: JsonElement): JsonObject = JsonObject(this + (key to value))
    private fun JsonObject.child(key: String, block: (JsonObject) -> JsonObject): JsonObject = with(key, block(getValue(key).jsonObject))
    private fun pack(): JsonArray = buildJsonArray {
        add(buildJsonObject { put("resourceId", "rough_prism"); put("qty", "9007199254740993") })
        add(buildJsonObject { put("resourceId", "frost_quartz"); put("qty", "1") })
    }
    private fun reward(): JsonObject = buildJsonObject { put("shards", exact); put("gems", "0"); put("pack", pack()) }
    private fun entitlement(): JsonObject = buildJsonObject {
        put("week", "2026-09-21"); put("amountRaw", exact); put("baseId", otherBase); put("wallet", wallet)
        put("decimals", 9); put("place", 11); put("band", 2); put("weeklyScore", 17); put("payoutStatus", "not_implemented")
    }
    private fun skr(): JsonObject = buildJsonObject {
        put("status", "payout_deferred"); put("mint", wallet); put("label", "Devnet test SKR, not official SKR")
        put("entitlement", entitlement())
    }
    private fun weeklyRow(id: String, score: Int): JsonObject = buildJsonObject {
        put("baseId", id); put("name", JsonNull); put("weeklyScore", score); put("trophies", 3500)
    }
    private fun v2(): JsonObject = legacy().with("ladderVersion", JsonPrimitive(2))
        .child("you") { it.with("tierV2", JsonPrimitive("diamond")).with("rewardV2", reward()).with("weeklyScore", JsonPrimitive(-3)) }
        .with("board", JsonArray(legacy().getValue("board").jsonArray.map { it.jsonObject.with("tierV2", JsonPrimitive("diamond")) }))
        .child("lastSettlement") { it.with("tierV2", JsonPrimitive("silver")).with("gems", JsonPrimitive("9007199254740993")).with("pack", pack()) }
        .with("weeklyBoard", JsonArray(listOf(weeklyRow(otherBase, 19), weeklyRow(base, 0))))
        .with("skr", skr())
    private fun decode(raw: JsonObject = v2()) = LeagueOverview.from(raw)

    @Test fun legacyOverviewKeepsItsRequiredFieldsAndHasNoInventedV2Values() {
        val parsed = decode(legacy())
        assertEquals(LeaguePresentationMode.LEGACY, parsed.presentationMode)
        assertEquals("sol", parsed.you!!.tier); assertEquals(3500, parsed.you.trophies)
        assertNull(parsed.ladderVersion); assertNull(parsed.you.tierV2); assertNull(parsed.you.rewardV2)
        assertNull(parsed.you.weeklyScore); assertNull(parsed.board.single().tierV2)
        assertNull(parsed.lastSettlement!!.tierV2); assertNull(parsed.lastSettlement.gems); assertNull(parsed.lastSettlement.pack)
        assertNull(parsed.weeklyBoard); assertNull(parsed.skr)
        assertEquals("9007199254740993", parsed.lastSettlement.cacheShards)
        assertEquals("keg_of_haste", parsed.lastSettlement.items.single().itemId)
    }

    @Test fun completeV2PreservesExactServerAmountsAndEveryAdditiveField() {
        val parsed = decode()
        assertEquals(LeaguePresentationMode.V2, parsed.presentationMode)
        assertEquals(2, parsed.ladderVersion); assertEquals("sol", parsed.you!!.tier)
        assertEquals("diamond", parsed.you.tierV2); assertEquals("diamond", parsed.board.single().tierV2)
        assertEquals(LeagueRewardV2(exact, "0", listOf(LeaguePackLine("rough_prism", "9007199254740993"), LeaguePackLine("frost_quartz", "1"))), parsed.you.rewardV2)
        assertEquals("silver", parsed.lastSettlement!!.tierV2); assertEquals("9007199254740993", parsed.lastSettlement.gems)
        assertEquals(parsed.you.rewardV2!!.pack, parsed.lastSettlement.pack)
    }

    @Test fun allSevenV2TierIdentitiesCoexistWithTheFourLegacyIdentities() {
        for (tier in listOf("bronze", "silver", "gold", "platinum", "diamond", "solana", "seeker")) {
            val parsed = decode(v2().child("you") { it.with("tierV2", JsonPrimitive(tier)) })
            assertEquals(tier, parsed.you!!.tierV2); assertEquals("sol", parsed.you.tier)
        }
        for (tier in listOf("bronze", "silver", "gold", "sol")) {
            assertEquals(tier, decode(legacy().child("you") { it.with("tier", JsonPrimitive(tier)) }).you!!.tier)
        }
    }

    @Test fun unknownOrMalformedOptionalTiersDropOnlyTheAffectedTier() {
        for (bad in listOf(JsonPrimitive("mythic"), JsonPrimitive("sol"), JsonPrimitive(7), JsonNull, JsonArray(emptyList()))) {
            val raw = v2().child("you") { it.with("tierV2", bad) }
                .with("board", JsonArray(v2().getValue("board").jsonArray.map { it.jsonObject.with("tierV2", bad) }))
                .child("lastSettlement") { it.with("tierV2", bad) }
            val parsed = decode(raw)
            assertNull(parsed.you!!.tierV2); assertNull(parsed.board.single().tierV2); assertNull(parsed.lastSettlement!!.tierV2)
            assertNotNull(parsed.you.rewardV2); assertNotNull(parsed.lastSettlement.pack); assertNotNull(parsed.skr)
        }
    }

    @Test fun malformedRewardAmountDropsOnlyTheOptionalRewardObject() {
        for (key in listOf("shards", "gems")) for (bad in listOf(JsonPrimitive(-1), JsonPrimitive("-1"), JsonPrimitive("01"),
            JsonPrimitive("1.5"), JsonPrimitive("1e3"), JsonPrimitive(" 1"), JsonPrimitive(""), JsonNull, JsonPrimitive(true))) {
            val parsed = decode(v2().child("you") { it.with("rewardV2", reward().with(key, bad)) })
            assertNull(parsed.you!!.rewardV2); assertEquals("diamond", parsed.you.tierV2)
            assertEquals(-3, parsed.you.weeklyScore); assertNotNull(parsed.lastSettlement!!.pack)
        }
    }

    @Test fun malformedSettlementAmountsAreIndependentOfPackAndRequiredShards() {
        for (bad in listOf(JsonPrimitive(3), JsonPrimitive("-1"), JsonPrimitive("001"), JsonPrimitive("2.5"), JsonNull)) {
            val parsed = decode(v2().child("lastSettlement") { it.with("gems", bad) })
            assertNull(parsed.lastSettlement!!.gems); assertNotNull(parsed.lastSettlement.pack)
            assertEquals("9007199254740993", parsed.lastSettlement.cacheShards)
        }
    }

    @Test fun packRejectsUnknownResourcesDuplicatesAndNonpositiveOrNoncanonicalQuantitiesAsOneField() {
        val line = pack()[0].jsonObject
        val badPacks = listOf<JsonElement>(JsonNull, JsonPrimitive("pack"), JsonArray(listOf(line, line)),
            JsonArray(listOf(line.with("resourceId", JsonPrimitive("crystal_fragment")))),
            JsonArray(listOf(line.with("resourceId", JsonPrimitive("unknown_raw"))))) +
            listOf(JsonPrimitive("0"), JsonPrimitive("-1"), JsonPrimitive("01"), JsonPrimitive(1), JsonPrimitive("1.1"), JsonNull)
                .map { JsonArray(listOf(line.with("qty", it))) }
        for (bad in badPacks) {
            val parsed = decode(v2().child("lastSettlement") { it.with("pack", bad) })
            assertNull(parsed.lastSettlement!!.pack); assertEquals("9007199254740993", parsed.lastSettlement.gems)
            assertNotNull(parsed.you!!.rewardV2)
            assertNull(decode(v2().child("you") { it.with("rewardV2", reward().with("pack", bad)) }).you!!.rewardV2)
        }
    }

    @Test fun emptyPackAndZeroAmountsRemainValidServerValues() {
        val zeroReward = reward().with("shards", JsonPrimitive("0")).with("pack", JsonArray(emptyList()))
        val parsed = decode(v2().child("you") { it.with("rewardV2", zeroReward) }
            .child("lastSettlement") { it.with("gems", JsonPrimitive("0")).with("pack", JsonArray(emptyList())) })
        assertEquals(LeagueRewardV2("0", "0", emptyList()), parsed.you!!.rewardV2)
        assertEquals("0", parsed.lastSettlement!!.gems); assertEquals(emptyList<LeaguePackLine>(), parsed.lastSettlement.pack)
    }

    @Test fun weeklyScoresPreserveNegativeZeroAndAbsentWithoutComputingFromTrophies() {
        assertEquals(-3, decode().you!!.weeklyScore)
        assertEquals(0, decode(v2().child("you") { it.with("weeklyScore", JsonPrimitive(0)) }).you!!.weeklyScore)
        assertNull(decode(legacy()).you!!.weeklyScore)
        val rows = decode().weeklyBoard!!
        assertEquals(listOf(otherBase, base), rows.map { it.baseId }); assertEquals(listOf(19, 0), rows.map { it.weeklyScore })
        assertNull(rows.first().name); assertEquals(3500, rows.first().trophies)
        assertEquals(-19, decode(v2().with("weeklyBoard", JsonArray(listOf(weeklyRow(base, -19))))).weeklyBoard!!.single().weeklyScore)
    }

    @Test fun malformedWeeklyScoreDropsOnlyScore() {
        for (bad in listOf(JsonPrimitive("3"), JsonPrimitive(1.5), JsonPrimitive(2147483648L), JsonNull, JsonPrimitive(true))) {
            val parsed = decode(v2().child("you") { it.with("weeklyScore", bad) })
            assertNull(parsed.you!!.weeklyScore); assertNotNull(parsed.you.rewardV2); assertNotNull(parsed.weeklyBoard)
        }
    }

    @Test fun malformedWeeklyBoardDropsTheWholeOptionalBoardWithoutReorderingOrRepairingRows() {
        val row = weeklyRow(base, 7)
        for (bad in listOf<JsonElement>(JsonPrimitive("board"), JsonArray(listOf(row, row)),
            JsonArray(listOf(row.with("baseId", JsonPrimitive("not-a-base")))),
            JsonArray(listOf(row.with("weeklyScore", JsonPrimitive("7")))),
            JsonArray(listOf(row.with("trophies", JsonPrimitive(-1)))))) {
            val parsed = decode(v2().with("weeklyBoard", bad))
            assertNull(parsed.weeklyBoard); assertEquals(base, parsed.board.single().baseId); assertEquals(-3, parsed.you!!.weeklyScore)
        }
        assertEquals(emptyList<LeagueWeeklyRank>(), decode(v2().with("weeklyBoard", JsonArray(emptyList()))).weeklyBoard)
    }

    @Test fun walletSkrAllocationIsDeferredAndMayBelongToAnotherBase() {
        val parsed = decode(); val allocation = parsed.skr!!; val entry = allocation.entitlement!!
        assertEquals("payout_deferred", allocation.status); assertEquals(wallet, allocation.mint)
        assertEquals("Devnet test SKR, not official SKR", allocation.label)
        assertEquals(LeagueSkrEntitlement("2026-09-21", exact, otherBase, wallet, 9, 11, 2, 17, "not_implemented"), entry)
        assertNotEquals(parsed.you!!.baseId, entry.baseId)
    }

    @Test fun disabledAndUnallocatedSkrRemainDistinctFromMissingSkr() {
        val disabled = decode(v2().with("skr", buildJsonObject { put("status", "disabled"); put("entitlement", JsonNull) })).skr!!
        assertEquals("disabled", disabled.status); assertNull(disabled.entitlement); assertNull(disabled.mint)
        assertNull(decode(v2().child("skr") { it.with("entitlement", JsonNull) }).skr!!.entitlement)
        assertEquals("payout_deferred", decode(v2().child("skr") { it.with("entitlement", JsonNull) }).skr!!.status)
        assertNull(decode(legacy()).skr)
    }

    @Test fun malformedSkrEntitlementDropsOnlyEntitlementWithoutClaimingPayment() {
        val defects = listOf("amountRaw" to JsonPrimitive("01"), "amountRaw" to JsonPrimitive("18446744073709551616"),
            "amountRaw" to JsonPrimitive(7), "baseId" to JsonPrimitive("bad"), "wallet" to JsonPrimitive("bad"),
            "week" to JsonPrimitive("2026-02-30"), "decimals" to JsonPrimitive(-1), "decimals" to JsonPrimitive(20),
            "decimals" to JsonPrimitive("9"), "place" to JsonPrimitive(0), "band" to JsonPrimitive(4),
            "weeklyScore" to JsonPrimitive(0), "payoutStatus" to JsonPrimitive("paid"))
        for ((key, bad) in defects) {
            val parsed = decode(v2().child("skr") { it.with("entitlement", entitlement().with(key, bad)) })
            assertNull(parsed.skr!!.entitlement); assertEquals("payout_deferred", parsed.skr.status)
            assertEquals(wallet, parsed.skr.mint); assertNotNull(parsed.you!!.rewardV2)
        }
    }

    @Test fun malformedOptionalSkrIdentityAndLabelDoNotEraseValidAllocation() {
        val parsed = decode(v2().child("skr") { it.with("mint", JsonPrimitive("not-a-mint")).with("label", JsonPrimitive(5)) })
        assertNull(parsed.skr!!.mint); assertNull(parsed.skr.label); assertNotNull(parsed.skr.entitlement)
        assertEquals("0", decode(v2().child("skr") { it.with("entitlement", entitlement().with("amountRaw", JsonPrimitive("0"))) }).skr!!.entitlement!!.amountRaw)
        for (decimals in listOf(0, 19)) assertEquals(decimals,
            decode(v2().child("skr") { it.with("entitlement", entitlement().with("decimals", JsonPrimitive(decimals))) }).skr!!.entitlement!!.decimals)
    }

    @Test fun unknownLadderAndSkrStatusAreUnavailableAndDoNotFailLegacyFields() {
        for (bad in listOf(JsonPrimitive(3), JsonPrimitive(1), JsonPrimitive("2"), JsonPrimitive(true), JsonNull,
            JsonArray(emptyList()), JsonObject(emptyMap()))) {
            val parsed = decode(v2().with("ladderVersion", bad))
            assertNull(parsed.ladderVersion); assertNotNull(parsed.you!!.rewardV2)
            assertEquals(LeaguePresentationMode.UNAVAILABLE, parsed.presentationMode)
        }
        val parsed = decode(v2().child("skr") { it.with("status", JsonPrimitive("paid")) })
        assertNull(parsed.skr); assertEquals("sol", parsed.you!!.tier)
    }

    @Test fun missingVersionWithAnyV2FieldIsUnavailableEvenWhenThatFieldIsMalformed() {
        val payloads = listOf(
            legacy().with("weeklyBoard", JsonArray(emptyList())),
            legacy().with("skr", skr()),
            legacy().child("you") { it.with("tierV2", JsonPrimitive("diamond")) },
            legacy().child("you") { it.with("rewardV2", reward()) },
            legacy().child("you") { it.with("weeklyScore", JsonPrimitive(0)) },
            legacy().with("board", JsonArray(legacy().getValue("board").jsonArray.map { it.jsonObject.with("tierV2", JsonNull) })),
            legacy().child("lastSettlement") { it.with("tierV2", JsonPrimitive("unknown")) },
            legacy().child("lastSettlement") { it.with("gems", JsonPrimitive("0")) },
            legacy().child("lastSettlement") { it.with("pack", JsonArray(emptyList())) })
        for (raw in payloads) {
            val parsed = decode(raw)
            assertEquals(LeaguePresentationMode.UNAVAILABLE, parsed.presentationMode)
            assertNull(parsed.ladderVersion); assertEquals("sol", parsed.you!!.tier)
        }
        assertEquals(LeaguePresentationMode.V2, decode(legacy().with("ladderVersion", JsonPrimitive(2))).presentationMode)
    }

    @Test fun presentationModeComesFromTheObservedProtocolAndCannotBeSuppliedByTheWire() {
        assertEquals(LeaguePresentationMode.LEGACY,
            decode(legacy().with("presentationMode", JsonPrimitive("V2"))).presentationMode)
        assertEquals(LeaguePresentationMode.V2,
            decode(v2().with("presentationMode", JsonPrimitive("LEGACY"))).presentationMode)
        assertEquals(LeaguePresentationMode.UNAVAILABLE,
            decode(v2().with("ladderVersion", JsonNull).with("presentationMode", JsonPrimitive("LEGACY"))).presentationMode)
    }

    @Test fun unknownFieldsAreIgnoredAndDecodingDoesNotMutateInput() {
        val raw = v2().with("future", buildJsonObject { put("x", true) })
            .child("you") { it.with("future", JsonPrimitive("allowed")) }
        val before = raw.toString()
        assertEquals(decode(), decode(raw)); assertEquals(before, raw.toString())
    }

    @Test fun invalidRequiredLegacyFieldsStillRefuseTheWholeOverview() {
        val defects = listOf(
            v2().child("you") { it.with("tier", JsonPrimitive("diamond")) },
            v2().child("you") { it.with("baseId", JsonPrimitive("bad")) },
            v2().child("you") { it.with("trophies", JsonPrimitive(-1)) },
            v2().child("lastSettlement") { it.with("cacheShards", JsonPrimitive("01")) },
            v2().with("trophyModel", JsonPrimitive("weekly")),
            v2().with("board", JsonArray(listOf(v2().getValue("board").jsonArray[0], v2().getValue("board").jsonArray[0]))),
            v2().child("week") { it.with("closesAt", JsonPrimitive("invalid-time")) })
        for (raw in defects) assertThrows(Exception::class.java) { decode(raw) }
    }
}
