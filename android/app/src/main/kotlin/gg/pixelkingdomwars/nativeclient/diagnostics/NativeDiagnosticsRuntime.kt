package gg.pixelkingdomwars.nativeclient.diagnostics

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.renderer.FrameTimeReport
import gg.pixelkingdomwars.nativeclient.telemetry.NativeTelemetryTransport
import gg.pixelkingdomwars.nativeclient.telemetry.TelemetryBuild
import kotlinx.coroutines.*
import java.util.Locale

/** Provided from the actual device preference; never inferred from DEBUG or from a wallet. */
val LocalNativeDiagnosticsEnabled = staticCompositionLocalOf { false }

object NativeDiagnosticsRuntime {
    private val session = NativeDiagnosticsSession(TelemetryBuild(BuildConfig.NATIVE_BUILD_SHA, "${BuildConfig.VERSION_NAME}:${BuildConfig.VERSION_CODE}"))
    private val transport by lazy { NativeTelemetryTransport(BuildConfig.API_ORIGIN) }
    private val scope by lazy { CoroutineScope(SupervisorJob() + Dispatchers.IO) }
    val state = session.state
    fun setEnabled(enabled: Boolean) = session.setEnabled(enabled)
    fun sample(report: FrameTimeReport) = session.sample(report)
    fun summary(report: FrameTimeReport) {
        val generation = session.currentGeneration()
        val batch = session.summary(report) ?: return
        scope.launch {
            if (!session.isActive(generation)) return@launch
            try { transport.send(batch) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Diagnostics never retry or report their own failure. */ }
        }
    }
}

/** No pointer handlers or clickable surfaces: the readout cannot intercept world/game controls. */
@Composable fun NativeDiagnosticsReadout(modifier: Modifier = Modifier) {
    val state by NativeDiagnosticsRuntime.state.collectAsState()
    if (!state.enabled) return
    var now by remember { mutableLongStateOf(System.nanoTime() / 1_000_000) }
    LaunchedEffect(Unit) {
        while (isActive) { delay(1_000); now = System.nanoTime() / 1_000_000 }
    }
    val report = state.report
    val ageSeconds = state.sampledAtMs?.let { ((now - it).coerceAtLeast(0) / 1_000) }
    Column(modifier.background(Color(0xDE101419)).padding(4.dp)) {
        val lines = if (report == null) listOf("NATIVE PERF · waiting for frame samples") else {
            val timings = report.steady.takeIf { it.count > 0 } ?: report.warmup
            listOfNotNull(
                ageSeconds?.takeIf { it >= 2 }?.let { "LAST SAMPLE ${it}s AGO · renderer may be covered or paused" },
                "NATIVE ${report.activeScene.uppercase(Locale.ROOT)} · ${report.averageFps.perfNumber()} fps · ${report.activeSeconds.perfNumber()}s window",
                "p50 ${timings.p50Ms.perfNumber()} · p95 ${timings.p95Ms.perfNumber()} · p99 ${timings.p99Ms.perfNumber()} ms",
                "draws ${report.meanDrawCalls.perfNumber()} avg / ${report.maxDrawCalls} max · texture ~${report.textureRgbaMiB.perfNumber()} MiB",
                "frames ${timings.count} · stalls >50ms ${timings.stallsOver50Ms} · sample drops ${timings.dropped}",
            )
        }
        lines.forEach { Text(it, color = Color(0xFFCFEFA2), fontSize = 11.sp, lineHeight = 13.sp) }
    }
}

private fun Double?.perfNumber() = if (this == null) "—" else String.format(Locale.US, "%.1f", this)
