package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import org.junit.Test
import kotlin.test.*

/** Exercises the same verified pack shipped by the importer. CI regenerates this pack before JVM
 * gates, so missing motion or FX contracts cannot silently turn the battle into static aliases. */
class CombatPackFixtureTest {
    @Test fun `generated authored pack builds and samples every canonical replay fixture`() {
        val pack = System.getenv("PKW_COMBAT_PACK")?.let(::File)
        val root = pack ?: File("../app/src/main/assets/native")
        val fixtureRoot = pack?.resolve("fixtures") ?: File("../app/src/debug/assets/native/fixtures")
        val reader = JsonReader(); val render = reader.parse(root.resolve("render-catalog.json").readText())
        val library = CombatArt.catalogue(render)
        assertTrue(library.isNotEmpty(), "The pinned pack must contain authored combat profiles")
        val catalog = reader.parse(root.resolve("catalogue.json").readText())
        val presentation = catalog.get("presentation")
        val constants = catalog.get("constants")
        val actorFrames = render.get("actors").filter { it.getInt("level", 1) == 1 }
            .associate { it.getString("type") to it.getString("frameKey") }
        val sourceBuildings = render.get("entries").toList()
        val fixtures = fixtureRoot.listFiles()!!.filter { it.extension == "json" && it.name !in setOf("base.json", "replay.json") }
        assertTrue(fixtures.isNotEmpty())
        for (fixture in fixtures) {
            val data = reader.parse(fixture.readText())
            val events = data.get("events").map { PresentationEvent.fromJson(it.toJson(JsonWriter.OutputType.json)) }
            val buildings = data.get("snapshot").get("buildings").mapNotNull { b ->
                val type = b.getString("type")
                val entry = sourceBuildings.firstOrNull { it.getString("type") == type && it.getInt("level") == b.getInt("level") }
                    ?: return@mapNotNull null // Wall geometry is covered by RendererContractsTest.
                val service=entry.takeIf { it.has("phaseE") }?.let(PhaseEServiceArt::entry)
                // Metadata-only services remain in the accepted replay; they never claim a legacy frame.
                RenderBuilding(b.getString("id"), if(service!=null)"service:$type:${b.getInt("level")}" else entry.getString("frameKey"),
                    b.getFloat("tx"),b.getFloat("ty"),entry.getFloat("footprintWidth"),entry.getFloat("footprintHeight"),
                    type=type,level=b.getInt("level"),service=service)
            }
            for(original in data.get("snapshot").get("buildings").filter { it.getString("type") in PhaseEServiceArt.facilities }) {
                val retained=buildings.single { it.id==original.getString("id") }
                assertNotNull(retained.service);assertNull(retained.initialHp);assertNull(retained.maxHp)
            }
            val scene = BattleScene(BaseScene(buildings, 32, 32, presentation.getFloat("tilePixels")),
                PresentationRevision(data.getString("id", fixture.nameWithoutExtension), "fixture", data.getInt("simVersion"), 0, 0, events), actorFrames,
                presentation.getFloat("unitsPerTile"), presentation.getFloat("tickMs"),
                constants.get("RAID_RULES").getInt("troopFireVisualTicks"),
                constants.get("TROOP_ABILITIES").get("hexbarrow").get("brood").getInt("positionKeyframeTicks"))
            val model = BattleVisualModel(events, scene.positionCadenceTicks, scene.summonedPositionCadenceTicks)
            val plan = CombatVisualPlan(scene, model, library); val output = mutableListOf<CombatSprite>()
            if (fixture.nameWithoutExtension in setOf("mixed_assault", "dragon_air", "electric_chain", "laser_beam")) {
                val proof = CpuCombatProof(root)
                val candidates = events.filter { it.e in setOf("fire", "troopFire", "attackRun") }.take(100).map { it.t + 6f }
                val strokes = mutableListOf<CombatStroke>()
                val strokeCandidates = events.filter { it.e in setOf("fire","chain") }.take(40).flatMap { event -> (0..80).map { event.t + it / 4f } }
                val strokeBest = strokeCandidates.maxByOrNull { candidate -> plan.transientStrokes(candidate,strokes);strokes.size }
                strokeBest?.let { plan.transientStrokes(it,strokes) }
                if(fixture.nameWithoutExtension == "electric_chain" && library.values.any { it.chain != null }) assertTrue(strokes.isNotEmpty(),"Canonical electric fixture must present chain strokes")
                if(fixture.nameWithoutExtension == "laser_beam" && library.values.any { art -> art.projectiles.values.any { it.stroke != null } }) assertTrue(strokes.isNotEmpty(),"Canonical laser fixture must present the released beam")
                val best = if(strokes.isNotEmpty()) requireNotNull(strokeBest) else candidates.maxByOrNull { candidate -> plan.transientSprites(candidate, output); output.size } ?: 0f
                proof.write(scene, model, plan, render, best, fixture.nameWithoutExtension)
                println("CPU visual proof ${fixture.nameWithoutExtension}: tick=$best; missing=${plan.missingCoverage.sorted()}")
            }
            for (tick in listOf(0f, model.finalTick / 3f, model.finalTick / 2f, model.finalTick.toFloat(), model.finalTick / 3f)) {
                model.actorIds.forEach { plan.actor(it, tick) }
                buildings.forEach { plan.building(it.id, tick) }
                plan.transientSprites(tick, output)
                assertTrue(output.all { it.x.isFinite() && it.y.isFinite() }, fixture.name)
            }
        }
        // These are synthetic presentation contracts, not simulator battles or reward fixtures.
        // The sweep timings/frames themselves come from the executed canonical web controller.
        for((hero,skill) in listOf("vex" to "doubleOrNothingHeads","theodor" to "silentButDeadly","vex" to "crimsonDash","vex" to "omegaShardstorm","vex" to "moonsunderWave","theodor" to "snotRocket","theodor" to "brownNote")) {
            val frame=actorFrames.getValue(hero)
            if(skill == "crimsonDash" && render.getInt("rendererContractVersion",2) >= 3)
                assertTrue(library[frame]?.heroEffects?.get("$skill:impact")?.effects?.any { it.travelTailMs != null } == true,
                    "Renderer contract3 must include canonical crimson dash travel; missing export is a regression")
            if(skill == "omegaShardstorm" && render.getInt("rendererContractVersion",2) >= 4) {
                val effects=requireNotNull(library[frame]?.heroEffects?.get("$skill:impact")) {
                    "Renderer contract4 must include canonical omega choreography; missing export is a regression"
                }.effects
                val count=constants.get("HERO_SKILLS").get("vex").get("omegaShardstorm").get("crescents").last().asInt()
                assertEquals(count,effects.count { it.travelOffset != null },"Every canonical crescent must have a captured world offset")
                assertEquals(1,effects.count { it.travelTailMs == null },"Omega retains its stationary nova alongside travelling crescents")
                assertEquals(count,effects.mapNotNull { it.travelOffset }.toSet().size,"Spokes must not duplicate one direction")
            }
            if(skill == "moonsunderWave" && render.getInt("rendererContractVersion",2) >= 6) {
                val effects=requireNotNull(library[frame]?.heroEffects?.get("$skill:impact")) {
                    "Renderer contract6 requires canonical Moonsunder travel and named-troop bleed"
                }.effects
                assertEquals(1,effects.count { it.rangePx!=null })
                assertEquals(constants.get("HERO_SKILLS").get("vex").get("moonsunderWave").getFloat("rangeTiles")*presentation.getFloat("tilePixels"),effects.single { it.rangePx!=null }.rangePx)
                assertEquals(1,effects.count { it.targetActorCenterAtCast })
            }
            if(skill == "snotRocket" && render.getInt("rendererContractVersion",2) >= 7) {
                val shot=requireNotNull(library[frame]?.heroEffects?.get("$skill:impact")) {
                    "Renderer contract7 requires canonical caster-origin Snot Rocket and absent-caster fallback"
                }.effects.single()
                assertNotNull(shot.actorToEventFallbackMs)
                assertNotNull(shot.travelTailMs)
                assertEquals(shot.clip.durationMs+shot.travelTailMs!!,shot.actorToEventFallbackMs!!,.01f)
            }
            if(render.get("combatCoverage")?.get("actorToEventHeroSkills")?.any { it.asString()==skill } == true) {
                val shot=requireNotNull(library[frame]?.heroEffects?.get("$skill:impact")) {
                    "Declared actor-origin hero family $skill must include its authored effect; missing art is a regression"
                }.effects.single()
                assertNotNull(shot.actorToEventFallbackMs);assertNotNull(shot.travelTailMs)
                assertEquals(shot.clip.durationMs+shot.travelTailMs!!,shot.actorToEventFallbackMs!!,.01f)
                if(skill=="brownNote") assertEquals("fx_theo_gasburst",shot.clip.key)
            }
            if(library[frame]?.heroEffects?.containsKey("$skill:impact") != true) continue
            val center=presentation.getFloat("unitsPerTile")*8
            val events=buildList {
                add("""{"e":"deploy","t":0,"id":1,"troop":"giant","hero":"$hero","x":$center,"y":$center}""")
                if(skill=="moonsunderWave") add("""{"e":"deploy","t":0,"id":2,"troop":"highlander","x":${center*1.25f},"y":$center}""")
                if(skill=="brownNote") {
                    add("""{"e":"hit","t":1,"target":"wall","dmg":1}""")
                    add("""{"e":"destroyed","t":1,"id":"wall"}""")
                }
                add("""{"e":"heroSkill","t":1,"id":1,"hero":"$hero","skill":"$skill","phase":"impact","x":${if(skill in setOf("snotRocket","brownNote")) center*1.5f else center},"y":$center,"fromX":$center,"fromY":$center,"toX":${center*1.5f},"toY":$center,"target":${if(skill=="brownNote") "\"wall\"" else "2"}}""")
                add("""{"e":"troopDeath","t":20,"id":1}""")
            }.map(PresentationEvent::fromJson)
            val baseBuildings=if(skill=="brownNote") {
                val wall=render.get("walls").first { it.getInt("level")==1 && it.getInt("mask")==0 }
                val width=wall.getFloat("footprintWidth");val height=wall.getFloat("footprintHeight")
                listOf(RenderBuilding("wall",wall.getString("frameKey"),12f-width/2,8f-height/2,width,height))
            } else emptyList()
            val scene=BattleScene(BaseScene(baseBuildings,16,16,presentation.getFloat("tilePixels")),
                PresentationRevision("synthetic-hero-contract","fixture",catalog.getInt("simVersion"),0,0,events),actorFrames,
                presentation.getFloat("unitsPerTile"),presentation.getFloat("tickMs"),10,10)
            val model=BattleVisualModel(events,10)
            val plan=CombatVisualPlan(scene,model,library)
            val effect=mutableListOf<CombatSprite>();plan.transientSprites(2f,effect)
            assertTrue(effect.isNotEmpty(),"Source hero sweep $skill must resolve actual artwork")
            CpuCombatProof(root).write(scene,model,plan,render,2f,"hero_contract_${hero}_$skill")
            if(skill == "crimsonDash") for(tick in listOf(1f,3.5f,6f,8f))
                CpuCombatProof(root).write(scene,model,plan,render,tick,"hero_dash_tick_${tick}")
            if(skill == "omegaShardstorm") {
                val specs=library.getValue(frame).heroEffects.getValue("$skill:impact").effects
                assertEquals(specs.size,effect.size,"All authored omega art must be present at the initial checkpoint")
                assertFalse(plan.missingCoverage.any { it.startsWith("heroEffects:$skill:") })
                for(tick in listOf(1f,3.5f,6f,8f))
                    CpuCombatProof(root).write(scene,model,plan,render,tick,"hero_omega_tick_${tick}")
            }
            if(skill == "moonsunderWave") {
                assertEquals(2,effect.size,"Both authored wave and named-troop bleed must be visible")
                assertFalse(plan.missingCoverage.any { it.startsWith("heroEffects:$skill:") })
                for(tick in listOf(1f,2.2f,3.5f,5.4f,6f,8f))
                    CpuCombatProof(root).write(scene,model,plan,render,tick,"hero_moonsunder_tick_${tick}")
            }
            if(skill in setOf("snotRocket","brownNote")) {
                val family=if(skill=="snotRocket") "snot" else "brown"
                assertEquals(1,effect.size)
                assertFalse(plan.missingCoverage.any { it.startsWith("heroEffects:$skill:") })
                for(tick in listOf(1f,2.2f,3.5f,5.4f,6f,8f))
                    CpuCombatProof(root).write(scene,model,plan,render,tick,"hero_${family}_tick_${tick}")
                val fallbackEvents=events.filter { it.e!="deploy" && it.e!="troopDeath" }
                val fallbackScene=scene.copy(revision=scene.revision.copy(events=fallbackEvents))
                val fallbackModel=BattleVisualModel(fallbackEvents,10)
                val fallbackPlan=CombatVisualPlan(fallbackScene,fallbackModel,library)
                fallbackPlan.transientSprites(1f,effect)
                assertEquals(1,effect.size,"Missing caster must retain the canonical stationary fallback")
                val fallbackEnd=1f+library.getValue(frame).heroEffects.getValue("$skill:impact").effects.single().actorToEventFallbackMs!!/scene.tickDurationMs
                for(tick in listOf(1f,3.5f,fallbackEnd))
                    CpuCombatProof(root).write(fallbackScene,fallbackModel,fallbackPlan,render,tick,"hero_${family}_fallback_tick_${tick}")
            }
            println("Synthetic hero CPU contract $hero/$skill: missing=${plan.missingCoverage.sorted()}")
        }
        if(render.getInt("rendererContractVersion",2)>=8) verifyFirestorm(root,render,catalog,library)
        if(render.getInt("rendererContractVersion",2)>=9) verifyMaul(root,render,catalog,library)
        if(render.getInt("rendererContractVersion",2)>=10) verifyHowl(root,render,catalog,library)
        if(render.getInt("rendererContractVersion",2)>=5) verifyBasePresentation(root,render)
    }

    private fun verifyFirestorm(root:File,render:com.badlogic.gdx.utils.JsonValue,catalog:com.badlogic.gdx.utils.JsonValue,library:Map<String,CombatArt>) {
        val presentation=catalog.get("presentation");val tile=presentation.getFloat("tilePixels");val unit=presentation.getFloat("unitsPerTile")
        val actors=render.get("actors").filter { it.getString("type")=="direwyvern" }
        assertTrue(actors.isNotEmpty())
        for(actor in actors) {
            val art=library.getValue(actor.getString("frameKey"));val fan=assertNotNull(art.firestorm)
            val body=art.clips.getValue(fan.bodyState)
            assertTrue(fan.pinFrames.all { it in 1..body.frames.first().size });assertTrue(art.atlases.contains(fan.clip.atlasPath))
        }
        val actor=actors.first { it.getInt("level")==1 };val art=library.getValue(actor.getString("frameKey"));val fan=art.firestorm!!
        val body=art.clips.getValue(fan.bodyState)
        val events=listOf("""{"e":"deploy","t":0,"id":1,"troop":"direwyvern","x":${8*unit},"y":${8*unit}}""",
            """{"e":"troopAbility","t":1,"id":1,"ability":"firestorm","x":${8*unit},"y":${8*unit},"ix":${12*unit},"iy":${8*unit}}""").map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(emptyList(),16,16,tile),PresentationRevision("firestorm","fixture",14,0,0,events),
            mapOf("direwyvern" to actor.getString("frameKey")),unit,presentation.getFloat("tickMs"),5,5)
        val model=BattleVisualModel(events,5);val plan=CombatVisualPlan(scene,model,library);val out=mutableListOf<CombatSprite>()
        assertFalse(plan.missingCoverage.any { it.contains("firestorm") })
        val release=1+(fan.pinFrames.first()-1)*1000f/body.fps/scene.tickDurationMs
        plan.transientSprites(release-.001f,out);assertTrue(out.isEmpty())
        for(tick in listOf(release,release+1,release+3,release+5,plan.playbackExtent.visualEndTick)) {
            plan.transientSprites(tick,out)
            if(tick==plan.playbackExtent.visualEndTick)assertTrue(out.isEmpty()) else assertEquals(1,out.size)
            CpuCombatProof(root).write(scene,model,plan,render,tick,"firestorm_current/dire_firestorm_tick_$tick")
        }
        verifyAllFirestormFacings(root,render,catalog,library,actors)
    }
    private fun verifyAllFirestormFacings(root:File,render:com.badlogic.gdx.utils.JsonValue,catalog:com.badlogic.gdx.utils.JsonValue,
        library:Map<String,CombatArt>,actors:List<com.badlogic.gdx.utils.JsonValue>) {
        val presentation=catalog.get("presentation");val tile=presentation.getFloat("tilePixels");val unit=presentation.getFloat("unitsPerTile")
        val tickMs=presentation.getFloat("tickMs")
        val sha={ file:File -> java.security.MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) } }
        val catalogSha=sha(root.resolve("render-catalog.json"))
        val prefix="firestorm_corrected/${catalogSha.take(16)}"
        val report=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
        report.addChild("scope",com.badlogic.gdx.utils.JsonValue("Synthetic CPU sprite-plan captures; manual visual review required. No GL, battle outcome or device performance claim."))
        report.addChild("renderCatalogueSha256",com.badlogic.gdx.utils.JsonValue(catalogSha))
        val captures=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.array);report.addChild("captures",captures)
        val sheets=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.array);report.addChild("contactSheets",sheets)
        val directions=mapOf("s" to (0 to 1),"sw" to (-1 to 1),"w" to (-1 to 0),"nw" to (-1 to -1),
            "n" to (0 to -1),"ne" to (1 to -1),"e" to (1 to 0),"se" to (1 to 1))
        val unique=actors.distinctBy { library.getValue(it.getString("frameKey")).let { art -> art.clips.getValue(art.firestorm!!.bodyState).key } }
        assertEquals(actors.map { it.getString("combatKey") }.toSet().size,unique.size,"Every distinct generated Firestorm profile needs a review row")
        val proof=CpuCombatProof(root)
        for(actor in unique) {
            val art=library.getValue(actor.getString("frameKey"));val fan=assertNotNull(art.firestorm);val body=art.clips.getValue(fan.bodyState)
            assertEquals(directions.keys,body.rowOrder.toSet());assertEquals(body.rowOrder.size,body.frames.size)
            val emitters=assertNotNull(body.emitters?.get(fan.emitter));assertEquals(body.rowOrder.size,emitters.size)
            for((row,frames) in body.frames.withIndex()) {
                assertEquals(frames.size,emitters.get(row).size)
                for(point in emitters.get(row))assertEquals(2,point.size,"Authored pins must never fall back to cell center")
            }
            assertTrue(art.atlases.containsAll(listOf(body.atlasPath,fan.clip.atlasPath)))
            val contact=mutableListOf<Pair<String,File>>()
            for((row,facing) in body.rowOrder.withIndex()) {
                val (dx,dy)=directions.getValue(facing)
                val events=listOf("""{"e":"deploy","t":0,"id":1,"troop":"direwyvern","x":${6*unit},"y":${6*unit}}""",
                    """{"e":"troopAbility","t":1,"id":1,"ability":"firestorm","x":${6*unit},"y":${6*unit},"ix":${(6+dx*4)*unit},"iy":${(6+dy*4)*unit}}""").map(PresentationEvent::fromJson)
                val scene=BattleScene(BaseScene(emptyList(),12,12,tile),PresentationRevision("firestorm-$facing","synthetic",14,0,0,events),
                    mapOf("direwyvern" to actor.getString("frameKey")),unit,tickMs,5,5)
                val model=BattleVisualModel(events,5);val plan=CombatVisualPlan(scene,model,library)
                assertFalse(plan.missingCoverage.any { it.contains("firestorm") })
                val pins=listOf(fan.pinFrames.first(),fan.pinFrames[fan.pinFrames.size/2],fan.pinFrames.last())
                val samples=listOf("release","middle-key","last-key").zip(pins.map { Math.nextUp(1+(it-1)*1000f/body.fps/tickMs) })+
                    ("expiry" to plan.playbackExtent.visualEndTick)
                val out=mutableListOf<CombatSprite>()
                for((index,sample) in samples.withIndex()) {
                    val (label,tick)=sample;plan.transientSprites(tick,out)
                    if(index==pins.size) assertTrue(out.isEmpty(),"$facing must expire at its finite tail")
                    else {
                        val actorSprite=assertNotNull(plan.actor(1,tick));assertEquals(body.frames[row][pins[index]-1],actorSprite.frameKey)
                        val sprite=out.single();assertEquals(fan.clip.key,sprite.clip.key)
                        val point=body.emitter(fan.emitter,row,pins[index]-1)
                        assertEquals(6*tile+(point.first-body.anchorX*body.cellWidth)*body.scale,sprite.x,.002f)
                        assertEquals(6*tile+(point.second-body.anchorY*body.cellHeight)*body.scale,sprite.y,.002f)
                    }
                    val file=proof.write(scene,model,plan,render,tick,"$prefix/${body.key}_${facing}_$label",pixels=(12*tile).toInt())
                    contact+="$facing $label t=$tick" to file
                    val record=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
                    for((key,value) in mapOf("body" to body.key,"facing" to facing,"checkpoint" to label,"file" to file.canonicalPath,"sha256" to sha(file))) record.addChild(key,com.badlogic.gdx.utils.JsonValue(value))
                    record.addChild("tick",com.badlogic.gdx.utils.JsonValue(tick.toDouble()));captures.addChild(record)
                }
                // Scrubbing from expiry must rebuild the exact first attached frame, without hidden retained FX.
                plan.transientSprites(samples.first().second,out);assertEquals(1,out.size)
            }
            val sheet=proof.contactSheet(contact,4,"${body.key} | CPU only | $catalogSha","$prefix/${body.key}_contact")
            val record=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
            record.addChild("file",com.badlogic.gdx.utils.JsonValue(sheet.canonicalPath));record.addChild("sha256",com.badlogic.gdx.utils.JsonValue(sha(sheet)));sheets.addChild(record)
        }
        val destination=File("../.reports/visual/combat/$prefix/capture-receipt.json");destination.parentFile.mkdirs()
        destination.writeText(report.prettyPrint(com.badlogic.gdx.utils.JsonValue.PrettyPrintSettings().apply { outputType=JsonWriter.OutputType.json }))
    }
    private fun verifyMaul(root:File,render:com.badlogic.gdx.utils.JsonValue,catalog:com.badlogic.gdx.utils.JsonValue,
        library:Map<String,CombatArt>) {
        val presentation=catalog.get("presentation");val tile=presentation.getFloat("tilePixels")
        val unit=presentation.getFloat("unitsPerTile");val tickMs=presentation.getFloat("tickMs")
        val cadence=catalog.get("constants").get("RAID_RULES").getInt("troopFireVisualTicks")
        val actors=render.get("actors").filter { it.getString("type")=="direwyvern" }
        assertTrue(actors.isNotEmpty(),"Renderer9 must admit the Maul actor family")
        val unique=actors.distinctBy { library.getValue(it.getString("frameKey")).let { a->a.clips.getValue(assertNotNull(a.maul).bodyState).key } }
        assertEquals(4,unique.size,"All four authored Direwyvern tiers need actual-asset evidence")
        assertEquals(actors.map { it.getString("combatKey") }.toSet().size,unique.size)
        assertTrue(render.get("combatCoverage").get("troopAbilityControllers").any { it.asString()=="direwyvern:maul" })
        val directions=mapOf("s" to (0 to 1),"sw" to (-1 to 1),"w" to (-1 to 0),"nw" to (-1 to -1),
            "n" to (0 to -1),"ne" to (1 to -1),"e" to (1 to 0),"se" to (1 to 1))
        val sha={ f:File->java.security.MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) } }
        val catalogSha=sha(root.resolve("render-catalog.json"));val prefix="maul/${catalogSha.take(16)}"
        val report=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
        report.addChild("scope",com.badlogic.gdx.utils.JsonValue("Synthetic targetless Maul CPU sprite-plan captures. Manual visual review required; no GL, outcome or performance claim."))
        report.addChild("renderCatalogueSha256",com.badlogic.gdx.utils.JsonValue(catalogSha))
        val captures=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.array);report.addChild("captures",captures)
        val sheets=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.array);report.addChild("contactSheets",sheets)
        fun tickAt(ms:Float):Float { val tick=ms/tickMs;return if(tick*tickMs<ms)Math.nextUp(tick) else tick }
        fun tickBefore(ms:Float):Float { var tick=ms/tickMs;while(tick*tickMs>=ms)tick=Math.nextDown(tick);return tick }
        val proof=CpuCombatProof(root)
        for(actor in unique) {
            val art=library.getValue(actor.getString("frameKey"));val maul=assertNotNull(art.maul)
            val body=art.clips.getValue(maul.bodyState)
            assertEquals(directions.keys,body.rowOrder.toSet());assertEquals(body.rowOrder.size,body.frames.size)
            assertTrue(maul.releaseFrame in 1..body.frames.first().size)
            assertTrue(maul.clip.durationMs>maul.secondDelayMs,"Canonical wings visibly overlap before either expires")
            assertTrue(art.atlases.containsAll(listOf(body.atlasPath,maul.clip.atlasPath)))
            for(path in listOf(body.atlasPath,maul.clip.atlasPath)) assertTrue(root.resolve(path).isFile,"Required Maul atlas missing: $path")
            val firstMs=tickMs+(maul.releaseFrame-1)*1000f/body.fps;val secondMs=firstMs+maul.secondDelayMs
            val firstEndMs=firstMs+maul.clip.durationMs;val effectEndMs=secondMs+maul.clip.durationMs
            val contact=mutableListOf<Pair<String,File>>()
            for((row,facing) in body.rowOrder.withIndex()) {
                val (dx,dy)=directions.getValue(facing)
                // Real prior position movement establishes facing. The canonical Maul cue
                // itself has no ix/iy and remains the final event; no fabricated horizon.
                val events=listOf("""{"e":"deploy","t":0,"id":1,"troop":"direwyvern","x":${(6-dx)*unit},"y":${(6-dy)*unit}}""",
                    """{"e":"pos","t":1,"id":1,"x":${6*unit},"y":${6*unit}}""",
                    """{"e":"troopAbility","t":1,"id":1,"ability":"maul","x":${6*unit},"y":${6*unit}}""").map(PresentationEvent::fromJson)
                val scene=BattleScene(BaseScene(emptyList(),12,12,tile),PresentationRevision("maul-$facing","synthetic",14,0,0,events),
                    mapOf("direwyvern" to actor.getString("frameKey")),unit,tickMs,cadence,cadence)
                val model=BattleVisualModel(events,cadence);val plan=CombatVisualPlan(scene,model,library)
                assertFalse(plan.missingCoverage.any { it.contains("maul") });assertEquals(1f,plan.playbackExtent.eventEndTick)
                assertTrue(plan.playbackExtent.visualEndTick.isFinite())
                assertEquals(tickAt(maxOf(tickMs+body.durationMs,effectEndMs)),plan.playbackExtent.visualEndTick)
                assertEquals(body.frames[row].first(),assertNotNull(plan.actor(1,1f)).frameKey,"Targetless cast retains $facing")
                val out=mutableListOf<CombatSprite>()
                plan.transientSprites(tickBefore(firstMs),out);assertTrue(out.isEmpty())
                plan.transientSprites(tickBefore(secondMs),out);assertEquals(1,out.size)
                val samples=listOf("cast" to 1f,"first-release" to tickAt(firstMs),"second-release" to tickAt(secondMs),
                    "first-expiry" to tickAt(firstEndMs),"effect-expiry" to tickAt(effectEndMs),"all-expiry" to plan.playbackExtent.visualEndTick)
                for((label,tick) in samples) {
                    plan.transientSprites(tick,out)
                    val expected=when(label) { "cast","effect-expiry","all-expiry"->0;"second-release"->2;else->1 }
                    assertEquals(expected,out.size,"${body.key} $facing $label")
                    assertTrue(out.all { it.clip.key==maul.clip.key && it.x.isFinite() && it.y.isFinite() && it.depth.isFinite() })
                    if(out.isNotEmpty()) {
                        val offsets=if(label=="first-expiry") listOf(maul.rightOffsetX) else if(expected==2) listOf(maul.leftOffsetX,maul.rightOffsetX) else listOf(maul.leftOffsetX)
                        assertEquals(offsets.map { 6*tile+it },out.map { it.x })
                        out.forEach { sprite->assertEquals(6*tile+maul.groundOffsetY,sprite.y);assertEquals(6*tile+maul.depthOffset,sprite.depth) }
                    }
                    if(label=="first-release" || label=="second-release")
                        assertEquals(maul.clip.frames.first().first(),out.last().frameKey,"Every wing starts its own authored clip clock")
                    if(label=="all-expiry") {
                        val standing=assertNotNull(plan.actor(1,tick))
                        assertTrue(standing.frameKey in standing.clip.frames[standing.clip.row(facing)],"Rest after targetless Maul retains $facing")
                    }
                    val file=proof.write(scene,model,plan,render,tick,"$prefix/${body.key}_${facing}_$label",pixels=(12*tile).toInt())
                    contact+="$facing $label t=$tick" to file
                    val record=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
                    for((key,value) in mapOf("body" to body.key,"facing" to facing,"checkpoint" to label,"file" to file.canonicalPath,"sha256" to sha(file))) record.addChild(key,com.badlogic.gdx.utils.JsonValue(value))
                    for((key,value) in mapOf("tick" to tick,"eventEndTick" to plan.playbackExtent.eventEndTick,"visualEndTick" to plan.playbackExtent.visualEndTick)) record.addChild(key,com.badlogic.gdx.utils.JsonValue(value.toDouble()))
                    record.addChild("impactCount",com.badlogic.gdx.utils.JsonValue(expected.toLong()));captures.addChild(record)
                }
                plan.transientSprites(tickAt(secondMs),out);val restored=out.toList();assertEquals(2,restored.size)
                plan.transientSprites(plan.playbackExtent.visualEndTick,out);assertTrue(out.isEmpty())
                plan.transientSprites(tickAt(secondMs),out);assertEquals(restored,out,"Seeking after expiry reconstructs exactly the two original impacts")
            }
            val sheet=proof.contactSheet(contact,6,"${body.key} | CPU only | $catalogSha","$prefix/${body.key}_contact")
            val record=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
            record.addChild("file",com.badlogic.gdx.utils.JsonValue(sheet.canonicalPath));record.addChild("sha256",com.badlogic.gdx.utils.JsonValue(sha(sheet)));sheets.addChild(record)
        }
        assertEquals(4*8*6,captures.size)
        val destination=File("../.reports/visual/combat/$prefix/capture-receipt.json");destination.parentFile.mkdirs()
        destination.writeText(report.prettyPrint(com.badlogic.gdx.utils.JsonValue.PrettyPrintSettings().apply { outputType=JsonWriter.OutputType.json }))
    }
    private fun verifyHowl(root:File,render:com.badlogic.gdx.utils.JsonValue,catalog:com.badlogic.gdx.utils.JsonValue,
        library:Map<String,CombatArt>) {
        val presentation=catalog.get("presentation");val tile=presentation.getFloat("tilePixels")
        val unit=presentation.getFloat("unitsPerTile");val tickMs=presentation.getFloat("tickMs")
        val cadence=catalog.get("constants").get("RAID_RULES").getInt("troopFireVisualTicks")
        val actors=render.get("actors").filter { it.getString("type")=="gloamfang" }
        assertTrue(actors.isNotEmpty(),"Renderer10 must admit the Howl actor family")
        actors.forEach { assertNotNull(library.getValue(it.getString("frameKey")).howl) }
        val unique=actors.distinctBy { library.getValue(it.getString("frameKey")).let { a->a.clips.getValue(assertNotNull(a.howl).bodyState).key } }
        assertEquals(4,unique.size,"Every authored Gloamfang tier needs actual-art evidence")
        assertTrue(render.get("combatCoverage").get("troopAbilityControllers").any { it.asString()=="gloamfang:howl" })
        val directions=mapOf("s" to (0 to 1),"sw" to (-1 to 1),"w" to (-1 to 0),"nw" to (-1 to -1),
            "n" to (0 to -1),"ne" to (1 to -1),"e" to (1 to 0),"se" to (1 to 1))
        val sha={ f:File->java.security.MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) } }
        val catalogSha=sha(root.resolve("render-catalog.json"));val prefix="howl/${catalogSha.take(16)}"
        val report=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
        report.addChild("scope",com.badlogic.gdx.utils.JsonValue("Synthetic Howl CPU sprite-plan captures, targetless and aimed east. Manual visual review required; no GL, outcome or performance claim."))
        report.addChild("checkpointClock",com.badlogic.gdx.utils.JsonValue("Authored relative boundaries are computed in Double. Captures choose the first Float tick whose actual Float elapsed time reaches that boundary, matching the web fixture's post-boundary side. This aligns comparison clocks; it does not change production Float scheduling or eliminate its sub-millisecond body/effect clock differences."))
        report.addChild("renderCatalogueSha256",com.badlogic.gdx.utils.JsonValue(catalogSha))
        val earlySpawnChecks=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.array);report.addChild("earlySpawnChecks",earlySpawnChecks)
        val captures=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.array);report.addChild("captures",captures)
        val sheets=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.array);report.addChild("contactSheets",sheets)
        fun tickAt(ms:Float):Float { val tick=ms/tickMs;return if(tick*tickMs<ms)Math.nextUp(tick) else tick }
        fun tickBefore(ms:Float):Float { var tick=ms/tickMs;while(tick*tickMs>=ms)tick=Math.nextDown(tick);return tick }
        val proof=CpuCombatProof(root)
        for(actor in unique) {
            val art=library.getValue(actor.getString("frameKey"));val howl=assertNotNull(art.howl)
            val body=art.clips.getValue(howl.bodyState)
            assertEquals(directions.keys,body.rowOrder.toSet());assertEquals(body.rowOrder.size,body.frames.size)
            assertTrue(howl.releaseFrame in 1..body.frames.first().size)
            assertFalse(howl.clip.loop);assertTrue(howl.clip.durationMs>0)
            for(path in listOf(body.atlasPath,howl.clip.atlasPath)) {
                assertTrue(path in art.atlases);assertTrue(root.resolve(path).isFile,"Missing Howl art: $path")
            }
            val spawn=art.clips.getValue(art.profile.getString("spawn"))
            assertTrue(spawn.durationMs>0)
            // The accepted web fixture completed the real spawn before onPos.
            // The former CPU deploy0/pos1/Howl1 prelude instead moved during
            // spawning, when the canonical controller preserves south facing.
            // Deliver movement strictly after spawn, then cast at its endpoint.
            val movementStartTick=kotlin.math.floor((spawn.durationMs/tickMs).toDouble()).toInt()+1
            val castTick=movementStartTick+cadence
            val castMs=castTick*tickMs
            fun tickAtElapsed(requested:Double):Float {
                fun actual(tick:Float)=(tick*tickMs-castMs).toDouble()
                var tick=((castMs.toDouble()+requested)/tickMs.toDouble()).toFloat()
                while(actual(tick)<requested)tick=Math.nextUp(tick)
                while(actual(Math.nextDown(tick))>=requested)tick=Math.nextDown(tick)
                assertTrue(actual(tick)>=requested)
                assertTrue(actual(Math.nextDown(tick))<requested,"Capture uses the first representable native elapsed time at the authored boundary")
                return tick
            }
            val releaseElapsedMs=(howl.releaseFrame-1)*1000.0/body.fps.toDouble()
            val effectDurationMs=howl.clip.frames.first().size*1000.0/howl.clip.fps.toDouble()
            val bodyDurationMs=body.frames.first().size*1000.0/body.fps.toDouble()
            val releaseMs=castMs+(howl.releaseFrame-1)*1000f/body.fps
            val effectEndMs=releaseMs+howl.clip.durationMs;val bodyEndMs=castMs+body.durationMs
            if(art.leap!=null && art.lunge!=null) {
                val earlyTick=if(spawn.durationMs>tickMs) 1 else 0
                val earlyEvents=listOf(
                    """{"e":"deploy","t":0,"id":1,"troop":"gloamfang","x":${5*unit},"y":${6*unit}}""",
                    """{"e":"pos","t":$earlyTick,"id":1,"x":${6*unit},"y":${6*unit}}""",
                    """{"e":"troopAbility","t":$earlyTick,"id":1,"ability":"howl","x":${6*unit},"y":${6*unit}}""",
                ).map(PresentationEvent::fromJson)
                val earlyScene=BattleScene(BaseScene(emptyList(),12,12,tile),PresentationRevision("howl-during-spawn","synthetic",14,0,0,earlyEvents),
                    mapOf("gloamfang" to actor.getString("frameKey")),unit,tickMs,cadence,cadence)
                val earlyPlan=CombatVisualPlan(earlyScene,BattleVisualModel(earlyEvents,cadence),library)
                val earlyPose=assertNotNull(earlyPlan.actor(1,earlyTick.toFloat()))
                assertEquals(body.frames[body.row("s")].first(),earlyPose.frameKey,
                    "Movement during the authored spawn cannot turn a targetless Howl east")
                val check=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
                check.addChild("body",com.badlogic.gdx.utils.JsonValue(body.key))
                check.addChild("expectedFacing",com.badlogic.gdx.utils.JsonValue("s"))
                check.addChild("frame",com.badlogic.gdx.utils.JsonValue(earlyPose.frameKey))
                check.addChild("tick",com.badlogic.gdx.utils.JsonValue(earlyTick.toLong()));earlySpawnChecks.addChild(check)
            }
            for(aimed in listOf(false,true)) {
                val mode=if(aimed) "aimed-east" else "targetless"
                val contact=mutableListOf<Pair<String,File>>()
                for(facing in body.rowOrder) {
                    val (dx,dy)=directions.getValue(facing);val expectedFacing=if(aimed) "e" else facing
                    // A prior canonical position establishes heading. Targetless Howl
                    // has no endpoint; an explicit east endpoint is only a visual branch probe.
                    val aim=if(aimed) ",\"ix\":${8*unit},\"iy\":${6*unit}" else ""
                    val events=listOf("""{"e":"deploy","t":0,"id":1,"troop":"gloamfang","x":${(6-dx)*unit},"y":${(6-dy)*unit}}""",
                        """{"e":"pos","t":$castTick,"id":1,"x":${6*unit},"y":${6*unit}}""",
                        """{"e":"troopAbility","t":$castTick,"id":1,"ability":"howl","x":${6*unit},"y":${6*unit}$aim}""").map(PresentationEvent::fromJson)
                    assertEquals(movementStartTick.toFloat(),PositionDelivery.compile(events,cadence,cadence,tickMs).getValue(1).startTick)
                    val scene=BattleScene(BaseScene(emptyList(),12,12,tile),PresentationRevision("howl-$mode-$facing","synthetic",14,0,0,events),
                        mapOf("gloamfang" to actor.getString("frameKey")),unit,tickMs,cadence,cadence)
                    val model=BattleVisualModel(events,cadence);val plan=CombatVisualPlan(scene,model,library)
                    assertFalse(plan.missingCoverage.any { it.contains("howl") })
                    assertEquals(castTick.toFloat(),plan.playbackExtent.eventEndTick)
                    assertEquals(tickAt(maxOf(effectEndMs,bodyEndMs)),plan.playbackExtent.visualEndTick)
                    assertEquals(body.frames[body.row(expectedFacing)].first(),assertNotNull(plan.actor(1,castTick.toFloat())).frameKey)
                    val out=mutableListOf<CombatSprite>()
                    plan.transientSprites(tickBefore(releaseMs),out);assertTrue(out.isEmpty())
                    plan.transientSprites(tickBefore(effectEndMs),out);assertEquals(1,out.size)
                    val samples=listOf("cast" to 0.0,"release" to releaseElapsedMs,"mid" to releaseElapsedMs+effectDurationMs/2,
                        "effect-expiry" to releaseElapsedMs+effectDurationMs,"body-expiry" to bodyDurationMs)
                        .map { (label,requested) -> Triple(label,tickAtElapsed(requested),requested) }
                    for((label,tick,requestedElapsedMs) in samples) {
                        plan.transientSprites(tick,out)
                        val expected=if(tick*tickMs>=releaseMs && tick*tickMs<effectEndMs) 1 else 0
                        assertEquals(expected,out.size,"${body.key} $mode $facing $label")
                        out.forEach { ring->
                            assertEquals(howl.clip.key,ring.clip.key);assertEquals(6*tile+howl.offsetX,ring.x)
                            assertEquals(6*tile+howl.offsetY,ring.y);assertEquals(6*tile+howl.depthOffset,ring.depth)
                            assertEquals(0f,ring.rotation);assertTrue(ring.x.isFinite()&&ring.y.isFinite()&&ring.depth.isFinite())
                        }
                        if(label=="release") assertEquals(howl.clip.frames.first().first(),out.single().frameKey)
                        val actorPose=assertNotNull(plan.actor(1,tick))
                        if(label=="body-expiry") assertTrue(actorPose.frameKey in actorPose.clip.frames[actorPose.clip.row(expectedFacing)],"Howl rest retains $expectedFacing")
                        val file=proof.write(scene,model,plan,render,tick,"$prefix/${body.key}_${mode}_${facing}_$label",pixels=(12*tile).toInt())
                        contact+="$facing $label t=$tick" to file
                        val record=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
                        for((key,value) in mapOf("body" to body.key,"initialFacing" to facing,"expectedFacing" to expectedFacing,"mode" to mode,"checkpoint" to label,"file" to file.canonicalPath,"sha256" to sha(file))) record.addChild(key,com.badlogic.gdx.utils.JsonValue(value))
                        for((key,value) in mapOf("tick" to tick,"eventEndTick" to plan.playbackExtent.eventEndTick,"visualEndTick" to plan.playbackExtent.visualEndTick)) record.addChild(key,com.badlogic.gdx.utils.JsonValue(value.toDouble()))
                        fun spriteMetadata(sprite:CombatSprite):com.badlogic.gdx.utils.JsonValue {
                            val value=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
                            for((key,text) in mapOf("frame" to sprite.frameKey,"atlasPath" to sprite.clip.atlasPath)) value.addChild(key,com.badlogic.gdx.utils.JsonValue(text))
                            for((key,number) in mapOf("x" to sprite.x,"y" to sprite.y,"depth" to sprite.depth,"scaleX" to sprite.horizontalScale,
                                "scaleY" to sprite.clip.scale,"rotationDegrees" to sprite.rotation,"alpha" to sprite.alpha)) value.addChild(key,com.badlogic.gdx.utils.JsonValue(number.toDouble()))
                            value.addChild("flipX",com.badlogic.gdx.utils.JsonValue(sprite.flipX))
                            return value
                        }
                        record.addChild("castTick",com.badlogic.gdx.utils.JsonValue(castTick.toLong()))
                        record.addChild("movementStartTick",com.badlogic.gdx.utils.JsonValue(movementStartTick.toLong()))
                        record.addChild("spawnDurationMs",com.badlogic.gdx.utils.JsonValue(spawn.durationMs.toDouble()))
                        record.addChild("elapsedSinceCastMs",com.badlogic.gdx.utils.JsonValue((tick*tickMs-castMs).toDouble()))
                        record.addChild("requestedElapsedSinceCastMs",com.badlogic.gdx.utils.JsonValue(requestedElapsedMs))
                        record.addChild("checkpointQuantizationDeltaMs",com.badlogic.gdx.utils.JsonValue((tick*tickMs-castMs).toDouble()-requestedElapsedMs))
                        record.addChild("actorPose",spriteMetadata(actorPose))
                        val rings=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.array)
                        out.forEach { rings.addChild(spriteMetadata(it)) };record.addChild("rings",rings)
                        record.addChild("ringCount",com.badlogic.gdx.utils.JsonValue(out.size.toLong()));captures.addChild(record)
                    }
                    plan.transientSprites(tickAtElapsed(releaseElapsedMs),out);val released=out.toList()
                    plan.transientSprites(plan.playbackExtent.visualEndTick,out);assertTrue(out.isEmpty())
                    plan.transientSprites(tickAtElapsed(releaseElapsedMs),out);assertEquals(released,out,"Seek restores one original ring without callback replay")
                }
                val sheet=proof.contactSheet(contact,5,"${body.key} $mode | CPU only | $catalogSha","$prefix/${body.key}_${mode}_contact")
                val record=com.badlogic.gdx.utils.JsonValue(com.badlogic.gdx.utils.JsonValue.ValueType.`object`)
                record.addChild("file",com.badlogic.gdx.utils.JsonValue(sheet.canonicalPath));record.addChild("sha256",com.badlogic.gdx.utils.JsonValue(sha(sheet)));sheets.addChild(record)
            }
        }
        assertEquals(4*8*2*5,captures.size);assertEquals(4*2,sheets.size)
        assertEquals(unique.count { library.getValue(it.getString("frameKey")).let { a->a.leap!=null && a.lunge!=null } },earlySpawnChecks.size)
        val destination=File("../.reports/visual/combat/$prefix/capture-receipt.json");destination.parentFile.mkdirs()
        destination.writeText(report.prettyPrint(com.badlogic.gdx.utils.JsonValue.PrettyPrintSettings().apply { outputType=JsonWriter.OutputType.json }))
    }
    private fun verifyBasePresentation(root: File,render: com.badlogic.gdx.utils.JsonValue) {
        val rules=BasePresentation.parse(requireNotNull(render.get("basePresentation")) {
            "Renderer contract5 must include canonical base job and operating presentation"
        })
        assertTrue(rules.jobs.builders.isNotEmpty());assertTrue(rules.workingTypes.isNotEmpty())
        val entries=cpuStaticBuildingEntries(render);val library=CombatArt.catalogue(render)
        fun building(type: String,x: Float,level: Int=1): RenderBuilding {
            val entry=entries.first { it.getString("type")==type && it.getInt("level")==level }
            return RenderBuilding(type,entry.getString("frameKey"),x,3f,entry.getFloat("footprintWidth"),entry.getFloat("footprintHeight"),type=type,level=level)
        }
        val wallEntry=render.get("walls").first { it.getInt("level")==1 && it.getInt("mask")==0 }
        val wallRun=(9..11).map { x -> RenderBuilding("wall-$x",wallEntry.getString("frameKey"),x.toFloat(),8f,
            wallEntry.getFloat("footprintWidth"),wallEntry.getFloat("footprintHeight"),type="wall",level=1) }
        val buildings=listOf(building("keep",1f),building("mine",5f),building("cannon",8f),building("forge",11f))+wallRun
        val connected=WallVisualModel(buildings,WallCatalogue(render))
        wallRun.forEach { assertNotEquals(it.frameKey,connected.frameAt(it.id,0f),"CPU base proofs must draw connected aliases, not isolated input frames") }
        val offsets=entries.associate { it.getString("frameKey") to (it.getFloat("offsetX",0f) to it.getFloat("offsetY",0f)) }
        val jobs=buildings.filter { it.type in setOf("mine","cannon") }.map {
            RenderJob("job-${it.id}",if(it.type=="mine")"upgrade"else"build",it.tileX,it.tileY,it.footprintWidth,it.footprintHeight,0,10000,it.id)
        }
        val obstacle=render.get("basePresentation").get("obstacles").first()
        val scene=BaseScene(buildings,16,10,rules.tilePixels,baseId="synthetic-base-art",jobs=jobs,keepLevel=rules.jobs.builders.keys.min(),
            obstacles=listOf(RenderObstacle("tree",obstacle.getString("frameKey"),5f,7f,obstacle.getFloat("footprintWidth"),obstacle.getFloat("footprintHeight"))))
        val model=BaseVisualModel(scene,library,rules,0,seatOffsets=offsets)
        for(b in buildings.filter { it.type!="wall" }) assertNotNull(model.building(b.id,200),"Canonical ${b.type} must animate or use authored idle fallback")
        assertTrue(model.building("forge",200)!!.clip.key.contains("work"),"Resources operate without a research/job prerequisite")
        val expected=mutableListOf<BaseVisualSprite>();val actual=mutableListOf<BaseVisualSprite>()
        model.jobs(15000,expected);model.jobs(200,actual);model.jobs(15000,actual);assertEquals(expected,actual)
        assertEquals(jobs.size*2,expected.size,"Past deadlines must retain both source scaffold and builder until authoritative refresh")
        for(at in listOf(0L,(rules.jobs.travelMs/2).toLong(),rules.jobs.travelMs.toLong(),15000L))
            CpuCombatProof(root).writeBase(scene,model,render,at,"construction_$at")
        val completed=scene.copy(buildings=buildings.map { if(it.type=="mine")building("mine",5f,2)else it },jobs=emptyList())
        val after=BaseVisualModel(completed,library,rules,16000,model,offsets)
        assertTrue(after.building("mine",16000)!!.clip.key.contains("levelup"))
        CpuCombatProof(root).writeBase(completed,after,render,16000,"upgrade_confirmed")
        CpuCombatProof(root).writeBase(completed,after,render,20000,"operating")
    }
}
