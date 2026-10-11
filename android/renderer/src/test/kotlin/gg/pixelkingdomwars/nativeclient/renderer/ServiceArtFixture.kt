package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue

/** Synthetic closed format, not pixels, game rules, an export or content readiness. */
internal fun serviceFixture(): JsonValue {
    val clips = linkedMapOf<String, Any?>(); val appearances = linkedMapOf<String, Any?>(); val groups = sortedSetOf<String>()
    val hash = "a".repeat(64)
    fun clip(id: String, count: Int, playback: Int, loop: Boolean, kind: String) {
        val effect = kind == "effect"
        clips[id] = linkedMapOf<String, Any?>("frames" to (0 until count).map { mapOf("sourceIndex" to it, "key" to "${id}_f${it+1}", "sha256" to hash, "hashDomain" to "rgba-cell") },
            "playbackIndices" to (0 until playback).toList(), "fps" to 8, "loop" to loop,
            "cellW" to if(effect) 64 else 112, "cellH" to if(effect) 64 else 112,
            "anchorPx" to if(effect) listOf(32,32) else listOf(56,112), "anchorKind" to if(effect) "centre" else "cellBottomPivotX").also {
            if(!effect) it["footprint"] = listOf(2,2)
            if(kind != "service") it["providerIndices"] = (1..8).toList()
            if(kind == "berth") it["reducedMotion"] = mapOf("frame" to 0)
            if(effect) it["reducedMotion"] = mapOf("image" to mapOf("path" to "production-assets/shared-fx/craft-success/frames/frame-00.png", "sha256" to hash, "bytes" to 100))
        }
    }
    fun ref(id: String, state: String) = mapOf("appearance" to id, "state" to state)
    fun appearance(id: String, facility: String, family: String, tier: Int?, states: Map<String, Any?>) {
        val geometry = linkedMapOf<String, Any?>("cell" to listOf(112,112), "footprint" to listOf(2,2), "drawScale" to 1,
            "deedScale" to .5, "seat" to "full-cell-bottom", "horizontalPivot" to 56, "cellBottom" to 112)
        if(facility == "berth") {
            val aerial = family in setOf("survey-balloon", "courier-airship")
            geometry["groundContact"] = listOf(56,93); geometry["attachment"] = listOf(56,if(aerial)56 else 78)
            geometry["tidalGate"] = if(aerial) null else listOf(56,28)
        } else {
            geometry["sourcePivot"] = listOf(56,104); geometry["contactLine"] = 104
            if(facility in setOf("lodge","market")) geometry["providerCell"] = listOf(80,80)
        }
        appearances[id] = mapOf("id" to id, "facility" to facility, "family" to family, "tier" to tier, "geometry" to geometry, "states" to states)
    }
    for(facility in listOf("workshop","lodge","market","harvester")) {
        val families = if(facility == "harvester") listOf("frostveil","elderwood","sunscar","crownlands","seeker-reach","stormcairn","thornwake","cinderfall") else listOf(facility)
        for(family in families) for(tier in 1..4) {
            val id = if(facility == "harvester") "harvester-$family-t$tier" else "$facility-t$tier"
            val prefix = if(facility == "harvester") "pe_harv_${family}_t$tier" else "pe_${family}_t$tier"; groups += prefix
            val states = linkedMapOf<String, Any?>()
            for(state in when(facility) { "workshop" -> listOf("idle","ready","damaged","rubble"); "harvester" -> listOf("idle","ready","damaged","destroyed"); else -> listOf("idle","damaged") })
                states[state] = mapOf("kind" to "static", "key" to "${prefix}_${state}_f1")
            for(state in listOf("working","construction","collapse")) {
                val working = state == "working"; val name = "${prefix}_$state"
                clip(name, if(working && facility in setOf("lodge","market"))8 else 9, if(working)8 else 9, working, "service")
                states[state] = mapOf("kind" to "clip", "clip" to name)
            }
            if(facility == "harvester") states["rubble"] = mapOf("kind" to "alias", "target" to ref(id,"destroyed"))
            else states["destroyed"] = mapOf("kind" to "alias", "target" to ref("workshop-t$tier","rubble"))
            if(facility in setOf("lodge","market")) states["ready"] = mapOf("kind" to "composition", "parts" to listOf(ref(id,"idle")), "overlay" to mapOf("effect" to "craft-success", "offset" to listOf(24,0)))
            appearance(id,facility,family,tier,states)
        }
    }
    for(family in listOf("starter","survey-balloon","cargo-cutter","courier-airship","expedition-barge")) {
        val id = "$family-berth"; val prefix = "pe_berth_$family"; val states = linkedMapOf<String, Any?>()
        for(state in listOf("intact","damaged","destroyed")) states[state] = mapOf("kind" to "static", "key" to "${prefix}_${state}_f1")
        clip("${prefix}_ambient",8,8,true,"berth"); states["ambient"] = mapOf("kind" to "clip", "clip" to "${prefix}_ambient")
        states["away"] = mapOf("kind" to "composition", "parts" to listOf(ref(id,"intact"), ref(id,"ambient")))
        appearance(id,"berth",family,null,states)
    }
    groups += "pe_fleet_berths"; groups += "pe_fx"; clip("pe_fx_craft-success",8,8,false,"effect")
    return serviceJson(mapOf("version" to 1, "metadata" to mapOf("peClips" to clips, "peAppearances" to appearances,
        "peEffects" to mapOf("craft-success" to mapOf("clip" to "pe_fx_craft-success", "anchor" to listOf(.5,.5)))),
        "groups" to groups.map { id -> mapOf("id" to id, "atlasPath" to "atlas/$id@1x.json", "imagePath" to "atlas/$id@1x.png", "decodedBytes" to 4096,
            "files" to listOf("json","png").map { mapOf("path" to "atlas/$id@1x.$it", "sha256" to hash, "size" to 100) }) }))
}
internal fun serviceJson(value: Any?): JsonValue = when(value) {
    null -> JsonValue(JsonValue.ValueType.nullValue)
    is String -> JsonValue(value)
    is Boolean -> JsonValue(value)
    is Int -> JsonValue(value.toLong())
    is Long -> JsonValue(value)
    is Double -> JsonValue(value)
    is Map<*,*> -> JsonValue(JsonValue.ValueType.`object`).also { out -> value.forEach { (key,v) -> out.addChild(key as String,serviceJson(v)) } }
    is Iterable<*> -> JsonValue(JsonValue.ValueType.array).also { out -> value.forEach { out.addChild(serviceJson(it)) } }
    else -> error("Unsupported test JSON")
}
