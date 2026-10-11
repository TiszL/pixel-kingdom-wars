package gg.pixelkingdomwars.nativeclient.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

/** Non-exported: only the platform installer, through this app's own PendingIntent, reports session status here. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val confirmation = if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) null
            else if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
        val prompt = confirmation?.let { SystemPrompt { launcher -> launcher.startActivity(it) } }
        NativeUpdateRuntime.repository?.onInstallEvent(installEvent(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE), prompt))
    }
}
