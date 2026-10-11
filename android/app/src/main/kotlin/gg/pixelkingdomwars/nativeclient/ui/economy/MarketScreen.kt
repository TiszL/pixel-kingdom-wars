package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.FilterChip
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.ui.attack.shortWallet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.*
import kotlinx.serialization.json.JsonObject

class MarketViewModel(private val repository: MarketRepository, private val images: WorldDeedPreview? = null,
    val trades: MarketTradeViewModel? = null) : ScreenViewModel() {
    val state = repository.state
    private var foreground = false
    private var foregroundEpoch = 0
    private var initialApplied = false
    suspend fun foreground(initialItemId: String?) {
        foreground = true; foregroundEpoch++
        try {
            val query = if (!initialApplied) MarketQuery(initialItemId) else state.value.query
            initialApplied = true
            repository.refresh(query)
            awaitCancellation()
        } finally { foreground = false; foregroundEpoch++ }
    }
    fun refresh() = run { repository.refresh(); trades?.refresh() }
    fun filter(itemId: String?) = run { repository.refresh(state.value.query.copy(itemId = itemId)) }
    fun sort(sort: MarketSort) = run { repository.refresh(state.value.query.copy(sort = sort)) }
    fun open(market: ExternalMarket, assetId: String?, navigate: (String) -> Unit) = run {
        check(foreground); val epoch = foregroundEpoch
        val link = repository.externalLink(market, assetId)
        repository.requireCurrent()
        check(foreground && foregroundEpoch == epoch) { "Return to Market, then open the marketplace again." }
        navigate(link)
    }
    suspend fun artwork(asset: CoreMarketAsset, valid: (ByteArray) -> Boolean): ByteArray {
        val epoch = foregroundEpoch
        fun current() {
            repository.requireCurrent()
            check(foreground && foregroundEpoch == epoch && MarketRepository.ASSETS in state.value.fresh &&
                state.value.assets?.assets?.any { it.id == asset.id && it.image == asset.image } == true) { "The asset view changed." }
        }
        current()
        val bytes = requireNotNull(images).loadImage(requireNotNull(asset.image), valid)
        current(); return bytes
    }
}

/** The two existing market lanes remain distinct: SOL item offers and externally traded Core assets.
 * Layout mirrors web menu.tsx ItemMarketTab / MarketScreen: MARKET | COLLECTION tab plates, a floor rail of
 * item plates, listing cubes, then your listings; every gate and enable rule below is unchanged. */
@Composable fun MarketScreen(model: MarketViewModel, wallet: String, catalogue: JsonObject?, landOwned: Boolean,
    initialItemId: String?, onInventory: () -> Unit, onLand: () -> Unit, onBack: () -> Unit,
    purchaseWallet: MarketPurchaseWallet? = null) {
    val state by model.state.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    var collectionTab by rememberSaveable(wallet) { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val uri = LocalUriHandler.current
    val tradeState = model.trades?.state?.collectAsState()?.value ?: MarketTradeState()
    val tradeBounds = remember(catalogue) { MarketTradeBounds.from(catalogue) }
    val definitions = (catalogue?.get("constants") as? JsonObject)?.get("ITEMS") as? JsonObject
    fun itemName(id: String) = (definitions?.get(id) as? JsonObject)?.string("name") ?: id
    fun itemAsset(id: String) = (definitions?.get(id) as? JsonObject)?.string("asset")
    BackHandlerAt(BackPriority.SCREEN) { onBack() }
    LaunchedEffect(model, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(initialItemId) } }
    LaunchedEffect(model.trades, tradeBounds, lifecycle) { model.trades?.let { trade -> lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { trade.foreground(tradeBounds, ::itemName) } } }
    val loading = state.loading || busy || tradeState.busy
    // Second old-screen sweep (owner 2026-10-06): the Market's saved-purchase (original request) owner on the designed page.
    // The list is lazy, so the page hands it the bounded height; REFRESH is the quiet link above the tabs.
    DesignedPage("MARKET", onBack, scrollState = null) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            GameArt("shards", Modifier.size(22.dp))
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { model.refresh() }, enabled = !loading) { Text("REFRESH", style = MaterialTheme.typography.labelMedium) }
        }
        PlateTabs(listOf(false to "MARKET", true to "COLLECTION"), collectionTab) { collectionTab = it }
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            notice?.let { DismissableNotice(it.message, it.error, model::dismissNotice) }
        }
        val relevantPaths = if (collectionTab) setOf(MarketRepository.COLLECTION, MarketRepository.ASSETS) else setOf(MarketRepository.BOOK, MarketRepository.OWN)
        items(state.errors.filterKeys { it in relevantPaths }.entries.toList(), key = { it.key }) { (_, message) -> Notice("$message Previously shown values may be out of date.", true) }
        if (!collectionTab) {
            val book = state.book
            val floors = book?.summary.orEmpty().associate { it.itemId to it.floorLamports }
            item {
                // Web LAND_LOCKED.market Chip: not a dead notice — tapping it opens the land pitch.
                if (!landOwned) PlateRow("BROWSE FREELY · BUY LAND TO TRADE", "sol", note = "New item sales and purchases require a Land Deed.", accent = true, onClick = onLand)
                if (model.trades == null) Notice("Buying, listing and cancelling item trades are currently available in the web game.")
            }
            model.trades?.let { trade -> item { MarketTradePanel(trade, tradeState, wallet, tradeBounds, purchaseWallet, ::itemName, ::itemAsset, state.book?.feeBps) } }
            item {
                Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("FLOOR PRICES", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = SurfaceInk.gold)
                    book?.let { Text("${marketPercent(it.feeBps)}% FEE · SELLER GETS ${marketPercent(10_000 - it.feeBps)}%", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint) }
                }
            }
            if (book?.summary?.isEmpty() == true) item { EmptyPlate("NOTHING LISTED RIGHT NOW. LIST ONE OF YOUR STORED ITEMS TO OPEN THE MARKET.") }
            items(book?.summary.orEmpty(), key = { "floor:${it.itemId}" }) { floor ->
                val active = state.query.itemId == floor.itemId
                PixelPlate("shard", Modifier.fillMaxWidth().heightIn(min = 52.dp).alpha(if (loading) .6f else 1f)
                    .then(if (active) Modifier.border(2.dp, SurfaceInk.gold) else Modifier).semantics { selected = active }
                    .clickable(enabled = !loading, role = Role.Button, interactionSource = remember { MutableInteractionSource() }, indication = null) {
                        model.filter(if (active) null else floor.itemId)
                    }, PaddingValues(horizontal = 10.dp, vertical = 6.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ItemArt(itemAsset(floor.itemId), Modifier.size(30.dp))
                        Column(Modifier.weight(1f)) {
                            Text(itemName(floor.itemId), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${floor.listed} LISTED", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint)
                        }
                        GameArt("sol", Modifier.size(14.dp)); Text(marketSol(floor.floorLamports), style = MaterialTheme.typography.titleSmall, color = SurfaceInk.goldHi)
                        Text(if (active) "▾" else "▸", color = if (active) SurfaceInk.gold else SurfaceInk.faint, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            item {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(state.query.itemId == null, { model.filter(null) }, enabled = !loading, label = { Text("ALL") })
                    MarketSort.entries.forEach { sort -> FilterChip(state.query.sort == sort, { model.sort(sort) }, enabled = !loading, label = { Text(sort.label.uppercase()) }) }
                }
                val count = book?.offers?.size
                Text(state.query.itemId?.let { "${itemName(it).uppercase()}${count?.let { n -> " · $n" } ?: ""}" } ?: "ALL LISTINGS${count?.let { " · $it" } ?: ""}",
                    style = MaterialTheme.typography.labelMedium, color = SurfaceInk.gold)
            }
            if (book?.offers?.isEmpty() == true) item { EmptyPlate(if (state.query.itemId != null) "NO LISTINGS FOR THIS ITEM." else "NO LISTINGS.") }
            item {
                BoxWithConstraints(Modifier.fillMaxWidth()) {
                    val columns = ((maxWidth.value + 8) / 126).toInt().coerceAtLeast(1)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        book?.offers.orEmpty().chunked(columns).forEach { row ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                row.forEach { offer ->
                                    val mine = offer.seller == wallet
                                    val tag = marketFloorTag(offer.priceLamports, floors[offer.itemId], mine)
                                    PixelPanel(Modifier.weight(1f).then(if (tag.atFloor) Modifier.border(2.dp, SurfaceInk.gold) else Modifier)) {
                                    Column(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        ItemArt(itemAsset(offer.itemId), Modifier.size(44.dp))
                                        Text(itemName(offer.itemId), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        Text(tag.text, style = MaterialTheme.typography.labelSmall, color = if (mine) SurfaceInk.gold else if (tag.atFloor) SurfaceInk.success else SurfaceInk.faint)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                    GameArt("sol", Modifier.size(14.dp)); Text(marketSol(offer.priceLamports), style = MaterialTheme.typography.titleSmall, color = SurfaceInk.goldHi)
                }
                var details by remember(offer.id) { mutableStateOf(false) }
                model.trades?.let { trade -> if (!mine && tradeState.supported) {
                    if (!landOwned) TextButton(onClick = onLand, modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 4.dp, vertical = 6.dp)) { Text("NEEDS LAND", style = MaterialTheme.typography.labelSmall) }
                    else Button(onClick = { trade.reviewPurchase(offer) }, enabled = !loading && landOwned &&
                        MarketRepository.BOOK in state.fresh && tradeState.saved?.attempted != true &&
                        tradeState.blocking.none { it.kind == gg.pixelkingdomwars.nativeclient.ops.IntentKind.MARKET_RESERVE }, modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 4.dp, vertical = 6.dp)) { Text("BUY", style = MaterialTheme.typography.labelMedium) }
                } }
                TextButton(onClick = { details = !details }, contentPadding = PaddingValues(0.dp), modifier = Modifier.fillMaxWidth()) { Text(if (details) "HIDE DETAILS" else "DETAILS", style = MaterialTheme.typography.labelSmall) }
                if (details) {
                (definitions?.get(offer.itemId) as? JsonObject)?.string("desc")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted) }
                Text(if (mine) "Your listing" else "Seller: ${shortWallet(offer.seller)}", style = MaterialTheme.typography.bodySmall)
                Text("Source: ${offer.baseId?.let { "Land Deed $it" } ?: "wallet custody"}", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
                floors[offer.itemId]?.let { floor -> Text("Server floor: ${marketSol(floor)} SOL", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted) }
                SelectionContainer { Text("Listing: ${offer.id}", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint) }
                }
                                    } }
                                }
                                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                            }
                        }
                    }
                }
            }
            item { Text("YOUR OPEN LISTINGS", Modifier.padding(top = 4.dp), style = MaterialTheme.typography.labelMedium, color = SurfaceInk.gold)
            }
            if (state.own?.isEmpty() == true) item { EmptyPlate("YOU HAVE NO OPEN LISTINGS.") }
            items(state.own.orEmpty(), key = { "own:${it.id}" }) { listing ->
                TitledPlate(itemName(listing.itemId), art = itemAsset(listing.itemId) ?: "bag", note = if (listing.status == "reserved") "RESERVED" else "LIVE") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        GameArt("sol", Modifier.size(14.dp)); Text("${marketSol(listing.priceLamports)} SOL", style = MaterialTheme.typography.titleSmall, color = SurfaceInk.goldHi)
                        Text(if (listing.status == "reserved") "· a buyer is paying" else "· live on the book", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
                    }
                    var details by remember(listing.id) { mutableStateOf(false) }
                    model.trades?.let { trade -> if (tradeState.supported) {
                        OutlinedButton(onClick = { trade.reviewCancellation(listing.id) }, modifier = Modifier.fillMaxWidth(), enabled = !loading && landOwned &&
                            MarketRepository.OWN in state.fresh && tradeState.blocking.none { it.kind == gg.pixelkingdomwars.nativeclient.ops.IntentKind.MARKET_CANCEL }) { Text("CANCEL LISTING") }
                    } }
                    TextButton(onClick = { details = !details }, contentPadding = PaddingValues(0.dp), modifier = Modifier.fillMaxWidth()) { Text(if (details) "HIDE DETAILS" else "DETAILS", style = MaterialTheme.typography.labelSmall) }
                    if (details) {
                        Text("Source: ${listing.baseId?.let { "Land Deed $it" } ?: "wallet custody"}", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
                        SelectionContainer { Text("Listing: ${listing.id}", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint) }
                    }
                }
            }
            item { OutlinedButton(onClick = onInventory, modifier = Modifier.fillMaxWidth()) { GameArt("bag", Modifier.size(20.dp)); Text("OPEN INVENTORY") } }
        } else {
            val collection = state.collection; val assets = state.assets
            val collectionFresh = MarketRepository.COLLECTION in state.fresh
            item {
                Text("Your kingdom's on-chain assets — Land Deeds now, cosmetics later. They are real Metaplex Core NFTs that trade on external marketplaces; the deed royalty is separate from the in-game item-market fee.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.faint)
                collection?.let { col ->
                    val open = col.tradingEnabled
                    PixelPlate("shard", Modifier.fillMaxWidth().padding(top = 8.dp).then(if (open) Modifier.border(2.dp, SurfaceInk.gold) else Modifier), PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            GameArt(if (open) "keep" else "shield", Modifier.size(20.dp))
                            Text(if (open) "TRADING LIVE" else "SOULBOUND — TRADING OPENS AT LAUNCH", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = if (open) SurfaceInk.success else SurfaceInk.muted)
                            Text("${marketPercent(col.royaltyBps)}% ROYALTY", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint)
                        }
                    }
                }
                if (collection?.collection == null && collectionFresh) EmptyPlate("NO DEED COLLECTION IS CONFIGURED ON THIS SERVER.")
                collection?.collection?.let { id -> TitledPlate("LAND DEEDS COLLECTION", Modifier.padding(top = 8.dp), note = shortWallet(id)) {
                    SelectionContainer { Text(id, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint) }
                    ExternalMarketButtons(enabled = !loading && collectionFresh && collection.tradingEnabled, open = { model.open(it, null, uri::openUri) }) } }
                Text("MY ASSETS", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.labelMedium, color = SurfaceInk.gold)
            }
            if (assets?.assets?.isEmpty() == true) item { EmptyPlate("NO CORE ASSETS WERE RETURNED FOR THIS WALLET.") }
            items(assets?.assets.orEmpty(), key = { "asset:${it.id}" }) { asset -> TitledPlate(asset.name, note = "${if (asset.kind == "deed") "LAND DEED" else "COSMETIC"}${if (asset.frozen) " · SOULBOUND" else ""}") {
                if (asset.image != null) MarketArtwork(model, asset, MarketRepository.ASSETS in state.fresh)
                SelectionContainer { Text(asset.id, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint) }
                ExternalMarketButtons(enabled = !loading && collectionFresh && MarketRepository.ASSETS in state.fresh &&
                    collection?.tradingEnabled == true && assets?.tradingEnabled == true && !asset.frozen,
                    open = { model.open(it, asset.id, uri::openUri) })
            } }
            if (assets?.dasConfigured == false) item { Text("Live asset discovery is not configured; this view can include the server's recorded Land Deed.", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint) }
        }
    }
    }
    model.trades?.let { MarketTradeDialogs(it, tradeState, purchaseWallet, ::itemName, ::itemAsset, state.book?.feeBps) }
}

@Composable private fun MarketArtwork(model: MarketViewModel, asset: CoreMarketAsset, fresh: Boolean) {
    var attempt by remember(asset.id, asset.image) { mutableIntStateOf(0) }
    val bitmap by produceState<android.graphics.Bitmap?>(null, model, asset.id, asset.image, fresh, attempt) {
        value = null
        if (fresh) try {
            val bytes = model.artwork(asset) { data ->
                val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
                bounds.outWidth in 1..4096 && bounds.outHeight in 1..4096
            }
            value = withContext(Dispatchers.Default) {
                val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                val options = android.graphics.BitmapFactory.Options().apply { inSampleSize = (maxOf(bounds.outWidth, bounds.outHeight) / 512).coerceAtLeast(1) }
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* The row remains usable if this public image is unavailable. */ }
    }
    bitmap?.let { Image(it.asImageBitmap(), "${asset.name} artwork", Modifier.size(44.dp)) }
        ?: TextButton(onClick = { attempt++ }, enabled = fresh) { Text("RETRY ARTWORK") }
}

@Composable private fun ExternalMarketButtons(enabled: Boolean, open: (ExternalMarket) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { ExternalMarket.entries.forEach { market ->
        OutlinedButton(onClick = { open(market) }, enabled = enabled) { Text("${market.label.uppercase()} ↗") }
    } }
}
