package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.ops.*

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class TrainingScheduleTest {
    private val quote=Json.parseToJsonElement("""{
      "requested":[{"troop":"highlander","count":4},{"troop":"plunderer","count":1}],
      "queueable":[{"troop":"highlander","count":2},{"troop":"plunderer","count":1}],
      "costShards":"9007199254740993","completionSec":25,
      "consent":{"version":2,"queue":[{"id":"00000000-0000-4000-8000-000000000001","startedAt":"2026-09-06T11:59:59.750Z","finishesAt":"2026-09-06T12:00:02.750Z"}],
      "unitDurations":[{"troop":"highlander","durationMs":7500},{"troop":"plunderer","durationMs":7500}]},
      "schedule":{"version":2,"mode":"sequential","serverNow":"2026-09-06T12:00:00.250Z","startsAt":"2026-09-06T12:00:02.750Z","finishesAt":"2026-09-06T12:00:25.250Z","waitMs":2500,"durationMs":22500}
    }""").jsonObject
    private fun replace(parent:String,key:String,value:JsonElement) = JsonObject(quote +
        (parent to JsonObject(quote.getValue(parent).jsonObject + (key to value))))

    @Test fun `only recognized scheduling advertisement permits new consent purchases`() {
        assertEquals(TrainingScheduling.LEGACY,trainingScheduling(jsonBody()))
        assertEquals(TrainingScheduling.LEGACY,trainingScheduling(Json.parseToJsonElement("""{"features":{"researchConsent":{"version":1}}}""").jsonObject))
        for((raw,expected) in listOf(
            """{"version":2,"mode":"sequential","lanes":1,"consentRequired":true}""" to TrainingScheduling.SEQUENTIAL,
            """{"version":3,"mode":"sequential","lanes":1,"consentRequired":true}""" to TrainingScheduling.UNSUPPORTED,
            """{"version":2,"mode":"parallel","lanes":1,"consentRequired":true}""" to TrainingScheduling.UNSUPPORTED,
            """{"version":2,"mode":"sequential","lanes":1,"consentRequired":"true"}""" to TrainingScheduling.UNSUPPORTED,
            """{"version":2,"mode":"sequential","lanes":1}""" to TrainingScheduling.UNSUPPORTED,
            """{"version":2,"mode":"sequential","consentRequired":true}""" to TrainingScheduling.UNSUPPORTED,
            """{"version":2,"mode":"sequential","lanes":2,"consentRequired":true}""" to TrainingScheduling.UNSUPPORTED,
            """{"version":2,"mode":"sequential","lanes":"1","consentRequired":true}""" to TrainingScheduling.UNSUPPORTED,
            "null" to TrainingScheduling.UNSUPPORTED)) {
            assertEquals(expected,trainingScheduling(buildJsonObject { put("features",buildJsonObject { put("trainingScheduling",Json.parseToJsonElement(raw)) }) }))
        }
        assertEquals(TrainingScheduling.UNSUPPORTED,trainingScheduling(buildJsonObject { put("features",JsonNull) }))
    }

    @Test fun `partial composition preserves exact ordered consent price and millisecond schedule`() {
        val body=trainingConfirmation(quote,"base-A","original-key",TrainingScheduling.SEQUENTIAL)
        assertEquals(quote["consent"],body["consent"])
        assertEquals(quote["queueable"],body["composition"])
        assertEquals("9007199254740993",body.string("confirmedCostShards"))
        val schedule=requireNotNull(trainingQuoteSchedule(quote))
        assertEquals(2500L,schedule.waitMs);assertEquals(22500L,schedule.durationMs)
        assertEquals("2026-09-06T12:00:25.250Z",schedule.finishesAt)
        assertEquals("7.5 s",trainingDurationLabel(7500));assertEquals("0.001 s",trainingDurationLabel(1))
    }

    @Test fun `legacy quote remains usable but capability response races require explicit new review`() {
        val legacy=JsonObject(quote - "consent" - "schedule")
        assertFalse(trainingConfirmation(legacy,"base-A","original-key").containsKey("consent"))
        assertThrows(IllegalArgumentException::class.java) { trainingConfirmation(quote,"base-A","original-key") }
        assertThrows(IllegalArgumentException::class.java) { trainingConfirmation(legacy,"base-A","original-key",TrainingScheduling.SEQUENTIAL) }
        assertThrows(ApiCompatibilityException::class.java) { trainingConfirmation(quote,"base-A","original-key",TrainingScheduling.UNSUPPORTED) }
    }

    @Test fun `missing malformed or reordered timing never becomes an approved purchase`() {
        val consent=quote.getValue("consent").jsonObject
        val durations=consent.getValue("unitDurations").jsonArray
        val invalid=listOf(JsonObject(quote - "consent"),JsonObject(quote - "schedule"),
            replace("consent","version",JsonPrimitive(3)),
            replace("consent","unitDurations",JsonArray(durations.reversed())),
            replace("consent","unitDurations",JsonArray(durations.dropLast(1))),
            replace("consent","unitDurations",JsonArray(listOf(JsonObject(durations[0].jsonObject + ("durationMs" to JsonPrimitive(7500.5))),durations[1]))),
            replace("schedule","durationMs",JsonPrimitive(22501)),
            replace("schedule","waitMs",JsonPrimitive(2501)),
            replace("schedule","finishesAt",JsonPrimitive("2026-09-06T12:00:25.250001Z")),
            replace("consent","queue",JsonArray(consent.getValue("queue").jsonArray.let { it+it })))
        for(bad in invalid) assertThrows(ApiCompatibilityException::class.java) {
            trainingConfirmation(bad,"base-A","original-key",TrainingScheduling.SEQUENTIAL)
        }
    }

    @Test fun `recreated saved intent retains consent without consulting a replacement quote`() {
        val storage=object : SecretStore {
            var value:String?=null
            override fun read()=value
            override fun write(value:String) { this.value=value }
            override fun clear() { value=null }
        }
        val original=trainingConfirmation(quote,"base-A","original-key",TrainingScheduling.SEQUENTIAL)
        val intent=PendingIntent(IntentKind.TRAINING_BATCH,"wallet-A","base-A","original-key",TrainingBatchSpec.PATH,original,"Train army",quote)
        assertTrue(PendingIntentStore(storage).create(intent))
        val restored=PendingIntentStore(storage).get(IntentKind.TRAINING_BATCH,"wallet-A")!!
        assertEquals(original,restored.body);assertEquals(quote,restored.quote)
        val newer=replace("consent","queue",buildJsonArray {})
        val replacement=trainingConfirmation(newer,"base-A","original-key",TrainingScheduling.SEQUENTIAL)
        assertNotEquals(replacement,original)
        // A replacement quote with the same key is a different saved record: the exact-match retirement refuses it.
        assertFalse(PendingIntentStore(storage).clearIfMatching(intent.copy(body=replacement,quote=newer)))
        assertEquals(original,PendingIntentStore(storage).get(IntentKind.TRAINING_BATCH,"wallet-A")?.body)
    }

    @Test fun `new batch waits for every quoted unit while grandfathered rows may overlap each other`() {
        val row=quote.getValue("consent").jsonObject.getValue("queue").jsonArray.single().jsonObject
        fun withEarlierListedRow(finishesAt:String)=replace("consent","queue",JsonArray(listOf(
            JsonObject(row + mapOf("id" to JsonPrimitive("00000000-0000-4000-8000-000000000002"),
                "finishesAt" to JsonPrimitive(finishesAt))),row)))
        // Other schedule arithmetic remains valid. The latest queue finish is
        // deliberately not the last listed row, so admission must use its max.
        assertThrows(ApiCompatibilityException::class.java) {
            trainingConfirmation(withEarlierListedRow("2026-09-06T12:00:03.750Z"),"base-A","original-key",TrainingScheduling.SEQUENTIAL)
        }
        val grandfathered=withEarlierListedRow("2026-09-06T12:00:02.500Z")
        assertEquals(grandfathered["consent"],trainingConfirmation(grandfathered,"base-A","original-key",TrainingScheduling.SEQUENTIAL)["consent"])
    }
}
