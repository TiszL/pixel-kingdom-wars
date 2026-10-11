package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class ContentUpdateReadinessTest {
    private val context=ContentUpdateContext("a".repeat(64),14,9)
    // Rewritten with concurrent startup: restoration no longer follows the catalogue, but resume
    // still cannot read half published metadata, and checks stay closed until both branches end.
    @Test fun `resume cannot read half published metadata while account restoration runs alongside the catalogue`() = runBlocking {
        val readiness=ContentUpdateReadiness()
        val metadataRead=CompletableDeferred<Unit>();val releaseCatalogue=CompletableDeferred<Unit>()
        var catalogueLoaded=false;var accountRestored=false
        // The shell's BootViewModel runs restoration concurrently with content preparation.
        val startup=async { coroutineScope {
            val restoration=async {
                metadataRead.await()
                assertFalse("Restoration starts before the catalogue is published",catalogueLoaded)
                assertNull("...and still never observes half published metadata",readiness.current)
                accountRestored=true
            }
            readiness.load {
                val metadata=context
                metadataRead.complete(Unit);releaseCatalogue.await()
                catalogueLoaded=true
                metadata
            }
            restoration.await()
        } }
        metadataRead.await()
        assertNull("Resume occurs after metadata I/O but before catalogue publication",readiness.current)
        assertFalse("A forced check waits for startup, however early restoration finishes",readiness.beginCheck(true,1))
        releaseCatalogue.complete(Unit);startup.await()
        assertSame(context,readiness.current)
        assertTrue(accountRestored && catalogueLoaded)
    }
    @Test fun `failed and cancelled content loads never open the update gate`() = runBlocking {
        val readiness=ContentUpdateReadiness()
        var cataloguePublished=false
        val missingBundledMetadata=emptyMap<String,String>()
        try {
            readiness.load {
                // Validate the complete metadata snapshot before publishing visible assets.
                val candidate=ContentUpdateContext(requireNotNull(missingBundledMetadata["contentVersion"]),14,9)
                cataloguePublished=true
                candidate
            }
            fail("Expected missing bundled metadata to fail before publication")
        } catch(_:IllegalArgumentException) { }
        assertFalse(cataloguePublished)
        assertNull(readiness.current)
        val entered=CompletableDeferred<Unit>()
        val cancelled=launch { readiness.load { entered.complete(Unit);awaitCancellation() } }
        entered.await();cancelled.cancelAndJoin();assertNull(readiness.current)
        readiness.load { context }
        assertSame("An explicit retry can publish the fully loaded context",context,readiness.current)
    }
    @Test fun `an update captures one immutable context rather than rereading partially replaced fields`() = runBlocking {
        val readiness=ContentUpdateReadiness();readiness.load { context }
        val captured=readiness.current!!
        val replacement=context.copy(bundledVersion="b".repeat(64),simVersion=18,rendererVersion=15)
        readiness.load { assertNull(readiness.current);replacement }
        assertEquals(9,captured.rendererVersion);assertEquals(14,captured.simVersion);assertEquals("a".repeat(64),captured.bundledVersion)
        assertEquals(18,readiness.current!!.simVersion);assertEquals(15,readiness.current!!.rendererVersion)
        assertSame(replacement,readiness.current)
    }
    @Test fun `startup diagnostics expose only phase and fixed failure categories`() {
        val secret="https://private.invalid/session?secret=do-not-log"
        assertEquals("LOGIN_STATUS_REQUEST:SESSION_SUPERSEDED",startupFailureDiagnostic(StartupPhase.LOGIN_STATUS_REQUEST,SessionSupersededException()))
        assertEquals("RESTORING_CONTENT:CANCELLED",startupFailureDiagnostic(StartupPhase.RESTORING_CONTENT,CancellationException(secret)))
        assertEquals("ACCOUNT_IDENTITY_REQUEST:FAILED",startupFailureDiagnostic(StartupPhase.ACCOUNT_IDENTITY_REQUEST,IOException(secret)))
        assertEquals("RESTORING_SESSION:INTERRUPTED",startupFailureDiagnostic(StartupPhase.RESTORING_SESSION,null))
    }
}
