package gg.pixelkingdomwars.nativeclient.telemetry

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeTelemetryTest {
    private class Memory : SecretStore {
        var value: String? = null; var writes = 0; var fail = false
        override fun read(): String? { check(!fail); return value }
        override fun write(value: String) { check(!fail); this.value = value; writes++ }
        override fun clear() { check(!fail); value = null }
    }
    private val build = TelemetryBuild("657ee4c", "0.1.0-foundation-debug:1")
    private val secret = "session-cookie wallet-signature /Users/private/key.json token?private=true"
    private fun error(file: String = "KingdomScreen.kt", line: Int = 123) = IllegalStateException(secret).apply {
        stackTrace = arrayOf(StackTraceElement("provider.$secret", secret, "/Users/private/Key.kt", 10),
            StackTraceElement("gg.pixelkingdomwars.nativeclient.ui.KingdomScreen", "method$secret", file, line))
    }
    @Test fun `diagnostics retain only closed error metadata without exception locations`() = runTest {
        val disk = Memory(); val sent = mutableListOf<JsonObject>()
        val telemetry = NativeTelemetry(disk, build, { true }, { sent += it })
        telemetry.record(NativeError.SCREEN, error()); assertFalse(disk.value!!.contains(secret))
        telemetry.flush(); assertNull(disk.value)
        val batch = sent.single(); assertEquals(build.context(), batch.getValue("context"))
        val props = batch.getValue("events").jsonArray.single().jsonObject.getValue("props").jsonObject
        assertEquals(setOf("name", "code", "message", "count"), props.keys)
        assertFalse(props.containsKey("source"))
        assertEquals(JsonPrimitive("Native screen action failed"), props["message"])
        for (forbidden in listOf(secret, "provider", "method", "wallet", "Cookie", "token", "stack", "KingdomScreen")) assertFalse(batch.toString().contains(forbidden))
    }
    /** Seeker incident 2026-09-17: the MWA error class must reach the diagnostics channel, and only that class —
     * the same closed vocabulary the API attributes (NATIVE_ERROR_MESSAGES), never the transaction or wallet text. */
    @Test fun `every wallet failure kind has one diagnostics code that journals, dedups and sends like any native error`() = runTest {
        for (kind in gg.pixelkingdomwars.nativeclient.wallet.WalletFailureKind.entries) assertEquals(kind.diagnostic, NativeError.forWallet(kind).code)
        assertEquals(NativeError.entries.size, NativeError.entries.map { it.code }.toSet().size)
        val disk = Memory(); val sent = mutableListOf<JsonObject>(); val telemetry = NativeTelemetry(disk, build, { true }, { sent += it })
        val invalid = NativeError.forWallet(gg.pixelkingdomwars.nativeclient.wallet.WalletFailureKind.INVALID_PAYLOADS)
        telemetry.record(invalid); telemetry.record(invalid); telemetry.record(NativeError.WALLET_NOT_SIGNED)
        assertTrue(disk.value!!.contains("NATIVE_WALLET_INVALID_PAYLOADS")); telemetry.flush()
        val events = sent.single().getValue("events").jsonArray.map { it.jsonObject.getValue("props").jsonObject }
        assertEquals(listOf("NATIVE_WALLET_INVALID_PAYLOADS" to 2, "NATIVE_WALLET_NOT_SIGNED" to 1), events.map { it.getValue("code").jsonPrimitive.content to it.getValue("count").jsonPrimitive.int })
        assertEquals(setOf("name", "code", "message", "count"), events.first().keys)
    }
    @Test fun `unsafe filenames and cancellation cannot become diagnostic data`() = runTest {
        val disk = Memory(); val sent = mutableListOf<JsonObject>(); val telemetry = NativeTelemetry(disk, build, { true }, { sent += it })
        telemetry.record(NativeError.SCREEN, CancellationException(secret)); assertNull(disk.value)
        telemetry.record(NativeError.RENDER, error("/private/Key.kt")); telemetry.flush()
        assertFalse(sent.single().toString().contains("source"))
    }
    @Test fun `offline reporting has no disk or network effect`() = runTest {
        val disk = Memory().apply { fail = true }; var calls = 0
        val telemetry = NativeTelemetry(disk, build, { false }, { calls++ })
        telemetry.record(NativeError.UNCAUGHT, error()); telemetry.flush(); assertEquals(0, calls); assertEquals(0, disk.writes)
    }
    @Test fun `crash reports retain their original binary build across an upgrade`() = runTest {
        val disk = Memory(); val sent = mutableListOf<JsonObject>()
        NativeTelemetry(disk, build, { true }, { error("not called") }).record(NativeError.UNCAUGHT, error())
        val next = TelemetryBuild("0123456789abcdef", "0.2.0:13")
        val resumed = NativeTelemetry(disk, next, { true }, { sent += it }); resumed.record(NativeError.STARTUP); resumed.flush()
        assertEquals(listOf(build.context(), next.context()), sent.map { it.getValue("context") }); assertNull(disk.value)
    }
    @Test fun `duplicates aggregate and the retained queue is bounded`() = runTest {
        val disk = Memory(); val sent = mutableListOf<JsonObject>(); val telemetry = NativeTelemetry(disk, build, { true }, { sent += it })
        repeat(5) { telemetry.record(NativeError.SCREEN, error()) }
        telemetry.flush()
        assertEquals(JsonPrimitive(5), sent.single().getValue("events").jsonArray.single().jsonObject.getValue("props").jsonObject["count"])
        repeat(24) { index -> NativeTelemetry(disk, TelemetryBuild("dev", "0.1.$index:1"), { true }, { sent += it }).record(NativeError.RENDER, error()) }
        assertEquals(20, Json.parseToJsonElement(disk.value!!).jsonObject.getValue("reports").jsonArray.size)
    }
    @Test fun `lost response is never automatically replayed and new reports survive in flight`() = runTest {
        val disk = Memory(); var now = 100_000L; var calls = 0
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val telemetry = NativeTelemetry(disk, build, { true }, { calls++; assertNull(disk.value); entered.complete(Unit); release.await(); throw java.io.IOException(secret) }, { now })
        telemetry.record(NativeError.RENDER); val flushing = launch { telemetry.flush() }; entered.await()
        telemetry.record(NativeError.STARTUP); telemetry.flush(); release.complete(Unit); flushing.join()
        assertEquals(1, calls); assertTrue(disk.value!!.contains("NATIVE_STARTUP")); assertFalse(disk.value!!.contains("NATIVE_RENDER"))
        val sent = mutableListOf<JsonObject>(); now += 20_000
        NativeTelemetry(disk, build, { true }, { sent += it }, { now }).flush()
        assertEquals(1, sent.size); assertFalse(sent.single().toString().contains("NATIVE_RENDER")); assertNull(disk.value)
    }
    @Test fun `frequent lifecycle callbacks do not repeatedly send diagnostics`() = runTest {
        val disk = Memory(); var now = 10_000L; var calls = 0
        val telemetry = NativeTelemetry(disk, build, { true }, { calls++ }, { now })
        telemetry.record(NativeError.RENDER); telemetry.flush(); telemetry.record(NativeError.STARTUP)
        repeat(20) { telemetry.flush() }; assertEquals(1, calls)
        now += 15_000; telemetry.flush(); assertEquals(2, calls)
    }
    @Test fun `corrupt or injected persisted records fail closed without transmission`() = runTest {
        val disk = Memory(); var calls = 0; val telemetry = NativeTelemetry(disk, build, { true }, { calls++ })
        telemetry.record(NativeError.RENDER)
        val raw = Json.parseToJsonElement(disk.value!!).jsonObject; val row = raw.getValue("reports").jsonArray.single().jsonObject
        disk.value = JsonObject(raw + ("reports" to JsonArray(listOf(JsonObject(row + ("message" to JsonPrimitive(secret))))))).toString()
        telemetry.flush(); assertEquals(0, calls)
        telemetry.record(NativeError.STARTUP); assertEquals(0, calls)
    }
    @Test fun `diagnostic storage failures cannot change the game or replace the prior crash handler`() {
        val disk = Memory().apply { fail = true }; val telemetry = NativeTelemetry(disk, build, { true }, {})
        telemetry.record(NativeError.RENDER, error())
        val original = error(); val thread = Thread.currentThread(); var delegated = 0
        val handler = telemetryCrashHandler({ throw IllegalStateException("storage failed") }, Thread.UncaughtExceptionHandler { seenThread, seenError ->
            delegated++; assertSame(thread, seenThread); assertSame(original, seenError)
        })
        assertThrows(IllegalStateException::class.java) { handler.uncaughtException(thread, original) }; assertEquals(1, delegated)
    }
}
