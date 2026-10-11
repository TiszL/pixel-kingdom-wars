package gg.pixelkingdomwars.nativeclient.renderer

/** Prepared clip adapters reuse the renderer's authored playback and depth model.
 * Phase is visual-only and survives only the same base/building/plan identity. */
internal class ServiceSceneVisuals(val assets: ServiceSceneAssets, private val base: BaseScene,
    observedAtMs: Long, previous: ServiceSceneVisuals? = null) {
    private data class Layer(val source: ServiceLayer, val clip: AuthoredClip)
    private class Animation(val plan: ServicePlan, val layers: List<Layer>, val terminal: Animation?) {
        val duration: Float get() = layers.maxOfOrNull { it.clip.durationMs } ?: 0f
    }
    private val animations: Map<String, Map<ServiceCombatState?, Animation>>
    private val phases: Map<String, Long>
    init {
        fun animation(plan: ServicePlan): Animation = Animation(plan, plan.layers.map { layer ->
            Layer(layer, AuthoredClip(plan.signature, assets.atlases.values.single { it.cells.containsKey(layer.frames.first()) }.path,
                listOf(layer.frames),listOf("s"),layer.fps,layer.origin.x,layer.origin.y,layer.scale,layer.cell.x,layer.cell.y,
                layer.loop,null,emptyMap()))
        },plan.terminal?.let(::animation))
        animations = assets.plans.mapValues { (_, plans) -> plans.mapValues { animation(it.value) } }
        val old = previous?.takeIf { base.baseId != null && it.base.baseId == base.baseId }
        phases = animations.mapValues { (id, plans) ->
            val signature = plans[null]?.plan?.signature
            if (signature != null && old?.animations?.get(id)?.get(null)?.plan?.signature == signature)
                old.phases.getValue(id) else observedAtMs
        }
    }
    fun available(id: String, state: ServiceCombatState? = null): Boolean = animations[id]?.containsKey(state) == true
    fun sprites(building: RenderBuilding, nowMs: Long, depth: Float, output: MutableList<BaseVisualSprite>,
        state: ServiceCombatState? = null, elapsedMs: Float? = null) {
        var animation = animations[building.id]?.get(state) ?: return
        var age = elapsedMs ?: (nowMs - phases.getValue(building.id)).coerceAtLeast(0).toFloat()
        if (animation.terminal != null && age >= animation.duration) { age -= animation.duration; animation = animation.terminal!! }
        val x = (building.tileX + building.footprintWidth / 2) * base.tilePixels
        val y = (building.tileY + building.footprintHeight) * base.tilePixels
        for (layer in animation.layers) {
            val clip = layer.clip
            output += BaseVisualSprite(clip, clip.frame(age,0),x + layer.source.offset.x,y + layer.source.offset.y,
                clip.cellWidth * clip.scale,clip.cellHeight * clip.scale,clip.anchorX,clip.anchorY,depth)
        }
    }
}
