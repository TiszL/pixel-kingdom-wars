package gg.pixelkingdomwars.nativeclient.ui.more

import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.NoteLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipStrip
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteCardPage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteNoticeRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag

import android.graphics.Bitmap
import android.webkit.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import java.io.ByteArrayInputStream
import kotlinx.coroutines.*

@OptIn(ExperimentalLayoutApi::class)
@Composable fun AboutScreen(repository: LegalRepository, wallet: String?, onBack: () -> Unit, embedded: Boolean = false) {
    val state by repository.state.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle; val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current; val clipboard = LocalClipboardManager.current
    var document by rememberSaveable { mutableStateOf(LegalDocument.TERMS) }
    var expanded by rememberSaveable { mutableStateOf(false) }
    var detailsOpen by rememberSaveable { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableStateOf<Job?>(null) }
    val controlsScroll = rememberScrollState()
    fun back() { refresh?.cancel(); repository.close(); onBack() }
    fun external(url: String) { notice = runCatching { uri.openUri(url); null }.getOrElse { "No app could open this link: $url" } }
    fun copy(value: String, message: String) {
        notice = runCatching { clipboard.setText(AnnotatedString(value)); message }.getOrElse { "Copy failed. Long-press the visible address." }
    }
    fun reload() { refresh?.cancel(); refresh = scope.launch { repository.load(document, true) } }
    BackHandlerAt(BackPriority.SCREEN) { if (expanded) expanded = false else back() }
    DisposableEffect(repository) { onDispose { refresh?.cancel(); repository.close() } }
    LaunchedEffect(repository, document, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { repository.load(document) }
    }
    LaunchedEffect(state.error) { if (state.error != null) controlsScroll.scrollTo(0) }
    // Owner 2026-10-06 ("UI unfinished"): the old dark About column is the designed card ([RouteCardPage], hub
    // settings-help.png's ABOUT / TERMS family). The reader, the repository, every link and every line are unchanged.
    RouteCardPage(if (expanded) document.label.uppercase() else "ABOUT, LEGAL & SUPPORT", null,
        onClose = { if (expanded) expanded = false else back() }, scrolls = false) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val controlsMaxHeight = if (state.html != null) maxHeight * .6f else maxHeight
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                // Bound the complete toolbar to the card, including recovery notices; one scroller keeps every utility
                // reachable while leaving space for the full document.
                Column(Modifier.fillMaxWidth().heightIn(max = controlsMaxHeight)
                    .verticalScroll(controlsScroll), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    state.error?.let {
                        RouteNoticeRow(it + if (state.html != null) " Previously loaded text is still shown." else "", error = true,
                            retrying = state.loading, onRetry = ::reload)
                    }
                    if (!expanded) {
                        FilterChipStrip(LegalDocument.entries.map { entry ->
                            FilterChipUi(entry.name, if (entry == LegalDocument.TERMS) "TERMS" else "PRIVACY", description = entry.label)
                        }, selected = document.name, onSelect = { id ->
                            LegalDocument.entries.firstOrNull { it.name == id }?.let { refresh?.cancel(); document = it }
                        })
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            SecondaryButton("OPEN IN BROWSER", { external(document.url) }, Modifier.weight(1f), verb = Verb.BLUE)
                            SecondaryButton("EXPAND READER", { expanded = true }, Modifier.weight(1f))
                        }
                        NoteLine("Open in your browser to follow links.")
                        QuietButton(if (detailsOpen) "DETAILS & SUPPORT −" else "DETAILS & SUPPORT +", { detailsOpen = !detailsOpen }, onParchment = true)
                        if (detailsOpen) {
                            gg.pixelkingdomwars.nativeclient.diagnostics.LocalReportControls()
                            SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                NoteLine("Version ${BuildConfig.VERSION_NAME}")
                                NoteLine("Android build ${BuildConfig.NATIVE_BUILD_SHA}")
                                NoteLine(document.url)
                            } }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                SecondaryButton("COPY LINK", { copy(document.url, "Document link copied.") }, Modifier.weight(1f))
                                SecondaryButton("RELOAD", ::reload, Modifier.weight(1f), enabled = !state.loading)
                            }
                            SelectionContainer { NoteLine(GameSupport.EMAIL) }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                SecondaryButton("EMAIL SUPPORT", { external(GameSupport.mailto(wallet)) }, Modifier.weight(1f), verb = Verb.BLUE)
                                SecondaryButton("COPY ADDRESS", { copy(GameSupport.EMAIL, "Support address copied.") }, Modifier.weight(1f))
                            }
                            SecondaryButton("DISCORD", { external(GameSupport.DISCORD) }, Modifier.fillMaxWidth(), verb = Verb.BLUE)
                        }
                    }
                    notice?.let { SelectionContainer { RouteNoticeRow(it) } }
                    if (state.loading) StatusTag("LOADING", Verb.STONE, dots = true)
                    if (state.html == null && !state.loading && state.error == null) SecondaryButton("RETRY DOCUMENT", ::reload, Modifier.fillMaxWidth())
                }
                if (state.document == document) state.html?.let { html ->
                    StaticLegalReader(html, document.title, Modifier.weight(1f).fillMaxWidth())
                }
            }
        }
    }
}

/** Static bytes only. No loadUrl, cookies, JS bridge, file/content access, subresource network,
 * popup, form or in-reader navigation. Global WebView/Privy settings are never touched. */
@Composable private fun StaticLegalReader(html: String, title: String, modifier: Modifier) {
    val scale = LocalConfiguration.current.fontScale
    val content = remember(html) { legalReaderHtml(html) }
    key(content) {
        AndroidView<android.view.View>(modifier = modifier, factory = { context ->
            try { WebView(context).apply {
                settings.apply {
                    javaScriptEnabled = false; javaScriptCanOpenWindowsAutomatically = false
                    domStorageEnabled = false; databaseEnabled = false
                    allowFileAccess = false; allowContentAccess = false
                    @Suppress("DEPRECATION")
                    allowFileAccessFromFileURLs = false
                    @Suppress("DEPRECATION")
                    allowUniversalAccessFromFileURLs = false
                    blockNetworkLoads = true; blockNetworkImage = true; loadsImagesAutomatically = false
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW; cacheMode = WebSettings.LOAD_NO_CACHE
                    setSupportMultipleWindows(false); setGeolocationEnabled(false)
                    builtInZoomControls = true; displayZoomControls = false; setSupportZoom(true)
                }
                isSaveEnabled = false
                accessibilityPaneTitle = title
                setDownloadListener { _, _, _, _, _ -> }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                    @Suppress("DEPRECATION") override fun shouldOverrideUrlLoading(view: WebView?, url: String?) = true
                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?) =
                        WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                        if (url != "about:blank") view?.stopLoading()
                    }
                }
                loadDataWithBaseURL(null, content, "text/html", "UTF-8", null)
            } } catch (_: Exception) {
                android.widget.TextView(context).apply {
                    text = context.getString(gg.pixelkingdomwars.nativeclient.R.string.legal_renderer_unavailable)
                    setTextColor(android.graphics.Color.WHITE); textSize = 16f
                }
            }
        }, update = { view -> if (view is WebView) view.settings.textZoom = (scale * 100).toInt() },
            onRelease = { view -> if (view is WebView) { view.stopLoading(); view.removeAllViews(); view.destroy() } })
    }
}
