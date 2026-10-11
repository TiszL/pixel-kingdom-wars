package gg.pixelkingdomwars.nativeclient.audio

import org.junit.Assert.*
import org.junit.Test

class UiAudioTest {
    private class Fixture {
        val identity = Any(); var base = "deed"; val calls = mutableListOf<Pair<UiAudioSound, String>>()
        val emitter = UiAudioEmitter { cue, key -> calls += cue to key }
        init { emitter.update(identity, "pack", true) }
        val scope = emitter.scope(base) { base }.also { it.active(true) }
        fun accept(action: BaseAudioAction) = action.accepted(identity, "deed", listOf(UiAudioCue.CONFIRM))
    }
    @Test fun `canonical aliases keep global per Activity deterministic legacy sequence and coin gain`() {
        val f = Fixture(); f.scope.tap(); f.scope.capture()!!.accepted(f.identity, f.base, listOf(UiAudioCue.CLAIM, UiAudioCue.COINS))
        assertEquals(listOf("sfx_tap:0", "sfx_claim_chime:1", "sfx_coin_shower:2"), f.calls.map { it.second })
        assertEquals(listOf("sfx_ui_tap", "sfx_ui_claim_chime", "sfx_ui_coin_shower"), f.calls.map { it.first.family })
        assertEquals(0.8f, f.calls.last().first.gain, 0f)
    }
    @Test fun `accepted receipt settles before a failed later hydration and can never replay`() {
        val f = Fixture(); val action = f.scope.capture()!!
        f.accept(action); action.failed(f.identity, f.base); f.accept(action)
        assertEquals(listOf(UiAudioCue.CONFIRM), f.calls.map { it.first })
    }
    @Test fun `original still visible refusal sounds once without acceptance`() {
        val f = Fixture(); val action = f.scope.capture()!!
        action.failed(f.identity, f.base); action.failed(f.identity, f.base)
        assertEquals(listOf(UiAudioCue.ERROR), f.calls.map { it.first })
    }
    @Test fun `Back then same screen return cannot adopt the pending action`() {
        val f = Fixture(); val action = f.scope.capture()!!
        f.scope.active(false); f.scope.active(true); f.accept(action)
        assertTrue(f.calls.isEmpty()); f.accept(f.scope.capture()!!); assertEquals(1, f.calls.size)
    }
    @Test fun `mute focus background and content replacement permanently expire pending feedback`() {
        for (reason in listOf("mute", "focus", "background", "pack")) {
            val f = Fixture(); val action = f.scope.capture()!!
            f.emitter.update(f.identity, if (reason == "pack") "next" else "pack", false)
            assertNull(f.scope.capture())
            f.emitter.update(f.identity, "pack", true); f.accept(action)
            assertTrue(reason, f.calls.isEmpty())
        }
    }
    @Test fun `same wallet new session identity does not receive original action or stale scope tap`() {
        val f = Fixture(); val action = f.scope.capture()!!; f.emitter.update(Any(), "pack", true)
        f.accept(action); f.scope.tap(); assertTrue(f.calls.isEmpty()); assertNull(f.scope.capture())
    }
    @Test fun `deed switch and wrong receipt actor or deed cannot sound confirmation`() {
        for (wrong in listOf("current", "receipt", "actor")) {
            val f = Fixture(); val action = f.scope.capture()!!
            if (wrong == "current") f.base = "other"
            action.accepted(if (wrong == "actor") Any() else f.identity, if (wrong == "receipt") "other" else "deed", listOf(UiAudioCue.CONFIRM))
            assertTrue(wrong, f.calls.isEmpty())
        }
    }
    @Test fun `new selection and disposal silence original pending feedback`() {
        for (close in listOf(true, false)) {
            val f = Fixture(); val action = f.scope.capture()!!
            if (close) f.scope.close() else f.scope.invalidate()
            f.accept(action); assertTrue(f.calls.isEmpty())
        }
    }
    @Test fun `scope can exist before audio admission when its screen identity is authoritative`() {
        val identity = Any(); val calls = mutableListOf<UiAudioSound>()
        val emitter = UiAudioEmitter { cue, _ -> calls += cue }
        val scope = emitter.scope("deed", identity) { "deed" }.also { it.active(true) }
        assertNull(scope.capture()); emitter.update(identity, "pack", true); scope.tap()
        assertEquals(listOf(UiAudioCue.TAP), calls)
    }
    @Test fun `current muted events consume exact legacy sequence without warming or delayed replay`() {
        val f = Fixture(); f.emitter.update(f.identity, "pack", false, current = true)
        f.scope.tap(); f.scope.capture()!!.accepted(f.identity, f.base, listOf(UiAudioCue.CLAIM, UiAudioCue.COINS))
        assertTrue(f.calls.isEmpty())
        f.emitter.update(f.identity, "pack", true); f.scope.tap()
        assertEquals(listOf(UiAudioCue.TAP to "sfx_tap:3"), f.calls)
    }
    @Test fun `unmuting expires a previously silent pending action instead of playing or counting it later`() {
        val f = Fixture(); f.emitter.update(f.identity, "pack", false, current = true)
        val action = f.scope.capture()!!
        f.emitter.update(f.identity, "pack", true); f.accept(action); f.scope.tap()
        assertEquals(listOf(UiAudioCue.TAP to "sfx_tap:0"), f.calls)
    }
    @Test fun `only visible scopes of the current session own screen prewarming`() {
        val f = Fixture(); assertTrue(f.emitter.hasVisibleScope)
        f.scope.active(false); assertFalse(f.emitter.hasVisibleScope)
        f.scope.active(true); f.emitter.update(Any(), "next", true); assertFalse(f.emitter.hasVisibleScope)
        f.scope.close(); assertFalse(f.emitter.hasVisibleScope)
    }
    @Test fun `decoder failure cannot throw into a confirmed action`() {
        val owner = Any(); val emitter = UiAudioEmitter { _, _ -> error("decoder") }; emitter.update(owner, "pack", true)
        val scope = emitter.scope("deed") { "deed" }.also { it.active(true) }
        scope.capture()!!.accepted(owner, "deed", listOf(UiAudioCue.CONFIRM))
    }
    @Test fun `result scopes share the exact legacy sequence while warming only their own source cues`() {
        val f=Fixture();f.scope.tap();f.scope.active(false)
        val result=object:UiAudioSound {override val legacy="sfx_star_3";override val family="sfx_battle_star_3";override val gain=1f}
        val screen=f.emitter.scope(f.base,f.identity,setOf(result)){f.base}.also {it.active(true)}
        assertEquals(setOf(result),f.emitter.visibleCues)
        screen.shown(listOf(result));assertEquals("sfx_star_3:1",f.calls.last().second)
        screen.close();assertTrue(f.emitter.visibleCues.isEmpty())
        f.scope.active(true);assertEquals(UiAudioCue.entries.toSet(),f.emitter.visibleCues)
    }
    @Test fun `muted result consumes the shared key without later focus or load replay`() {
        val f=Fixture();val result=object:UiAudioSound {override val legacy="sfx_shield_up";override val family="sfx_battle_shield_up";override val gain=.8f}
        f.emitter.update(f.identity,"pack",false,current=true);f.scope.shown(listOf(result));assertTrue(f.calls.isEmpty())
        f.emitter.update(f.identity,"pack",true);f.scope.tap();assertEquals("sfx_tap:1",f.calls.single().second)
    }

}
