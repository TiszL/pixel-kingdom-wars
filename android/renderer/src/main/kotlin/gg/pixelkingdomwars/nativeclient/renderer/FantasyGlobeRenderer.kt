package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.ApplicationAdapter
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.InputAdapter
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.Mesh
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.VertexAttribute
import com.badlogic.gdx.graphics.VertexAttributes
import com.badlogic.gdx.graphics.glutils.ShaderProgram
import com.badlogic.gdx.graphics.glutils.PixmapTextureData
import com.badlogic.gdx.graphics.glutils.FrameBuffer
import com.badlogic.gdx.graphics.glutils.FileTextureData
import java.util.concurrent.Executors
import com.badlogic.gdx.graphics.glutils.ShapeRenderer
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.utils.TimeUtils
import kotlin.math.*

data class GlobeDetailState(val residentIds: List<String>, val pending: Int, val coarseReady: Boolean, val paused: Boolean, val view: GlobeView,
                            val residentChains: List<String> = emptyList(), val activatingChain: String? = null)

data class GlobeDetailSource(val id: String, val west: Float, val east: Float, val south: Float, val north: Float, val width: Int, val height: Int, val filterScale: Float)

/** The same inverse orthographic sphere as web, evaluated on the GPU. Managed file textures
 * survive EGL loss. Coast/realm masks remain nearest sampled and never drive gameplay. */
class FantasyGlobeRenderer(
    private val assets: FileHandle,
    initialView: GlobeView,
    private val detailSources: List<GlobeDetailSource>,
    private val art: GlobeArt,
    motion: Boolean,
    private val onView: (GlobeView, GlobeViewport) -> Unit,
    private val onPick: (GlobePick) -> Unit,
    private val onError: (String) -> Unit,
    private val onDisposed: () -> Unit,
    private val onReady: () -> Unit = {},
    private val onDetailError: (String?) -> Unit = {},
    private val onDetailState: ((GlobeDetailState) -> Unit)? = null,
    private val assetSource: GlobeAssetSource? = null,
) : ApplicationAdapter() {
    @Volatile private var requestedView = initialView.normalized()
    private var view = requestedView
    private lateinit var shader: ShaderProgram
    private lateinit var mesh: Mesh
    private lateinit var color: Texture
    private lateinit var surface: Pixmap
    private lateinit var regions: Texture
    private data class RegionTexture(val texture: Texture, val lease: GlobeAssetLease) {
        fun dispose() { texture.dispose(); lease.close() }
    }
    private sealed class PreparedDetail(val lease: GlobeAssetLease) {
        class Region(lease: GlobeAssetLease, val pixels: Pixmap) : PreparedDetail(lease)
        class Chain(lease: GlobeAssetLease, val color: Pixmap, val mask: Pixmap) : PreparedDetail(lease)
        fun dispose() {
            when (this) {
                is Region -> if (!pixels.isDisposed) pixels.dispose()
                is Chain -> { if (!color.isDisposed) color.dispose(); if (!mask.isDisposed) mask.dispose() }
            }
            lease.close()
        }
    }
    private val details = linkedMapOf<Int, RegionTexture>()
    private val detailWorker = Executors.newSingleThreadExecutor { work -> Thread(work, "world-detail").apply { isDaemon = true } }
    private var detailPreparation: GlobeDetailPreparation<PreparedDetail>? = null
    private var detailView: GlobeView? = null
    private var visibleDetails = emptyList<Int>()
    private var visibleChains = emptyList<Int>()
    private data class ActivatingChain(val index: Int, val prepared: PreparedDetail.Chain, val color: Texture) {
        fun dispose() { color.dispose(); prepared.dispose() }
    }
    private var activatingChain: ActivatingChain? = null
    private var detailErrorReported = false
    @Volatile private var retryDetailRequested = false
    private var paused = false
    private var reportedDetailState: GlobeDetailState? = null
    fun retryDetails() { retryDetailRequested = true; Gdx.graphics?.requestRendering() }
    private lateinit var oceanPixels: Pixmap
    private lateinit var ocean: Texture
    private lateinit var regionPixels: Pixmap
    private lateinit var gridShader:ShaderProgram
    private lateinit var cells:Pixmap;private lateinit var cellTexture:Texture
    private lateinit var shapes:ShapeRenderer
    private var perimeter=emptyList<DoubleArray>()
    @Volatile private var requestedSelection=GlobeSelection()
    private var paintedSelection=GlobeSelection()
    private lateinit var islandShader: ShaderProgram
    private lateinit var batch: SpriteBatch
    private lateinit var clouds: GlobeCloudRaster
    private lateinit var effects: GlobeIslandEffects
    private var cloudPixels: Pixmap?=null;private var cloudTexture: Texture?=null
    private var globeFrame: FrameBuffer?=null;private var paintedView: GlobeView?=null
    private var cloudView: GlobeView?=null;private var lastCloud=0L;private var clock=0L;private var elapsedMs=0.0
    @Volatile private var motion=motion
    private data class IslandTextures(val color:Texture,val mask:Texture,val pixels:Pixmap,val lease:GlobeAssetLease) {
        fun dispose(){color.dispose();mask.dispose();pixels.dispose();lease.close()}
    }
    private val islands=linkedMapOf<Int,IslandTextures>()
    private var width = 0; private var height = 0
    private var ready = false
    private var reportedReady = false
    private var cancelGesture: () -> Unit = {}
    fun setView(value: GlobeView) { requestedView = value.normalized(); Gdx.graphics?.requestRendering() }
    fun setSelection(value:GlobeSelection) {requestedSelection=value;Gdx.graphics?.requestRendering()}
    fun setMotion(enabled: Boolean) { motion=enabled;clock=0;lastCloud=0;Gdx.graphics?.requestRendering() }
    override fun create() {
        try {
            color = Texture(assets.child("atlas/fantasy/globe/realm-texture.png"))
            color.setFilter(Texture.TextureFilter.Nearest, Texture.TextureFilter.Nearest)
            surface = Pixmap(assets.child("atlas/fantasy/globe/surface-mask.png"))
            val sourceRegions = Pixmap(assets.child("atlas/fantasy/globe/realm-mask.png"))
            try { regionPixels = globeRegionMask(sourceRegions, surface) } finally { sourceRegions.dispose() }
            regions = Texture(PixmapTextureData(regionPixels,null,false,false,true))
            oceanPixels=Pixmap(art.oceanWidth,art.oceanHeight,Pixmap.Format.RGBA8888)
            val depths=assets.child(art.oceanPath).readBytes();require(depths.size==art.oceanWidth*art.oceanHeight*4)
            oceanPixels.pixels.put(depths).position(0)
            ocean=Texture(PixmapTextureData(oceanPixels,null,false,false,true))
            ocean.setFilter(Texture.TextureFilter.Nearest,Texture.TextureFilter.Nearest)
            val cloudSource=Pixmap(assets.child(art.cloudPath))
            try {
                require(cloudSource.width==art.cloudWidth*art.clouds.size && cloudSource.height>=art.cloudHeight)
                clouds=GlobeCloudRaster(art,IntArray(cloudSource.width*art.cloudHeight){i->cloudSource.getPixel(i%cloudSource.width,i/cloudSource.width)},cloudSource.width)
            } finally {cloudSource.dispose()}
            effects=GlobeIslandEffects(assets.child(art.effectsPath),art)
            cells=Pixmap(art.columns,art.rows,Pixmap.Format.RGBA8888);cells.setBlending(Pixmap.Blending.None)
            val edges=mutableListOf<DoubleArray>()
            for(y in 0 until art.rows)for(x in 0 until art.columns) {
                val id=y*art.columns+x;val genesis=art.genesisCell(id)
                cells.drawPixel(x,y,(if(art.eligible(id))0x01000000 else 0) or (if(genesis)0x0000ff00 else 0) or 255)
                if(genesis) {
                    val west=x*360.0/art.columns-180;val east=(x+1)*360.0/art.columns-180
                    val north=90-y*180.0/art.rows;val south=90-(y+1)*180.0/art.rows
                    if(x==0 || !art.genesisCell(id-1))edges+=doubleArrayOf(west,north,west,south)
                    if(x==art.columns-1 || !art.genesisCell(id+1))edges+=doubleArrayOf(east,north,east,south)
                    if(y==0 || !art.genesisCell(id-art.columns))edges+=doubleArrayOf(west,north,east,north)
                    if(y==art.rows-1 || !art.genesisCell(id+art.columns))edges+=doubleArrayOf(west,south,east,south)
                }
            }
            perimeter=edges;cellTexture=Texture(PixmapTextureData(cells,null,false,false,true))
            cellTexture.setFilter(Texture.TextureFilter.Nearest,Texture.TextureFilter.Nearest)
            gridShader=ShaderProgram(VERTEX,GRID_FRAGMENT);check(gridShader.isCompiled){"Parcel grid shader is unavailable"}
            shapes=ShapeRenderer()
            batch=SpriteBatch()
            islandShader=ShaderProgram(VERTEX,ISLAND_FRAGMENT)
            check(islandShader.isCompiled){"Island shader is unavailable"}
            regions.setFilter(Texture.TextureFilter.Nearest, Texture.TextureFilter.Nearest)
            require(detailSources.map { it.id } == listOf("heartlands", "solana", "stormcairn", "thornwake", "cinderfall")) { "Globe detail contract is incompatible" }
            val graphics = Gdx.graphics
            detailPreparation = GlobeDetailPreparation(detailWorker, { index, checkpoint ->
                val chain = index >= detailSources.size
                val id = if (chain) art.chainIds[index-detailSources.size] else detailSources[index].id
                val lease = assetSource?.acquire("${if(chain) "chain" else "region"}-$id",checkpoint) ?: GlobeAssetLease(assets)
                var color: Pixmap? = null; var mask: Pixmap? = null
                try {
                    checkpoint()
                    color = Pixmap(lease.directory.child("atlas/fantasy/globe/generated/$id-detail.png"))
                    checkpoint()
                    if (chain) {
                        mask = Pixmap(lease.directory.child("atlas/fantasy/globe/generated/$id-detail-mask.png"))
                        checkpoint()
                        require(color.width==art.atlas && color.height==art.atlas && mask.width==art.atlas && mask.height==art.atlas)
                        PreparedDetail.Chain(lease,color,mask)
                    } else {
                        val source = detailSources[index]
                        require(color.width == source.width && color.height == source.height) { "World detail dimensions do not match" }
                        PreparedDetail.Region(lease,color)
                    }
                } catch (error: Throwable) { color?.dispose();mask?.dispose();lease.close();throw error }
            }, PreparedDetail::dispose, graphics::requestRendering, { assetSource?.cancelPending() })
            shader = ShaderProgram(VERTEX, FRAGMENT)
            check(shader.isCompiled) { "Globe shader is unavailable" }
            mesh = Mesh(true, 4, 6, VertexAttribute(VertexAttributes.Usage.Position, 2, "a_position"))
            mesh.setVertices(floatArrayOf(-1f,-1f, 1f,-1f, 1f,1f, -1f,1f)); mesh.setIndices(shortArrayOf(0,1,2,2,3,0))
            Gdx.input.inputProcessor = object : InputAdapter() {
                val contacts=GlobeGestureState(8.0*Gdx.graphics.density)
                init { cancelGesture=contacts::clear }
                override fun touchDown(x: Int, y: Int, pointer: Int, button: Int): Boolean = contacts.down(pointer,x,y)
                override fun touchDragged(x: Int, y: Int, pointer: Int): Boolean {
                    val delta=contacts.drag(pointer,x,y) ?: return false
                    val radius=GlobeViewport(width,height).radius(view)
                    if(radius>0)requestedView=view.copy(lon=view.lon-delta.dx/radius*180/Math.PI,
                        lat=view.lat+delta.dy/radius*180/Math.PI,zoom=view.zoom*delta.scale).normalized()
                    view=requestedView;Gdx.graphics.requestRendering();onView(view,GlobeViewport(width,height));return true
                }
                override fun touchCancelled(x: Int, y: Int, pointer: Int, button: Int): Boolean = contacts.cancel(pointer)
                override fun touchUp(x: Int, y: Int, pointer: Int, button: Int): Boolean {
                    val end=contacts.up(pointer) ?: return false
                    if (end.settled) {
                        if (end.tap) GlobeGeometry.unproject(x.toDouble(), y.toDouble(), view, GlobeViewport(width,height))?.let { (lon,lat) ->
                            val px = floor((lon+180)/360*surface.width).toInt().coerceIn(0,surface.width-1)
                            val py = floor((90-lat)/180*surface.height).toInt().coerceIn(0,surface.height-1)
                            val code = surface.getPixel(px,py)
                            val footprint=GlobeViewport(width,height).radius(view)*2*Math.PI/surface.width
                            val hit=if(footprint>1.5)art.islandAt(lon,lat) else null
                            val pick=if(hit!=null) {
                                val pixels=islands[hit.island.chain]?.pixels
                                // The coarse chain remains inspectable while its precise mask loads.
                                // Touch processing never decodes files or guesses an island land hit.
                                if(pixels==null)GlobePick(lon,lat,chain=hit.island.chain)
                                else if(pixels.getPixel(hit.x,hit.y) ushr 24 == 1)GlobePick(lon,lat,chain=hit.island.chain,island=hit.island.slot)
                                else GlobePick(lon,lat)
                            } else if((footprint>1.5 && (code ushr 8 and 255)>0) || code ushr 24==0)GlobePick(lon,lat)
                            else if((code ushr 8 and 255)>0)GlobePick(lon,lat,chain=(code ushr 8 and 255)-1)
                            else GlobePick(lon,lat,realm=(regionPixels.getPixel(px,py) ushr 24)-1,deedEligible=(code ushr 16 and 255)>0)
                            onPick(pick)
                        }
                        onView(view, GlobeViewport(width,height))
                    }
                    return true
                }
                override fun scrolled(amountX: Float, amountY: Float): Boolean {
                    requestedView = view.copy(zoom = view.zoom * 1.2.pow(-amountY.toDouble())).normalized()
                    view = requestedView; Gdx.graphics.requestRendering(); onView(view, GlobeViewport(width,height)); return true
                }
            }
            ready = true
            Gdx.graphics.isContinuousRendering = false
        } catch (error: Exception) { onError(error.message ?: "World artwork could not open") }
    }
    override fun resize(width: Int, height: Int) {
        this.width=width;this.height=height;paintedView=null;cloudView=null;detailView=null
        globeFrame?.dispose();globeFrame=null;cloudTexture?.dispose();cloudTexture=null;cloudPixels?.dispose();cloudPixels=null
        if(width>0&&height>0&&::batch.isInitialized) {batch.projectionMatrix.setToOrtho2D(0f,0f,width.toFloat(),height.toFloat());shapes.projectionMatrix.setToOrtho2D(0f,0f,width.toFloat(),height.toFloat())}
        onView(requestedView,GlobeViewport(width,height));Gdx.graphics.requestRendering()
    }
    private fun uniforms(program:ShaderProgram,radius:Float) {
        program.setUniformf("u_resolution",width.toFloat(),height.toFloat())
        program.setUniformf("u_camera",(view.lon*Math.PI/180).toFloat(),(view.lat*Math.PI/180).toFloat())
        program.setUniformf("u_radius",radius)
        program.setUniformf("u_oceanSize",art.oceanWidth.toFloat(),art.oceanHeight.toFloat())
        for((index,stop)in art.oceanStops.withIndex())program.setUniformf("u_stop$index",stop[0],stop[1]/255,stop[2]/255,stop[3]/255)
        program.setUniformf("u_oceanMix",((view.zoom-1)/2).coerceIn(0.0,1.0).toFloat())
    }
    private fun paintGlobe() {
        val viewport=GlobeViewport(width,height);val radius=viewport.radius(view).toFloat();val footprint=radius*2*Math.PI/surface.width
        shader.bind();uniforms(shader,radius)
        detailSources.indices.forEach { index ->
            // Every sampler remains bound, but absent details retain the exact coarse colour.
            (details[index]?.texture ?: color).bind(index + 2);shader.setUniformi("u_detail$index", index + 2)
            shader.setUniformf("u_available$index", if (index in details) 1f else 0f)
            val source = detailSources[index];shader.setUniformf("u_patch$index", source.west, source.east, source.south, source.north)
            shader.setUniformf("u_filter$index",source.width.toFloat(),source.height.toFloat(),(footprint*source.filterScale-1).coerceIn(0.0,1.0).toFloat())
        }
        ocean.bind(7);shader.setUniformi("u_ocean",7)
        regions.bind(1);shader.setUniformi("u_regions",1)
        color.bind(0);shader.setUniformi("u_texture",0)
        shader.setUniformf("u_detailMix",((footprint-.8)/.7).coerceIn(0.0,1.0).toFloat())
        shader.setUniformf("u_islands",if(footprint>1.5)1f else 0f)
        shader.setUniformf("u_islandReadyMask",islands.keys.fold(0) { bits,index->bits or (1 shl index) }.toFloat())
        mesh.render(shader,GL20.GL_TRIANGLES)
        if(radius*2*Math.PI/art.columns>=3) {
            gridShader.bind();gridShader.setUniformf("u_resolution",width.toFloat(),height.toFloat())
            gridShader.setUniformf("u_camera",(view.lon*Math.PI/180).toFloat(),(view.lat*Math.PI/180).toFloat())
            gridShader.setUniformf("u_radius",radius);gridShader.setUniformf("u_gridSize",art.columns.toFloat(),art.rows.toFloat())
            regions.bind(1);gridShader.setUniformi("u_regions",1);cellTexture.bind(0);gridShader.setUniformi("u_cells",0)
            Gdx.gl.glEnable(GL20.GL_BLEND);Gdx.gl.glBlendFunc(GL20.GL_SRC_ALPHA,GL20.GL_ONE_MINUS_SRC_ALPHA)
            mesh.render(gridShader,GL20.GL_TRIANGLES);Gdx.gl.glDisable(GL20.GL_BLEND)
        }
        if(footprint<=1.5){paintSanctuary();return}
        islandShader.bind();uniforms(islandShader,radius)
        islandShader.setUniformf("u_layout",art.cell.toFloat(),art.atlas.toFloat(),art.extent.toFloat())
        ocean.bind(2);islandShader.setUniformi("u_ocean",2)
        // Canonical first candidate wins in overlapping rectangles. At most three decoded atlases
        // remain resident; the resulting sphere is cached so clouds never churn that LRU.
        for(island in art.islands.asReversed()) {
            val point=GlobeGeometry.project(island.lon,island.lat,view,viewport)
            val angular=(island.rx+island.ry)*art.extent*Math.PI/180
            if(point.z+angular<=0)continue
            val extent=angular*radius+2
            val left=max(0,floor(point.x-extent).toInt());val right=min(width,ceil(point.x+extent).toInt())
            val top=max(0,floor(point.y-extent).toInt());val bottom=min(height,ceil(point.y+extent).toInt())
            if(right<=left || bottom<=top)continue
            val entry=islands[island.chain] ?: continue
            ocean.bind(2) // A newly decoded atlas may have used the previously active texture unit.
            entry.mask.bind(1);islandShader.setUniformi("u_mask",1)
            entry.color.bind(0);islandShader.setUniformi("u_color",0)
            islandShader.setUniformf("u_island",island.lon.toFloat(),island.lat.toFloat(),island.rx.toFloat(),island.ry.toFloat())
            islandShader.setUniformf("u_slot",(island.slot%3).toFloat(),(island.slot/3).toFloat())
            Gdx.gl.glEnable(GL20.GL_SCISSOR_TEST);Gdx.gl.glScissor(left,height-bottom,right-left,bottom-top)
            mesh.render(islandShader,GL20.GL_TRIANGLES)
        }
        Gdx.gl.glDisable(GL20.GL_SCISSOR_TEST)
        paintSanctuary()
    }
    private fun paintSanctuary() {
        if(view.zoom<2.5 || view.zoom>9)return
        Gdx.gl.glEnable(GL20.GL_BLEND);Gdx.gl.glBlendFunc(GL20.GL_SRC_ALPHA,GL20.GL_ONE_MINUS_SRC_ALPHA)
        shapes.begin(ShapeRenderer.ShapeType.Line);shapes.setColor(196/255f,177/255f,208/255f,76/255f)
        for(edge in perimeter) {
            val a=GlobeGeometry.project(edge[0],edge[1],view,GlobeViewport(width,height));val b=GlobeGeometry.project(edge[2],edge[3],view,GlobeViewport(width,height))
            if(a.z<.15 || b.z<.15)continue
            shapes.line(a.x.roundToInt().toFloat(),height-a.y.roundToInt().toFloat(),b.x.roundToInt().toFloat(),height-b.y.roundToInt().toFloat())
        }
        shapes.end();Gdx.gl.glDisable(GL20.GL_BLEND)
    }
    private fun updateSelection() {
        val changed=requestedSelection
        if(changed==paintedSelection)return
        val ids=paintedSelection.owned+paintedSelection.occupied+changed.owned+changed.occupied+listOfNotNull(paintedSelection.selected,changed.selected)
        for(id in ids)if(id in 0 until art.columns*art.rows) {
            val x=id%art.columns;val y=id/art.columns
            val state=when {id==changed.selected->3;id in changed.owned->2;id in changed.occupied->1;else->0}
            cells.drawPixel(x,y,(cells.getPixel(x,y) and 0xff00ffff.toInt()) or (state shl 16))
        }
        cellTexture.bind();cells.pixels.position(0)
        Gdx.gl.glTexSubImage2D(GL20.GL_TEXTURE_2D,0,0,0,art.columns,art.rows,GL20.GL_RGBA,GL20.GL_UNSIGNED_BYTE,cells.pixels)
        paintedSelection=changed;paintedView=null
    }
    private fun updateDetails() {
        val preparation = detailPreparation ?: return
        if (retryDetailRequested) {
            retryDetailRequested = false; preparation.pause(); preparation.resume()
            detailErrorReported = false; onDetailError(null)
        }
        if (detailView != view) {
            visibleDetails = visibleGlobeDetails(detailSources, view, GlobeViewport(width,height), surface.width)
            visibleChains = visibleGlobeChains(art.islands, art.extent, view, GlobeViewport(width,height), surface.width)
            detailView = view
        }
        // Keep every visible patch, with at most two inactive warm entries. The same five-region
        // ceiling as web is never exceeded, and an overview no longer decodes all regional art.
        visibleDetails.forEach { index -> details.remove(index)?.let { details[index] = it } }
        val inactive = details.keys.filter { it !in visibleDetails }
        inactive.dropLast(2).forEach { index -> details.remove(index)?.dispose(); paintedView = null }
        visibleChains.forEach { index -> islands.remove(index)?.let { islands[index]=it } }
        val retainedChains=(visibleChains+islands.keys.toList().asReversed()).distinct().take(3).toSet()
        islands.keys.filter { it !in retainedChains }.forEach { islands.remove(it)?.dispose();paintedView=null }
        val wanted=visibleChains.filter { it !in islands }.map { it+detailSources.size } + visibleDetails.filter { it !in details }
        activatingChain?.let { pending ->
            activatingChain=null
            if(pending.index !in wanted)pending.dispose()
            else {
                var mask:Texture?=null
                try {
                    // Color and mask upload on separate frames, but become visible atomically.
                    val prepared=pending.prepared
                    mask=Texture(PixmapTextureData(prepared.mask,null,false,false,true))
                    mask.setFilter(Texture.TextureFilter.Nearest,Texture.TextureFilter.Nearest)
                    islands.put(pending.index-detailSources.size,IslandTextures(pending.color,mask,prepared.mask,prepared.lease))?.dispose()
                    paintedView=null
                } catch(error:Exception) { mask?.dispose();pending.dispose();preparation.fail(pending.index);reportDetailError() }
            }
            preparation.request(visibleChains.filter { it !in islands }.map { it+detailSources.size }+visibleDetails.filter { it !in details })
            return
        }
        preparation.request(wanted)
        preparation.take()?.let { completed ->
            completed.value.fold({ prepared ->
                var texture: Texture? = null
                try {
                    // Decode already happened on the worker. FileTextureData owns/disposes the
                    // pixmap at upload and remains valid for an unexpected EGL recreation.
                    val id=if(prepared is PreparedDetail.Chain)art.chainIds[completed.index-detailSources.size] else detailSources[completed.index].id
                    val pixels=when(prepared) {is PreparedDetail.Chain->prepared.color;is PreparedDetail.Region->prepared.pixels}
                    texture = Texture(FileTextureData(prepared.lease.directory.child("atlas/fantasy/globe/generated/$id-detail.png"), pixels, null, false))
                    if(prepared is PreparedDetail.Chain) {
                        texture.setFilter(Texture.TextureFilter.Nearest,Texture.TextureFilter.Nearest)
                        activatingChain=ActivatingChain(completed.index,prepared,texture)
                        Gdx.graphics.requestRendering()
                    } else {
                        texture.setFilter(Texture.TextureFilter.Linear, Texture.TextureFilter.Linear)
                        details.put(completed.index, RegionTexture(texture,prepared.lease))?.dispose();paintedView=null
                    }
                } catch (error: Exception) {
                    texture?.dispose()
                    prepared.dispose()
                    preparation.fail(completed.index); reportDetailError()
                }
            }, { reportDetailError() })
            // One texture upload per frame. The next decode can begin after this hand-off.
            if(activatingChain==null)preparation.request(visibleChains.filter { it !in islands }.map { it+detailSources.size }+visibleDetails.filter { it !in details })
        }
    }
    private fun reportDetails() {
        val observer = onDetailState ?: return
        val state = GlobeDetailState(details.keys.map { detailSources[it].id }, (detailPreparation?.pendingCount() ?: 0)+(if(activatingChain!=null)1 else 0), reportedReady, paused, view,
            islands.keys.map { art.chainIds[it] },activatingChain?.let { art.chainIds[it.index-detailSources.size] })
        if (reportedDetailState != state) { reportedDetailState = state; observer(state) }
    }
    private fun reportDetailError() {
        if (!detailErrorReported) { detailErrorReported = true; onDetailError("Some world detail couldn't load.") }
    }
    override fun render() {
        Gdx.gl.glClearColor(11/255f,14/255f,20/255f,1f);Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)
        if (!ready || paused || width <= 0 || height <= 0) return
        try {
            view=requestedView;updateSelection();if(reportedReady)updateDetails()
            val now=TimeUtils.nanoTime()
            if(clock!=0L && motion)elapsedMs+=((now-clock)/1_000_000.0).coerceIn(0.0,100.0)
            clock=now
            val frame=globeFrame ?: FrameBuffer(Pixmap.Format.RGBA8888,width,height,false).also {globeFrame=it}
            if(paintedView!=view) {
                frame.begin()
                try { paintGlobe() } finally { Gdx.gl.glDisable(GL20.GL_SCISSOR_TEST);frame.end() }
                paintedView=view
            }
            // The island pass can finish on unit 2 when no island is visible.
            // Pixmap uploads and SpriteBatch's sampler both require unit 0.
            Gdx.gl.glActiveTexture(GL20.GL_TEXTURE0)
            if(cloudView!=view || now-lastCloud>=50_000_000L) {
                val pixels=cloudPixels ?: Pixmap(width,height,Pixmap.Format.RGBA8888).also {cloudPixels=it}
                val data=clouds.draw(view,GlobeViewport(width,height),elapsedMs,motion,1.0/Gdx.graphics.density)
                effects.draw(data,view,GlobeViewport(width,height),elapsedMs,motion,1.0/Gdx.graphics.density)
                val buffer=pixels.pixels;buffer.clear();data.forEach { value->buffer.put((value ushr 24).toByte());buffer.put((value ushr 16).toByte());buffer.put((value ushr 8).toByte());buffer.put(value.toByte()) };buffer.position(0)
                val texture=cloudTexture ?: Texture(PixmapTextureData(pixels,null,false,false,true)).also {cloudTexture=it}
                texture.bind();Gdx.gl.glTexSubImage2D(GL20.GL_TEXTURE_2D,0,0,0,width,height,GL20.GL_RGBA,GL20.GL_UNSIGNED_BYTE,buffer)
                cloudView=view;lastCloud=now
            }
            // The framebuffer already has a bottom-left origin. Keep it upright so
            // north, marker projection and touch unprojection describe the same pixels.
            batch.begin();batch.draw(frame.colorBufferTexture,0f,0f,width.toFloat(),height.toFloat(),0f,0f,1f,1f)
            cloudTexture?.let {batch.draw(it,0f,0f,width.toFloat(),height.toFloat())};batch.end()
            if (!reportedReady) { reportedReady=true;onReady();Gdx.graphics.requestRendering() }
            reportDetails()
            // A stopped/reduced scene does not hold a continuous animation loop.
            val center=GlobeGeometry.project(-115.0,38.0,view,GlobeViewport(width,height))
            val canopy=art.clouds.maxOf { abs(it.lon+115)+it.width/2+.55+abs(it.lat-38)+it.height/2+.18 }*Math.PI/180
            val span=GlobeViewport(width,height).radius(view)*canopy+10
            Gdx.graphics.isContinuousRendering=motion && ((center.z+canopy>.12 && center.x+span>=0 && center.x-span<width && center.y+span>=0 && center.y-span<height) || effects.visible(view,GlobeViewport(width,height),1.0/Gdx.graphics.density))
        } catch(error:Exception) {ready=false;Gdx.graphics.isContinuousRendering=false;onError(error.message ?: "World artwork could not draw")}
    }
    override fun pause() {
        cancelGesture();clock=0;paused=true;detailPreparation?.pause()
        // Do not make Android restore a stack of detail textures before the coarse world resumes.
        activatingChain?.dispose();activatingChain=null
        islands.values.forEach(IslandTextures::dispose);islands.clear()
        details.values.forEach(RegionTexture::dispose);details.clear();paintedView=null;reportDetails()
    }
    override fun resume() {
        clock=0;paused=false;paintedView=null;cloudView=null;detailView=null;detailPreparation?.resume()
        Gdx.graphics.requestRendering()
    }
    override fun dispose() {
        cancelGesture()
        activatingChain?.dispose();activatingChain=null
        islands.values.forEach {it.dispose()};islands.clear()
        globeFrame?.dispose();cloudTexture?.dispose();cloudPixels?.dispose()
        if(::batch.isInitialized)batch.dispose()
        if(::shapes.isInitialized)shapes.dispose()
        if(::gridShader.isInitialized)gridShader.dispose()
        if(::cellTexture.isInitialized)cellTexture.dispose()
        if(::cells.isInitialized)cells.dispose()
        if(::ocean.isInitialized)ocean.dispose()
        if(::oceanPixels.isInitialized)oceanPixels.dispose()
        if (::color.isInitialized) color.dispose()
        if (::surface.isInitialized) surface.dispose()
        if (::regions.isInitialized) regions.dispose()
        if (::regionPixels.isInitialized) regionPixels.dispose()
        details.values.forEach(RegionTexture::dispose);details.clear()
        if (::shader.isInitialized) shader.dispose()
        if (::islandShader.isInitialized) islandShader.dispose()
        if (::mesh.isInitialized) mesh.dispose()
        // The scene lease outlives a still-reading worker without a synchronous GL/Main join.
        val preparation = detailPreparation
        if (preparation != null) preparation.close { detailWorker.shutdown();onDisposed() }
        else { detailWorker.shutdown();onDisposed() }
    }
    companion object {
        private const val VERTEX = "attribute vec2 a_position; void main(){ gl_Position=vec4(a_position,0.0,1.0); }"
        private const val SPHERE = """
            #ifdef GL_ES
            precision highp float;
            #endif
            uniform vec2 u_resolution,u_camera,u_oceanSize;
            uniform float u_radius,u_oceanMix;
            uniform sampler2D u_ocean;
            uniform vec4 u_stop0,u_stop1,u_stop2,u_stop3;
            float depthAt(vec2 cell){
                vec2 uv=(vec2(mod(mod(cell.x,u_oceanSize.x)+u_oceanSize.x,u_oceanSize.x),clamp(cell.y,0.0,u_oceanSize.y-1.0))+.5)/u_oceanSize;
                vec4 b=floor(texture2D(u_ocean,uv)*255.0+.5);
                float exponent=mod(b.r,128.0)*2.0+floor(b.g/128.0);
                float mantissa=(mod(b.g,128.0)*65536.0+b.b*256.0+b.a)/8388608.0;
                return (b.r>=128.0?-1.0:1.0)*(1.0+mantissa)*exp2(exponent-127.0);
            }
            vec3 oceanColor(vec2 uv){
                vec2 p=vec2(uv.x*u_oceanSize.x-.5,clamp(uv.y*u_oceanSize.y-.5,0.0,u_oceanSize.y-1.0));
                vec2 cell=floor(p),f=fract(p);
                float h=mix(mix(depthAt(cell),depthAt(cell+vec2(1.0,0.0)),f.x),mix(depthAt(cell+vec2(0.0,1.0)),depthAt(cell+vec2(1.0)),f.x),f.y);
                if(h<=u_stop1.x)return mix(u_stop0.yzw,u_stop1.yzw,clamp((h-u_stop0.x)/(u_stop1.x-u_stop0.x),0.0,1.0));
                if(h<=u_stop2.x)return mix(u_stop1.yzw,u_stop2.yzw,clamp((h-u_stop1.x)/(u_stop2.x-u_stop1.x),0.0,1.0));
                return mix(u_stop2.yzw,u_stop3.yzw,clamp((h-u_stop2.x)/(u_stop3.x-u_stop2.x),0.0,1.0));
            }
            vec2 geography(vec2 p,float z){
                float c=cos(u_camera.y),s=sin(u_camera.y);
                float lat=asin(clamp(p.y*c+z*s,-1.0,1.0));
                float lon=u_camera.x+atan(p.x,z*c-p.y*s);
                return vec2(fract((lon+3.14159265359)/6.28318530718),.5-lat/3.14159265359);
            }
            vec3 lighting(vec3 rgb,vec2 p,float z){
                float sun=dot(vec3(p,z),vec3(-.38,.44,.79));
                rgb*=sun>.23?1.0:(sun>-.12?.72:.4);
                if(z<.11)rgb=rgb*vec3(.55,.65,.7)+vec3(38.0,43.0,45.0)/255.0;
                return rgb;
            }
        """
        private val FRAGMENT = SPHERE + """
            uniform sampler2D u_texture,u_regions,u_detail0,u_detail1,u_detail2,u_detail3,u_detail4;
            uniform vec4 u_patch0,u_patch1,u_patch2,u_patch3,u_patch4;
            uniform vec3 u_filter0,u_filter1,u_filter2,u_filter3,u_filter4;
            uniform float u_detailMix,u_islands,u_islandReadyMask,u_available0,u_available1,u_available2,u_available3,u_available4;
            vec2 patchUv(vec2 degrees,vec4 bounds){
                float lon=degrees.x+floor(((bounds.x+bounds.y)*.5-degrees.x)/360.0+.5)*360.0;
                return vec2((lon-bounds.x)/(bounds.y-bounds.x),(bounds.w-degrees.y)/(bounds.w-bounds.z));
            }
            vec3 detailColor(sampler2D image,vec2 uv,vec3 filterInfo){
                vec2 nearest=(floor(uv*filterInfo.xy)+.5)/filterInfo.xy;
                return mix(texture2D(image,nearest).rgb,texture2D(image,clamp(uv,.5/filterInfo.xy,1.0-.5/filterInfo.xy)).rgb,filterInfo.z);
            }
            void main(){
                vec2 p=(gl_FragCoord.xy-u_resolution*.5)/u_radius;float r2=dot(p,p);
                if(r2>1.0){
                    vec3 rgb=vec3(11.0,14.0,20.0);
                    if(r2<1.023)rgb=vec3(42.0,76.0,75.0);
                    else if(r2<1.055&&mod(floor(gl_FragCoord.x)+floor(gl_FragCoord.y),2.0)<1.0)rgb=vec3(21.0,42.0,37.0);
                    gl_FragColor=vec4(rgb/255.0,1.0);return;
                }
                float z=sqrt(max(0.0,1.0-r2));vec2 uv=geography(p,z);
                vec3 rgb=texture2D(u_texture,uv).rgb;vec4 mask=texture2D(u_regions,uv);
                float region=floor(mask.r*255.0+.5)-1.0;
                bool exploration=mask.a>0.0;
                vec2 degrees=vec2(uv.x*360.0-180.0,90.0-uv.y*180.0);
                vec2 detailUv=vec2(-1.0);vec3 detail=rgb;
                if(region>=0.0 && !exploration && u_detailMix>0.0){
                    if(region<3.5 && u_available0>0.0){detailUv=patchUv(degrees,u_patch0);detail=detailColor(u_detail0,detailUv,u_filter0);}
                    else if(region>=3.5 && region<4.5 && u_available1>0.0){detailUv=patchUv(degrees,u_patch1);detail=detailColor(u_detail1,detailUv,u_filter1);}
                    else if(region>=4.5 && region<5.5 && u_available2>0.0){detailUv=patchUv(degrees,u_patch2);detail=detailColor(u_detail2,detailUv,u_filter2);}
                    else if(region>=5.5 && region<6.5 && u_available3>0.0){detailUv=patchUv(degrees,u_patch3);detail=detailColor(u_detail3,detailUv,u_filter3);}
                    else if(region>=6.5 && u_available4>0.0){detailUv=patchUv(degrees,u_patch4);detail=detailColor(u_detail4,detailUv,u_filter4);}
                    if(detailUv.x>=0.0 && detailUv.x<1.0 && detailUv.y>=0.0 && detailUv.y<1.0)rgb=mix(rgb,detail,u_detailMix);
                }
                float chain=floor(mask.a*255.0+.5)-1.0;
                bool islandReady=exploration && mod(floor(u_islandReadyMask/exp2(chain)),2.0)>0.5;
                if(islandReady&&u_islands>0.0)rgb=oceanColor(uv);
                else if(!exploration&&region<0.0)rgb=mix(rgb,oceanColor(uv),u_oceanMix);
                gl_FragColor=vec4(lighting(rgb,p,z),1.0);
            }
        """
        private val GRID_FRAGMENT = SPHERE + """
            uniform sampler2D u_cells,u_regions;
            uniform vec2 u_gridSize;
            vec3 cellInfo(vec2 pixel){
                vec2 p=(pixel-u_resolution*.5)/u_radius;float r2=dot(p,p);if(r2>1.0)return vec3(-1.0,0.0,0.0);
                vec2 uv=geography(p,sqrt(max(0.0,1.0-r2)));
                if(texture2D(u_regions,uv).g==0.0)return vec3(-1.0,0.0,0.0);
                vec2 cell=clamp(floor(uv*u_gridSize),vec2(0.0),u_gridSize-1.0);
                vec4 value=texture2D(u_cells,(cell+.5)/u_gridSize);
                if(value.r==0.0)return vec3(-1.0,0.0,0.0);
                return vec3(cell.y*u_gridSize.x+cell.x,floor(value.g*255.0+.5),uv.y);
            }
            void main(){
                vec3 current=cellInfo(gl_FragCoord.xy);if(current.x<0.0)discard;
                float h=current.y>2.5?.4:current.y>.5?.2:0.0;
                vec3 tint=current.y>2.5?vec3(244.0,215.0,123.0):current.y>1.5?vec3(227.0,174.0,60.0):vec3(121.0,191.0,191.0);
                vec2 p=(gl_FragCoord.xy-u_resolution*.5)/u_radius;float z=sqrt(max(0.0,1.0-dot(p,p)));
                bool grid=u_radius*6.28318530718/u_gridSize.x*cos((.5-current.z)*3.14159265359)*z>=3.0;
                vec3 left=cellInfo(gl_FragCoord.xy-vec2(1.0,0.0)),up=cellInfo(gl_FragCoord.xy+vec2(0.0,1.0));
                bool edge=grid && ((left.x>=0.0&&left.x!=current.x)||(up.x>=0.0&&up.x!=current.x));
                float line=0.0;vec3 ink=vec3(36.0,47.0,42.0);
                if(edge){bool strong=current.y>2.5||left.y>2.5||up.y>2.5;bool gold=strong||current.y>1.5||left.y>1.5||up.y>1.5;line=strong?.95:gold?.7:.42;if(gold)ink=vec3(244.0,215.0,123.0);}
                float a=line+h*(1.0-line);if(a==0.0)discard;
                gl_FragColor=vec4((ink*line+tint*h*(1.0-line))/a/255.0,a);
            }
        """
        private val ISLAND_FRAGMENT = SPHERE + """
            uniform sampler2D u_color,u_mask;
            uniform vec4 u_island;
            uniform vec3 u_layout;
            uniform vec2 u_slot;
            void main(){
                vec2 p=(gl_FragCoord.xy-u_resolution*.5)/u_radius;float r2=dot(p,p);if(r2>1.0)discard;
                float z=sqrt(max(0.0,1.0-r2));vec2 uv=geography(p,z);
                vec2 degrees=vec2(uv.x*360.0-180.0,90.0-uv.y*180.0);
                vec2 local=vec2(mod(mod(degrees.x-u_island.x+180.0,360.0)+360.0,360.0)-180.0,degrees.y-u_island.y)/u_island.zw;
                if(abs(local.x)>=u_layout.z || abs(local.y)>=u_layout.z)discard;
                vec2 cell=floor((local/u_layout.z*vec2(1.0,-1.0)+1.0)*u_layout.x*.5);
                vec2 atlas=(u_slot*u_layout.x+cell+.5)/u_layout.y;
                bool land=floor(texture2D(u_mask,atlas).r*255.0+.5)==1.0;
                vec3 rgb=texture2D(u_color,atlas).rgb;
                if(!land)rgb=mix(rgb,oceanColor(uv),u_oceanMix);
                gl_FragColor=vec4(lighting(rgb,p,z),1.0);
            }
        """
    }
}
