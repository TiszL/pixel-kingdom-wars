package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.*
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Closed, test-only fixtures: adding a family requires reviewed event construction. */
internal enum class OfflineHeroGlFixture(val mode: String,val label: String,val hero: String,val skill: String,
    val minimumContract: Int,val ticks: List<Float>,val missingCaster: Boolean=false,val terminalAtCast: Boolean=false) {
    MOONSUNDER("moonsunder-gl","MOONSUNDER","vex","moonsunderWave",6,listOf(1f,2.2f,3.5f,5.4f,6f,8f)),
    SNOT_ROCKET("snot-gl","SNOT ROCKET · ACTIVE CASTER","theodor","snotRocket",7,listOf(1f,2.2f,3.5f,5.4f,6f,8f)),
    SNOT_MISSING_CASTER("snot-fallback-gl","SNOT ROCKET · MISSING CASTER","theodor","snotRocket",7,listOf(1f,3.5f,6.6f),true,true),
    SNOT_TERMINAL("snot-terminal-gl","SNOT ROCKET · FINAL EVENT","theodor","snotRocket",7,listOf(1f,2.2f,3.5f,5.4f,6f,8f),terminalAtCast=true),
    BROWN_NOTE("brown-gl","BROWN NOTE · WALL BREACH","theodor","brownNote",7,listOf(1f,2.2f,3.5f,5.4f,6f,8f),terminalAtCast=true),
    BROWN_MISSING_CASTER("brown-fallback-gl","BROWN NOTE · MISSING CASTER","theodor","brownNote",7,listOf(1f,3.5f,7f),true,true),
    FIRESTORM("firestorm-gl","FIRESTORM · BUILDING CENTRE","direwyvern","firestorm",8,emptyList(),terminalAtCast=true),
    FIRESTORM_FALLBACK("firestorm-fallback-gl","FIRESTORM · EVENT TARGET","direwyvern","firestorm",8,emptyList(),terminalAtCast=true),
    MAUL("maul-gl","MAUL · STAGGERED WING IMPACTS","direwyvern","maul",9,emptyList(),terminalAtCast=true),
    HOWL("howl-gl","HOWL · RETAINED SOUTH","gloamfang","howl",10,emptyList(),terminalAtCast=true),
    HOWL_AIMED("howl-aimed-gl","HOWL · AIMED EAST","gloamfang","howl",10,emptyList(),terminalAtCast=true);

    fun events(center: Float): List<PresentationEvent> = buildList {
        if(skill=="howl") {
            add("""{"e":"deploy","t":0,"id":1,"troop":"gloamfang","x":$center,"y":$center}""")
            val aim=if(this@OfflineHeroGlFixture==HOWL_AIMED) ",\"ix\":${center*1.5f},\"iy\":$center" else ""
            add("""{"e":"troopAbility","t":1,"id":1,"ability":"howl","x":$center,"y":$center$aim}""")
            return@buildList
        }
        if(skill=="maul") {
            add("""{"e":"deploy","t":0,"id":1,"troop":"direwyvern","x":$center,"y":$center}""")
            // Canonical Maul has a cast origin and no aimed target. Its final event
            // must still allow both authored impacts to finish without fake clocks.
            add("""{"e":"troopAbility","t":1,"id":1,"ability":"maul","x":$center,"y":$center}""")
            return@buildList
        }
        if(skill=="firestorm") {
            add("""{"e":"deploy","t":0,"id":1,"troop":"direwyvern","x":$center,"y":$center}""")
            add("""{"e":"troopAbility","t":1,"id":1,"ability":"firestorm","x":$center,"y":$center,"ix":${center*1.5f},"iy":$center,"targetBuildingId":"fan-target"}""")
            return@buildList
        }
        if(!missingCaster)
            add("""{"e":"deploy","t":0,"id":1,"troop":"giant","hero":"$hero","x":$center,"y":$center}""")
        if(this@OfflineHeroGlFixture==MOONSUNDER)
            add("""{"e":"deploy","t":0,"id":2,"troop":"highlander","x":${center*1.25f},"y":$center}""")
        if(skill=="brownNote") {
            // Synthetic cues retain canonical wall damage/destruction before the visual effect.
            add("""{"e":"hit","t":1,"target":"wall","dmg":1}""")
            add("""{"e":"destroyed","t":1,"id":"wall"}""")
        }
        add("""{"e":"heroSkill","t":1,"id":1,"hero":"$hero","skill":"$skill","phase":"impact","x":${if(this@OfflineHeroGlFixture==MOONSUNDER) center else center*1.5f},"y":$center,"fromX":$center,"fromY":$center,"toX":${center*1.5f},"toY":$center,"target":${if(skill=="brownNote") "\"wall\"" else "2"}}""")
        if(!missingCaster && !terminalAtCast) add("""{"e":"troopDeath","t":20,"id":1}""")
        // Terminal fixtures end on the skill itself. Authored FX must finish beyond eventEndTick
        // without a fake rally, actor death, result or timeline marker.
    }.map(PresentationEvent::fromJson)
}

/** Explicit test-host composition, using production KingdomSurface/GL rendering.
 * No sessions, network, arbitrary asset replacement, timer acceleration or results. */
internal object MoonsunderGlHarness {
    fun capture(instrumentation: Instrumentation,fixture: OfflineHeroGlFixture) {
        check(BuildConfig.DEBUG && Build.HARDWARE=="ranchu")
        val context=instrumentation.targetContext
        val directory=File(context.noBackupFilesDir,fixture.mode)
        check(directory.mkdir()) { "Preserve prior GL evidence before rerunning" }
        var activity: MainActivity?=null
        var stage="launch-offline-preview"
        val files=mutableListOf<JsonObject>()
        var manifest: JsonObject?=null
        var sourceEvents: List<PresentationEvent> = emptyList()
        fun receipt(status: String) {
            File(directory,"receipt.json").writeText(buildJsonObject {
                put("status",status);put("stage",stage);put("syntheticPresentationOnly",true)
                put("fixture",fixture.mode);put("label",fixture.label);put("missingCaster",fixture.missingCaster)
                put("terminalAtCast",fixture.terminalAtCast);put("sourceEventEndTick",sourceEvents.lastOrNull()?.t?.let(::JsonPrimitive) ?: JsonNull)
                put("sourceEvents",JsonArray(sourceEvents.map { Json.parseToJsonElement(it.json) }))
                put("walletApprovalTested",false);put("backendAccessRequested",false)
                put("rendererContractVersion",manifest?.get("rendererContractVersion") ?: JsonNull)
                put("contentVersion",manifest?.get("contentVersion") ?: JsonNull)
                put("files",JsonArray(files))
            }.toString())
        }
        try {
            receipt("running")
            val intent=Intent(context,MainActivity::class.java).putExtra("preview","battle")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            activity=instrumentation.startActivitySync(intent) as MainActivity
            val host=activity
            check(host.intent.getStringExtra("preview")=="battle")
            stage="await-verified-preview-assets";receipt("running")
            var assets: File?=null
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(45)
            while(assets==null && System.nanoTime()<deadline) {
                instrumentation.runOnMainSync {
                    val fragment=host.supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().singleOrNull()
                    if(fragment?.renderer!=null && fragment.assetPath.isNotEmpty()) assets=File(fragment.assetPath)
                }
                if(assets==null) Thread.sleep(50)
            }
            val root=requireNotNull(assets)
            check(root.canonicalFile.parentFile==context.noBackupFilesDir.canonicalFile && root.name.matches(Regex("bundled-[a-f0-9]{64}")))
            fun read(name: String)=Json.parseToJsonElement(File(root,name).readText()).jsonObject
            manifest=read("manifest.json")
            val catalogue=read("catalogue.json");val render=read("render-catalog.json")
            val contract=render.getValue("rendererContractVersion").jsonPrimitive.int
            check(contract in 6..10 && contract>=fixture.minimumContract)
            val presentation=catalogue.getValue("presentation").jsonObject
            val constants=catalogue.getValue("constants").jsonObject
            val units=requireNotNull(presentation.string("unitsPerTile")).toFloat()
            val center=units*8
            val frames=render.objects("actors").filter { it.string("level")=="1" }
                .associate { requireNotNull(it.string("type")) to requireNotNull(it.string("frameKey")) }
            check(fixture.hero in frames && "highlander" in frames)
            // Refuse a mislabeled pack before capture; no absent-family screenshots can pass.
            val parsed=com.badlogic.gdx.utils.JsonReader().parse(File(root,"render-catalog.json").readText())
            val art=CombatArt.catalogue(parsed).getValue(frames.getValue(fixture.hero))
            if(fixture.skill=="firestorm") check(art.firestorm!=null)
            else if(fixture.skill=="maul") check(art.maul!=null)
            else if(fixture.skill=="howl") check(art.howl!=null)
            else {
                val effects=art.heroEffects.getValue("${fixture.skill}:impact").effects
                check(if(fixture==OfflineHeroGlFixture.MOONSUNDER) effects.any { it.rangePx!=null } && effects.any { it.targetActorCenterAtCast }
                    else effects.single().actorToEventFallbackMs!=null)
            }
            val events=fixture.events(center);sourceEvents=events
            check(!fixture.terminalAtCast || events.last().t==1 && events.last().e==if(fixture.skill in setOf("firestorm","maul","howl")) "troopAbility" else "heroSkill")
            val buildings=if(fixture.skill=="brownNote") {
                val wall=render.objects("walls").first { it.string("level")=="1" && it.string("mask")=="0" }
                val width=requireNotNull(wall.string("footprintWidth")).toFloat();val height=requireNotNull(wall.string("footprintHeight")).toFloat()
                listOf(RenderBuilding("wall",requireNotNull(wall.string("frameKey")),12f-width/2,8f-height/2,width,height))
            } else if(fixture==OfflineHeroGlFixture.FIRESTORM) {
                val target=render.objects("entries").first { it.string("type")=="keep" && it.string("level")=="1" }
                val width=requireNotNull(target.string("footprintWidth")).toFloat();val height=requireNotNull(target.string("footprintHeight")).toFloat()
                listOf(RenderBuilding("fan-target",requireNotNull(target.string("frameKey")),12f-width/2,8f-height/2,width,height))
            } else emptyList()
            val scene=BattleScene(BaseScene(buildings,16,16,requireNotNull(presentation.string("tilePixels")).toFloat()),
                PresentationRevision("synthetic-${fixture.mode}","fixture",requireNotNull(catalogue.string("simVersion")).toInt(),0,0,events),frames,units,
                requireNotNull(presentation.string("tickMs")).toFloat(),constants.getValue("RAID_RULES").jsonObject.getValue("troopFireVisualTicks").jsonPrimitive.int,
                constants.getValue("TROOP_ABILITIES").jsonObject.getValue("hexbarrow").jsonObject.getValue("brood").jsonObject.getValue("positionKeyframeTicks").jsonPrimitive.int,
                playheadTick=1f,playing=false)
            val checkpoint=mutableStateOf(1f)
            val expected=AtomicReference(1f)
            val matching=AtomicInteger()
            val lastFrame=AtomicReference<BattlePlaybackFrame?>(null)
            val gate=AtomicReference(CountDownLatch(1))
            stage="attach-synthetic-test-host";receipt("running")
            instrumentation.runOnMainSync {
                host.setContent {
                    MaterialTheme {
                        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                            Text("SYNTHETIC ${fixture.label} GL · tick ${checkpoint.value} · no battle result",Modifier.padding(12.dp))
                            SceneSurface(root,scene.base,Modifier.fillMaxWidth().weight(1f),
                                battle=scene.copy(playheadTick=checkpoint.value,playing=false),playbackKey=checkpoint.value.toBits(),onFrame={ frame ->
                                    if(frame.raidId==scene.revision.raidId && frame.revision==scene.revision.revision && frame.playheadTick==expected.get()) {
                                        lastFrame.set(frame)
                                        if(matching.incrementAndGet()>=3) gate.get().countDown()
                                    } else matching.set(0)
                                })
                        }
                    }
                }
            }
            val ticks=if(fixture.skill=="firestorm") {
                val fan=requireNotNull(art.firestorm);val body=art.clips.getValue(fan.bodyState)
                val release=1f+(fan.pinFrames.first()-1)*1000f/body.fps/scene.tickDurationMs
                val end=CombatVisualPlan(scene,BattleVisualModel(events,scene.positionCadenceTicks,scene.summonedPositionCadenceTicks),CombatArt.catalogue(parsed)).playbackExtent.visualEndTick
                listOf(1f,release+.01f,release+fan.clip.durationMs/scene.tickDurationMs*.4f,
                    release+fan.clip.durationMs/scene.tickDurationMs*.8f,end)
            } else if(fixture.skill=="maul") {
                val maul=requireNotNull(art.maul);val body=art.clips.getValue(maul.bodyState)
                val first=1f+(maul.releaseFrame-1)*1000f/body.fps/scene.tickDurationMs
                val second=first+maul.secondDelayMs/scene.tickDurationMs
                val firstEnd=first+maul.clip.durationMs/scene.tickDurationMs
                val end=CombatVisualPlan(scene,BattleVisualModel(events,scene.positionCadenceTicks,scene.summonedPositionCadenceTicks),CombatArt.catalogue(parsed)).playbackExtent.visualEndTick
                listOf(1f,Math.nextUp(first),Math.nextUp(second),Math.nextUp(firstEnd),end)
            } else if(fixture.skill=="howl") {
                val howl=requireNotNull(art.howl);val body=art.clips.getValue(howl.bodyState)
                val release=1f+(howl.releaseFrame-1)*1000f/body.fps/scene.tickDurationMs
                val effectEnd=release+howl.clip.durationMs/scene.tickDurationMs
                val end=CombatVisualPlan(scene,BattleVisualModel(events,scene.positionCadenceTicks,scene.summonedPositionCadenceTicks),CombatArt.catalogue(parsed)).playbackExtent.visualEndTick
                listOf(1f,Math.nextUp(release),(release+effectEnd)/2,Math.nextUp(effectEnd),end)
            } else fixture.ticks
            for(tick in ticks) {
                stage="paused-frame-$tick";receipt("running")
                val ready=CountDownLatch(1);gate.set(ready);matching.set(0);expected.set(tick)
                instrumentation.runOnMainSync { checkpoint.value=tick }
                check(ready.await(20,TimeUnit.SECONDS)) { "Paused GL progress did not stabilize" }
                val copied=CountDownLatch(1);val code=AtomicInteger(-1)
                var bitmap: Bitmap?=null
                instrumentation.runOnMainSync {
                    Choreographer.getInstance().postFrameCallback {
                        Choreographer.getInstance().postFrameCallback capture@{
                            if(matching.get()<3 || checkpoint.value!=tick) { copied.countDown();return@capture }
                            val surface=surfaces(host.window.decorView).singleOrNull { it.isAttachedToWindow && it.width>0 && it.height>0 }
                            if(surface==null) { copied.countDown();return@capture }
                            try {
                                bitmap=Bitmap.createBitmap(surface.width,surface.height,Bitmap.Config.ARGB_8888)
                                PixelCopy.request(surface,requireNotNull(bitmap),{ result -> code.set(result);copied.countDown() },Handler(Looper.getMainLooper()))
                            } catch(_: Exception) { code.set(PixelCopy.ERROR_SOURCE_INVALID);copied.countDown() }
                        }
                    }
                }
                check(copied.await(10,TimeUnit.SECONDS) && code.get()==PixelCopy.SUCCESS && matching.get()>=3)
                val image=requireNotNull(bitmap)
                try {
                    val frame=requireNotNull(lastFrame.get())
                    check(frame.playheadTick==tick && frame.extent.eventEndTick==events.last().t.toFloat() && frame.extent.visualEndTick>=tick)
                    val output=File(directory,"tick_$tick.png")
                    output.outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG,100,it)) }
                    files+=buildJsonObject { put("path",output.name);put("tick",tick);put("width",image.width);put("height",image.height)
                        put("sha256",MessageDigest.getInstance("SHA-256").digest(output.readBytes()).joinToString("") { "%02x".format(it) })
                        put("bytes",output.length());put("matchingProgressCallbacks",matching.get());put("progressRequiresCompleteTextures",true)
                        put("progressEmittedAfterBatchEnd",true);put("eventEndTick",frame.extent.eventEndTick);put("visualEndTick",frame.extent.visualEndTick)
                        put("uiFrameBoundariesAfterMatch",2);put("pixelCopyResult",code.get()) }
                } finally { image.recycle() }
            }
            stage="all-paused-surfaces-captured";receipt("captured-needs-visual-inspection")
        } catch(error: Exception) { receipt("failed");throw error }
        finally {
            activity?.let { host -> instrumentation.runOnMainSync { host.finishAndRemoveTask() } }
            instrumentation.waitForIdleSync()
        }
    }
    private fun surfaces(view: View): List<SurfaceView> = when(view) {
        is SurfaceView -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { surfaces(view.getChildAt(it)) }
        else -> emptyList()
    }
}
