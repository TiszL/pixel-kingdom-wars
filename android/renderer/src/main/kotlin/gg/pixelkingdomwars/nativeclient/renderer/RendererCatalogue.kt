package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue

/** Metadata admission only: no textures, image decoding, GL or scene construction. */
object RendererCatalogue {
    fun validate(text: String) = validate(JsonReader().parse(text))
    /** The same admission for an already parsed tree, so one parse can serve admission and rendering. */
    fun validate(root: JsonValue) {
        serviceArt(root)
        staticArt(root)
        CombatArt.catalogue(root)
        WallCatalogue(root)
        basePresentation(root)
        PreparedCampScene.artwork(root)
        // Contract 13 sections are additive: an older pack keeps its legacy views.
        wallArt(root); builder(root); ground(root)
        // Contract 15 (docs/REALM-KIT-PLAN.md E-8): the revision-5 realm kit section is additive and optional;
        // when present its descriptors must be hash-addressed like every layered section.
        realmKit(root)
        root.get("archivePresentation")?.let { archive->
            require(archive.getInt("version")==1)
            requireNotNull(ArchivedMeleePolicy.parse(archive)) { "Legacy archived controller contract missing" }
        }
        DeployPreviewPolicy.parse(root.get("sensoryPolicy")?.get("deploymentPreview"))
    }
    /** Metadata admission is separate from verified selected-group file readiness. */
    fun serviceArt(root: JsonValue): PhaseEServiceArt? {
        val version = root.getInt("rendererContractVersion", 2)
        if (version < 15) { require(!root.has("phaseE") && !root.has("boundCosmetics")) { "Service metadata requires renderer15" }; return null }
        val exact = root.get("rendererContractVersion")
        require((version == 15 || version == 16 || version == 17) && exact.isNumber && exact.asDouble() == version.toDouble()) { "Unsupported service renderer contract" }
        // Renderer17 (N-C5 CONTENT-MOUNT, local branch support under I4/D153.249): the ACCEPTED private parser owns the whole
        // exact17 root — service graph, bound cosmetics AND the fleet block — and its service graph (cosmetics attached) is the
        // admitted service art. Metadata support only: the updater/compatibility range, active pack and candidates are unchanged.
        if (version == 17) return PhaseEFleetArt.parse(root).services
        val art = PhaseEServiceArt.parse(requireNotNull(root.get("phaseE")) { "Service metadata is missing" })
        // Renderer16 (C4) is renderer15 plus the additive bound-cosmetics extension; a 15
        // pack may not carry it, a 16 pack must.
        if (version == 15) { require(!root.has("boundCosmetics")) { "Bound cosmetics require renderer16" }; return art }
        return art.withCosmetics(PhaseECosmeticArt.parse(requireNotNull(root.get("boundCosmetics")) { "Bound cosmetics metadata is missing" }))
    }
    internal fun wallArt(root: JsonValue): WallArtSpec? = root.get("walls5")?.let(::WallArtSpec)
    internal fun builder(root: JsonValue): BuilderPresentation? = root.get("builder")?.let(BuilderPresentation::parse)
    /** `layeredGroundV5` (and the debug `layeredGroundV5Preview` twin): metadata admission only, the manifest
     * bytes are verified by [RealmKitSource] on the presentation worker. Absent sections are valid at every contract. */
    internal fun realmKit(root: JsonValue) {
        for (name in listOf("layeredGroundV5", "layeredGroundV5Preview")) {
            val section = root.get(name) ?: continue
            require(section.getInt("version") == 1) { "Unsupported realm kit section" }
            require(section.getString("status") in setOf("accepted", "preview-only")) { "Realm kit section status is unknown" }
            val manifests = section.get("manifests")
            val realms = root.get("ground")?.get("realms")?.size
            val descriptors = if (manifests == null) listOf(section) else { require(manifests.isArray && (realms == null || manifests.size <= realms)) { "Realm kit section lists more realms than the ground contract" }; manifests.toList() }
            require(descriptors.map { it.getString("realmId") }.let { it.toSet().size == it.size }) { "Duplicate realm kit realm" }
            for (d in descriptors) {
                val hash = d.getString("sha256"); require(hash.matches(Regex("[a-f0-9]{64}"))) { "Realm kit manifest hash is malformed" }
                require(d.getString("manifestPath") == "atlas/fantasy/layered-ground/$hash/manifest.json") { "Realm kit manifest identity changed" }
                require(d.get("size")?.isLong == true && d.getLong("size") >= 1) { "Realm kit manifest size is missing" }
            }
        }
    }
    /** Production content must keep every selectable realm on accepted kit ground. Structural
     * [validate] remains useful for authentic historical metadata; it is not production admission.
     * The content repository has no player's realm, so checking only currentVisual would permit an
     * update that strands a different realm. This checks descriptors, not file residency: verified
     * core bytes and [RealmKitSource] still own manifest, sheet and pixel admission. */
    fun requireAcceptedRealmKits(root: JsonValue) {
        val message = "Accepted realm kit ground is required"
        val ground = requireNotNull(root.get("ground")) { message }
        val realms = requireNotNull(ground.get("realms")) { message }
        require(realms.isArray && realms.size > 0 && realms.all { it.isString }) { message }
        val ids = realms.map { it.asString() }
        require(ids.toSet().size == ids.size) { message }
        val current = requireNotNull(ground.get("currentVisual")) { message }
        require(current.get("version")?.isLong == true && current.getLong("version") == 1L &&
            current.get("artVersion")?.isLong == true && current.getLong("artVersion") == 2L &&
            current.get("groundRevision")?.isLong == true && current.getLong("groundRevision") == 5L &&
            current.get("realmId")?.isString == true && current.getString("realmId") in ids) { message }
        val section = requireNotNull(root.get("layeredGroundV5")) { message }
        require(section.get("version")?.isLong == true && section.getLong("version") == 1L &&
            section.getString("status", "") == "accepted") { message }
        realmKit(root) // Keep hash, path, size and duplicate checks, including on a cached tree.
        val descriptors = section.get("manifests")?.toList() ?: listOf(section)
        require(descriptors.size == ids.size && descriptors.map { it.getString("realmId") }.toSet() == ids.toSet()) { message }
    }
    internal fun ground(root: JsonValue): GroundPresentation? {
        val source = root.get("ground")
        require(root.getInt("rendererContractVersion", 2) < 14 || source?.getInt("version") == 2) { "Revision-aware ground contract is missing" }
        return source?.let(::GroundPresentation)
    }
    internal fun basePresentation(root: JsonValue): BasePresentation? {
        val source=root.get("basePresentation")
        require(source!=null || root.getInt("rendererContractVersion",2)<5) { "Base presentation contract is missing" }
        require(root.getInt("rendererContractVersion",2)<14 || source?.has("buildingLoopSpeed") == true) { "Base building loop speed is missing" }
        return source?.let(BasePresentation::parse)
    }
    internal fun staticArt(root: JsonValue): List<Art> {
        require(root.getInt("schemaVersion") == 1) { "Unsupported render catalogue" }
        val entries = mutableListOf<Art>()
        val identities = mutableSetOf<Pair<String, Int>>()
        for (entry in root.get("entries")) {
            if (root.getInt("rendererContractVersion", 2) >= 15) {
                require(identities.add(entry.getString("type") to entry.getInt("level"))) { "Duplicate building catalogue entry" }
                if (entry.getString("type") in PhaseEServiceArt.facilities) require(entry.has("phaseE")) { "Service entry cannot invent a static fallback" }
            }
            if (entry.has("phaseE")) {
                require(root.getInt("rendererContractVersion", 2) in 15..17)
                PhaseEServiceArt.entry(entry) // No invented frame, no static atlas admission.
            } else entries += parseArt(entry)
        }
        root.get("walls")?.forEach { entries += parseArt(it) }
        root.get("actors")?.forEach { entries += parseArt(it) }
        root.get("terrain")?.let { entries += parseArt(it) }
        root.get("basePresentation")?.get("obstacles")?.forEach { entries += parseArt(it) }
        return entries
    }

    private fun parseArt(value: JsonValue): Art {
        val anchor = value.get("anchor")
        return Art(value.getString("frameKey"), value.getString("atlasPath"),
            value.getFloat("scale"), anchor?.getFloat(0) ?: 0.5f,
            anchor?.getFloat(1) ?: 1f,
            value.getFloat("offsetX", 0f), value.getFloat("offsetY", 0f), value.get("motion")?.let { motion ->
                Motion(motion.getString("atlasPath"), motion.get("frames").map { row -> row.map { it.asString() } },
                    motion.get("rowOrder").map { it.asString() }, motion.getFloat("fps"),
                    motion.get("anchor").getFloat(0), motion.get("anchor").getFloat(1), motion.getFloat("scale"))
            })
    }

}

internal data class Art(val key: String, val atlasPath: String, val scale: Float, val anchorX: Float, val anchorY: Float,
                           val offsetX: Float, val offsetY: Float, val motion: Motion? = null, val flipX: Boolean = false, val rotation: Float = 0f, val cropWidth: Float = Float.POSITIVE_INFINITY, val horizontalScale: Float = scale)
internal data class Motion(val atlasPath: String, val frames: List<List<String>>, val rowOrder: List<String>,
                              val fps: Float, val anchorX: Float, val anchorY: Float, val scale: Float)
