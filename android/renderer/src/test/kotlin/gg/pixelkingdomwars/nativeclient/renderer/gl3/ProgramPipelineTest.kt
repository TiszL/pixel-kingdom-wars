package gg.pixelkingdomwars.nativeclient.renderer.gl3

import java.io.File
import java.nio.file.Files
import kotlin.test.*
import org.junit.Test

class ProgramCacheTest {
    private val formats = intArrayOf(0x8743)
    private val driver = DriverIdentity("Mali-G615 MC2", "OpenGL ES 3.2 v1.r47p0", 21L)
    private fun root(): File = Files.createTempDirectory("program-cache").toFile()
    private fun key(cache: ProgramCache, vs: String = "vs", fs: String = "fs") =
        cache.key(ProgramCache.sha256Hex(vs), ProgramCache.sha256Hex(fs))

    @Test fun `a stored binary loads back only for the same stage hashes`() {
        val cache = ProgramCache(root(), driver, 1 shl 20)
        cache.store(key(cache), 0x8743, byteArrayOf(1, 2, 3))
        assertContentEquals(byteArrayOf(1, 2, 3), cache.load(key(cache), formats, 1)!!.bytes)
        assertNull(cache.load(key(cache, fs = "fs changed"), formats, 1), "a shader change must never load an old binary")
    }

    @Test fun `a new driver or app build starts cold and purges the old namespace`() {
        val dir = root()
        val old = ProgramCache(dir, driver, 1 shl 20)
        old.store(key(old), 0x8743, byteArrayOf(9))
        val updated = ProgramCache(dir, driver.copy(version = "OpenGL ES 3.2 v1.r48p0"), 1 shl 20)
        assertNull(updated.load(key(updated), formats, 1))
        assertEquals(1, dir.listFiles()!!.size, "binaries of a dead driver were left on disk forever")
        val newApk = ProgramCache(dir, driver.copy(appVersionCode = 22L), 1 shl 20)
        assertNull(newApk.load(key(newApk), formats, 1))
    }

    @Test fun `a binary in a format the driver no longer lists is deleted, not tried`() {
        val cache = ProgramCache(root(), driver, 1 shl 20)
        cache.store(key(cache), 0x1234, byteArrayOf(5))
        assertNull(cache.load(key(cache), formats, 1))
        assertEquals(0L, cache.totalBytes())
    }

    @Test fun `a corrupted binary is deleted and a crash mid-write leaves nothing loadable`() {
        val dir = root()
        val cache = ProgramCache(dir, driver, 1 shl 20)
        val k = key(cache)
        cache.store(k, 0x8743, ByteArray(64) { it.toByte() })
        val file = dir.walk().first { it.name.endsWith(".pb") }
        file.writeBytes(file.readBytes().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() })
        assertNull(cache.load(k, formats, 1), "a flipped payload byte reached glProgramBinary")
        assertFalse(file.exists())

        cache.store(k, 0x8743, byteArrayOf(1, 2))
        val truncated = dir.walk().first { it.name.endsWith(".pb") }
        truncated.writeBytes(truncated.readBytes().copyOf(20))
        assertNull(cache.load(k, formats, 1))

        val namespace = dir.listFiles()!!.single()
        File(namespace, "$k.pb.123.tmp").writeBytes(byteArrayOf(1))
        ProgramCache(dir, driver, 1 shl 20)
        assertEquals(emptyList(), namespace.listFiles()!!.filter { it.name.endsWith(".tmp") }.map { it.name })
    }

    @Test fun `past the size cap the least recently used binaries go first`() {
        val cache = ProgramCache(root(), driver, 250)
        val a = key(cache, "a"); val b = key(cache, "b"); val c = key(cache, "c")
        cache.store(a, 0x8743, ByteArray(60)); Thread.sleep(20)
        cache.store(b, 0x8743, ByteArray(60)); Thread.sleep(20)
        assertNotNull(cache.load(a, formats, 1)); Thread.sleep(20) // a is used again: b is now the oldest
        cache.store(c, 0x8743, ByteArray(60))
        assertNull(cache.load(b, formats, 1))
        assertNotNull(cache.load(a, formats, 1)); assertNotNull(cache.load(c, formats, 1))
        assertTrue(cache.totalBytes() <= 250)
    }

    @Test fun `the cache refuses a key that is not a sha256`() {
        val cache = ProgramCache(root(), driver, 1 shl 20)
        assertFailsWith<IllegalArgumentException> { cache.store("../../escape", 1, byteArrayOf(1)) }
    }
}

class ProgramBuilderTest {
    private val driver = DriverIdentity("Fake Mali-G615", "OpenGL ES 3.2 fake", 21L)

    private class Worker(dir: File, driver: DriverIdentity) {
        val group = FakeShareGroup()
        val gl = FakeGl3(group, "worker")
        val cache = ProgramCache(dir, driver, 1 shl 20)
        val builder = ProgramBuilder(gl, cache, CoreRig.VIEW_BLOCK, 0)
        fun build(name: String = "rm-map", fs: String = CoreRig.FS) = ProgramJob(name, CoreRig.VS, fs).also { builder.build(it) }
    }

    @Test fun `a cold build links from source, keeps the binary and the next entry loads it without compiling`() {
        val dir = Files.createTempDirectory("programs").toFile()
        val first = Worker(dir, driver)
        val cold = first.build()
        assertEquals(ProgramJob.BUILT, cold.state)
        assertFalse(cold.fromCache)
        assertTrue(first.group.program(cold.program)!!.retrievable, "GL_PROGRAM_BINARY_RETRIEVABLE_HINT must be set before link")
        assertNotEquals(0L, cold.fence, "the GL thread adopts only after a fence")

        val second = Worker(dir, driver) // the next World entry: a new context, same driver
        val warm = second.build()
        assertEquals(ProgramJob.BUILT, warm.state)
        assertTrue(warm.fromCache)
        assertEquals(0, second.gl.calls("compileShader"), "a cached program must not compile again")
    }

    @Test fun `a binary the driver rejects is deleted and the program rebuilt from source`() {
        val dir = Files.createTempDirectory("programs").toFile()
        Worker(dir, driver).build()
        val updated = Worker(dir, driver) // same GL_RENDERER / GL_VERSION strings, but the driver now rejects the binary
        updated.group.driverToken = "mali-g615-r48"
        val job = updated.build()
        assertEquals(ProgramJob.BUILT, job.state)
        assertFalse(job.fromCache)
        assertEquals(2, updated.gl.calls("compileShader"))
        val again = Worker(dir, driver).also { it.group.driverToken = "mali-g615-r48" }.build()
        assertTrue(again.fromCache, "the rebuilt binary replaced the rejected one")
    }

    @Test fun `a rejected binary is deleted even when the rebuilt program's binary cannot be kept`() {
        val dir = Files.createTempDirectory("programs").toFile()
        Worker(dir, driver).build()
        val updated = Worker(dir, driver).apply { group.driverToken = "mali-g615-r48"; group.binaryRetrievable = false }
        assertEquals(ProgramJob.BUILT, updated.build().state)
        assertEquals(0L, updated.cache.totalBytes(), "a binary the driver rejected would be retried, and fail, on every entry")
    }

    @Test fun `a compile error fails the job with the shader log and publishes no fence`() {
        val worker = Worker(Files.createTempDirectory("programs").toFile(), driver)
        val job = worker.build(fs = "#error broken\n" + CoreRig.FS)
        assertEquals(ProgramJob.FAILED, job.state)
        assertTrue(job.error!!.contains("fs:"), job.error)
        assertEquals(0L, job.fence)
        assertEquals(0L, worker.cache.totalBytes())
    }

    /**
     * The host's wake rides on the job, not on each compiler, so every way a build can end wakes it: the builder's
     * BUILT and FAILED, and a compiler that writes FAILED itself when its worker is gone (`:app`'s
     * `SharedContextCompiler.CompileTask.unavailable`). The wake runs after the state is visible, so the frame it brings
     * sees the outcome; a queued job never wakes anyone.
     */
    @Test fun `every end of a build wakes the host after its state is visible, whoever publishes it`() {
        val worker = Worker(Files.createTempDirectory("programs").toFile(), driver)
        val seen = ArrayList<Int>()
        fun job(fs: String = CoreRig.FS) = ProgramJob("rm-map", CoreRig.VS, fs).also { j -> j.onSettled = Runnable { seen += j.state } }
        worker.builder.build(job())
        worker.builder.build(job(fs = "#error broken\n" + CoreRig.FS))
        val gone = job()
        gone.state = ProgramJob.QUEUED
        gone.error = "realm program rm-map: worker context lost"; gone.state = ProgramJob.FAILED // what a compiler does
        assertEquals(listOf(ProgramJob.BUILT, ProgramJob.FAILED, ProgramJob.FAILED), seen)

        val abandoned = job().apply { onSettled = null } // Gl3Core clears it on restore and dispose
        worker.builder.build(abandoned)
        assertEquals(3, seen.size, "an abandoned job wakes nobody")
    }

    @Test fun `without binary formats the builder links from source and caches nothing`() {
        val worker = Worker(Files.createTempDirectory("programs").toFile(), driver)
        worker.group.binaryFormats = IntArray(0)
        val job = worker.build()
        assertEquals(ProgramJob.BUILT, job.state)
        assertEquals(0L, worker.cache.totalBytes())
        assertFalse(worker.group.program(job.program)!!.retrievable)
    }
}
