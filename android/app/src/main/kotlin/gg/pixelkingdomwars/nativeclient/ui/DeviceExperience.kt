package gg.pixelkingdomwars.nativeclient.ui

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ActivityInfo
import android.database.ContentObserver
import android.os.Build
import android.os.Vibrator
import android.os.VibrationEffect
import android.os.VibrationAttributes
import android.media.AudioAttributes
import java.util.concurrent.atomic.AtomicLong
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.MotionDurationScale
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import gg.pixelkingdomwars.nativeclient.data.DevicePreferences
import gg.pixelkingdomwars.nativeclient.data.DeviceSettings
import gg.pixelkingdomwars.nativeclient.renderer.HapticPattern
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Android's animation-disable accessibility setting is the native equivalent of prefers-reduced-motion.
 * Keep a nonzero system duration scale intact; turning the app setting OFF never overrides the OS. */
data class SystemExperience(val animatorScale: Float = 1f, val haptics: Boolean? = null, val foreground: Boolean = false) {
    val reduceMotion: Boolean get() = animatorScale == 0f
}
fun effectiveReducedMotion(settings: DeviceSettings, system: SystemExperience): Boolean = settings.reduceMotion || system.reduceMotion
fun gameHapticsAllowed(settings: DeviceSettings, system: SystemExperience): Boolean =
    system.foreground && settings.haptics && system.haptics != false && !effectiveReducedMotion(settings, system)
fun patternHapticsAllowed(settings:DeviceSettings,system:SystemExperience,shown:Boolean,focused:Boolean,viewEnabled:Boolean):Boolean =
    gameHapticsAllowed(settings,system) && shown && focused && viewEnabled
fun motionDurationScale(settings: DeviceSettings, system: SystemExperience): Float =
    if (effectiveReducedMotion(settings, system)) 0f else system.animatorScale
/** Android13+ keeps touch-feedback policy inside the service; a stale legacy bit cannot override it. */
fun readLegacyHapticSetting(sdk: Int, read: () -> Boolean): Boolean? =
    if (sdk < Build.VERSION_CODES.TIRAMISU) runCatching(read).getOrDefault(false) else null
/** Decision 2026-10-06 (the owner's Seeker report on build 880a7e7a: the Clan sheet cut off on a rotated phone; see the
 *  DECISION on MainActivity in AndroidManifest.xml): the game is portrait only, the manifest's `userPortrait`. A runtime request overrides the manifest, so this must
 *  agree with it. The retired web-parity "Landscape lock" (skp_landscape) is no longer read. */
/** Owner 2026-10-06 16:53: the game follows the phone's rotation again (every orientation the user allows). The morning's
 *  portrait lock (N-046) fixed the landscape Clan cut-off by removing landscape, which also removed the owner's scrcpy
 *  landscape demo; the landscape sheet layouts are tracked as their own fixes (K-night-A11). The manifest says the same. */
fun gameOrientation(): Int = ActivityInfo.SCREEN_ORIENTATION_FULL_USER

/** Browser patterns start ON; Android's timing overload starts OFF and uses default amplitude. */
fun androidHapticTimings(pattern:HapticPattern):LongArray = longArrayOf(0)+pattern.timings.toLongArray()

val LocalReducedMotion = staticCompositionLocalOf { false }
val LocalGameHaptic = staticCompositionLocalOf<() -> Unit> { {} }
val LocalSystemExperience = staticCompositionLocalOf { SystemExperience() }

/** One hardware owner, no scheduler. An old surface can cancel only its own last request. */
class OwnedHapticDelivery(private val stop:()->Unit,private val deliver:(HapticPattern)->Unit) {
    private var owner:Any?=null
    @Synchronized fun play(token:Any,pattern:HapticPattern) { stop();owner=token;deliver(pattern) }
    @Synchronized fun cancel(token:Any) { if(owner===token)cancelAll() }
    @Synchronized fun cancelAll() { owner=null;stop() }
}

/** One Activity-owned observer; no global Compose policy, OS setting or wallet-session mutation. */
class DeviceExperience(private val activity: Activity, private val preferences: DevicePreferences) : DefaultLifecycleObserver {
    private val epoch=AtomicLong()
    private var sensoryPreferences=preferences.state.value.let { it.reduceMotion to it.haptics }
    val sensoryEpoch:Long get()=epoch.get()
    private val vibrator by lazy { activity.getSystemService(Vibrator::class.java) }
    private val patterns=OwnedHapticDelivery({runCatching { vibrator?.cancel() };Unit},::deliverPattern)
    private val current = MutableStateFlow(readSystem(false))
    val state = current.asStateFlow()
    private val scale = mutableFloatStateOf(motionDurationScale(preferences.state.value, current.value))
    val motionScale = object : MotionDurationScale {
        override val scaleFactor: Float get() = scale.floatValue
    }
    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) { refresh() }
    }
    init {
        activity.contentResolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        observeLegacyHaptics()
    }
    @Suppress("DEPRECATION") // This setting is consulted only on Android28–32; modern feedback is service-gated.
    private fun observeLegacyHaptics() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU)
            activity.contentResolver.registerContentObserver(Settings.System.getUriFor(Settings.System.HAPTIC_FEEDBACK_ENABLED), false, observer)
    }
    @Suppress("DEPRECATION") // Same API28–32 compatibility boundary as the observer.
    private fun readSystem(foreground: Boolean): SystemExperience {
        val scale = runCatching { Settings.Global.getFloat(activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) }
            .getOrDefault(1f).takeIf { it.isFinite() && it >= 0f } ?: 1f
        val enabled = runCatching { ValueAnimator.areAnimatorsEnabled() }.getOrDefault(scale != 0f)
        val haptics = readLegacyHapticSetting(Build.VERSION.SDK_INT) { Settings.System.getInt(activity.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0 }
        return SystemExperience(if (enabled) scale else 0f, haptics, foreground)
    }
    private fun refresh() {
        val next=readSystem(current.value.foreground)
        if(next!=current.value)epoch.incrementAndGet()
        current.value=next;refreshScale()
        if(!gameHapticsAllowed(preferences.state.value,next))patterns.cancelAll()
    }
    private fun refreshScale() { scale.floatValue = motionDurationScale(preferences.state.value, current.value) }
    fun applyPreferences() {
        val value=preferences.state.value;val selected=value.reduceMotion to value.haptics
        if(selected!=sensoryPreferences) { sensoryPreferences=selected;epoch.incrementAndGet() }
        if(!gameHapticsAllowed(value,current.value))patterns.cancelAll()
        refreshScale();applyOrientation()
    }
    /** Installed-web fullscreen parity. Reapply only on resume/focus, so a swipe can reveal transient bars. */
    fun applyFullscreen() {
        if (!current.value.foreground || activity.isFinishing || activity.isDestroyed || !activity.window.decorView.hasWindowFocus()) return
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }
    @SuppressLint("SourceLockedOrientationActivity") // Deliberate: portrait only (gameOrientation, manifest decision).
    fun applyOrientation() {
        val wanted = gameOrientation()
        if (activity.requestedOrientation != wanted) activity.requestedOrientation = wanted
    }
    /** A light game tap uses Android's predefined feedback; the platform's own per-view/device gates still apply. */
    fun haptic() {
        // Read settings at delivery time too: a queued old callback cannot buzz after OFF/background.
        refresh()
        if (gameHapticsAllowed(preferences.state.value, current.value))
            activity.window.decorView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    }
    /** Production patterns are source-derived. Each request replaces the preceding pattern,
     * in event order; there is no strength priority, queue or game-side haptic budget. */
    fun patternHaptic(owner:Any,pattern:HapticPattern) {
        refresh()
        val view=activity.window.decorView
        if(!patternHapticsAllowed(preferences.state.value,current.value,
            view.isShown,view.hasWindowFocus(),view.isHapticFeedbackEnabled))return
        patterns.play(owner,pattern)
    }
    fun cancelHaptics(owner:Any) { patterns.cancel(owner) }
    private fun deliverPattern(pattern:HapticPattern) {
        runCatching {
            val target=vibrator?.takeIf { it.hasVibrator() } ?: return
            val effect=if(pattern.timings.size==1)VibrationEffect.createOneShot(pattern.timings.single(),VibrationEffect.DEFAULT_AMPLITUDE)
                else VibrationEffect.createWaveform(androidHapticTimings(pattern),-1)
            if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.TIRAMISU)
                target.vibrate(effect,VibrationAttributes.Builder().setUsage(VibrationAttributes.USAGE_TOUCH).build())
            else target.vibrate(effect,AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).build())
        }
    }
    override fun onResume(owner: LifecycleOwner) { epoch.incrementAndGet();current.value = readSystem(true); applyPreferences(); applyFullscreen() }
    override fun onPause(owner: LifecycleOwner) { epoch.incrementAndGet();current.value = current.value.copy(foreground = false);patterns.cancelAll() }
    override fun onDestroy(owner: LifecycleOwner) { onPause(owner);activity.contentResolver.unregisterContentObserver(observer) }
}
