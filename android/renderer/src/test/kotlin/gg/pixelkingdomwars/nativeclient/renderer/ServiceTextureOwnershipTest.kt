package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.assets.AssetManager
import com.badlogic.gdx.assets.loaders.FileHandleResolver
import com.badlogic.gdx.assets.loaders.TextureLoader
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.TextureData
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.*

/** A prepared pixel-data test double, not decoded or usable image pixels. */
internal fun serviceTestPixels(width:Int=1024,height:Int=1024,closed:()->Unit={}):ServiceTexturePixels {
    var disposed=false
    return ServiceTexturePixels(object:TextureData {
        override fun getType()=TextureData.TextureDataType.Pixmap
        override fun isPrepared()=true // PixmapTextureData's pinned constant implementation.
        override fun prepare():Unit=error("Prepared service pixels must not decode asynchronously")
        override fun consumePixmap():Pixmap=error("This source-only test does not upload pixels")
        override fun disposePixmap()=false
        override fun consumeCustomData(target:Int):Unit=error("No custom upload")
        override fun getWidth()=width.also { check(!disposed) }
        override fun getHeight()=height.also { check(!disposed) }
        override fun getFormat()=Pixmap.Format.RGBA8888.also { check(!disposed) }
        override fun useMipMaps()=false
        override fun isManaged()=true
    }) { check(!disposed);disposed=true;closed() }
}

class ServiceTextureOwnershipTest {
    @Test fun `staging and resident texture share exact pixel owner and dispose it only after the last owner leaves`() {
        var disposed=0
        val staged=serviceTestPixels { disposed++ }
        val texture=staged.retain()
        staged.close();assertEquals(0,disposed)
        assertEquals(1024,texture.data.width) // Same managed data can restore the current GL context.
        texture.close();assertEquals(1,disposed)
        assertFails { texture.retain() }
    }
    @Test fun `canceled pinned TextureLoader cannot reopen files or consume disposed pixels after contains becomes false`() {
        val fileReads=AtomicInteger();val synced=AtomicInteger();val failure=AtomicReference<Throwable?>()
        val started=CountDownLatch(1);val release=CountDownLatch(1);val finished=CountDownLatch(1)
        val resolver=FileHandleResolver { path -> object:FileHandle(path) {
            override fun read():java.io.InputStream { fileReads.incrementAndGet();error("Optional files may only be read by owned preparation") }
        } }
        val manager=AssetManager(resolver,false)
        val loader=object:TextureLoader(resolver) {
            override fun loadAsync(manager:AssetManager,name:String,file:FileHandle,parameter:TextureParameter?) {
                started.countDown()
                try { check(release.await(5,TimeUnit.SECONDS));super.loadAsync(manager,name,file,parameter) }
                catch(error:Throwable) { failure.set(error);throw error }
                finally { finished.countDown() }
            }
            override fun loadSync(manager:AssetManager,name:String,file:FileHandle,parameter:TextureParameter?):Texture {
                synced.incrementAndGet();error("Canceled loadSync must never consume pixels")
            }
        }
        manager.setLoader(Texture::class.java,loader)
        val disposed=AtomicBoolean();val pixels=serviceTestPixels { disposed.set(true) }
        try {
            manager.load("service-page",Texture::class.java,TextureLoader.TextureParameter().also { it.textureData=pixels.data })
            manager.update();assertTrue(started.await(5,TimeUnit.SECONDS))
            manager.unload("service-page");manager.update()
            assertFalse(manager.contains("service-page")) // Reproduces why this is not an async-reader join.
            pixels.close();assertTrue(disposed.get())
            release.countDown();assertTrue(finished.await(5,TimeUnit.SECONDS));manager.update()
            assertNull(failure.get());assertEquals(0,fileReads.get());assertEquals(0,synced.get())
        } finally { release.countDown();manager.dispose();if(!disposed.get())pixels.close() }
    }
}
