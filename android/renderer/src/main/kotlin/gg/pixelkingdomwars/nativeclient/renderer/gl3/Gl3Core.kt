package gg.pixelkingdomwars.nativeclient.renderer.gl3

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import java.nio.Buffer
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The world engines' GL core (GLOBE-NATIVE-PLAN §3.2, §5; mirrors the web `core.js`): programs built off the GL thread
 * and adopted on a fence, immutable textures with an allocator tally and per-pool caps (evict LRU first, then refuse),
 * cached framebuffers, std140 uniform blocks, (program, state) first-draw tracking with a rehearsal into scratch
 * targets, the tiler frame order, a fence ring for the GPU-bound flag, and context-change detection with a restore
 * registry. GL thread only; one instance per world EGL context lifetime.
 *
 * The engines issue every call that changes what the pair key sees (program, blend, depth, colour mask, cull,
 * scissor, target, vertex array, texture binds and draws) through this class; [gl] is public for uniforms, buffer
 * data and vertex-attribute setup only.
 *
 * [strict] turns a rule violation into an exception (tests, debug builds); otherwise it is counted in
 * [Gl3Stats.orderViolations] and the offending call is dropped. [coldUploadBytes] is `GPU_SAFE.coldUploadBytes`.
 *
 * Render on demand (plan §5.6, §5.8): [wake] runs, on the publishing thread, whenever a submitted program's build ends
 * (the host passes its pacer's any-thread `markDirty`); after every frame the host asks [needsFrame] and schedules the
 * next paced vsync while it holds. Nothing here needs a frame while a build is only queued, so the world stays at 0 fps.
 */
class Gl3Core(val gl: Gl3, private val compiler: ProgramCompiler, private val coldUploadBytes: Long, private val strict: Boolean,
              private val wake: Runnable = NO_WAKE) {
    val stats = Gl3Stats()
    private val report = Gl3FrameReport()

    /** The context generation: bumped on every context change; objects of an older epoch are stale. */
    var epoch = 0; private set
    private var contextId = 0L
    private var lost = false
    private var awaitingNewContext = false
    private var passLive = true
    private var sentinel = 0
    /** Set by the first frame that drew to the screen; cleared by a context change (a restore builds again). */
    var firstWorldFrameDrawn = false; private set
    private var frameIndex = 0L
    private var inFrame = false
    private var phase = IDLE
    @PublishedApi internal var rehearsing = false
    private var bufferW = 1
    private var bufferH = 1
    private var scratchUnit = 15

    private val programs = HashMap<String, Gl3Program>()
    private val pending = ArrayList<Gl3Program>()
    /** Programs a blocking compiler relinks after a context loss, one per frame ([restoring]). */
    private val restoreQueue = ArrayDeque<Gl3Program>()
    private var programUid = 0
    private var current: Gl3Program? = null
    private var currentBound = false

    // state shadow (what the pair key sees)
    private var blend = false
    private var srcRgb = GL20.GL_ONE; private var dstRgb = GL20.GL_ZERO
    private var srcAlpha = GL20.GL_ONE; private var dstAlpha = GL20.GL_ZERO
    private var depthTest = false; private var depthWrite = true; private var depthFn = GL20.GL_LESS
    private var colorBits = 15
    private var cull = false
    private var scissorTest = false
    private var keyFormat = 0
    private var keyDepth = true
    private var layout = 0
    private var vao: Gl3VertexArray? = null
    private var framebuffer = 0
    private val pairs = LongSet()

    // textures (an intrusive LRU list is also the registry)
    private var texUid = 0
    private var lruHead: Gl3Texture? = null
    private var lruTail: Gl3Texture? = null
    private val poolCaps = LongArray(Gl3Pool.entries.size) { Long.MAX_VALUE }
    private var combinedCap = Long.MAX_VALUE
    private val pendingTextures = ArrayList<Gl3Texture>()
    private val dummies = arrayOfNulls<Gl3Texture>(4)
    private var lowT: Gl3Texture? = null

    private val vertexArrays = ArrayList<Gl3VertexArray>()
    private val blocks = ArrayList<Gl3UniformBlock>()
    private val restorables = ArrayList<Gl3Restorable>()
    private val triVao = Gl3VertexArray(LAYOUT_FULLSCREEN)
    private val quadVao = Gl3VertexArray(LAYOUT_QUAD)
    private var triBuffer = 0
    private var quadBuffer = 0

    private val fenceSync = LongArray(FENCES)
    private val fenceSubmitNs = LongArray(FENCES)
    private val fenceSeenNs = LongArray(FENCES)
    private val fenceCold = BooleanArray(FENCES)

    private var frameFirstDraws = 0
    private var frameAdoptions = 0
    private var frameUploadBytes = 0L
    private var frameDraws = 0
    private var frameInstances = 0L
    private var framePasses = 0
    private var lastOwnCold = false

    init { initContextObjects() }

    // ---------------------------------------------------------------- frame

    /** The world surface's buffer size (the fixed dpr-2 buffer, plan §5.5). */
    fun resize(width: Int, height: Int) { bufferW = maxOf(1, width); bufferH = maxOf(1, height) }

    /**
     * Start a frame. [contextId] is the current EGL context handle (`EGL14.eglGetCurrentContext().nativeHandle`). A
     * reset status, a changed handle or a vanished sentinel program is a context loss (plan §5.7): objects go stale,
     * [Gl3Stats.contextLosses] counts it and [Gl3FrameReport.contextChanged] reports it. A reset leaves the context
     * unusable, so the frame is skipped (false) until a new handle arrives; a new handle restores at once: core
     * objects are rebuilt, every program is resubmitted (with a blocking compiler: queued, see [restoring]) and every
     * [Gl3Restorable] runs.
     */
    fun beginFrame(nowNanos: Long, contextId: Long): Boolean {
        if (inFrame) { stats.orderViolations++; inFrame = false; rehearsing = false } // the last frame threw mid-way
        report.contextChanged = false
        if (this.contextId == 0L) this.contextId = contextId
        else if (!lost) {
            // (a reset status is reported once; with EGL_LOSE_CONTEXT_ON_RESET the context stays dead, so after a
            // reset only a NEW handle restores; a vanished sentinel under the same handle is a new, usable context)
            val reset = gl.getGraphicsResetStatus() != 0
            if (reset || contextId != this.contextId || (sentinel != 0 && !gl.isProgram(sentinel))) {
                markLost()
                awaitingNewContext = reset && contextId == this.contextId
            }
        }
        if (lost) {
            if (awaitingNewContext && contextId == this.contextId) return false
            restore(contextId) // the restore frame links nothing
        } else if (restoreQueue.isNotEmpty()) submit(restoreQueue.removeFirst()) // one GL-thread link per frame
        inFrame = true
        passLive = true
        phase = BEFORE_PASSES
        frameIndex++
        pollFences(nowNanos)
        pollPrograms()
        pollTextures()
        return true
    }

    /** End the frame: invalidate the screen's depth before the swap, fence the frame, report it (plan §5.4, §5.9). */
    fun endFrame(nowNanos: Long): Gl3FrameReport {
        guard(inFrame, "endFrame outside a frame")
        if (phase == SCREEN) gl.invalidateFramebuffer(GL20.GL_FRAMEBUFFER, 1, SCREEN_DEPTH)
        val own = frameFirstDraws > 0 || frameAdoptions > 0 || frameUploadBytes > coldUploadBytes
        val cold = own || lastOwnCold
        lastOwnCold = own
        val slot = (frameIndex % FENCES).toInt()
        if (fenceSync[slot] != 0L) gl.deleteSync(fenceSync[slot])
        fenceSync[slot] = gl.fenceSync(); fenceSubmitNs[slot] = nowNanos; fenceSeenNs[slot] = 0L; fenceCold[slot] = cold
        if (phase == SCREEN && restoreQueue.isEmpty()) firstWorldFrameDrawn = true // a restore is behind the loading state
        report.frame = frameIndex; report.cold = cold; report.draws = frameDraws; report.instances = frameInstances
        report.passes = framePasses; report.firstDraws = frameFirstDraws; report.adoptions = frameAdoptions; report.uploadBytes = frameUploadBytes
        stats.frames++; stats.drawsLast = frameDraws; stats.instancesLast = frameInstances; stats.passesLast = framePasses
        if (report.gpuBound) stats.gpuBoundFrames++
        frameFirstDraws = 0; frameAdoptions = 0; frameUploadBytes = 0L; frameDraws = 0; frameInstances = 0L; framePasses = 0
        inFrame = false; phase = IDLE; rehearsing = false
        return report
    }

    /** Bind an offscreen target for a pass. Offscreen passes come first in a frame; after [beginScreen] or inside a
     *  rehearsal this is a frame-order violation (plan §5.9). The colour attachment starts per [load]. */
    fun offscreen(color: Gl3Texture, layer: Int = 0, level: Int = 0, load: Gl3Load = Gl3Load.CLEAR, depth: Gl3Texture? = null) {
        guard(inFrame, "offscreen pass outside a frame")
        if (phase == SCREEN || rehearsing) return violation("offscreen pass after the screen pass or inside a rehearsal")
        phase = OFFSCREEN
        if (stale(color) || (depth != null && stale(depth)) || color.state != Gl3Texture.READY) { passLive = false; return }
        passLive = true
        bindTarget(color, layer, level, depth)
        keyFormat = color.format.id; keyDepth = depth != null
        gl.viewport(0, 0, maxOf(1, color.width shr level), maxOf(1, color.height shr level))
        startTarget(load, depth != null)
        framePasses++
    }

    /** Bind the default framebuffer, exactly once per frame, and clear it at its start (plan §5.9). */
    fun beginScreen(r: Float, g: Float, b: Float, a: Float) {
        guard(inFrame, "screen pass outside a frame")
        if (phase == SCREEN || rehearsing) return violation("the default framebuffer bound twice in one frame")
        phase = SCREEN
        passLive = true
        gl.bindFramebuffer(GL20.GL_FRAMEBUFFER, 0); framebuffer = 0
        keyFormat = 0; keyDepth = true
        gl.viewport(0, 0, bufferW, bufferH)
        gl.clearColor(r, g, b, a)
        startTarget(Gl3Load.CLEAR, true)
        framePasses++
    }

    // ---------------------------------------------------------------- programs

    /**
     * The program [name] (fully preprocessed stages from `WorldShaders.kt`). Created once and submitted to the
     * compiler; PENDING until adopted. With a compiler that blocks the GL thread, creation after the first world frame
     * is refused: the program comes back FAILED (plan §5.3: no GL-thread link after the first world frame); while
     * [restoring] it joins the restore queue (one link per frame) instead of linking here.
     */
    fun program(name: String, vs: String, fs: String, vsSha256: String? = null, fsSha256: String? = null): Gl3Program {
        programs[name]?.let { return it }
        require(programUid < 0x7fff) { "Too many programs" }
        val program = Gl3Program(name, vs, fs, vsSha256, fsSha256, ++programUid)
        programs[name] = program
        if (compiler.blocksCaller && firstWorldFrameDrawn) {
            program.state = Gl3Program.FAILED
            program.error = "realm program $name: no GL-thread link after the first world frame"
            stats.failedPrograms++
            violation(program.error!!)
            return program
        }
        if (compiler.blocksCaller && restoreQueue.isNotEmpty()) { queueRestore(program); return program }
        submit(program)
        return program
    }

    /** Programs still building, including those waiting in the restore queue (dive readiness, the loading meter). */
    val pendingPrograms: Int get() = pending.size + restoreQueue.size

    /**
     * A context loss restored under a compiler that blocks the GL thread ([DirectProgramCompiler]: no shared context)
     * and programs are still queued for relinking. Each frame links at most one (the restore frame none), so no frame
     * stalls on more than one link, while libGDX's pause handshake waits at most 4 s before killing the process
     * (plan §5.9). The host shows the loading state and the notice until this turns false and [pendingPrograms] is 0;
     * a screen pass drawn meanwhile is not the first world frame. [needsFrame] holds throughout, so the frames come.
     */
    val restoring: Boolean get() = restoreQueue.isNotEmpty()

    /**
     * True while only another frame can finish work the core already holds: a program whose build ended (its fence
     * not yet signalled, or its failure not yet reported), a worker-filled texture adopted with a pending fence, or a
     * restore queue. Fences are polled with timeout 0 once per frame, so the host keeps its pacer running (one frame per
     * paced vsync, never a spin) while this holds: `if (core.needsFrame) idle.invalidate()` after `frameRendered`. A
     * program still queued on the worker does not count: [wake] brings the frame that adopts it. Nor does a reset
     * context waiting for its replacement (the new surface's first frame restores). Never allocates.
     */
    val needsFrame: Boolean get() {
        if (lost) return false
        if (restoreQueue.isNotEmpty() || pendingTextures.isNotEmpty()) return true
        for (i in 0 until pending.size) if (pending[i].job.state != ProgramJob.QUEUED) return true
        return false
    }

    /** Bind [program] if it is READY. A draw issued while it is not is skipped and counted, never waited for. */
    fun use(program: Gl3Program?): Boolean {
        current = program
        currentBound = program != null && program.state == Gl3Program.READY && program.epoch == epoch
        gl.useProgram(if (currentBound) program!!.handle else 0)
        return currentBound
    }

    // ---------------------------------------------------------------- state

    fun enable(cap: Int) = setCap(cap, true)
    fun disable(cap: Int) = setCap(cap, false)

    /** Ignored inside a rehearsal: the 1×1 box core set cannot be moved (core.js). */
    fun scissor(x: Int, y: Int, width: Int, height: Int) { if (!rehearsing) gl.scissor(x, y, width, height) }
    fun viewport(x: Int, y: Int, width: Int, height: Int) = gl.viewport(x, y, width, height)
    fun blendFunc(src: Int, dst: Int) = blendFuncSeparate(src, dst, src, dst)
    fun blendFuncSeparate(srcRgb: Int, dstRgb: Int, srcAlpha: Int, dstAlpha: Int) {
        this.srcRgb = srcRgb; this.dstRgb = dstRgb; this.srcAlpha = srcAlpha; this.dstAlpha = dstAlpha
        gl.blendFuncSeparate(srcRgb, dstRgb, srcAlpha, dstAlpha)
    }
    fun depthFunc(func: Int) { depthFn = func; gl.depthFunc(func) }
    fun depthMask(flag: Boolean) { depthWrite = flag; gl.depthMask(flag) }
    fun colorMask(r: Boolean, g: Boolean, b: Boolean, a: Boolean) {
        colorBits = (if (r) 1 else 0) or (if (g) 2 else 0) or (if (b) 4 else 0) or (if (a) 8 else 0)
        gl.colorMask(r, g, b, a)
    }

    /** A vertex array whose pipeline-relevant layout is [layout] (ids below 16 are the core's). Left bound, so the
     *  caller can set its attributes through [gl]. Lanes re-create theirs in a [Gl3Restorable]. */
    fun vertexArray(layout: Int): Gl3VertexArray {
        require(layout in 16..0x7fff) { "Layout ids 16..32767 belong to lanes" }
        val array = Gl3VertexArray(layout)
        createVertexArray(array)
        vertexArrays += array
        return array
    }

    fun bindVertexArray(array: Gl3VertexArray?) {
        if (array != null && array.epoch != epoch) { stats.staleUses++; return }
        vao = array; layout = array?.layout ?: 0
        gl.bindVertexArray(array?.name ?: 0)
    }

    /** The pair key of the current state (for a lane's rehearsal plan): blend and its factors, depth test/func/write,
     *  colour mask, cull, the target's format and depth attachment, and the vertex layout. */
    fun stateKey(): Long {
        var key = colorBits.toLong() shl 22
        if (blend) key = key or 1L or (factor(srcRgb).toLong() shl 1) or (factor(dstRgb).toLong() shl 5) or
            (factor(srcAlpha).toLong() shl 9) or (factor(dstAlpha).toLong() shl 13)
        if (depthTest) key = key or (1L shl 17) or ((if (depthWrite) 1L else 0L) shl 18) or (((depthFn - GL20.GL_NEVER) and 7).toLong() shl 19)
        if (cull) key = key or (1L shl 26)
        key = key or ((keyFormat and 31).toLong() shl 27) or ((layout and 0x7fff).toLong() shl 32)
        if (keyDepth) key = key or (1L shl 47)
        return key
    }

    /** Has this (program, state) pair ever been drawn in this context? */
    fun pairDrawn(program: Gl3Program, stateKey: Long): Boolean = pairs.contains(pairKey(program, stateKey))

    /** Every pair drawn so far (the emulator coverage gate compares rehearsed and used sets; allocates). */
    fun drawnPairs(): LongArray = pairs.toArray()

    // ---------------------------------------------------------------- draws

    fun drawArrays(mode: Int, first: Int, count: Int) { if (admit(1)) gl.drawArrays(mode, first, count) }
    fun drawArraysInstanced(mode: Int, first: Int, count: Int, instances: Int) { if (admit(instances)) gl.drawArraysInstanced(mode, first, count, instances) }
    fun drawElements(mode: Int, count: Int, type: Int, offset: Int) { if (admit(1)) gl.drawElements(mode, count, type, offset) }
    fun drawElementsInstanced(mode: Int, count: Int, type: Int, offset: Int, instances: Int) { if (admit(instances)) gl.drawElementsInstanced(mode, count, type, offset, instances) }

    /** The full-screen triangle (attribute 0 = clip-space xy). */
    fun fullscreen() {
        val previous = vao
        bindVertexArray(triVao); drawArrays(GL20.GL_TRIANGLES, 0, 3); bindVertexArray(previous)
    }

    /** The shared unit quad (attribute 0 = 0..1 corner, 6 vertices, non-indexed) for instanced sprites. */
    val quad: Gl3VertexArray get() = quadVao

    private fun admit(instances: Int): Boolean {
        guard(inFrame, "draw outside a frame")
        val program = current
        if (program == null || !currentBound || program.epoch != epoch || !passLive) { stats.skippedDraws++; return false }
        if (phase == BEFORE_PASSES && !rehearsing) { violation("draw before any pass is bound"); return false }
        if (pairs.add(pairKey(program, stateKey()))) {
            frameFirstDraws++
            if (rehearsing) stats.rehearsedFirstDraws++ else stats.liveFirstDraws++
        }
        if (rehearsing) stats.rehearsalDraws++
        frameDraws++; frameInstances += instances
        return true
    }

    // ---------------------------------------------------------------- rehearsal (plan §5.3 step 3)

    /**
     * Draw a never-drawn (program, state) pair into [scratch], a same-format stand-in for the pass's real target, so the
     * driver builds the pipeline variant now instead of at the pass's first live draw. Only before the frame's passes;
     * the 1×1 scissor cannot be moved or disabled by [block]; the pair key uses the format of the target [scratch]
     * stands for (the screen when [forScreen]); every tracked state is restored afterwards. Returns true when [block]
     * first-drew at least one pair. The caller (WorldHost) runs at most one pair per idle frame, never in a flight or
     * fade, and pauses on input.
     */
    inline fun rehearse(scratch: Gl3Texture, depth: Gl3Texture?, forScreen: Boolean, testDepth: Boolean, block: () -> Unit): Boolean {
        val before = rehearsalBegin(scratch, depth, forScreen, testDepth)
        if (before < 0) return false
        try { block() } finally { rehearsalEnd() }
        return stats.rehearsedFirstDraws > before
    }

    private var savedBlend = false; private var savedSrcRgb = 0; private var savedDstRgb = 0; private var savedSrcAlpha = 0; private var savedDstAlpha = 0
    private var savedDepthTest = false; private var savedDepthWrite = true; private var savedDepthFn = 0; private var savedColor = 15
    private var savedCull = false; private var savedScissor = false; private var savedProgram: Gl3Program? = null; private var savedVao: Gl3VertexArray? = null
    private var savedFramebuffer = 0; private var savedFormat = 0; private var savedKeyDepth = true

    @PublishedApi internal fun rehearsalBegin(scratch: Gl3Texture, depth: Gl3Texture?, forScreen: Boolean, testDepth: Boolean): Long {
        guard(inFrame, "rehearsal outside a frame")
        if (phase != BEFORE_PASSES || rehearsing) { violation("a rehearsal runs only before the frame's passes"); return -1 }
        if (stale(scratch) || !scratch.ready || (depth != null && (stale(depth) || !depth.ready))) return -1
        savedBlend = blend; savedSrcRgb = srcRgb; savedDstRgb = dstRgb; savedSrcAlpha = srcAlpha; savedDstAlpha = dstAlpha
        savedDepthTest = depthTest; savedDepthWrite = depthWrite; savedDepthFn = depthFn; savedColor = colorBits
        savedCull = cull; savedScissor = scissorTest; savedProgram = current; savedVao = vao
        savedFramebuffer = framebuffer; savedFormat = keyFormat; savedKeyDepth = keyDepth
        bindTarget(scratch, 0, 0, depth)
        keyFormat = if (forScreen) 0 else scratch.format.id
        keyDepth = depth != null
        gl.viewport(0, 0, scratch.width, scratch.height)
        if (testDepth) { setCap(GL20.GL_DEPTH_TEST, true); depthFunc(GL20.GL_LEQUAL); depthMask(true) } else setCap(GL20.GL_DEPTH_TEST, false)
        setCap(GL20.GL_BLEND, false)
        setCap(GL20.GL_SCISSOR_TEST, true); gl.scissor(0, 0, 1, 1)
        rehearsing = true
        passLive = true
        return stats.rehearsedFirstDraws
    }

    @PublishedApi internal fun rehearsalEnd() {
        rehearsing = false
        setCap(GL20.GL_BLEND, savedBlend); blendFuncSeparate(savedSrcRgb, savedDstRgb, savedSrcAlpha, savedDstAlpha)
        setCap(GL20.GL_DEPTH_TEST, savedDepthTest); depthFunc(savedDepthFn); depthMask(savedDepthWrite)
        colorMask(savedColor and 1 != 0, savedColor and 2 != 0, savedColor and 4 != 0, savedColor and 8 != 0)
        setCap(GL20.GL_CULL_FACE, savedCull); setCap(GL20.GL_SCISSOR_TEST, savedScissor)
        bindVertexArray(savedVao); use(savedProgram)
        gl.bindFramebuffer(GL20.GL_FRAMEBUFFER, savedFramebuffer); framebuffer = savedFramebuffer
        keyFormat = savedFormat; keyDepth = savedKeyDepth
        gl.viewport(0, 0, bufferW, bufferH)
        savedProgram = null; savedVao = null
    }

    // ---------------------------------------------------------------- textures

    /** Allocator caps in bytes (plan §5.8, per band): set by the host on every band or sleep change. A lowered cap
     *  evicts evictable textures (least recently used first) until the pool fits. */
    fun setCaps(globe: Long, realm: Long, combined: Long) {
        poolCaps[Gl3Pool.GLOBE.ordinal] = globe; poolCaps[Gl3Pool.REALM.ordinal] = realm; combinedCap = combined
        evictUntil(Gl3Pool.GLOBE, 0L); evictUntil(Gl3Pool.REALM, 0L)
    }

    fun texture2D(pool: Gl3Pool, width: Int, height: Int, format: Gl3Format, levels: Int = 1,
                  sampling: Gl3Sampling = Gl3Sampling.NEAREST, wrap: Gl3Wrap = Gl3Wrap.CLAMP): Gl3Texture? =
        create(pool, GL20.GL_TEXTURE_2D, width, height, 1, levels, format, sampling, wrap)

    fun array(pool: Gl3Pool, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int = 1,
              sampling: Gl3Sampling = Gl3Sampling.NEAREST, wrap: Gl3Wrap = Gl3Wrap.CLAMP): Gl3Texture? =
        create(pool, GL30.GL_TEXTURE_2D_ARRAY, width, height, layers, levels, format, sampling, wrap)

    /**
     * Reserve allocator room for a texture the worker context will create and fill (plan §5.7: textures not yet
     * sampled are filled on the worker, never ghosted). It stays PENDING until [adopt] hands over the worker's name
     * and fence, and becomes READY once that fence has signalled. Null when the pool cannot make room.
     */
    fun reserve(pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int = 1): Gl3Texture? {
        val bytes = format.layerBytes(width, height, levels) * layers
        if (!makeRoom(pool, bytes)) return null
        val texture = Gl3Texture(++texUid, pool, if (array) GL30.GL_TEXTURE_2D_ARRAY else GL20.GL_TEXTURE_2D, width, height, layers, levels, format, bytes)
        texture.epoch = epoch
        track(texture)
        return texture
    }

    fun adopt(texture: Gl3Texture, name: Int, fence: Long) {
        if (stale(texture) || texture.state != Gl3Texture.PENDING) { if (fence != 0L) gl.deleteSync(fence); return }
        texture.name = name; texture.fence = fence
        pendingTextures += texture
    }

    /** Bind [texture] for sampling on [unit]. It is LIVE from here on. A stale or unready texture binds nothing. */
    fun bindTexture(unit: Int, texture: Gl3Texture) {
        gl.activeTexture(GL20.GL_TEXTURE0 + unit)
        if (stale(texture) || texture.state != Gl3Texture.READY) { gl.bindTexture(texture.target, 0); return }
        texture.sampled = true
        texture.usedFrame = frameIndex
        touch(texture)
        gl.bindTexture(texture.target, texture.name)
    }

    /**
     * Fill part of a texture from the GL thread. Refused for a LIVE array (it gets layers through [copyStaged]), and,
     * after the first world frame, for more than `coldUploadBytes` at once (plan §5.3/§5.9: no full-layer upload on
     * the GL thread after the first world frame). Small live 2D updates (a page-table entry, the base-state texture)
     * are allowed and counted.
     */
    fun upload(texture: Gl3Texture, layer: Int, level: Int, x: Int, y: Int, width: Int, height: Int, pixels: Buffer) {
        if (stale(texture) || texture.state != Gl3Texture.READY) return
        val bytes = width.toLong() * height * texture.format.bytesPerTexel
        if (texture.isArray && texture.sampled) return violation("live array ${texture.uid} would receive texSubImage: use the staging copy")
        if (firstWorldFrameDrawn && bytes > coldUploadBytes) return violation("a $bytes-byte GL-thread upload after the first world frame")
        gl.activeTexture(GL20.GL_TEXTURE0 + scratchUnit)
        gl.bindTexture(texture.target, texture.name)
        gl.pixelStorei(GL20.GL_UNPACK_ALIGNMENT, 1)
        if (texture.target == GL30.GL_TEXTURE_2D_ARRAY) gl.texSubImage3D(texture.target, level, x, y, layer, width, height, 1, texture.format.uploadFormat, texture.format.uploadType, pixels)
        else gl.texSubImage2D(texture.target, level, x, y, width, height, texture.format.uploadFormat, texture.format.uploadType, pixels)
        gl.pixelStorei(GL20.GL_UNPACK_ALIGNMENT, 4)
        stats.uploadBytes += bytes; frameUploadBytes += bytes
    }

    /**
     * Copy one whole staging layer, filled by the worker, into layer [layer] of [target] (plan §5.7): a GPU-side
     * `glWaitSync` on the worker's fence (the CPU never blocks), then `glCopyImageSubData`. The frame counts it toward
     * coldness like an upload.
     */
    fun copyStaged(stagingName: Int, stagingTarget: Int, target: Gl3Texture, layer: Int, level: Int, fence: Long) {
        if (stale(target) || target.state != Gl3Texture.READY) { if (fence != 0L) gl.deleteSync(fence); return }
        val width = maxOf(1, target.width shr level); val height = maxOf(1, target.height shr level)
        if (fence != 0L) gl.waitSync(fence)
        gl.copyImageSubData(stagingName, stagingTarget, 0, 0, 0, 0, target.name, target.target, level, 0, 0, layer, width, height, 1)
        if (fence != 0L) gl.deleteSync(fence)
        val bytes = width.toLong() * height * target.format.bytesPerTexel
        stats.copyBytes += bytes; frameUploadBytes += bytes
    }

    fun free(texture: Gl3Texture?) {
        if (texture == null || texture.state == Gl3Texture.FREED) return
        if (texture.epoch == epoch) {
            texture.fbos?.let { for (fb in it) if (fb != 0) gl.deleteFramebuffer(fb) }
            if (texture.name != 0) gl.deleteTexture(texture.name)
            if (texture.fence != 0L) gl.deleteSync(texture.fence)
            pendingTextures.remove(texture)
        }
        if (lowT === texture) lowT = null
        untrack(texture)
        texture.state = Gl3Texture.FREED; texture.name = 0; texture.fence = 0L; texture.fbos = null
    }

    /** A 1×1 placeholder of the right sampler kind (an unbound usampler over a float texture is an error). */
    fun dummy(integer: Boolean, array: Boolean): Gl3Texture {
        val i = (if (integer) 1 else 0) + (if (array) 2 else 0)
        dummies[i]?.let { if (it.epoch == epoch && it.state == Gl3Texture.READY) return it }
        val format = if (integer) Gl3Format.R8UI else Gl3Format.RGBA8
        val made = if (array) array(Gl3Pool.CORE, 1, 1, 1, format) else texture2D(Gl3Pool.CORE, 1, 1, format)
        dummies[i] = made
        return made!!
    }

    /** The ground's k× target (core.js lowTarget): RGBA8, linear, reallocated when the buffer or k changes. */
    fun lowres(k: Double): Gl3Texture? {
        val width = maxOf(1, Math.ceil(bufferW * k).toInt()); val height = maxOf(1, Math.ceil(bufferH * k).toInt())
        val existing = lowT
        if (existing != null && existing.epoch == epoch && existing.state == Gl3Texture.READY && existing.width == width && existing.height == height) return existing
        free(existing)
        lowT = texture2D(Gl3Pool.CORE, width, height, Gl3Format.RGBA8, sampling = Gl3Sampling.LINEAR)
        return lowT
    }

    // ---------------------------------------------------------------- uniform blocks

    fun uniformBlock(binding: Int, sizeBytes: Int): Gl3UniformBlock {
        require(sizeBytes > 0 && sizeBytes % 16 == 0) { "std140 blocks are a multiple of 16 bytes" }
        val block = Gl3UniformBlock(binding, sizeBytes)
        createBlock(block)
        blocks += block
        return block
    }

    fun upload(block: Gl3UniformBlock) {
        if (block.epoch != epoch) { stats.staleUses++; return }
        gl.bindBuffer(GL30.GL_UNIFORM_BUFFER, block.buffer)
        gl.bufferSubData(GL30.GL_UNIFORM_BUFFER, 0, block.sizeBytes, block.bytes)
        gl.bindBufferBase(GL30.GL_UNIFORM_BUFFER, block.binding, block.buffer)
    }

    // ---------------------------------------------------------------- lifecycle

    /** Called after a context change, once the core's own objects exist again: lanes re-create theirs from the
     *  verified on-disk content (never refetched), off the GL thread where they upload (plan §5.7). */
    fun onRestore(restorable: Gl3Restorable) { restorables += restorable }

    /**
     * Free everything with `glDelete*` only: no fence wait, no status query, no join (plan §5.9: `pause()`/`dispose()`
     * run inside libGDX's UI-thread handshake). Built-but-unadopted programs are deleted; queued jobs are dropped by
     * the compiler's O(1) [ProgramCompiler.dispose].
     */
    fun dispose() {
        for (program in pending) program.job.onSettled = null // a build ending after this wakes nobody
        if (!lost) {
            for (program in programs.values) if (program.handle != 0 && program.epoch == epoch) gl.deleteProgram(program.handle)
            for (program in pending) { // (a program waiting in the restore queue has no job of this epoch)
                val job = program.job
                if (job.state == ProgramJob.BUILT && job.epoch == epoch) {
                    if (job.fence != 0L) gl.deleteSync(job.fence)
                    if (job.program != 0) gl.deleteProgram(job.program)
                }
            }
            var t = lruHead
            while (t != null) { val next = t.next; free(t); t = next }
            for (array in vertexArrays) if (array.epoch == epoch) gl.deleteVertexArray(array.name)
            gl.deleteVertexArray(triVao.name); gl.deleteVertexArray(quadVao.name)
            gl.deleteBuffer(triBuffer); gl.deleteBuffer(quadBuffer)
            for (block in blocks) if (block.epoch == epoch) gl.deleteBuffer(block.buffer)
            for (i in 0 until FENCES) if (fenceSync[i] != 0L) { gl.deleteSync(fenceSync[i]); fenceSync[i] = 0L }
        }
        programs.clear(); pending.clear(); restoreQueue.clear(); pendingTextures.clear(); vertexArrays.clear(); blocks.clear(); restorables.clear()
        compiler.dispose()
    }

    // ---------------------------------------------------------------- internals

    private fun submit(program: Gl3Program) {
        val job = ProgramJob(program.name, program.vs, program.fs, program.vsSha256, program.fsSha256)
        job.epoch = epoch
        job.onSettled = wake
        program.job = job; program.state = Gl3Program.PENDING; program.handle = 0; program.epoch = -1; program.resetLocations()
        pending += program
        compiler.submit(job)
    }

    private fun queueRestore(program: Gl3Program) {
        program.state = Gl3Program.PENDING; program.handle = 0; program.epoch = -1; program.resetLocations()
        restoreQueue.addLast(program)
    }

    private fun pollPrograms() {
        var i = 0
        while (i < pending.size) {
            val program = pending[i]
            val job = program.job
            when (job.state) {
                ProgramJob.FAILED -> {
                    program.state = Gl3Program.FAILED; program.error = job.error; stats.failedPrograms++
                    removeSwap(pending, i)
                }
                ProgramJob.BUILT -> {
                    val status = if (job.fence == 0L) GL30.GL_ALREADY_SIGNALED else gl.clientWaitSync(job.fence, 0, 0)
                    if (status == GL30.GL_TIMEOUT_EXPIRED) { i++; continue }
                    if (job.fence != 0L) gl.deleteSync(job.fence)
                    program.handle = job.program; program.epoch = epoch; program.state = Gl3Program.READY
                    program.fromCache = job.fromCache; program.buildNanos = job.buildNanos
                    if (sentinel == 0) sentinel = job.program
                    stats.adoptions++; if (job.fromCache) stats.adoptedFromCache++
                    frameAdoptions++
                    removeSwap(pending, i)
                }
                else -> i++
            }
        }
    }

    private fun pollTextures() {
        var i = 0
        while (i < pendingTextures.size) {
            val texture = pendingTextures[i]
            val status = if (texture.fence == 0L) GL30.GL_ALREADY_SIGNALED else gl.clientWaitSync(texture.fence, 0, 0)
            if (status == GL30.GL_TIMEOUT_EXPIRED) { i++; continue }
            if (texture.fence != 0L) gl.deleteSync(texture.fence)
            texture.fence = 0L; texture.state = Gl3Texture.READY
            removeSwap(pendingTextures, i)
        }
    }

    private fun pollFences(nowNanos: Long) {
        report.gpuBound = false; report.gpuSampleCount = 0
        for (age in FENCES downTo 1) {
            val frame = frameIndex - age
            if (frame < 1) continue
            val slot = (frame % FENCES).toInt()
            val sync = fenceSync[slot]
            if (sync == 0L) continue
            if (gl.clientWaitSync(sync, 0, 0) == GL30.GL_TIMEOUT_EXPIRED) {
                fenceSeenNs[slot] = nowNanos
                if (age >= 2) report.gpuBound = true
                continue
            }
            val seen = fenceSeenNs[slot]
            val n = report.gpuSampleCount
            if (n < report.gpuSamplesMs.size) {
                report.gpuSamplesMs[n] = if (seen > 0L) (seen - fenceSubmitNs[slot]) / 1e6 else 0.0
                report.gpuSamplesCold[n] = fenceCold[slot]
                report.gpuSampleCount = n + 1
            }
            gl.deleteSync(sync); fenceSync[slot] = 0L
        }
    }

    private fun create(pool: Gl3Pool, target: Int, width: Int, height: Int, layers: Int, levels: Int, format: Gl3Format,
                       sampling: Gl3Sampling, wrap: Gl3Wrap): Gl3Texture? {
        require(width > 0 && height > 0 && layers > 0 && levels > 0) { "Empty texture" }
        val bytes = format.layerBytes(width, height, levels) * layers
        if (!makeRoom(pool, bytes)) return null
        val texture = Gl3Texture(++texUid, pool, target, width, height, layers, levels, format, bytes)
        texture.epoch = epoch
        texture.name = gl.genTexture()
        gl.activeTexture(GL20.GL_TEXTURE0 + scratchUnit)
        gl.bindTexture(target, texture.name)
        if (target == GL30.GL_TEXTURE_2D_ARRAY) gl.texStorage3D(target, levels, format.internal, width, height, layers)
        else gl.texStorage2D(target, levels, format.internal, width, height)
        val nearest = format.integer || sampling == Gl3Sampling.NEAREST || sampling == Gl3Sampling.NEAREST_MIPMAP_NEAREST
        val min = when {
            format.integer || levels == 1 -> if (nearest) GL20.GL_NEAREST else GL20.GL_LINEAR
            sampling == Gl3Sampling.NEAREST_MIPMAP_NEAREST -> GL20.GL_NEAREST_MIPMAP_NEAREST
            sampling == Gl3Sampling.LINEAR_MIPMAP_LINEAR -> GL20.GL_LINEAR_MIPMAP_LINEAR
            else -> if (nearest) GL20.GL_NEAREST else GL20.GL_LINEAR
        }
        gl.texParameteri(target, GL20.GL_TEXTURE_MIN_FILTER, min)
        gl.texParameteri(target, GL20.GL_TEXTURE_MAG_FILTER, if (nearest) GL20.GL_NEAREST else GL20.GL_LINEAR)
        val w = when (wrap) { Gl3Wrap.CLAMP -> GL20.GL_CLAMP_TO_EDGE; Gl3Wrap.REPEAT -> GL20.GL_REPEAT; Gl3Wrap.MIRROR -> GL20.GL_MIRRORED_REPEAT }
        gl.texParameteri(target, GL20.GL_TEXTURE_WRAP_S, w); gl.texParameteri(target, GL20.GL_TEXTURE_WRAP_T, w)
        texture.state = Gl3Texture.READY
        track(texture)
        return texture
    }

    private fun fits(pool: Gl3Pool, bytes: Long): Boolean {
        if (pool == Gl3Pool.CORE) return true
        val capped = stats.poolBytes[Gl3Pool.GLOBE.ordinal] + stats.poolBytes[Gl3Pool.REALM.ordinal]
        return stats.poolBytes[pool.ordinal] + bytes <= poolCaps[pool.ordinal] && capped + bytes <= combinedCap
    }

    private fun makeRoom(pool: Gl3Pool, bytes: Long): Boolean {
        if (fits(pool, bytes)) return true
        evictUntil(pool, bytes)
        if (fits(pool, bytes)) return true
        stats.refusals++
        return false
    }

    /** Evict evictable textures, least recently used first and never one used this frame, until [bytes] more fit in
     *  [pool]. A pool over its own cap evicts only from itself; the combined cap may evict from either capped pool. */
    private fun evictUntil(pool: Gl3Pool, bytes: Long) {
        var t = lruHead
        while (t != null && !fits(pool, bytes)) {
            val next = t.next
            val ownOver = stats.poolBytes[pool.ordinal] + bytes > poolCaps[pool.ordinal]
            val candidate = t.evictable && t.usedFrame != frameIndex && t.pool != Gl3Pool.CORE && (t.pool == pool || !ownOver)
            if (candidate) { t.onEvict?.invoke(t); free(t); stats.evictions++ }
            t = next
        }
    }

    private fun track(texture: Gl3Texture) {
        texture.tracked = true
        stats.poolBytes[texture.pool.ordinal] += texture.bytes
        append(texture)
    }

    private fun untrack(texture: Gl3Texture) {
        if (!texture.tracked) return
        texture.tracked = false
        stats.poolBytes[texture.pool.ordinal] -= texture.bytes
        unlink(texture)
    }

    private fun touch(texture: Gl3Texture) { if (texture.tracked && lruTail !== texture) { unlink(texture); append(texture) } }
    private fun append(texture: Gl3Texture) {
        texture.prev = lruTail; texture.next = null
        if (lruTail == null) lruHead = texture else lruTail!!.next = texture
        lruTail = texture
    }
    private fun unlink(texture: Gl3Texture) {
        val p = texture.prev; val n = texture.next
        if (p == null) lruHead = n else p.next = n
        if (n == null) lruTail = p else n.prev = p
        texture.prev = null; texture.next = null
    }

    private fun bindTarget(color: Gl3Texture, layer: Int, level: Int, depth: Gl3Texture?) {
        val slots = color.fbos ?: IntArray(color.layers * color.levels).also { color.fbos = it }
        val index = level * color.layers + layer
        var fb = slots[index]
        if (fb == 0) {
            fb = gl.genFramebuffer(); slots[index] = fb
            gl.bindFramebuffer(GL20.GL_FRAMEBUFFER, fb)
            if (color.target == GL30.GL_TEXTURE_2D_ARRAY) gl.framebufferTextureLayer(GL20.GL_FRAMEBUFFER, GL20.GL_COLOR_ATTACHMENT0, color.name, level, layer)
            else gl.framebufferTexture2D(GL20.GL_FRAMEBUFFER, GL20.GL_COLOR_ATTACHMENT0, GL20.GL_TEXTURE_2D, color.name, level)
            if (depth != null) gl.framebufferTexture2D(GL20.GL_FRAMEBUFFER, GL20.GL_DEPTH_ATTACHMENT, GL20.GL_TEXTURE_2D, depth.name, 0)
        } else gl.bindFramebuffer(GL20.GL_FRAMEBUFFER, fb)
        framebuffer = fb
    }

    private fun startTarget(load: Gl3Load, withDepth: Boolean) {
        when (load) {
            Gl3Load.CLEAR -> {
                setCap(GL20.GL_SCISSOR_TEST, false); colorMask(true, true, true, true)
                if (withDepth) depthMask(true)
                gl.clear(GL20.GL_COLOR_BUFFER_BIT or (if (withDepth) GL20.GL_DEPTH_BUFFER_BIT else 0))
            }
            Gl3Load.DONT_CARE -> gl.invalidateFramebuffer(GL20.GL_FRAMEBUFFER, if (withDepth) 2 else 1, COLOR_DEPTH_ATTACHMENTS)
            Gl3Load.KEEP -> stats.reloads++
        }
    }

    private fun setCap(cap: Int, on: Boolean) {
        if (rehearsing && cap == GL20.GL_SCISSOR_TEST) return
        when (cap) {
            GL20.GL_BLEND -> blend = on
            GL20.GL_DEPTH_TEST -> depthTest = on
            GL20.GL_CULL_FACE -> cull = on
            GL20.GL_SCISSOR_TEST -> scissorTest = on
        }
        if (on) gl.enable(cap) else gl.disable(cap)
    }

    private fun stale(texture: Gl3Texture): Boolean {
        if (texture.epoch == epoch && texture.state != Gl3Texture.FREED) return false
        stats.staleUses++
        return true
    }

    private fun markLost() {
        lost = true
        epoch++
        stats.contextLosses++
        report.contextChanged = true
        // every GL name belongs to the dead context: forget them without deleting
        var t = lruHead
        while (t != null) { val next = t.next; t.state = Gl3Texture.FREED; t.name = 0; t.fence = 0L; t.fbos = null; untrack(t); t = next }
        pendingTextures.clear(); lowT = null; dummies.fill(null)
        pairs.clear()
        fenceSync.fill(0L)
        sentinel = 0
        current = null; currentBound = false; vao = null; layout = 0; framebuffer = 0
        vertexArrays.clear()
        firstWorldFrameDrawn = false
        lastOwnCold = false
    }

    private fun restore(contextId: Long) {
        this.contextId = contextId
        lost = false
        awaitingNewContext = false
        compiler.contextChanged(epoch)
        initContextObjects()
        for (block in blocks) createBlock(block)
        for (program in pending) program.job.onSettled = null // a dead-epoch build must not wake the host
        pending.clear(); restoreQueue.clear()
        for (program in programs.values) if (program.state != Gl3Program.FAILED) {
            if (compiler.blocksCaller) queueRestore(program) else submit(program)
        }
        report.contextChanged = true
        for (restorable in restorables) restorable.restore(this)
    }

    private fun initContextObjects() {
        blend = false; depthTest = false; depthWrite = true; depthFn = GL20.GL_LESS; colorBits = 15; cull = false; scissorTest = false
        srcRgb = GL20.GL_ONE; dstRgb = GL20.GL_ZERO; srcAlpha = GL20.GL_ONE; dstAlpha = GL20.GL_ZERO
        scratchUnit = maxOf(1, minOf(gl.getInteger(GL20.GL_MAX_TEXTURE_IMAGE_UNITS), gl.getInteger(GL20.GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS)) - 1)
        triBuffer = gl.genBuffer(); quadBuffer = gl.genBuffer()
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, triBuffer)
        gl.bufferData(GL20.GL_ARRAY_BUFFER, TRI.capacity() * 4, TRI, GL20.GL_STATIC_DRAW)
        createVertexArray(triVao)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quadBuffer)
        gl.bufferData(GL20.GL_ARRAY_BUFFER, QUAD.capacity() * 4, QUAD, GL20.GL_STATIC_DRAW)
        createVertexArray(quadVao)
        gl.bindVertexArray(0); vao = null; layout = 0
    }

    /** Creates [array] and leaves it bound; the core's own two also get attribute 0 from the bound array buffer. */
    private fun createVertexArray(array: Gl3VertexArray) {
        array.name = gl.genVertexArray(); array.epoch = epoch
        gl.bindVertexArray(array.name)
        if (array.layout < 16) { gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, GL20.GL_FLOAT, false, 0, 0) }
        vao = array; layout = array.layout
    }

    private fun createBlock(block: Gl3UniformBlock) {
        block.buffer = gl.genBuffer(); block.epoch = epoch
        gl.bindBuffer(GL30.GL_UNIFORM_BUFFER, block.buffer)
        gl.bufferData(GL30.GL_UNIFORM_BUFFER, block.sizeBytes, null, GL20.GL_DYNAMIC_DRAW)
        gl.bindBufferBase(GL30.GL_UNIFORM_BUFFER, block.binding, block.buffer)
    }

    private fun pairKey(program: Gl3Program, stateKey: Long): Long = (program.uid.toLong() shl 48) or stateKey

    private fun guard(ok: Boolean, message: String) { check(ok) { message } }

    private fun violation(message: String) {
        stats.orderViolations++
        if (strict) throw IllegalStateException(message)
    }

    private fun <T> removeSwap(list: ArrayList<T>, i: Int) {
        val last = list.size - 1
        if (i != last) list[i] = list[last]
        list.removeAt(last)
    }

    companion object {
        const val LAYOUT_FULLSCREEN = 1
        const val LAYOUT_QUAD = 2
        private val NO_WAKE = Runnable {}
        private const val FENCES = 3
        private const val IDLE = 0
        private const val BEFORE_PASSES = 1
        private const val OFFSCREEN = 2
        private const val SCREEN = 3
        private val SCREEN_DEPTH = intArrayOf(GL30.GL_DEPTH)
        private val COLOR_DEPTH_ATTACHMENTS = intArrayOf(GL20.GL_COLOR_ATTACHMENT0, GL20.GL_DEPTH_ATTACHMENT)
        private val TRI = floats(-1f, -1f, 3f, -1f, -1f, 3f)
        private val QUAD = floats(0f, 0f, 1f, 0f, 1f, 1f, 0f, 0f, 1f, 1f, 0f, 1f)

        private fun floats(vararg values: Float) =
            ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().put(values).also { it.position(0) }

        /** Blend factor → 4-bit index (15 GLES factors). */
        private fun factor(f: Int): Int = when (f) {
            GL20.GL_ZERO -> 0; GL20.GL_ONE -> 1
            in GL20.GL_SRC_COLOR..GL20.GL_SRC_ALPHA_SATURATE -> 2 + (f - GL20.GL_SRC_COLOR)
            in GL20.GL_CONSTANT_COLOR..GL20.GL_ONE_MINUS_CONSTANT_ALPHA -> 11 + (f - GL20.GL_CONSTANT_COLOR)
            else -> 15
        }
    }
}

/** Re-creates a lane's GL objects after a context change (plan §5.7), from verified on-disk content. */
fun interface Gl3Restorable { fun restore(core: Gl3Core) }
