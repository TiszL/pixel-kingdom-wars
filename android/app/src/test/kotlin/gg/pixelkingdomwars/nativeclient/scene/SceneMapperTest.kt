package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.renderer.RealmVisual
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Rewritten from BaseSceneAdapterTest: the mapper takes explicit catalogues and carries visualContext. */
class SceneMapperTest {
    private fun json(path: String) = Json.parseToJsonElement(File(path).readText()).jsonObject
    private val catalogue = json("src/main/assets/native/catalogue.json")
    private val render = json("src/main/assets/native/render-catalog.json")
    private val base = json("src/debug/assets/native/fixtures/base.json")
    private val logs = mutableListOf<String>()
    private val mapper = SceneMapper(catalogue, render) { logs += it }

    @Test fun `plot versions preserve old scenes and the combat field while admitting signed home coordinates`() {
        val policy = Json.parseToJsonElement(gg.pixelkingdomwars.nativeclient.model.PlotGeometry::class.java.classLoader!!.getResource("plot-geometry.json")!!.readText())
        val raidPolicy = Json.parseToJsonElement("""{"legacyVersion":1,"currentVersion":2,"marginTilesByVersion":{"1":4,"2":34},"snapRadiusTiles":1}""")
        val c = JsonObject(catalogue + ("constants" to JsonObject(catalogue.getValue("constants").jsonObject + mapOf("PLOT_GEOMETRY" to policy, "RAID_BATTLEFIELD" to raidPolicy))))
        val m = SceneMapper(c,render)
        val old = m.baseScene(base)
        assertEquals(30, old.columns); assertEquals(0, old.minimumTileX)
        val expanded = JsonObject(base + buildJsonObject { put("plotVersion",2); put("battlefieldVersion",2); put("claimMin",-10); put("claimMax",40); put("claim",buildJsonObject {put("min",-10);put("max",40)}) })
        val home = m.baseScene(expanded)
        assertEquals(50,home.columns);assertEquals(-10,home.minimumTileX)
        assertEquals(old.buildings, home.buildings)
        assertEquals(-10f,home.camera!!.claimMin)
        val battle = m.previewScene(buildJsonObject {put("stage",100);put("snapshot",expanded)},catalogue.getValue("simVersion").jsonPrimitive.int)
        assertEquals(-34,battle.base.battlefield!!.minimum);assertEquals(64,battle.base.battlefield!!.maximum)
        assertThrows(IllegalArgumentException::class.java) { m.baseScene(JsonObject(base + ("plotVersion" to JsonPrimitive(3)))) }
    }
    @Test fun `occupied defender framing keeps destroyed footprints and separate centres from frozen snapshot`() {
        val sharedPolicy=Json.parseToJsonElement("""{"legacyVersion":1,"currentVersion":2,"marginTilesByVersion":{"1":4,"2":34},"snapRadiusTiles":1}""")
        val constants=JsonObject(catalogue.getValue("constants").jsonObject+("RAID_BATTLEFIELD" to sharedPolicy))
        val m=SceneMapper(JsonObject(catalogue+("constants" to constants)),render)
        val buildings=base.getValue("buildings").jsonArray.take(2).mapIndexed { index, raw ->
            JsonObject(raw.jsonObject+buildJsonObject {put("tx",if(index==0) 4 else 17);put("ty",if(index==0) 8 else 12);put("fw",2);put("fh",3)})
        }
        val snapshot=JsonObject(base+buildJsonObject {put("buildings",JsonArray(buildings));put("battlefieldVersion",2);put("claimMin",-10);put("claimMax",40)})
        val preview=m.previewScene(buildJsonObject {put("stage",100);put("snapshot",snapshot)},15)
        assertEquals(gg.pixelkingdomwars.nativeclient.renderer.BaseWorldBounds(4f,8f,19f,15f),preview.base.defenderBounds)
        val live=buildJsonObject {
            put("raidId","frozen-camera");put("revision","destroyed");put("simVersion",15);put("lastSequence",1)
            put("snapshot",snapshot);put("events",buildJsonArray {})
            put("buildingHealth",buildJsonArray {for(b in buildings) add(buildJsonObject {put("id",b.getValue("id"));put("initialHp",0);put("maxHp",100)})})
        }
        assertEquals("Destruction must not reframe the surviving base",preview.base.defenderBounds,m.liveScene(live).base.defenderBounds)
        val old=JsonObject(snapshot-"battlefieldVersion")
        assertNull(m.scoutScene(old,"legacy",14).base.defenderBounds)
        val empty=JsonObject(snapshot+("buildings" to buildJsonArray {}))
        assertNull(m.scoutScene(empty,"empty",15).base.defenderBounds)
    }
    @Test fun `obsolete preparation stops inside building and event loops`() {
        var checkpoints=0
        val stopped=IllegalStateException("superseded")
        assertSame(stopped,assertThrows(IllegalStateException::class.java) {
            mapper.baseScene(base,checkpoint={checkpoints++;throw stopped})
        })
        assertEquals(1,checkpoints)
        checkpoints=0
        assertSame(stopped,assertThrows(IllegalStateException::class.java) {
            mapper.replayScene(json("src/debug/assets/native/fixtures/replay.json"),checkpoint={checkpoints++;throw stopped})
        })
        assertEquals(1,checkpoints)
    }
    @Test fun `battlefield version and omitted physical blockers come from the snapshot and shared policy`() {
        val current=mapper
        val snapshot=JsonObject(base+buildJsonObject {
            put("battlefieldVersion",2);put("claimMin",8);put("claimMax",22)
            put("buildings",JsonArray(emptyList()))
            put("deploymentBlockers",buildJsonArray {add(buildJsonObject {put("tx",15);put("ty",15);put("fw",2);put("fh",2)})})
        })
        val preview=buildJsonObject {put("stage",100);put("snapshot",snapshot)}
        val policy=current.previewScene(preview,15).base.battlefield!!
        assertTrue(policy.legal(-34,63));assertTrue(policy.legal(10,10));assertTrue(policy.legal(15,-7))
        assertFalse(policy.legal(15,15));assertFalse(policy.legal(16,16));assertFalse(policy.legal(64,0))
        // SIM15 now bundles this policy. Model an older pack explicitly rather
        // than assuming the current catalogue lacks battlefield admission.
        val oldConstants=JsonObject(catalogue.getValue("constants").jsonObject-"RAID_BATTLEFIELD")
        val old=SceneMapper(JsonObject(catalogue+("constants" to oldConstants)),render)
        assertThrows(IllegalArgumentException::class.java) {old.previewScene(preview,15)}
        val unsupported=JsonObject(snapshot+("battlefieldVersion" to JsonPrimitive(4)))
        assertThrows(IllegalArgumentException::class.java) {current.previewScene(JsonObject(preview+("snapshot" to unsupported)),15)}
    }

    @Test fun `v3 clearance uses exported square size and preserves v2 frozen blockers and v1 archives`() {
        val shared=Json.parseToJsonElement("""{"legacyVersion":1,"currentVersion":3,"marginTilesByVersion":{"1":4,"2":34,"3":34},"snapRadiusTiles":1,"deploymentSquareTiles":2}""").jsonObject
        fun subject(version:Int, square:JsonElement?=shared["deploymentSquareTiles"]):gg.pixelkingdomwars.nativeclient.renderer.BattlefieldInputPolicy {
            val configured=if(square==null) JsonObject(shared-"deploymentSquareTiles") else JsonObject(shared+("deploymentSquareTiles" to square))
            val c=JsonObject(catalogue.getValue("constants").jsonObject+("RAID_BATTLEFIELD" to configured))
            val blocks=buildJsonArray {
                // Exactly four empty cells remain, with all surrounding cells physically blocked.
                for(y in -1..2) for(x in -1..2) if(x !in 0..1 || y !in 0..1)
                    add(buildJsonObject {put("tx",x);put("ty",y);put("fw",1);put("fh",1)})
            }
            val snapshot=JsonObject(base+buildJsonObject {
                put("battlefieldVersion",version);put("buildings",buildJsonArray {});put("deploymentBlockers",blocks)
            })
            return battlefieldPolicy(snapshot,mapper.baseScene(snapshot),c)
        }
        val current=subject(3)
        assertEquals(2,current.deploymentSquareTiles)
        for(y in 0..1) for(x in 0..1) assertTrue(current.legal(x,y))
        assertFalse(current.legal(-1,0));assertTrue(subject(2).legal(0,0))
        assertNull(subject(2).deploymentSquareTiles)
        assertFalse(subject(3,JsonPrimitive(3)).legal(0,0))
        assertThrows(IllegalArgumentException::class.java) {subject(3,null)}
        assertNull(subject(1).deploymentSquareTiles)
        assertTrue("Legacy ignores additive blocker metadata",subject(1).legal(-1,0))
        assertThrows(IllegalArgumentException::class.java) {subject(4)}
    }

    @Test fun `v3 clearance retains destroyed frozen building footprints and ignores decorative scenery`() {
        val shared=Json.parseToJsonElement("""{"legacyVersion":1,"currentVersion":3,"marginTilesByVersion":{"1":4,"2":34,"3":34},"snapRadiusTiles":1,"deploymentSquareTiles":2}""")
        val c=JsonObject(catalogue+("constants" to JsonObject(catalogue.getValue("constants").jsonObject+("RAID_BATTLEFIELD" to shared))))
        val m=SceneMapper(c,render)
        val building=JsonObject(base.getValue("buildings").jsonArray.first().jsonObject+buildJsonObject {put("tx",4);put("ty",4);put("fw",2);put("fh",2)})
        val snapshot=JsonObject(base+buildJsonObject {
            put("battlefieldVersion",3);put("buildings",JsonArray(listOf(building)))
            put("obstacles",buildJsonArray {add(buildJsonObject {put("type","future-decor");put("tx",10);put("ty",10)})})
        })
        val data=buildJsonObject {
            put("raidId","clearance-frozen");put("revision","destroyed");put("simVersion",catalogue.getValue("simVersion"));put("lastSequence",1)
            put("snapshot",snapshot);put("events",buildJsonArray {})
            put("buildingHealth",buildJsonArray {add(buildJsonObject {put("id",building.getValue("id"));put("initialHp",0);put("maxHp",100)})})
        }
        val frozen=m.liveScene(data).base.battlefield!!
        assertFalse(frozen.legal(4,4));assertFalse(frozen.legal(5,5))
        assertTrue(frozen.legal(10,10));assertEquals(-34,frozen.minimum);assertEquals(64,frozen.maximum)
    }

    @Test fun `archive mapper preserves historical SIM and rejects missing legacy presentation admission`() {
        val saved=JsonObject(json("src/debug/assets/native/fixtures/replay.json")+("simVersion" to JsonPrimitive(1)))
        // The bundled pack now includes archive admission; explicitly remove it to model an older pack.
        assertThrows(IllegalArgumentException::class.java) { SceneMapper(catalogue, JsonObject(render - "archivePresentation")).replayScene(saved) }
        val currentSim=catalogue.getValue("simVersion").jsonPrimitive.int
        val policy=render.getValue("archivePresentation").jsonObject
        assertEquals(currentSim,policy.getValue("maximumSimVersion").jsonPrimitive.int)
        val scene=mapper.replayScene(saved)
        assertEquals(1,scene.revision.simVersion)
        assertEquals(saved.getValue("events").jsonArray.map { it.jsonObject.getValue("e").jsonPrimitive.content },scene.revision.events.map { it.e })
        val prior=JsonObject(policy+("maximumSimVersion" to JsonPrimitive(currentSim-1)))
        assertThrows(IllegalArgumentException::class.java) {SceneMapper(catalogue,JsonObject(render+("archivePresentation" to prior))).replayScene(saved)}
        assertThrows(IllegalArgumentException::class.java) {mapper.replayScene(JsonObject(saved+("simVersion" to JsonPrimitive(currentSim+1))))}
    }

    @Test fun `missing snapshot claim does not invent a centre that clips fixture walls`() {
        assertNull(mapper.baseScene(base).camera)
        val claimed = JsonObject(base + ("claim" to buildJsonObject { put("min", 8); put("max", 22) }))
        assertEquals(8f, mapper.baseScene(claimed).camera!!.claimMin)
        assertEquals(22f, mapper.baseScene(claimed).camera!!.claimMax)
        assertEquals(catalogue.getValue("constants").jsonObject.getValue("BASE_CAMERA").jsonObject.getValue("skirtTiles").jsonPrimitive.float, mapper.baseScene(claimed).camera!!.skirtTiles, 0f)
    }
    @Test fun `building health is supplied by presentation and never inferred from level`() {
        val original = mapper.baseScene(base).buildings.first()
        assertNull(original.maxHp); assertNull(original.initialHp)
        val supplied = buildJsonObject { put("id", original.id); put("initialHp", 731L); put("maxHp", 977L) }
        val received = mapper.baseScene(base, listOf(supplied)).buildings.first()
        assertEquals(731L, received.initialHp); assertEquals(977L, received.maxHp)
        assertThrows(IllegalArgumentException::class.java) { mapper.baseScene(base, listOf(supplied, supplied)) }
        assertThrows(NoSuchElementException::class.java) { mapper.baseScene(base, listOf(JsonObject(supplied - "maxHp"))) }
    }
    @Test fun `job adapter retains expired server jobs and resolves actual building sites`() {
        val building = base.getValue("buildings").jsonArray.first().jsonObject; val id = building.getValue("id")
        val job = buildJsonObject { put("id", "job"); put("kind", "upgrade"); put("buildingId", id); put("obstacleId", JsonNull); put("startedAt", "2020-01-01T00:00:00Z"); put("finishesAt", "2020-01-01T00:01:00Z") }
        val updated = JsonObject(base + mapOf("baseId" to JsonPrimitive("base"), "jobs" to JsonArray(listOf(job))))
        val withJobs = SceneMapper(catalogue, JsonObject(render + ("basePresentation" to buildJsonObject { put("obstacles", buildJsonObject {}) })))
        val scene = withJobs.baseScene(updated); val target = scene.buildings.first { it.id == id.jsonPrimitive.content }; val received = scene.jobs.single()
        assertEquals("base", scene.baseId); assertEquals(target.tileX, received.targetX, 0f); assertEquals(1577836800000L, received.startedAtMs)
    }
    @Test fun `clear jobs use catalogue obstacle footprint and discard a vanished target only`() {
        val obstacle = buildJsonObject { put("id", "obstacle"); put("spriteKey", "fixture"); put("tx", 7); put("ty", 9) }
        val art = buildJsonObject { put("frameKey", "dec_fixture"); put("footprintWidth", 3); put("footprintHeight", 3) }
        val job = buildJsonObject { put("id", "clear"); put("kind", "clear_obstacle"); put("buildingId", JsonNull); put("obstacleId", "obstacle"); put("startedAt", "2020-01-01T00:00:00Z"); put("finishesAt", "2020-01-01T00:01:00Z") }
        val updated = JsonObject(base + mapOf("obstacles" to JsonArray(listOf(obstacle)), "jobs" to JsonArray(listOf(job))))
        val withObstacles = SceneMapper(catalogue, JsonObject(render + ("basePresentation" to buildJsonObject { put("obstacles", buildJsonObject { put("fixture", art) }) })))
        val scene = withObstacles.baseScene(updated)
        assertEquals("dec_fixture", scene.obstacles.single().frameKey); assertEquals(3f, scene.jobs.single().footprintWidth, 0f)
        // E-11: the server spriteKey rides along — it is the join to a revision-5 kit's obstacleSprites twin.
        assertEquals("fixture", scene.obstacles.single().spriteKey)
        assertTrue(withObstacles.baseScene(JsonObject(updated + ("obstacles" to JsonArray(emptyList())))).jobs.isEmpty())
    }
    /** E-11 remnants: web BaseScene.syncRemnants stands the kit's stump on every `clearedObstacles[]` row for
     * OBSTACLE_REMNANT_DAYS; native showed bare turf the moment a clear job completed because nothing mapped the
     * array (RealmKitObstacleState.REMNANT was reachable only from tests). The remnant carries the seat, the key
     * and the `dec_` footprint the renderer needs, and nothing else: no id, so no selection or clear path finds it. */
    @Test fun `cleared obstacles map to presentation-only remnants with the catalogue footprint`() {
        val art = buildJsonObject { put("frameKey", "dec_fixture"); put("footprintWidth", 2); put("footprintHeight", 2) }
        val cleared = buildJsonArray {
            add(buildJsonObject { put("spriteKey", "fixture"); put("tx", 31); put("ty", 12); put("clearedAt", "2026-09-21T00:00:00Z") })
            add(buildJsonObject { put("spriteKey", "unknown-to-this-pack"); put("tx", 3); put("ty", 4); put("clearedAt", "2026-09-21T00:00:00Z") })
        }
        val withObstacles = SceneMapper(catalogue, JsonObject(render + ("basePresentation" to buildJsonObject { put("obstacles", buildJsonObject { put("fixture", art) }) })))
        val scene = withObstacles.baseScene(JsonObject(base + ("clearedObstacles" to cleared)))
        assertEquals(listOf("fixture", "unknown-to-this-pack"), scene.remnants.map { it.spriteKey })
        val stump = scene.remnants.first()
        assertEquals(31f, stump.tileX, 0f); assertEquals(12f, stump.tileY, 0f)
        assertEquals("The `dec_` footprint seats the twin exactly where the row stood", 2f, stump.footprintWidth, 0f); assertEquals(2f, stump.footprintHeight, 0f)
        assertEquals("A key this pack's catalogue lacks keeps web's 1×1 fallback instead of failing the base", 1f, scene.remnants[1].footprintWidth, 0f)
        assertTrue("A remnant is never a standing row: nothing to select, clear or block a placement", scene.obstacles.isEmpty())
        assertTrue("An older server without the array leaves no remnants", withObstacles.baseScene(base).remnants.isEmpty())
        val legacyPack = SceneMapper(catalogue, JsonObject(render - "basePresentation"))
        assertTrue("A pack without a base presentation contract keeps its static preview", legacyPack.baseScene(JsonObject(base + ("clearedObstacles" to cleared))).remnants.isEmpty())
    }
    @Test fun `a PvP raid snapshot freezes id-less decor obstacles and the battlefield still opens`() {
        // The raid snapshot's obstacles are the shared `BaseSnapshot.obstacles` contract: spriteKey/tx/ty only,
        // never a row id (only `/base` and `/map/scout` rows carry one, for clear jobs and selection). Every real
        // production base has uncleared obstacles, so a mapper that demanded an id failed every PvP raid with
        // "Couldn't open the battlefield" while campaign strongholds (no obstacles) opened (incident 2026-09-17).
        val decor = buildJsonArray {
            add(buildJsonObject { put("spriteKey", "bush"); put("tx", 7); put("ty", 9) })
            add(buildJsonObject { put("spriteKey", "tree_old"); put("tx", 12); put("ty", 3) })
            add(buildJsonObject { put("spriteKey", "bush"); put("tx", 12); put("ty", 9) })
        }
        val snapshot = JsonObject(base + buildJsonObject { put("claimMin", 0); put("claimMax", 29); put("obstacles", decor) })
        val live = buildJsonObject {
            put("raidId", "pvp-decor"); put("revision", "staged"); put("simVersion", catalogue.getValue("simVersion").jsonPrimitive.int)
            put("lastSequence", -1); put("snapshot", snapshot); put("events", buildJsonArray {})
        }
        val scene = mapper.liveScene(live)
        assertEquals(listOf("dec_bush", "dec_tree_old", "dec_bush"), scene.base.obstacles.map { it.frameKey })
        assertEquals(2f, scene.base.obstacles[1].footprintWidth, 0f)
        assertEquals("Each frozen placement keeps its own identity", 3, scene.base.obstacles.map { it.id }.distinct().size)
        assertEquals(base.getValue("buildings").jsonArray.size, scene.base.buildings.size)
        // A row id, when the server sends one, is still the identity jobs and selection resolve against.
        val identified = JsonObject(base + ("obstacles" to buildJsonArray { add(buildJsonObject { put("id", "row"); put("spriteKey", "bush"); put("tx", 1); put("ty", 1) }) }))
        assertEquals("row", mapper.baseScene(identified).obstacles.single().id)
    }
    /** Review of the 2026-09-17 PvP incident: the battlefield opens against a 30 s first-deploy window, and during a
     * battle the defender's decor is not even drawn — so a snapshot row whose art this pack does not know must cost
     * that one prop, never the whole battle. The player's own base still fails closed (a clearable obstacle the pack
     * cannot show is a content defect worth stopping for). Production-shaped snapshot: id-less rows, real claim bounds. */
    @Test fun `an unknown decor obstacle in a raid snapshot is skipped and the PvP battlefield still opens`() {
        val decor = buildJsonArray {
            add(buildJsonObject { put("spriteKey", "bush"); put("tx", 7); put("ty", 9) })
            add(buildJsonObject { put("spriteKey", "harvest_cart_2027"); put("tx", 3); put("ty", 4) })
            add(buildJsonObject { put("spriteKey", "tree_old"); put("tx", 12); put("ty", 3) })
            add(buildJsonObject { put("tx", 1); put("ty", 1) })
        }
        val snapshot = JsonObject(base + buildJsonObject { put("claimMin", 0); put("claimMax", 29); put("obstacles", decor) })
        val live = buildJsonObject {
            put("raidId", "pvp-odd-decor"); put("revision", "staged"); put("simVersion", catalogue.getValue("simVersion").jsonPrimitive.int)
            put("lastSequence", -1); put("snapshot", snapshot); put("events", buildJsonArray {})
        }
        val scene = mapper.liveScene(live)
        assertEquals("The known props stay; the unknown and the malformed row are dropped", listOf("dec_bush", "dec_tree_old"), scene.base.obstacles.map { it.frameKey })
        assertEquals(base.getValue("buildings").jsonArray.size, scene.base.buildings.size)
        assertTrue("The skip leaves a trace for the visual log", logs.any { "harvest_cart_2027" in it })
        assertTrue("A scout of the same deed opens too", mapper.scoutScene(snapshot, "target", 14).base.obstacles.size == 2)
        val own = JsonObject(base + ("obstacles" to buildJsonArray { add(buildJsonObject { put("id", "row"); put("spriteKey", "harvest_cart_2027"); put("tx", 3); put("ty", 4) }) }))
        assertThrows("The player's own base keeps failing closed", IllegalStateException::class.java) { mapper.baseScene(own) }
    }
    @Test fun `a campaign preview becomes a paused scene with no actors and its realm logged`() {
        val preview = buildJsonObject { put("stage", 3); put("snapshot", base); put("visualContext", buildJsonObject { put("version", 1); put("realmId", "sunscar"); put("artVersion", 2) }) }
        val scene = mapper.previewScene(preview, 14)
        assertFalse(scene.playing); assertEquals("campaign-preview-3", scene.revision.raidId); assertEquals(14, scene.revision.simVersion)
        assertTrue(scene.revision.events.isEmpty()); assertEquals(mapper.baseScene(base).buildings.size, scene.base.buildings.size)
        assertTrue(logs.any { it.contains("preview stage 3") && it.contains("realm=sunscar") })
        assertThrows(IllegalArgumentException::class.java) { mapper.previewScene(buildJsonObject { put("snapshot", base) }, 14) }
    }
    @Test fun `a production shaped flat scout report renders without a nested battle snapshot`() {
        val report = JsonObject(base + buildJsonObject {
            put("baseId", "target-base"); put("wallet", "target-wallet"); put("name", "Scouted kingdom")
            put("keepLevel", 5); put("trophies", 0); put("claimMin", 8); put("claimMax", 22); put("previewSec", 30)
            put("obstacles", JsonArray(emptyList())); put("heroes", JsonArray(emptyList()))
            put("visualContext", buildJsonObject { put("version", 1); put("realmId", "crownlands"); put("artVersion", 2) })
        })
        assertFalse(report.containsKey("snapshot"))
        val scene = mapper.scoutScene(report, "target-base", 14)
        assertEquals("scout-target-base", scene.revision.raidId); assertFalse(scene.playing)
        assertEquals(mapper.baseScene(report).buildings, scene.base.buildings)
        assertEquals(RealmVisual("crownlands", 2), scene.base.visual)
        assertTrue(scene.actorFrames.isEmpty()); assertTrue(scene.revision.events.isEmpty())
    }
    @Test fun `bundled hero artwork renders a high level Vex replay without changing its events`() {
        val replay = json("src/debug/assets/native/fixtures/replay.json")
        val hero = buildJsonObject { put("t", 0); put("e", "deploy"); put("id", 987); put("troop", "plunderer"); put("hero", "vex"); put("x", 128); put("y", 2176) }
        val updated = JsonObject(replay + mapOf("events" to JsonArray(listOf(hero)), "armySnapshot" to buildJsonObject {
            put("heroLevels", buildJsonObject { put("vex", 20) })
        }))
        val scene = mapper.replayScene(updated)
        val authored = render.getValue("actors").jsonArray.single { it.jsonObject.getValue("type").jsonPrimitive.content == "vex" }.jsonObject
        assertEquals(authored.getValue("frameKey").jsonPrimitive.content, scene.actorFrames["#987"])
        assertEquals(hero, Json.parseToJsonElement(scene.revision.events.single().json))
        assertEquals(updated.getValue("simVersion").jsonPrimitive.int, scene.revision.simVersion)
    }
    @Test fun `visual context is carried through the mapper and logged never guessed`() {
        assertTrue(logs.isEmpty())
        assertNull("a snapshot without context leaves the renderer's declared default in charge", mapper.baseScene(base).visual)
        val frost = buildJsonObject { put("version", 1); put("realmId", "frostveil"); put("artVersion", 2) }
        val scene = mapper.baseScene(JsonObject(base + ("visualContext" to frost)))
        assertTrue(logs.single().contains("realm=frostveil"))
        assertEquals(RealmVisual("frostveil", 2), scene.visual)
        val crown = buildJsonObject { put("version", 1); put("realmId", "crownlands"); put("artVersion", 2); put("groundRevision", 1) }
        assertEquals(RealmVisual("crownlands", 2, 1), mapper.baseScene(JsonObject(base + ("visualContext" to crown))).visual)
        assertNull("an unknown context version depicts the default rather than a guess",
            mapper.baseScene(JsonObject(base + ("visualContext" to buildJsonObject { put("version", 2); put("realmId", "frostveil"); put("artVersion", 2) }))).visual)
        assertThrows(IllegalArgumentException::class.java) { mapper.baseScene(JsonObject(base + ("visualContext" to buildJsonObject { put("realmId", "frostveil") }))) }
        // Replays carry the frozen context on their root, not inside the snapshot.
        val replay = json("src/debug/assets/native/fixtures/replay.json")
        assertNull(mapper.replayScene(replay).base.visual)
        assertEquals(RealmVisual("frostveil", 2), mapper.replayScene(JsonObject(replay + ("visualContext" to frost))).base.visual)
        assertEquals(RealmVisual("crownlands", 2, 1), mapper.replayScene(JsonObject(replay + ("visualContext" to crown))).base.visual)
    }
}
