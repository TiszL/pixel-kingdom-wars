package gg.pixelkingdomwars.nativeclient.content

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption

/** Process-wide GL ownership, independent of the updater's currently selected generation.
 * Acquisition only checks directory/receipt metadata; verified content hashing stays on IO. */
object SceneContentLeases {
    private val leases = mutableMapOf<String, Int>()

    @Synchronized fun acquire(root: File, directory: File): ContentLease {
        val key = checkedPath(root,directory)
        check(Files.isDirectory(directory.toPath(),LinkOption.NOFOLLOW_LINKS) &&
            Files.isRegularFile(File(directory,".verified").toPath(),LinkOption.NOFOLLOW_LINKS)) {
            "Downloaded artwork is unavailable; reload the scene"
        }
        leases[key] = (leases[key] ?: 0) + 1
        return ContentLease(directory) { synchronized(this) {
            val remaining = requireNotNull(leases[key]) - 1
            if (remaining == 0) leases.remove(key) else leases[key] = remaining
        } }
    }

    /** Existence check/acquisition cannot race this deletion. The callback must not acquire
     * updater or store locks; ContentStore calls this while already holding its own lock. */
    @Synchronized internal fun pruneIfUnleased(root: File, directory: File, prune: () -> Unit) {
        val key = checkedPath(root,directory)
        if ((leases[key] ?: 0) == 0) prune()
    }

    private fun checkedPath(root: File, directory: File): String {
        require(directory.name.matches(Regex("[a-f0-9]{64}"))) { "Invalid content generation" }
        require(directory.absoluteFile.normalize().parentFile == root.absoluteFile.normalize()) { "Content generation escapes root" }
        require(!Files.isSymbolicLink(root.toPath()) && !Files.isSymbolicLink(directory.toPath())) { "Content generation symlink rejected" }
        require(directory.canonicalFile.parentFile == root.canonicalFile) { "Content generation escapes root" }
        return directory.canonicalPath
    }
}
