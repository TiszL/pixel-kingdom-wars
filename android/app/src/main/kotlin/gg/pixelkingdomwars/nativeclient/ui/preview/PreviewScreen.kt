package gg.pixelkingdomwars.nativeclient.ui.preview

import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.data.LaunchMode
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.ui.displayClock
import gg.pixelkingdomwars.nativeclient.ui.kingdom.ArmyChipHits
import gg.pixelkingdomwars.nativeclient.ui.kingdom.ArmyChipLayer
import gg.pixelkingdomwars.nativeclient.ui.kingdom.ArmyChipScene
import gg.pixelkingdomwars.nativeclient.ui.kingdom.armyChips
import gg.pixelkingdomwars.nativeclient.scene.SceneMapper
import gg.pixelkingdomwars.nativeclient.scene.SceneSurface
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.battle.ReplayScreen
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.serialization.json.JsonObject

/** Debug-only offline fixture preview (`--es preview base|battle`): no account, wallet or network. */
class PreviewViewModel(private val graph: AppGraph) : ScreenViewModel() {
    val content = graph.content.state.stateIn(viewModelScope, SharingStarted.Eagerly, graph.content.state.value)
    private val _fixture = MutableStateFlow<Pair<JsonObject, JsonObject?>?>(null)
    val fixture = _fixture
    val mode: LaunchMode get() = graph.mode
    init { load() }
    fun load() = run { _fixture.value = graph.content.loadPreviewFixtures() }
}

@Composable fun PreviewScreen(model: PreviewViewModel) {
    val content by model.content.collectAsState(); val fixture by model.fixture.collectAsState()
    val busy by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    val assets = content.assets; val catalogue = content.catalogue; val render = content.renderCatalogue
    val replay = fixture?.second
    if (model.mode == LaunchMode.OFFLINE_BATTLE && replay != null) { ReplayScreen(content, replay, preview = true) {}; return }
    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        Text("Offline fixture preview · No account, network gameplay or spending", Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall, color = Palette.gold)
        notice?.let { Text(it.message, Modifier.padding(12.dp), color = MaterialTheme.colorScheme.error) }
        val base = fixture?.first
        if (model.mode == LaunchMode.OFFLINE_BASE && base != null && assets != null && catalogue != null && render != null) {
            val options = PreviewOptions.current
            val scene = remember(base, catalogue, render, options) { runCatching {
                val (decorated, health) = PreviewFixtures.decorate(base, render, options, System.currentTimeMillis())
                SceneMapper(catalogue, render).baseScene(decorated, health) to decorated.takeIf { options.army != null }?.let(BaseSnapshot::from)
            } }
            scene.getOrNull()?.let { (mapped, army) -> Box(Modifier.weight(1f).fillMaxWidth()) {
                val camera = remember { mutableStateOf<BaseCameraView?>(null) }
                SceneSurface(assets, mapped, Modifier.fillMaxSize(), performance = true, baseCamera = camera)
                // The production layer and planner over the synthetic status: the chip states without an account.
                if (army != null) ArmyChipLayer(armyChips(army, displayClock(), ArmyChipScene(home = true)), mapped, assets, render, camera, remember { ArmyChipHits() }, Modifier.fillMaxSize())
            } } ?: Text(scene.exceptionOrNull()?.message ?: "Fixture unavailable", Modifier.padding(24.dp))
        } else Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(if (busy) "Loading bundled artwork and fixture data." else "The fixture could not load. This session cannot access wallets or accounts.")
            TextButton(onClick = model::load, enabled = !busy) { Text("Retry offline fixture") }
        }
    }
}
