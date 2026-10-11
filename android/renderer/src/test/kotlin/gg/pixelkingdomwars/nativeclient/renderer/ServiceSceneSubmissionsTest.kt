package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.test.*

class ServiceSceneSubmissionsTest {
    @Test fun `captured GL refresh cannot supersede a newer Main scene or revoked facts`() {
        val submissions=ServiceSceneSubmissions();val refresh=AtomicBoolean(false)
        val captured=CountDownLatch(1);val release=CountDownLatch(1);val replacing=CountDownLatch(1);val replaced=CountDownLatch(1)
        val accepted=java.util.Collections.synchronizedList(mutableListOf<String>())
        submissions.replace {
            if(refresh.get()) { captured.countDown();check(release.await(5,TimeUnit.SECONDS)) }
            accepted += "A:enabled"
        }
        refresh.set(true)
        val old=thread { submissions.refresh() }
        assertTrue(captured.await(5,TimeUnit.SECONDS))
        val newer=thread { replacing.countDown();submissions.replace { accepted += "B:revoked" };replaced.countDown() }
        try { assertTrue(replacing.await(5,TimeUnit.SECONDS));assertFalse(replaced.await(100,TimeUnit.MILLISECONDS)) } finally { release.countDown() }
        old.join(5000);newer.join(5000);assertFalse(old.isAlive);assertFalse(newer.isAlive)
        assertEquals("B:revoked",accepted.last())
        submissions.refresh();assertEquals("B:revoked",accepted.last())
    }
    @Test fun `permission and source change refresh only the latest request and disposal removes its authority`() {
        val submissions=ServiceSceneSubmissions();var draws=0;var enabled=true
        submissions.replace { if(enabled)draws++ }
        submissions.change { enabled=false;true }
        submissions.refresh();assertEquals(1,draws)
        submissions.clear();submissions.change { enabled=true;true };submissions.refresh()
        assertEquals(1,draws)
    }
}
