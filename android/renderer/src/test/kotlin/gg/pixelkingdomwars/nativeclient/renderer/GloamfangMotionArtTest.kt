package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import kotlin.test.*
import org.junit.Test

/** Admission tests keep incompatible downloaded choreography out of a live scene. */
class GloamfangMotionArtTest {
    private val reader=JsonReader()
    private val aim="""{"minimumDeltaSquared":0.25,"retainWithinDegrees":32.5}"""
    private fun clip(key:String,extra:String="")="""{"key":"$key","atlasPath":"atlas/$key.json","frames":[["${key}1","${key}2"]],"rowOrder":["s"],"fps":10,"anchor":[0.5,0.5],"scale":1,"cellWidth":20,"cellHeight":20,"loop":false$extra}"""
    private val leap="""{"bodyState":"leap","durationMs":725,"heightRatio":0.3,"positionSnapDistance":1,"position":"castToEventTargetParabola","easing":"linear","depth":"groundY","ordinaryPosition":"preserveBodyAndCounter","ownedCancellation":true,"facing":"retainUnlessAimed","missingTarget":"snapOnly","aim":$aim}"""
    private val lunge="""{"bodyState":"lunge","position":"nextDeliveredPositionSnap","landing":"standOnDelivery","facing":"retainUnlessAimed","missingTarget":"snapOnly","aim":$aim}"""
    private fun combat():JsonValue {
        val dust=""", "fxCues":[{"fx":"dust","frames":[1],"effectKey":"dust"},{"fx":"dust","frames":[2],"effectKey":"dust"}]"""
        val rend=""", "fxCues":[{"fx":"rend","frames":[1,2],"effectKey":"rend"}]"""
        val howl="""{"bodyState":"howl","releaseFrame":1,"offsetX":0,"offsetY":0,"depthOffset":-1,"target":"currentActorAtRelease","facing":"retainUnlessAimed","ownedCancellation":true,"aim":$aim,"clip":${clip("ring")}}"""
        return reader.parse("""{"clips":{"leap":${clip("leap",dust)},"lunge":${clip("lunge",rend)},"howl":${clip("howl")},"prowl":${clip("prowl")}},"profile":{"stand":"prowl","move":"prowl"},"effects":{"dust":${clip("dust")},"rend":${clip("rend")}},"howl":$howl,"leap":$leap,"lunge":$lunge}""")
    }
    private fun replace(parent:JsonValue,key:String,value:JsonValue) { parent.remove(key);parent.addChild(key,value) }
    private fun catalogue(version:Int,art:JsonValue=combat(),shared:Boolean=false):JsonValue {
        val root=reader.parse("""{"rendererContractVersion":$version,"actors":[{"type":"gloamfang","frameKey":"actor"}]}""")
        if(shared) {
            root.get("actors").get(0).addChild("combatKey",JsonValue("gloamfang-tier"))
            val profiles=JsonValue(JsonValue.ValueType.`object`);profiles.addChild("gloamfang-tier",art);root.addChild("combatProfiles",profiles)
        } else root.get("actors").get(0).addChild("combat",art)
        return root
    }
    @Test fun `travel clock is captured independently from the finite authored body`() {
        val parsed=CombatArt.parse(combat())
        assertEquals(725f,assertNotNull(parsed.leap).durationMs)
        assertEquals(200f,parsed.clips.getValue("leap").durationMs)
        assertEquals(.3f,parsed.leap!!.heightRatio)
        assertEquals("lunge",assertNotNull(parsed.lunge).bodyState)
        val changed=combat();replace(changed.get("clips").get("leap"),"fps",JsonValue(20L))
        assertEquals(725f,CombatArt.parse(changed).leap!!.durationMs,"Changing body cadence cannot rewrite the source motion deadline")
        changed.get("leap").addChild("futurePresentationNote",JsonValue("compatible addition"))
        assertEquals(725f,CombatArt.parse(changed).leap!!.durationMs)
    }
    @Test fun `renderer eleven requires both motion contracts for inline and shared actors while ten remains playable`() {
        for(shared in listOf(false,true)) {
            val valid=CombatArt.catalogue(catalogue(11,shared=shared)).getValue("actor")
            assertNotNull(valid.leap);assertNotNull(valid.lunge)
            val serviceCompatible=CombatArt.catalogue(catalogue(15,shared=shared)).getValue("actor")
            assertNotNull(serviceCompatible.leap);assertNotNull(serviceCompatible.lunge)
            assertEquals(valid.atlases,serviceCompatible.atlases,"Service catalogue support preserves inline and shared actor residency")
            // Admitted content-mount contract 17 inherits both inline and shared combat metadata.
            val contentMountCompatible=CombatArt.catalogue(catalogue(17,shared=shared)).getValue("actor")
            assertNotNull(contentMountCompatible.leap);assertNotNull(contentMountCompatible.lunge)
            assertEquals(valid.atlases,contentMountCompatible.atlases,"Content-mount support preserves inline and shared actor residency")
            for(missing in listOf("leap","lunge")) {
                val candidate=combat();candidate.remove(missing)
                assertEquals("Motion contracts missing from admitted Gloamfang",assertFailsWith<IllegalArgumentException>{
                    CombatArt.catalogue(catalogue(11,candidate,shared))
                }.message)
            }
            val legacy=combat();legacy.remove("leap");legacy.remove("lunge")
            val restored=CombatArt.catalogue(catalogue(10,legacy,shared)).getValue("actor")
            assertNull(restored.leap);assertNull(restored.lunge);assertNotNull(restored.howl)
        }
        val unsupportedVersion=firstUnsupportedCombatRendererVersion()
        assertEquals("Unsupported combat renderer contract",assertFailsWith<IllegalArgumentException>{
            CombatArt.catalogue(catalogue(unsupportedVersion))
        }.message)
    }
    @Test fun `unknown choreography cannot silently become guessed movement or landing`() {
        val mutations=mapOf("leap" to mapOf("bodyState" to "lunge","position" to "linearToTarget","easing" to "quadratic",
            "depth" to "spriteY","ordinaryPosition" to "cancelCounter","facing" to "nearestAlways","missingTarget" to "inventTarget"),
            "lunge" to mapOf("bodyState" to "leap","position" to "timedLanding","landing" to "afterDuration",
                "facing" to "nearestAlways","missingTarget" to "inventTarget"))
        for((motion,fields) in mutations)for((field,value) in fields) {
            val candidate=combat();replace(candidate.get(motion),field,JsonValue(value))
            assertFailsWith<IllegalArgumentException>("Reject $motion.$field=$value"){CombatArt.parse(candidate)}
        }
        val unowned=combat();replace(unowned.get("leap"),"ownedCancellation",JsonValue(false))
        assertFailsWith<IllegalArgumentException>{CombatArt.parse(unowned)}
    }
    @Test fun `missing policy fields and invalid clocks reject the candidate before scene construction`() {
        for(field in listOf("durationMs","heightRatio","positionSnapDistance","missingTarget","facing","aim")) {
            val candidate=combat();candidate.get("leap").remove(field)
            assertFailsWith<IllegalArgumentException>("Leap requires $field"){CombatArt.parse(candidate)}
        }
        for(value in listOf(0.0,-1.0,Double.NaN,Double.POSITIVE_INFINITY)) {
            val candidate=combat();replace(candidate.get("leap"),"durationMs",JsonValue(value))
            assertFailsWith<IllegalArgumentException>{CombatArt.parse(candidate)}
        }
        for(value in listOf(0.0,-1.0,Double.NaN,Double.POSITIVE_INFINITY)) {
            val candidate=combat();replace(candidate.get("leap"),"positionSnapDistance",JsonValue(value))
            assertFailsWith<IllegalArgumentException>{CombatArt.parse(candidate)}
        }
        for(value in listOf(-.1,Double.NaN,Double.POSITIVE_INFINITY)) {
            val candidate=combat();replace(candidate.get("leap"),"heightRatio",JsonValue(value))
            assertFailsWith<IllegalArgumentException>{CombatArt.parse(candidate)}
        }
        val flat=combat();replace(flat.get("leap"),"heightRatio",JsonValue(0.0))
        assertEquals(0f,CombatArt.parse(flat).leap!!.heightRatio,"Zero is a valid source-authored flat arc")
    }
    @Test fun `both motions require finite aimed thresholds instead of direction fallback`() {
        for(motion in listOf("leap","lunge")) {
            for(field in listOf("aim","facing","missingTarget")) {
                val candidate=combat();candidate.get(motion).remove(field)
                assertFailsWith<IllegalArgumentException>{CombatArt.parse(candidate)}
            }
            for((field,values) in mapOf("minimumDeltaSquared" to listOf(0.0,-1.0,Double.NaN,Double.POSITIVE_INFINITY),
                "retainWithinDegrees" to listOf(-1.0,180.0,Double.NaN,Double.POSITIVE_INFINITY)))for(value in values) {
                val candidate=combat();replace(candidate.get(motion).get("aim"),field,JsonValue(value))
                assertFailsWith<IllegalArgumentException>{CombatArt.parse(candidate)}
            }
        }
    }
    @Test fun `required body clips are finite and all authored endpoint effects enter residency`() {
        for(state in listOf("leap","lunge")) {
            val missing=combat();missing.get("clips").remove(state)
            assertEquals("Motion body clip missing: $state",assertFailsWith<IllegalArgumentException>{CombatArt.parse(missing)}.message)
            val looping=combat();replace(looping.get("clips").get(state),"loop",JsonValue(true))
            assertFailsWith<IllegalArgumentException>{CombatArt.parse(looping)}
            val static=combat();replace(static.get("clips").get(state),"fps",JsonValue(0L))
            static.get("clips").get(state).addChild("static",JsonValue(true))
            assertFailsWith<IllegalArgumentException>{CombatArt.parse(static)}
        }
        val art=CombatArt.parse(combat())
        assertEquals(setOf("atlas/leap.json","atlas/lunge.json","atlas/howl.json","atlas/prowl.json","atlas/ring.json","atlas/dust.json","atlas/rend.json"),art.atlases)
        assertEquals(listOf(1,2),art.clips.getValue("leap").fxCues["dust"],"Landing dust must survive repeated authored cue entries")
        assertEquals("dust",art.clips.getValue("leap").effectByCue["dust"])
        assertEquals(listOf(1,2),art.clips.getValue("lunge").fxCues["rend"])
    }
    @Test fun `renderer eleven rejects unavailable locomotion before the first motion timeline is constructed`() {
        for(field in listOf("stand","move")) {
            val missing=combat();missing.get("profile").remove(field)
            assertEquals("Gloamfang locomotion clips missing",assertFailsWith<IllegalArgumentException>{
                CombatArt.catalogue(catalogue(11,missing))
            }.message)
            val unavailable=combat();replace(unavailable.get("profile"),field,JsonValue("not-admitted"))
            assertFailsWith<IllegalArgumentException>{CombatArt.catalogue(catalogue(11,unavailable))}
        }
        val badBattleMove=combat();badBattleMove.get("profile").addChild("battleMove",JsonValue("not-admitted"))
        assertFailsWith<IllegalArgumentException>{CombatArt.catalogue(catalogue(11,badBattleMove))}
        val missingClip=combat();missingClip.get("clips").remove("prowl")
        assertFailsWith<IllegalArgumentException>{CombatArt.catalogue(catalogue(11,missingClip))}
        val battleOnly=combat();battleOnly.get("profile").remove("move")
        battleOnly.get("profile").addChild("battleMove",JsonValue("prowl"))
        assertNotNull(CombatArt.catalogue(catalogue(11,battleOnly))["actor"],
            "An admitted battleMove needs no unused ordinary move alias")
    }
    @Test fun `one canonical aiming helper must agree across Howl Leap and Lunge`() {
        for(motion in listOf("howl","leap","lunge"))for((field,value) in listOf("minimumDeltaSquared" to .5,"retainWithinDegrees" to 33.0)) {
            val mismatched=combat();replace(mismatched.get(motion).get("aim"),field,JsonValue(value))
            assertEquals("Gloamfang shared facing contract mismatch",assertFailsWith<IllegalArgumentException>{
                CombatArt.catalogue(catalogue(11,mismatched))
            }.message,"A shared timeline cannot silently substitute another ability's otherwise valid heading policy")
        }
    }
}
