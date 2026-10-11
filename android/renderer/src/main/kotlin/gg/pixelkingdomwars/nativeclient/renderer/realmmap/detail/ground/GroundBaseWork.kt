package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

/**
 * The line texture's page bookkeeping (ground.js linesJob's `L`): which page each deed's river / land field lives on,
 * the free pages (a stack: the lowest page is handed out first, as the web pushes cap − 1 … next), and the geometry
 * (pages of 99² words, [pr] per row, the header block from row [r0]).
 */
class LinePages(val w: Int, val h: Int, val pr: Int, val r0: Int, val cap: Int, val riverPage: IntArray, val landPage: IntArray, val free: IntArrayDeque) {
    fun copy() = LinePages(w, h, pr, r0, cap, riverPage.copyOf(), landPage.copyOf(), free.copy())
    fun pageX(pg: Int) = (pg % pr) * ClassBake.PAGE
    fun pageY(pg: Int) = (pg / pr) * ClassBake.PAGE
}

/** The load's line texture as page bookkeeping (its words went up once, in the fresh texture). */
fun LineTexture.pages(): LinePages = LinePages(w, h, pr, r0, cap, riverPage.copyOf(), landPage.copyOf(), free.copy())

/**
 * GROUND's base-state work (ground.js `updateBends`, `queueBridges`, `bridgeJob`, `rebakeJob`, P0 fix pass #8), run on the
 * decode executor instead of main-thread slices: the rivers bent round the new plots (G16), the river pages they moved
 * re-baked, the land bridges of the changed plots' 3×3 and of the moved rivers' deeds recomputed (G15), and the header
 * words of every touched deed. The GL thread lands [Result.uploads] within its per-frame upload budget, then switches
 * to the new rivers and bridges and re-resolves [Result.invalidate]. Pure; its own [Classify] (not shared across threads).
 */
object GroundBaseWork {
    class Input(val assets: GroundAssets, val base: ByteArray, val changedPlots: IntArray, val lines: LinePages, val rivers: SegSet?, val bridges: FloatArray)

    /** A sub-image of the line texture to upload: [words] row-major, [w] × [h] at ([x], [y]). */
    class Upload(val x: Int, val y: Int, val w: Int, val h: Int, val words: IntArray)

    class Result(val rivers: SegSet, val bridges: FloatArray, val bridgeCount: Int, val lines: LinePages, val uploads: List<Upload>, val invalidate: IntArray,
                 val moved: Int, val full: Boolean)

    fun run(input: Input): Result {
        val a = input.assets; val cols = a.cols; val rows = a.rows
        val cls = Classify(a.cls.plots)
        val state = BaseState(cols, rows, input.base)
        val before = input.rivers ?: a.lines.rivers
        val next = cls.bendRivers(a.lines, state, a.cfg)
        // ground.js updateBends: the deeds whose segment lists changed
        val moved = IntList()
        for (k in 0 until cols * rows) {
            val x = before.cells[k]; val y = next.cells[k]
            if (x == null && y == null) continue
            var same = x != null && y != null && x.size == y.size
            var i = 0
            while (same && i < x!!.size) { for (o in 0 until 6) if (before.segs[x[i] * 6 + o] != next.segs[y!![i] * 6 + o]) { same = false; break }; i++ }
            if (!same) moved.add(k)
        }
        // G15: the bridges of the changed plots' 3×3 and of the moved rivers' deeds' 3×3 (ground.js baseChanged → queueBridges)
        val near = LinkedHashSet<Int>()
        fun around(k: Int) { val x = k % cols; val y = k / cols; for (j in -1..1) for (i in -1..1) { val xx = x + i; val yy = y + j; if (xx >= 0 && yy >= 0 && xx < cols && yy < rows) near += yy * cols + xx } }
        for (k in input.changedPlots) around(k)
        for (i in 0 until moved.size) around(moved[i])
        state.rivers = next
        val bridges = input.bridges.copyOf()
        val list = near.toIntArray()
        val was = FloatArray(list.size * 4); for ((i, k) in list.withIndex()) for (c in 0 until 4) was[i * 4 + c] = bridges[k * 4 + c]
        cls.plotBridges(a.fields, a.lines, state, a.cfg, bridges, list)
        val bridgeChanged = IntList()
        for ((i, k) in list.withIndex()) for (c in 0 until 4) if (was[i * 4 + c] != bridges[k * 4 + c]) { bridgeChanged.add(k); break }
        var bridgeCount = 0; for (k in 0 until cols * rows) if (bridges[k * 4 + 2] > 0f) bridgeCount++
        val inv = LinkedHashSet<Int>(); for (i in 0 until moved.size) inv += moved[i]; for (i in 0 until bridgeChanged.size) inv += bridgeChanged[i]
        // the river pages a moved deed reaches: its own and the deeds k − (0…1) in x and y (a page's row/column 98 is the
        // next deed's first vertices); each replaced in ONE upload, its header word following it
        val touch = LinkedHashSet<Int>()
        for (i in 0 until moved.size) { val k = moved[i]; val x = k % cols; val y = k / cols
            for (j in -1..0) for (ii in -1..0) { val xx = x + ii; val yy = y + j; if (xx >= 0 && yy >= 0 && xx < cols && yy < rows) touch += yy * cols + xx } }
        val lp = input.lines.copy()
        val uploads = ArrayList<Upload>()
        val page = IntArray(ClassBake.PAGE_N)
        for (k in touch) {
            val need = next.cells.containsKey(k)
            if (need && lp.riverPage[k] < 0) { val pg = lp.free.pop(); if (pg < 0) return fullRebuild(a, cls, state, next, bridges, bridgeCount, inv, input.lines, moved.size); lp.riverPage[k] = pg }
            if (!need && lp.riverPage[k] >= 0) { lp.free.push(lp.riverPage[k]); lp.riverPage[k] = -1 }
            if (need) { ClassBake.riverPageWords(next, k % cols, k / cols, cls.tiles, a.cfg, page); uploads += Upload(lp.pageX(lp.riverPage[k]), lp.pageY(lp.riverPage[k]), ClassBake.PAGE, ClassBake.PAGE, page.copyOf()) }
        }
        // the header words of every touched deed and every changed bridge, as whole rows of the header block (≤ 16 KB each)
        val rowsOf = sortedSetOf<Int>()
        for (k in touch) { rowsOf += (k * 3) / lp.w; rowsOf += (k * 3 + 2) / lp.w }
        for (i in 0 until bridgeChanged.size) { val k = bridgeChanged[i]; rowsOf += (k * 3) / lp.w; rowsOf += (k * 3 + 2) / lp.w }
        for (r in rowsOf) uploads += Upload(0, lp.r0 + r, lp.w, 1, headerRow(lp, r, cols, rows, next, bridges))
        return Result(next, bridges, bridgeCount, lp, uploads, inv.toIntArray(), moved.size, false)
    }

    /** The texture is full (ground.js: rebuilt in slices while the old one draws): a whole new bake of the same width,
     *  uploaded row by row when it still fits the texture's height; else no upload (the old fields stay, reported). */
    private fun fullRebuild(a: GroundAssets, cls: Classify, state: BaseState, next: SegSet, bridges: FloatArray, bridgeCount: Int, inv: Set<Int>,
                            old: LinePages, moved: Int): Result {
        state.rivers = next; state.bridges = bridges
        val t = GroundLoad.bakeLines(cls, a.lines, state, a.cfg, a.cols, a.rows, old.w)
        if (t.h > old.h) return Result(state.rivers!!, bridges, bridgeCount, old, emptyList(), IntArray(0), moved, true)
        val uploads = ArrayList<Upload>()
        for (r in 0 until t.h) uploads += Upload(0, r, t.w, 1, t.words.copyOfRange(r * t.w, (r + 1) * t.w))
        return Result(next, bridges, bridgeCount, t.pages().let { LinePages(old.w, old.h, it.pr, it.r0, it.cap, it.riverPage, it.landPage, it.free) }, uploads, inv.toIntArray(), moved, true)
    }

    /** One row of the header block: 3 words per deed (river page + 1 | downstream hint, land page + 1, packed bridge). */
    fun headerRow(lp: LinePages, r: Int, cols: Int, rows: Int, rivers: SegSet, bridges: FloatArray): IntArray {
        val out = IntArray(lp.w); val hint = DoubleArray(2)
        for (i in out.indices) {
            val word = r * lp.w + i; val k = word / 3
            if (k >= cols * rows) continue
            out[i] = when (word % 3) {
                0 -> { ClassBake.riverHint(rivers, k, hint)
                    val hx = (GroundMath.jsRound(hint[0] * 127).toInt() + 128) and 255; val hy = (GroundMath.jsRound(hint[1] * 127).toInt() + 128) and 255
                    if (lp.riverPage[k] >= 0) (lp.riverPage[k] + 1) or (hx shl 16) or (hy shl 24) else 0 }
                1 -> if (lp.landPage[k] >= 0) lp.landPage[k] + 1 else 0
                else -> { val o = k * 4; ClassBake.packBridge(bridges[o].toDouble(), bridges[o + 1].toDouble(), bridges[o + 2].toDouble(), bridges[o + 3].toDouble()) }
            }
        }
        return out
    }
}
