package gg.pixelkingdomwars.nativeclient.scene.probe

/** What a bench program stresses: an 8-bit texel fetch, a 64-bit integer texel fetch (the world's RGBA16UI records
 *  and LIFE table), or ALU only. */
enum class BenchKind(val fetchesPerIteration: Int) { FETCH_RGBA8(1), FETCH_RGBA16UI(1), ALU(0) }

/** One bench step: a synthetic program drawn [draws] times over a [size]² RGBA8 target, timed between `glFinish`
 *  calls. [iterations] is a literal loop bound in the shader, never a uniform. */
data class BenchStep(val id: String, val kind: BenchKind, val size: Int, val iterations: Int, val draws: Int) {
    val fragments: Long get() = size.toLong() * size
    val fetchesPerDraw: Long get() = fragments * kind.fetchesPerIteration * iterations
    val workPerDraw: Long get() = fragments * iterations
}

/**
 * The N0 device probe's GPU bench (GLOBE-NATIVE-PLAN §5.2, §8.3). It calibrates the whole-frame cost model with
 * measured ms per step and ns per fetch on the Seeker. It runs ONLY on the debug probe screen, never in a world frame
 * (`glFinish` is allowed there and nowhere else).
 *
 * It can never hang the GPU, by construction:
 * - a FIXED list of steps ([plan]); nothing is derived from the device;
 * - every loop bound is a literal in the shader source ([fragmentShader]); no `while`, no uniform-bounded loop;
 * - per draw at most [MAX_WORK_PER_DRAW] fragment-iterations (1024² × 64), a few tens of ms even at 1 Gtexel/s,
 *   far under any GPU watchdog;
 * - the ramp: steps of one kind run from cheapest to dearest, and once a step takes [RAMP_STOP_MS] or more, the
 *   dearer steps of that kind are skipped ([allowsNext]);
 * - one step per frame, so the probe's GL thread never holds the UI's pause handshake for long.
 *
 * The programs are synthetic, not the production passes: the pinned world shaders are provisional and must not be
 * used for rendering yet (LOCAL_TESTING.md). The plan's per-production-pass bench is an N1+ follow-up.
 */
object ProbeBench {
    const val MAX_WORK_PER_DRAW = 1024L * 1024 * 64
    const val RAMP_STOP_MS = 30.0
    const val DRAWS = 4
    const val TEXTURE_SIZE = 512
    val SIZES = intArrayOf(256, 512, 1024)
    val FETCH_ITERATIONS = intArrayOf(1, 16, 64)
    val ALU_ITERATIONS = intArrayOf(16, 64)

    fun plan(): List<BenchStep> {
        val steps = ArrayList<BenchStep>()
        for (kind in BenchKind.entries) {
            val iterations = if (kind == BenchKind.ALU) ALU_ITERATIONS else FETCH_ITERATIONS
            val ofKind = ArrayList<BenchStep>()
            for (n in iterations) for (size in SIZES) ofKind += BenchStep("${kind.name.lowercase()}-i$n-s$size", kind, size, n, DRAWS)
            ofKind.sortBy { it.workPerDraw }
            steps += ofKind
        }
        return steps
    }

    /** After a step of some kind took [measuredMs] (all draws), may the next dearer step of that kind run? */
    fun allowsNext(measuredMs: Double): Boolean = measuredMs.isFinite() && measuredMs < RAMP_STOP_MS

    /** ns per texel fetch from a step's measured ms (all draws); null for ALU steps. */
    fun nsPerFetch(step: BenchStep, measuredMs: Double): Double? {
        val fetches = step.fetchesPerDraw * step.draws
        return if (fetches <= 0L) null else measuredMs * 1e6 / fetches
    }

    const val VERTEX_SHADER = "#version 300 es\nlayout(location = 0) in vec2 a_pos;\nvoid main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n"

    fun fragmentShader(kind: BenchKind, iterations: Int): String {
        require(iterations in 1..256) { "Bench loops are small literals" }
        val body = when (kind) {
            BenchKind.FETCH_RGBA8 -> """
                |uniform sampler2D u_tex;
                |out vec4 o_color;
                |void main() {
                |  vec2 uv = gl_FragCoord.xy * ${1.0 / TEXTURE_SIZE};
                |  vec4 acc = vec4(0.0);
                |  for (int i = 0; i < $iterations; i++) {
                |    acc += texture(u_tex, uv + vec2(float(i) * 0.0137, float(i) * 0.0071));
                |  }
                |  o_color = acc * ${1.0 / iterations};
                |}""".trimMargin()
            BenchKind.FETCH_RGBA16UI -> """
                |uniform highp usampler2D u_tex;
                |out vec4 o_color;
                |void main() {
                |  ivec2 p = ivec2(gl_FragCoord.xy);
                |  uvec4 acc = uvec4(0u);
                |  for (int i = 0; i < $iterations; i++) {
                |    acc += texelFetch(u_tex, (p + ivec2(i * 7, i * 3)) & ivec2(${TEXTURE_SIZE - 1}), 0);
                |  }
                |  o_color = vec4(acc & uvec4(255u)) * ${1.0 / 255.0};
                |}""".trimMargin()
            BenchKind.ALU -> """
                |out vec4 o_color;
                |void main() {
                |  vec4 x = vec4(gl_FragCoord.xy * 0.001, 0.25, 0.5);
                |  for (int i = 0; i < $iterations; i++) {
                |    x = fract(x * 1.6180339 + vec4(0.1234, 0.5678, 0.9012, 0.3456));
                |  }
                |  o_color = x;
                |}""".trimMargin()
        }
        return "#version 300 es\nprecision highp float;\nprecision highp int;\n$body\n"
    }
}

/** Frame-interval statistics for the probe's pacing readout (present-to-present needs SurfaceFlinger; these are the
 *  app-side frame starts, the plan's cross-check, §8.3). */
data class PacingStats(val frames: Int, val p50Ms: Double, val p95Ms: Double, val p99Ms: Double, val over20Ms: Int, val over50Ms: Int) {
    companion object {
        /** From [count] consecutive frame-start timestamps (ns). Null with fewer than 2. */
        fun fromStarts(starts: LongArray, count: Int): PacingStats? {
            if (count < 2) return null
            val intervals = LongArray(count - 1) { starts[it + 1] - starts[it] }
            intervals.sort()
            fun p(q: Double) = intervals[(Math.ceil(q * intervals.size).toInt() - 1).coerceIn(0, intervals.size - 1)] / 1e6
            return PacingStats(count, p(0.5), p(0.95), p(0.99), intervals.count { it > 20_000_000L }, intervals.count { it > 50_000_000L })
        }
    }
}
