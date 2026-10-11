package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.network.BattlePhase
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class LiveBattleMappingTest {
    private val revision = "a".repeat(64)
    private val content = ContentState(File("/fixture/admitted"),
        buildJsonObject { put("simVersion", 15) }, buildJsonObject { put("rendererContractVersion", 2) },
        manifest = NativeContentManifest("b".repeat(40), 15, "c".repeat(64), emptyList()))
    private fun data(ordinal: Long = 1, clock: Long = 100, raid: String = "raid", revision: String = this.revision) = buildJsonObject {
        put("raidId", raid); put("revision", revision); put("source", "live"); put("status", "pending_orders")
        put("_clientPreparationOrdinal", ordinal); put("_clientFirstPageReceivedAtNanos", ordinal * 1_000_000L)
        put("clock", buildJsonObject { put("serverNow", clock); put("simNowMs", clock) })
    }
    private fun key(data: JsonObject = data(), content: ContentState = this.content, retry: Int = 0) =
        requireNotNull(liveBattleMappingKey(data, content, retry))
    private fun prepared(key: LiveBattleMappingKey = key(), trace: LocalPreparationTrace? = null) = PreparedLiveBattle(
        BattleScene(BaseScene(emptyList(), 30, 30, 32f),
            PresentationRevision(key.raidId, key.revision, 15, 0, 0, emptyList()),
            emptyMap(), 256f, 100f, 10, 10, preparationTrace = trace,
            commandDrawPlan = BattleCommandDrawPlan(1, key.raidId, key.revision, mapOf(7 to 1L))),
        key.terminal, mappingKey = key, preparationOrdinal = 1)

    @Test fun `reconnect metadata reuses the exact admitted scene with reports enabled or disabled`() {
        val trace = object : LocalPreparationTrace {
            override fun stage(stage: LocalPreparationStage) = Unit
            override fun renderer(generation: Long): LocalPreparationTrace = this
            override fun finish(outcome: LocalPreparationOutcome) = Unit
        }
        for (observer in listOf(null, trace)) {
            val original = prepareLiveStart(null, prepared(trace = observer), 3200.0)
            val refreshed = data(ordinal = 9, clock = 7400)
            assertNotEquals(data(), refreshed)
            val retained = requireNotNull(retainedLiveMapping(original, key(refreshed)))
            assertSame("Transport metadata cannot republish another renderer generation", original, retained)
            assertSame(original.scene.preparationTrace, retained.scene.preparationTrace)
            assertSame(original.scene.commandDrawPlan, retained.scene.commandDrawPlan)
            assertEquals(BattlePresentationStart.ColdPrefix(32f), retained.scene.presentationStart)
            val playback = livePlaybackScene(retained, 7400.0, BattlePhase.RUNNING, false, 2f)
            assertEquals("Fresh authoritative time still drives playback", 74f, playback.playheadTick, 0f)
            assertEquals(2f, playback.rate, 0f); assertTrue(playback.playing)
            assertSame(retained.scene.revision, playback.revision)
        }
    }

    @Test fun `both catalogues assets and admitted content version invalidate reuse`() {
        val original = prepared()
        val changes = listOf(
            content.copy(catalogue = buildJsonObject { put("simVersion", 16) }),
            content.copy(renderCatalogue = buildJsonObject { put("rendererContractVersion", 3) }),
            content.copy(assets = File("/fixture/replacement")),
            content.copy(manifest = content.manifest!!.copy(contentVersion = "d".repeat(64))),
        )
        changes.forEach { assertNull("An admitted content change requires fresh mapping", retainedLiveMapping(original, key(content = it))) }
        val checking = content.copy(checking = true, updateNotice = "Checking game content…", minimumNativeBuild = 20)
        assertSame("Update notices and order gating do not change admitted artwork", original, retainedLiveMapping(original, key(content = checking)))
    }

    @Test fun `manual retry and unsuccessful or cancelled mapping cannot be mistaken for a successful result`() {
        val original = prepared()
        val retry = key(retry = 1)
        assertNull(retainedLiveMapping(original, retry))
        // A failed/cancelled attempt keeps the last valid scene. It never attaches
        // the new admission key, so a repeated response must remain retryable.
        repeat(2) { assertNull(retainedLiveMapping(original, retry)) }
        val succeeded = prepared(retry)
        assertSame(succeeded, retainedLiveMapping(succeeded, retry))
        assertNull(retainedLiveMapping(succeeded, key(retry = 2)))
        assertNull(retainedLiveMapping(null, key()))
        assertNull(retainedLiveMapping(original.copy(mappingKey = null), key()))
    }

    @Test fun `new revision raid and terminal archive each require their own mapping`() {
        val original = prepared()
        assertNull(retainedLiveMapping(original, key(data(revision = "e".repeat(64)))))
        assertNull(retainedLiveMapping(original, key(data(raid = "next-raid"))))
        val archive = JsonObject(data() + mapOf("source" to JsonPrimitive("archive"), "status" to JsonPrimitive("resolved")))
        assertNull("Even an equal timeline must transition from prediction to terminal playback", retainedLiveMapping(original, key(archive)))
        val terminal = prepared(key(archive))
        assertSame(terminal, retainedLiveMapping(terminal, key(archive)))
    }

    @Test fun `reuse cannot bypass the prepared scene raid revision and terminal fences`() {
        val original = prepared()
        val wrongRaid = original.copy(scene = original.scene.copy(revision = original.scene.revision.copy(raidId = "different")))
        val wrongRevision = original.copy(scene = original.scene.copy(revision = original.scene.revision.copy(revision = "f".repeat(64))))
        assertNull(retainedLiveMapping(wrongRaid, key()))
        assertNull(retainedLiveMapping(wrongRevision, key()))
        assertNull(retainedLiveMapping(original.copy(terminal = true), key()))
    }

    @Test fun `incomplete admission has no reusable identity and immutable inputs remain captured`() {
        listOf(content.copy(assets = null), content.copy(catalogue = null), content.copy(renderCatalogue = null)).forEach {
            assertNull(liveBattleMappingKey(data(), it, 0))
        }
        assertNull(liveBattleMappingKey(JsonObject(data() - "raidId"), content, 0))
        assertNull(liveBattleMappingKey(JsonObject(data() - "revision"), content, 0))
        val captured = key()
        assertSame(content.catalogue, captured.catalogue); assertSame(content.renderCatalogue, captured.renderCatalogue)
        assertEquals(content.assets, captured.assets)
    }
}
