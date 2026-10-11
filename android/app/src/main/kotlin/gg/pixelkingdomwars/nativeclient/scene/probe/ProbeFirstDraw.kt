package gg.pixelkingdomwars.nativeclient.scene.probe

/**
 * The first-draw questions the N0 probe answers once on the Seeker (GLOBE-NATIVE-PLAN §5.3 steps 3 and 4, §8.3):
 * - **worker pre-warm**: does a 1×1 draw of a (program, state) on the shared worker context, into a target of the same
 *   format, build the pipeline variant for the world context too? If yes, rehearsal moves off the GL thread.
 * - **scratch vs screen**: does a rehearsal into an RGB8 (or RGBA8) scratch target build the variant the default
 *   framebuffer uses? `Gl3Core.rehearse(forScreen = true)` rests on that premise.
 *
 * Each trial times the FIRST and SECOND draw of a warmed program and of a control program that nothing warmed, in the
 * same state, on the GL thread (`glFinish` around each draw: the probe screen only). The first draw's excess over the
 * second is the variant build; the control's excess says what a cold variant costs on this driver.
 *
 * Programs are synthetic and distinct per salt: the salt is a literal in the arithmetic, never only a comment, so no
 * driver shader cache can hand one program's variant to another. Each has one literal-bounded loop (RM-GPU-1).
 */
object ProbeFirstDraw {
    const val TRIALS = 3
    /** Below this median control excess the driver shows no first-draw cost worth warming: the answer is inconclusive. */
    const val MIN_EXCESS_MS = 0.5
    const val TARGET_SIZE = 64

    /** An attribute-less fullscreen triangle: the worker context draws it without a vertex buffer (vertex arrays are
     *  not shared between contexts), with the same program as the GL thread. */
    const val VERTEX_SHADER = "#version 300 es\nvoid main() {\n" +
        "  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n" +
        "  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n}\n"

    fun fragmentShader(salt: Int): String {
        require(salt in 0..9999) { "salt is a small literal" }
        val a = 0.1234 + salt * 1e-4
        return "#version 300 es\nprecision highp float;\nout vec4 o_color;\nvoid main() {\n" +
            "  vec4 x = vec4(gl_FragCoord.xy * 0.001, 0.25, ${literal(0.5 + salt * 1e-5)});\n" +
            "  for (int i = 0; i < 16; i++) {\n" +
            "    x = fract(x * 1.6180339 + vec4(${literal(a)}, 0.5678, 0.9012, 0.3456));\n" +
            "  }\n  o_color = vec4(x.rgb, 0.5);\n}\n"
    }

    private fun literal(v: Double) = "%.6f".format(java.util.Locale.ROOT, v)

    enum class Verdict { WARMS, DOES_NOT_WARM, INCONCLUSIVE }

    data class Trial(val warmedFirstMs: Double, val warmedSecondMs: Double, val controlFirstMs: Double, val controlSecondMs: Double) {
        val warmedExcessMs: Double get() = warmedFirstMs - warmedSecondMs
        val controlExcessMs: Double get() = controlFirstMs - controlSecondMs
    }

    /**
     * WARMS when the warmed programs' median first-draw excess is at most a quarter of the controls'; DOES_NOT_WARM when
     * it is at least three quarters; otherwise, or when the controls show less than [MIN_EXCESS_MS] of excess, or a
     * timing is missing, INCONCLUSIVE. The medians keep one slow frame from deciding the answer.
     */
    fun verdict(trials: List<Trial>): Verdict {
        if (trials.isEmpty()) return Verdict.INCONCLUSIVE
        if (trials.any { t -> listOf(t.warmedFirstMs, t.warmedSecondMs, t.controlFirstMs, t.controlSecondMs).any { !it.isFinite() || it < 0.0 } })
            return Verdict.INCONCLUSIVE
        val control = median(trials.map { it.controlExcessMs })
        if (control < MIN_EXCESS_MS) return Verdict.INCONCLUSIVE
        val warmed = median(trials.map { it.warmedExcessMs })
        return when {
            warmed <= control * 0.25 -> Verdict.WARMS
            warmed >= control * 0.75 -> Verdict.DOES_NOT_WARM
            else -> Verdict.INCONCLUSIVE
        }
    }

    fun median(values: List<Double>): Double {
        require(values.isNotEmpty())
        val sorted = values.sorted()
        val mid = sorted.size / 2
        return if (sorted.size % 2 == 1) sorted[mid] else (sorted[mid - 1] + sorted[mid]) / 2
    }
}
