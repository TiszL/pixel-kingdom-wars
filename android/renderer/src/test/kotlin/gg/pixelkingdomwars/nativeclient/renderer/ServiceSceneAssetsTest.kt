package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.io.File
import java.nio.ByteBuffer
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import kotlin.test.*

class ServiceSceneAssetsTest {
    @get:Rule val temporary = TemporaryFolder()
    private val workshop = RenderBuilding("workshop","service:workshop:1",2f,3f,2f,2f,type="workshop",level=1,service=RenderServiceIdentity("workshop",1))
    private fun base(building: RenderBuilding = workshop, enabled: Boolean? = true, state: RenderServiceState = RenderServiceState.WORKING) =
        BaseScene(listOf(building),columns=12,rows=12,tilePixels=32f,baseId="original",services=RenderServiceFacts(enabled,activity=listOf(RenderServiceActivity(building.id,state))))
    private class Fixture(val art: PhaseEServiceArt, val root: File, val present: Set<String>) : ServiceAssetSource {
        val acquired=mutableListOf<String>(); val released=mutableListOf<String>()
        override fun isCurrent() = true
        override fun acquire(group: String, checkpoint: () -> Unit): ServiceAssetLease {
            acquired += group; require(group in present)
            return ServiceAssetLease(FileHandle(root)) { released += group }
        }
        override fun cancelPending() = Unit
    }
    /** Header/packing fixture only: no valid image pixels or GL-readiness claim. */
    private fun fixture(vararg ids: String, decodedOverride: Long? = null): Fixture {
        val raw=serviceFixture(); val original=PhaseEServiceArt.parse(raw); val root=temporary.newFolder()
        for(id in ids) {
            val group=raw.get("groups").first { it.getString("id")==id }
            val cells=linkedMapOf<String,ServicePoint>()
            original.clips.values.forEach { clip -> clip.frames.filter { original.groupFor(it.key).id==id }.forEach { cells[it.key]=clip.cell } }
            original.appearances.values.forEach { a -> a.states.values.filterIsInstance<ServiceArtState.Still>().filter { original.groupFor(it.key).id==id }.forEach { cells[it.key]=a.geometry.cell } }
            val atlas=serviceJson(mapOf("textures" to listOf(mapOf("image" to "$id@1x.png","format" to "RGBA8888","scale" to 1,
                "size" to mapOf("w" to 1024,"h" to 1024),"frames" to cells.entries.mapIndexed { index,(key,size) -> mapOf(
                    "filename" to key,"rotated" to false,"trimmed" to false,
                    "frame" to mapOf("x" to index%8*112,"y" to index/8*112,"w" to size.x.toInt(),"h" to size.y.toInt()),
                    "sourceSize" to mapOf("w" to size.x.toInt(),"h" to size.y.toInt()),
                    "spriteSourceSize" to mapOf("x" to 0,"y" to 0,"w" to size.x.toInt(),"h" to size.y.toInt())) }))))
            val json=File(root,"atlas/$id@1x.json");json.parentFile.mkdirs();json.writeText(atlas.toJson(com.badlogic.gdx.utils.JsonWriter.OutputType.json))
            val png=File(root,"atlas/$id@1x.png");val header=ByteBuffer.allocate(29)
            header.put(byteArrayOf(-119,80,78,71,13,10,26,10)).putInt(13).put("IHDR".toByteArray()).putInt(1024).putInt(1024)
                .put(byteArrayOf(8,6,0,0,0));png.writeBytes(header.array())
            group.get("decodedBytes").set(decodedOverride ?: (1024L*1024*4),null)
            for(pin in group.get("files")) {
                val file=File(root,pin.getString("path"));pin.get("size").set(file.length(),null)
                pin.get("sha256").set(MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) })
            }
        }
        return Fixture(PhaseEServiceArt.parse(raw),root,ids.toSet())
    }
    private fun prepare(f: Fixture,b: BaseScene=base(),enabled: Boolean=true,battle: Boolean=false,reduced: Boolean=false,
        source: ServiceAssetSource=f,check:()->Unit={},decode:(FileHandle)->ServiceTexturePixels={ serviceTestPixels() }):ServiceSceneAssets =
        ServiceSceneAssets.prepare(f.art,b,source,enabled,reduced,battle,check,decode=decode)

    @Test fun `absent source metadata or positive current permission never acquires optional files`() {
        val f=fixture("pe_workshop_t1")
        for (b in listOf(base(enabled=null),base(enabled=false))) prepare(f,b).use { assertTrue(it.plans.isEmpty()) }
        prepare(f,enabled=false).close()
        ServiceSceneAssets.prepare(f.art,base(),null,true,false,false,{}).close()
        ServiceSceneAssets.prepare(null,base(),f,true,false,false,{}).close()
        assertTrue(f.acquired.isEmpty())
    }
    @Test fun `only selected appearance groups acquire and exact leases survive preparation until explicitly released`() {
        val f=fixture("pe_workshop_t1")
        val assets=prepare(f)
        assertEquals(listOf("pe_workshop_t1"),f.acquired);assertTrue(f.released.isEmpty())
        assertEquals(1,assets.atlases.size)
        assertTrue(assets.atlases.values.single().cells.values.all { it.texture.startsWith(f.root.canonicalPath) })
        assets.close();assets.close();assertEquals(f.acquired,f.released)
    }
    @Test fun `completed vehicle-free Home Berth prepares ordinary art without fleet or journey admission`() {
        val berth = workshop.copy(id="berth", type="berth", service=RenderServiceIdentity("berth",null))
        val b = base(berth).copy(services=RenderServiceFacts(true))
        val f = fixture("pe_fleet_berths")
        prepare(f,b).use { assets ->
            assertEquals(listOf("pe_fleet_berths"),f.acquired)
            assertEquals("starter-berth:intact:false",assets.plans.getValue(berth.id).getValue(null).signature)
            assertNull(assets.fleet); assertNull(assets.journeyArt); assertEquals(assets.atlases,assets.allAtlases)
            val sprites=mutableListOf<BaseVisualSprite>()
            ServiceSceneVisuals(assets,b,0).sprites(berth,0,100f,sprites)
            assertEquals("pe_berth_starter_intact_f1",sprites.single().frameKey)
        }
        assertEquals(f.acquired,f.released)
    }
    @Test fun `missing optional Berth files retain logical footprint and draw on preparation after files arrive`() {
        val berth = workshop.copy(id="berth", type="berth", service=RenderServiceIdentity("berth",null))
        val b = base(berth).copy(services=RenderServiceFacts(true, currentAdvancedBerths=listOf(RenderAdvancedBerth(berth.id,
            RenderAdvancedInstallation("cargo_cutter",1,RenderAdvancedPresence.OCCUPIED)))))
        val f=fixture("pe_fleet_berths"); var available=false
        val source=object:ServiceAssetSource {
            override fun isCurrent()=true
            override fun acquire(group:String,checkpoint:()->Unit):ServiceAssetLease {
                check(available) { "Optional tier not resident" }; return f.acquire(group,checkpoint)
            }
            override fun cancelPending()=Unit
        }
        prepare(f,b,source=source).use { assets ->
            assertTrue(assets.atlases.isEmpty()); assertTrue(assets.plans.getValue(berth.id).isEmpty())
            assertFalse(ServiceSceneVisuals(assets,b,0).available(berth.id))
            assertNull(assets.fleet); assertNull(assets.journeyArt)
        }
        available=true
        prepare(f,b,source=source).use { assets ->
            val visuals=ServiceSceneVisuals(assets,b,0); assertTrue(visuals.available(berth.id))
            val sprites=mutableListOf<BaseVisualSprite>(); visuals.sprites(berth,0,100f,sprites)
            assertEquals("pe_berth_cargo-cutter_intact_f1",sprites.single().frameKey)
            assertEquals(listOf("pe_fleet_berths"),f.acquired)
            assertNull(assets.fleet); assertNull(assets.journeyArt)
        }
        assertEquals(f.acquired,f.released)
    }
    @Test fun `static Berth still requires current positive art permission and a current source`() {
        val berth=workshop.copy(id="berth",type="berth",service=RenderServiceIdentity("berth",null))
        val f=fixture("pe_fleet_berths")
        for (enabled in listOf(null,false)) prepare(f,base(berth,enabled)).use { assertTrue(it.plans.isEmpty()) }
        prepare(f,base(berth),enabled=false).use { assertTrue(it.plans.isEmpty()) }
        val revoked=object:ServiceAssetSource {
            override fun acquire(group:String,checkpoint:()->Unit):ServiceAssetLease=error("Revoked source")
            override fun cancelPending()=Unit
        }
        prepare(f,base(berth),source=revoked).use { assertTrue(it.plans.isEmpty()) }
        assertTrue(f.acquired.isEmpty())
    }
    @Test fun `hit geometry is the admitted state first body layer and never a guessed static key`() {
        val f=fixture("pe_workshop_t1")
        prepare(f,base(enabled=null),battle=true).use { assets ->
            for(state in listOf(ServiceCombatState.IDLE,ServiceCombatState.DAMAGED)) {
                val body=assets.plans.getValue(workshop.id).getValue(state).layers.first()
                assertEquals(body.cell.y*body.scale,assets.hitBodyHeight(workshop.id,state))
            }
            assertNull(assets.hitBodyHeight(workshop.id,null));assertNull(assets.hitBodyHeight("other",ServiceCombatState.IDLE))
        }
        prepare(f,enabled=false,battle=true).use { assertNull(it.hitBodyHeight(workshop.id,ServiceCombatState.IDLE)) }
        prepare(f,source=fixture(),battle=true).use { assertNull(it.hitBodyHeight(workshop.id,ServiceCombatState.IDLE)) }
    }
    @Test fun `cross group rubble refuses partial plan and immediately releases unused optional leases`() {
        val f=fixture("pe_lodge_t1")
        val lodge=workshop.copy(id="lodge",type="lodge",service=RenderServiceIdentity("lodge",1))
        val assets=prepare(f,base(lodge,enabled=null),battle=true)
        // Idle/damaged still remain safe; collapse and rubble need the missing Workshop group.
        assertTrue(assets.plans.getValue("lodge").containsKey(ServiceCombatState.IDLE))
        assertFalse(assets.plans.getValue("lodge").containsKey(ServiceCombatState.COLLAPSE))
        assertFalse(assets.plans.getValue("lodge").containsKey(ServiceCombatState.DESTROYED))
        assertEquals(listOf("pe_lodge_t1","pe_workshop_t1"),f.acquired)
        assets.close();assertEquals(listOf("pe_lodge_t1"),f.released)
    }
    @Test fun `PNG depth or packed cell drift never reaches texture admission and closes the acquired lease`() {
        for (change in listOf<(Fixture)->Unit>(
            { f -> val file=File(f.root,"atlas/pe_workshop_t1@1x.png");val bytes=file.readBytes();bytes[24]=16;file.writeBytes(bytes) },
            { f -> val file=File(f.root,"atlas/pe_workshop_t1@1x.png");val bytes=file.readBytes();ByteBuffer.wrap(bytes,16,4).putInt(2048);file.writeBytes(bytes) },
            { f -> val file=File(f.root,"atlas/pe_workshop_t1@1x.json");file.writeText(file.readText().replaceFirst("\"rotated\":false","\"rotated\": true")) }
        )) {
            val f=fixture("pe_workshop_t1");change(f)
            prepare(f).use { assertTrue(it.atlases.isEmpty());assertTrue(it.plans.values.all { p -> p.isEmpty() }) }
            assertEquals(f.acquired,f.released)
        }
    }
    @Test fun `supersession after acquire closes its lease and never publishes a partial scene`() {
        val f=fixture("pe_workshop_t1");var acquired=false
        val source=object:ServiceAssetSource {
            override fun isCurrent() = true
            override fun acquire(group:String,checkpoint:()->Unit)=f.acquire(group,checkpoint).also { acquired=true }
            override fun cancelPending()=Unit
        }
        assertFailsWith<CancellationException> { prepare(f,source=source,check={ if(acquired)throw CancellationException() }) }
        assertEquals(f.acquired,f.released)
    }
    @Test fun `owned acquisition cancellation is propagated instead of becoming a silent missing image`() {
        val f=fixture("pe_workshop_t1")
        val source=object:ServiceAssetSource {
            override fun isCurrent() = true
            override fun acquire(group:String,checkpoint:()->Unit):ServiceAssetLease=throw CancellationException()
            override fun cancelPending()=Unit
        }
        assertFailsWith<CancellationException> { prepare(f,source=source) }
    }
    @Test fun `construction does not load authored animation or invent a builder pacing clock`() {
        val f=fixture("pe_workshop_t1");val b=base(workshop.copy(underConstruction=true)).copy(jobs=listOf(RenderJob("job","build",2f,3f,2f,2f,0,10000,"workshop")))
        prepare(f,b).use { assertTrue(it.atlases.isEmpty()) };assertTrue(f.acquired.isEmpty())
        val root=JsonReader().parse(File("../app/src/main/assets/native/render-catalog.json").readText())
        val visuals=BaseVisualModel(b,emptyMap(),RendererCatalogue.basePresentation(root)!!,0)
        assertTrue(visuals.requiredAtlases.isEmpty());val sprites=mutableListOf<BaseVisualSprite>();visuals.jobs(5000,sprites);assertTrue(sprites.isEmpty())
    }
    @Test fun `working source closure frame is not played and unchanged refresh preserves visual phase only`() {
        val f=fixture("pe_workshop_t1");val b=base();val first=prepare(f,b)
        val prior=ServiceSceneVisuals(first,b,1000)
        val second=prepare(f,b);val current=ServiceSceneVisuals(second,b,1500,prior)
        val before=mutableListOf<BaseVisualSprite>();val after=mutableListOf<BaseVisualSprite>()
        prior.sprites(workshop,1875,100f,before);current.sprites(workshop,1875,100f,after)
        assertEquals("pe_workshop_t1_working_f8",after.single().frameKey);assertEquals(before,after)
        after.clear();current.sprites(workshop,2000,100f,after);assertEquals("pe_workshop_t1_working_f1",after.single().frameKey)
        val changed=ServiceSceneVisuals(second,b.copy(baseId="other"),1500,prior);after.clear();changed.sprites(workshop,1875,100f,after)
        assertEquals("pe_workshop_t1_working_f4",after.single().frameKey)
        first.close();second.close()
    }
    @Test fun `frozen destruction runs authored one shot then its exact leased rubble without a local game timer`() {
        val f=fixture("pe_lodge_t1","pe_workshop_t1");val lodge=workshop.copy(id="lodge",type="lodge",service=RenderServiceIdentity("lodge",1))
        val b=base(lodge,enabled=null);prepare(f,b,battle=true).use { assets ->
            val visuals=ServiceSceneVisuals(assets,b,0);val frames=mutableListOf<BaseVisualSprite>()
            visuals.sprites(lodge,0,160f,frames,ServiceCombatState.COLLAPSE,1000f)
            assertEquals("pe_lodge_t1_collapse_f9",frames.single().frameKey)
            frames.clear();visuals.sprites(lodge,0,160f,frames,ServiceCombatState.COLLAPSE,1125f)
            assertEquals("pe_workshop_t1_rubble_f1",frames.single().frameKey)
            assertEquals(160f,frames.single().depth)
        }
        assertEquals(f.acquired.sorted(),f.released.sorted())
    }
    @Test fun `reduced motion keeps neutral artwork and status without fabricating a working reduced frame`() {
        val f=fixture("pe_workshop_t1");prepare(f,reduced=true).use { assets ->
            val visuals=ServiceSceneVisuals(assets,base(),0);val sprites=mutableListOf<BaseVisualSprite>()
            visuals.sprites(workshop,9000,160f,sprites)
            assertEquals("pe_workshop_t1_idle_f1",sprites.single().frameKey)
            assertEquals("Working",selectServicePlan(f.art,workshop,null,base().services,true,true).status)
        }
    }
    @Test fun `selected decoded sum is checked without overflow before any acquisition or allocation`() {
        val f=fixture("pe_workshop_t1","pe_lodge_t1",decodedOverride=MAX_SELECTED_SERVICE_RGBA_BYTES)
        val lodge=workshop.copy(id="lodge",type="lodge",service=RenderServiceIdentity("lodge",1))
        prepare(f,base(lodge),battle=true).use { assertTrue(it.atlases.isEmpty());assertTrue(it.plans.isEmpty()) }
        assertTrue(f.acquired.isEmpty())
        val one=f.art.groups.getValue("pe_workshop_t1")
        assertTrue(servicePixelsWithinBudget(listOf(one)))
        assertFalse(servicePixelsWithinBudget(listOf(one,one)))
        assertFalse(servicePixelsWithinBudget(listOf(one.copy(decodedBytes=Long.MAX_VALUE),one)))
        assertFalse(servicePixelsWithinBudget(listOf(one.copy(decodedBytes=-1))))
    }

    @Test fun `revoked source refuses preparation even before UI closes its session`() {
        val f=fixture("pe_workshop_t1")
        val source=object:ServiceAssetSource {
            override fun acquire(group:String,checkpoint:()->Unit):ServiceAssetLease=error("Unowned source must never acquire")
            override fun cancelPending()=Unit
        }
        prepare(f,source=source).use { assertTrue(it.plans.isEmpty());assertTrue(it.atlases.isEmpty()) }
        assertTrue(f.acquired.isEmpty())
    }

    // ---- Owner report 2026-10-11 "so laggy it is not playable": Home refreshes stop re-decoding resident pictures ----
    // WHY: GET /base drives a Home preparation on every resume and every poll. Each one decoded every selected PNG again
    // (workshop/harvester 1.94 MB, lodge/market 1.61 MB, berths 3.01 MB of PNG; MiBs of RGBA each) although the renderer then
    // skipped uploading the already-resident texture, so every refresh was an allocation burst and a GC pause. An unchanged
    // selection must cost no decode; a changed one decodes only its new pictures; and the cache must never be what keeps
    // pixels alive (the existing owners and the selected-pixel cap still decide residency).
    @Test fun `an unchanged Home selection decodes each picture once and a changed selection decodes only the new picture`() {
        val f=fixture("pe_workshop_t1","pe_lodge_t1"); val decoded=mutableListOf<String>()
        val cache=ServicePixelCache { file -> decoded += file.name(); serviceTestPixels() }
        val lodge=workshop.copy(id="lodge",tileX=6f,type="lodge",service=RenderServiceIdentity("lodge",1))
        val both=BaseScene(listOf(workshop,lodge),columns=12,rows=12,tilePixels=32f,baseId="original",services=RenderServiceFacts(true,
            activity=listOf(RenderServiceActivity(workshop.id,RenderServiceState.WORKING),RenderServiceActivity(lodge.id,RenderServiceState.WORKING))))
        val first=prepare(f,decode=cache::decode); val second=prepare(f,decode=cache::decode)
        assertEquals(listOf("pe_workshop_t1@1x.png"),decoded,"two consecutive unchanged refreshes decode the workshop once")
        assertSame(first.atlases.values.single().pixels,second.atlases.values.single().pixels)
        assertEquals(first.atlases.values.single().cells,second.atlases.values.single().cells,"what is drawn is unchanged")
        val third=prepare(f,both,decode=cache::decode)
        assertEquals(listOf("pe_workshop_t1@1x.png","pe_lodge_t1@1x.png"),decoded,"adding the lodge decodes only the lodge")
        assertEquals(2,third.atlases.size)
        listOf(first,second,third).forEach { it.close() }
        assertEquals(f.acquired,f.released,"every lease is still released exactly once")
    }
    @Test fun `a resident texture keeps its picture decoded across refreshes and the last owner leaving frees it for a fresh decode`() {
        val f=fixture("pe_workshop_t1"); var decodes=0; var disposed=0
        val cache=ServicePixelCache { decodes++; serviceTestPixels { disposed++ } }
        // The renderer's commit: the resident texture retains the bundle's pixels, then the bundle releases its own reference.
        val first=prepare(f,decode=cache::decode); val texture=first.atlases.values.single().pixels.retain(); first.releasePixels(); first.close()
        repeat(3) { prepare(f,decode=cache::decode).use { refresh -> assertSame(texture,refresh.atlases.values.single().pixels) } }
        assertEquals(1,decodes,"three poll refreshes over a resident texture decode nothing"); assertEquals(0,disposed)
        texture.close(); assertEquals(1,disposed,"the cache holds no reference: unloading the texture frees its pixels")
        prepare(f,decode=cache::decode).close()
        assertEquals(2,decodes,"after eviction the next preparation decodes again"); assertEquals(2,disposed)
    }

    // ---- N-C5 RESIDENCY: the extracted reader seam and the unchanged ordinary path ----
    @Test fun `the expected-cell reader seam is the ordinary reader - same packed cells, canonical path and refusals, and nothing is expected of an empty inventory`() {
        val f=fixture("pe_workshop_t1"); val group=f.art.groups.getValue("pe_workshop_t1"); val directory=FileHandle(f.root)
        val expected=linkedMapOf<String,ServicePoint>()
        f.art.clips.values.forEach { clip -> clip.frames.filter { f.art.groupFor(it.key).id==group.id }.forEach { expected[it.key]=clip.cell } }
        f.art.appearances.values.forEach { a -> a.states.values.filterIsInstance<ServiceArtState.Still>().filter { f.art.groupFor(it.key).id==group.id }.forEach { expected[it.key]=a.geometry.cell } }
        val ordinary=readServiceAtlas(f.art,group,directory) { serviceTestPixels() }; val seam=readPackedAtlas(expected,group,directory) { serviceTestPixels() }
        assertEquals(ordinary.cells,seam.cells); assertEquals(ordinary.path,seam.path); assertEquals(ordinary.texture,seam.texture)
        assertEquals(File(f.root,"atlas/pe_workshop_t1@1x.json").canonicalPath,seam.path)
        ordinary.pixels.close(); seam.pixels.close()
        assertFails { readPackedAtlas(emptyMap(),group,directory) { serviceTestPixels() } }
        assertFails("a foreign inventory does not match the packed rows") { readPackedAtlas(mapOf("pe_veh_starter_docked_f1" to ServicePoint(112f,112f)),group,directory) { serviceTestPixels() } }
    }
    @Test fun `without a fleet capability the prepared generation is exactly the ordinary one`() {
        val f=fixture("pe_workshop_t1")
        prepare(f).use { assets ->
            assertNull(assets.fleet); assertNull(assets.journeyArt)
            assertEquals(assets.atlases,assets.allAtlases); assertEquals(assets.atlases.keys,assets.paths)
            assertEquals(listOf("pe_workshop_t1"),f.acquired)
        }
        assertEquals(f.acquired,f.released)
    }
}
