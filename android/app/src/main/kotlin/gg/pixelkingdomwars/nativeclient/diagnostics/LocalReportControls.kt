package gg.pixelkingdomwars.nativeclient.diagnostics

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Switch

@Composable fun LocalReportControls() {
    val state by LocalBattleReports.status.collectAsState()
    if (!state.enabled) {
        state.message?.let { message ->
            Text(message, style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = LocalBattleReports::clear) { Text("CLEAR LOCAL REPORTS") }
        }
        return
    }
    var raw by remember { mutableStateOf(false) }
    var permit by remember { mutableStateOf<LocalExportPermit?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val admitted = permit; permit = null
        if (uri != null && admitted != null) LocalBattleReports.export(uri, admitted)
    }
    Column(Modifier.fillMaxWidth()) {
        Text("LOCAL BATTLE REPORTS · ${state.records} records", style = MaterialTheme.typography.titleSmall)
        Text("Saved here for 7 days. Export only when you want to share them. Exit history may include older builds with unknown origin.", style = MaterialTheme.typography.bodySmall)
        Text("Include optional Android traces", style = MaterialTheme.typography.bodyMedium)
        Switch(checked = raw, onCheckedChange = { raw = it }, enabled = !state.busy, modifier = Modifier.semantics { contentDescription = "Include optional Android traces" })
        if (raw) Text("Raw traces can contain private app data and thread stacks. Check the exported file before sharing. They stay on this device until you export them.", style = MaterialTheme.typography.bodySmall)
        OutlinedButton(onClick = { LocalBattleReports.inspectHistory(raw) }, enabled = !state.busy) { Text("CHECK RECENT EXIT HISTORY") }
        OutlinedButton(onClick = { permit = LocalBattleReports.exportPermit(raw); launcher.launch("pixel-kingdom-wars-local-report.zip") }, enabled = !state.busy) { Text("EXPORT LOCAL REPORT") }
        TextButton(onClick = LocalBattleReports::clear) { Text("CLEAR LOCAL REPORTS") }
        state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}
