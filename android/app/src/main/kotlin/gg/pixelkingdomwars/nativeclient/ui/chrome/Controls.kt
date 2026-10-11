@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.chrome

import android.os.Build
import android.view.WindowManager
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.*
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.SheetState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion

/** Web styles.css `.btn` plates. gold = the forged primary (gold fill, ink text, dark bottom edge); sec = the
 * stone secondary (stone fill, #756b59 border, gold text); ghost = text only, underlined while pressed.
 * Disabled is a desaturated grey-stone plate with faint text, never a translucent copy of the live plate. */
private fun Modifier.bevel(variant: String, pressed: Boolean, enabled: Boolean) = drawBehind {
    val b = 2.dp.toPx()
    val inner = Size((size.width - 2*b).coerceAtLeast(0f), (size.height - 2*b).coerceAtLeast(0f))
    when {
        variant == "ghost" -> if (pressed && enabled) drawRect(Palette.gold, Offset(b, size.height - 2*b), Size((size.width - 2*b).coerceAtLeast(0f), b))
        !enabled -> { drawRect(Palette.borderLt); drawRect(Palette.panel, Offset(b, b), inner) }
        variant == "gold" -> {
            drawRect(Palette.ink)
            drawRect(if (pressed) Palette.goldDp else Palette.gold, Offset(b, b), inner)
            if (!pressed) drawRect(Palette.goldHi, Offset(b, b), Size(inner.width, 2.dp.toPx()))
            drawRect(if (pressed) Palette.ink else Palette.goldDp, Offset(b, size.height - b - 4.dp.toPx()), Size(inner.width, 4.dp.toPx()))
        }
        else -> {
            drawRect(Palette.stoneBorder)
            drawRect(if (pressed) Palette.ink else Palette.stone, Offset(b, b), inner)
            drawRect(Palette.ink, Offset(b, size.height - b - 3.dp.toPx()), Size(inner.width, 3.dp.toPx()))
        }
    }
}

/** Web Btn: square 2px border, forged plate, 44dp minimum touch height; caller consent/click/disabled state is unchanged. */
@Composable private fun WebButton(onClick: () -> Unit, modifier: Modifier, enabled: Boolean, variant: String,
    contentPadding: PaddingValues, content: @Composable RowScope.() -> Unit) {
    // Second old-screen sweep (owner 2026-10-06): on a designed surface the same button is the kit chunky face.
    if (onDesignedSurface()) { DesignedChromeButton(onClick, modifier, enabled, variant, contentPadding, content); return }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Row(modifier.defaultMinSize(minWidth=48.dp,minHeight=44.dp).bevel(variant,pressed,enabled).blockSceneInput()
        .clickable(interactionSource=interaction, indication=null, enabled=enabled, role=Role.Button, onClick=onClick)
        .padding(contentPadding), horizontalArrangement=Arrangement.spacedBy(8.dp,Alignment.CenterHorizontally), verticalAlignment=Alignment.CenterVertically) {
        CompositionLocalProvider(LocalContentColor provides when { !enabled -> Palette.textFaint; variant=="gold" -> Palette.ink; else -> Palette.gold }) {
            ProvideTextStyle(MaterialTheme.typography.labelLarge, content={ content() })
        }
    }
}
@Composable fun Button(onClick:()->Unit, modifier:Modifier=Modifier, enabled:Boolean=true,
    contentPadding:PaddingValues=PaddingValues(start=18.dp,top=8.dp,end=18.dp,bottom=12.dp),content:@Composable RowScope.()->Unit) =
    WebButton(onClick,modifier,enabled,"gold",contentPadding,content)
@Composable fun OutlinedButton(onClick:()->Unit, modifier:Modifier=Modifier, enabled:Boolean=true,
    contentPadding:PaddingValues=PaddingValues(start=18.dp,top=8.dp,end=18.dp,bottom=11.dp),content:@Composable RowScope.()->Unit) =
    WebButton(onClick,modifier,enabled,"sec",contentPadding,content)
@Composable fun TextButton(onClick:()->Unit, modifier:Modifier=Modifier, enabled:Boolean=true,
    contentPadding:PaddingValues=PaddingValues(horizontal=10.dp,vertical=6.dp),content:@Composable RowScope.()->Unit) =
    WebButton(onClick,modifier,enabled,"ghost",contentPadding,content)

/** Only painted chrome excludes scene input; transparent space between controls remains playable. */
internal fun Modifier.blockSceneInput() = sceneInputRegion()

/** Web card/Chip. A screen's existing inner padding and content ownership remain at its callsite. */
@Composable fun Card(modifier:Modifier=Modifier,content:@Composable ColumnScope.()->Unit) {
    if (onParchment()) { CreamCard(modifier, content); return }
    Column(modifier.background(Palette.card).border(2.dp,Palette.border).blockSceneInput(), content=content)
}
/** On the designed parchment a card / panel is the kit CREAM plate (ink rim, cream face, 4 dp lip). */
@Composable private fun CreamCard(modifier:Modifier, content:@Composable ColumnScope.()->Unit) {
    gg.pixelkingdomwars.nativeclient.ui.kit.Plate(gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind.CREAM, modifier) {
        Column(Modifier.fillMaxWidth(), content=content)
    }
}
@Composable fun Surface(modifier:Modifier=Modifier,color:Color=Palette.backdrop,content:@Composable ()->Unit) {
    Box(modifier.background(color).blockSceneInput()) { CompositionLocalProvider(LocalContentColor provides Palette.text, content=content) }
}
/** Web Panel9's two gold rivets, slate border and ink outline. */
@Composable fun PixelPanel(modifier:Modifier=Modifier,content:@Composable ColumnScope.()->Unit) {
    if (onParchment()) { CreamCard(modifier, content); return }
    Column(modifier.drawBehind {
        drawRect(Palette.ink)
        val p=2.dp.toPx()
        drawRect(Palette.borderLt,Offset(p,p),Size((size.width-2*p).coerceAtLeast(0f),(size.height-2*p).coerceAtLeast(0f)))
        drawRect(Palette.panel,Offset(2*p,2*p),Size((size.width-4*p).coerceAtLeast(0f),(size.height-4*p).coerceAtLeast(0f)))
    }.drawWithContent {
        drawContent()
        val rivet=6.dp.toPx(); val inset=8.dp.toPx()
        drawRect(Palette.gold,Offset(inset,inset),Size(rivet,rivet))
        drawRect(Palette.gold,Offset(size.width-inset-rivet,inset),Size(rivet,rivet))
    }.blockSceneInput().padding(4.dp), content=content)
}

/** Square game dialog. This owns scrolling; text slots must not add a vertical scroller.
 * On short/large-text viewports the entire panel scrolls, so IME cannot strand consent actions.
 */
@Composable fun AlertDialog(onDismissRequest:()->Unit,confirmButton:@Composable ()->Unit,modifier:Modifier=Modifier,
    dismissButton:(@Composable ()->Unit)?=null,icon:(@Composable ()->Unit)?=null,title:(@Composable ()->Unit)?=null,text:(@Composable ()->Unit)?=null) {
    // Compose 1.7 measures a custom-width dialog against the full display. Its floating window
    // must share those bounds; an excluded cutout would offset that full-height child off-screen.
    Dialog(onDismissRequest,properties=DialogProperties(usePlatformDefaultWidth=false,decorFitsSystemWindows=false)) {
        val window = (LocalView.current.parent as DialogWindowProvider).window
        DisposableEffect(window) {
            val previous = window.attributes.layoutInDisplayCutoutMode
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            onDispose { window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = previous } }
        }
        // Second old-screen sweep (owner 2026-10-06): the dark ink Panel9 dialog is gone. Every dialog is the designed wood
        // frame (DESIGN-SYSTEM §6 ConfirmDialog / kit-2.png SEAL): charcoal title plate, red close square, then the body and
        // the actions on parchment (a caller on a designed page) or on a charcoal plate (a caller still drawing light text).
        // Same slots, same X / scrim / Back dismissal, same scroll rules: the whole panel scrolls on short or large-text
        // viewports so the IME can never strand a consent action.
        val tone = LocalSurfaceTone.current
        BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding().padding(16.dp),contentAlignment=Alignment.Center) {
            val wholePanelScrolls = maxHeight < 360.dp || LocalDensity.current.fontScale > 1.3f
            // Sibling scrim, not a clickable ancestor of consent controls.
            Box(Modifier.matchParentSize().blockSceneInput().pointerInput(onDismissRequest) { detectTapGestures { onDismissRequest() } })
            DesignedDialogPanel(onDismissRequest, confirmButton, modifier.widthIn(max=440.dp).fillMaxWidth().heightIn(max=maxHeight),
                dismissButton, icon, title, text, wholePanelScrolls, parchment = tone == SurfaceTone.PARCHMENT)
        }
    }
}

/** The square close target every framed surface shares (web `.pclose`); semantics "Close" for readers. */
@Composable fun CloseButton(onClick:()->Unit, modifier:Modifier=Modifier, contentDescription:String="Close") {
    Box(modifier.size(44.dp).semantics { this.contentDescription=contentDescription }.blockSceneInput()
        .clickable(interactionSource=remember { MutableInteractionSource() },indication=null,role=Role.Button,onClick=onClick),
        contentAlignment=Alignment.Center) {
        if (onParchment()) gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon("shape:close", 20.dp, tint=gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors.textOnParch2)
        else GameArt("close", Modifier.size(20.dp))
    }
}

/** Keep Compose's IME, Back, modal focus and swipe dismissal behavior; draw the web panel on it. */
@Composable fun ModalBottomSheet(onDismissRequest:()->Unit,modifier:Modifier=Modifier,
    sheetState:SheetState=rememberModalBottomSheetState(),content:@Composable ColumnScope.()->Unit) {
    androidx.compose.material3.ModalBottomSheet(onDismissRequest=onDismissRequest,modifier=modifier,sheetState=sheetState,
        shape=RectangleShape,containerColor=Color.Transparent,contentColor=Palette.text,tonalElevation=0.dp,dragHandle=null) {
        PixelPlate("keep", Modifier.fillMaxWidth(), PaddingValues(4.dp)) { Column(Modifier.fillMaxWidth()) {
            // Drag handle plus an X: the sheet is always dismissable by swipe, Back, scrim or tap.
            Box(Modifier.fillMaxWidth().background(Palette.ink)) {
                Box(Modifier.align(Alignment.Center).padding(top=8.dp).size(40.dp,4.dp).background(Palette.goldDp))
                CloseButton(onDismissRequest, Modifier.align(Alignment.CenterEnd))
            }
            content()
        } }
    }
}

/** Web forms use a fixed label above a square field, never a floating Material label. */
@Composable fun OutlinedTextField(value:String,onValueChange:(String)->Unit,modifier:Modifier=Modifier,enabled:Boolean=true,readOnly:Boolean=false,
    textStyle:TextStyle=MaterialTheme.typography.bodyMedium,label:(@Composable ()->Unit)?=null,placeholder:(@Composable ()->Unit)?=null,
    leadingIcon:(@Composable ()->Unit)?=null,trailingIcon:(@Composable ()->Unit)?=null,supportingText:(@Composable ()->Unit)?=null,
    isError:Boolean=false,visualTransformation:VisualTransformation=VisualTransformation.None,keyboardOptions:KeyboardOptions=KeyboardOptions.Default,
    keyboardActions:KeyboardActions=KeyboardActions.Default,singleLine:Boolean=false,maxLines:Int=if(singleLine)1 else Int.MAX_VALUE,minLines:Int=1) {
    val interaction=remember { MutableInteractionSource() }; val focused by interaction.collectIsFocusedAsState()
    // On the designed parchment the field is the hub TextField look: cream face, ink rim (gold lip focused, red on error), brown ink.
    val parch=onParchment(); val k=gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors
    BasicTextField(value,onValueChange,modifier.alpha(if(enabled)1f else .5f).semantics(mergeDescendants=true) {
        if(isError) error("Invalid input")
    }, enabled=enabled,readOnly=readOnly,textStyle=textStyle.copy(color=if(parch)k.textOnParch else Palette.text),keyboardOptions=keyboardOptions,keyboardActions=keyboardActions,
        singleLine=singleLine,maxLines=maxLines,minLines=minLines,visualTransformation=visualTransformation,interactionSource=interaction,cursorBrush=SolidColor(if(parch)k.ink else Palette.gold),
        decorationBox={ inner -> Column(verticalArrangement=Arrangement.spacedBy(4.dp)) {
            // Keep the visible label/supporting copy inside the editable field's semantics subtree.
            label?.let { CompositionLocalProvider(LocalContentColor provides SurfaceInk.muted) { ProvideTextStyle(MaterialTheme.typography.bodySmall,it) } }
            Row(Modifier.fillMaxWidth().heightIn(min=48.dp).background(if(parch)k.cream else Palette.card).blockSceneInput()
                .border(2.dp,if(isError)(if(parch)k.red.face else Palette.danger) else if(focused)(if(parch)k.gold.lo else Palette.gold) else if(parch)k.ink else Palette.borderLt).padding(10.dp),
                verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                leadingIcon?.invoke(); Box(Modifier.weight(1f)) { if(value.isEmpty())placeholder?.invoke(); inner() }; trailingIcon?.invoke()
            }
            supportingText?.invoke()
        } })
}
@Composable fun FilterChip(selected:Boolean,onClick:()->Unit,modifier:Modifier=Modifier,enabled:Boolean=true,label:@Composable ()->Unit,
    leadingIcon:(@Composable ()->Unit)?=null,trailingIcon:(@Composable ()->Unit)?=null) {
    // On the designed parchment: a cream chip, the selected one on the kit's selected tint with the gold lip rim.
    val parch=onParchment(); val k=gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors
    Row(modifier.defaultMinSize(minWidth=48.dp,minHeight=48.dp).alpha(if(enabled)1f else .5f)
        .background(if(!parch)Palette.card else if(selected)k.selectedTint else k.cream).blockSceneInput()
        .border(2.dp,if(parch)(if(selected)k.gold.lo else k.ink) else if(selected)Palette.gold else Palette.border).semantics { this.selected=selected }
        .clickable(enabled=enabled,role=Role.Tab,onClick=onClick).padding(horizontal=10.dp,vertical=6.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
        CompositionLocalProvider(LocalContentColor provides if(parch)k.textOnParch else if(selected)Palette.gold else Palette.text) {
            ProvideTextStyle(MaterialTheme.typography.labelMedium) { leadingIcon?.invoke(); label(); trailingIcon?.invoke() }
        }
    }
}
@Composable fun Switch(checked:Boolean,onCheckedChange:((Boolean)->Unit)?,modifier:Modifier=Modifier,enabled:Boolean=true) {
    Box(modifier.size(48.dp).alpha(if(enabled)1f else .5f).blockSceneInput().toggleable(checked,enabled=enabled && onCheckedChange!=null,role=Role.Switch,onValueChange={onCheckedChange?.invoke(it)}),contentAlignment=Alignment.Center) {
        Box(Modifier.size(46.dp,24.dp).background(if(checked)Palette.success else Palette.border).border(2.dp,Palette.ink)) {
            Box(Modifier.align(if(checked)Alignment.CenterEnd else Alignment.CenterStart).padding(3.dp).size(18.dp).background(Palette.text).border(1.dp,Palette.ink))
        }
    }
}
@Composable fun Checkbox(checked:Boolean,onCheckedChange:((Boolean)->Unit)?,modifier:Modifier=Modifier,enabled:Boolean=true) {
    Box(modifier.size(48.dp).alpha(if(enabled)1f else .5f).blockSceneInput().toggleable(checked,enabled=enabled && onCheckedChange!=null,role=Role.Checkbox,onValueChange={onCheckedChange?.invoke(it)}),contentAlignment=Alignment.Center) {
        val parch=onParchment(); val k=gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors
        Box(Modifier.size(22.dp).background(if(parch)k.cream else Palette.card).border(2.dp,if(parch)k.ink else if(checked)Palette.gold else Palette.borderLt),contentAlignment=Alignment.Center) {
            if(checked)Box(Modifier.size(12.dp).background(if(parch)k.gold.lo else Palette.gold))
        }
    }
}
@Composable fun HorizontalDivider(modifier:Modifier=Modifier) { Box(modifier.fillMaxWidth().height(2.dp).background(if(onParchment())gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors.parchmentLo else Palette.borderLt)) }
@Composable fun DropdownMenu(expanded:Boolean,onDismissRequest:()->Unit,modifier:Modifier=Modifier,content:@Composable ColumnScope.()->Unit) {
    // Retain the platform's anchor/viewport placement, focus and dismissal behavior.
    androidx.compose.material3.DropdownMenu(expanded=expanded,onDismissRequest=onDismissRequest,
        modifier=modifier.widthIn(min=180.dp,max=400.dp).heightIn(max=360.dp),shape=RectangleShape,
        containerColor=if(onParchment())gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors.cream else Palette.panel,tonalElevation=0.dp,shadowElevation=0.dp,
        border=BorderStroke(2.dp,if(onParchment())gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors.ink else Palette.borderLt),content=content)
}
@Composable fun DropdownMenuItem(text:@Composable ()->Unit,onClick:()->Unit,modifier:Modifier=Modifier,enabled:Boolean=true) {
    TextButton(onClick,modifier.fillMaxWidth(),enabled,content={text()})
}
@Composable fun LinearProgressIndicator(modifier:Modifier=Modifier,color:Color=Palette.gold) { WebProgress(null,modifier,color) }
@Composable fun LinearProgressIndicator(progress:()->Float,modifier:Modifier=Modifier,color:Color=Palette.gold) { WebProgress(progress(),modifier,color) }
@Composable fun LinearProgressIndicator(progress:Float,modifier:Modifier=Modifier,color:Color=Palette.gold) { WebProgress(progress,modifier,color) }
@Composable private fun WebProgress(progress:Float?,modifier:Modifier,color:Color) {
    val reduced=LocalReducedMotion.current
    // On the designed parchment the line sits on the kit meter track (DESIGN-SYSTEM §6 ProgressBar).
    val track=if(onParchment())gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Colors.track else Palette.border
    // Scene-transitions spec §1.3: one-way sweep or nothing (reduced motion draws the bare track, never a parked segment).
    val phase = if(progress==null && !reduced) loadingPhase() else null
    // clipToBounds: nothing an indicator draws may leave its track (owner 2026-10-06).
    Canvas(modifier.fillMaxWidth().height(6.dp).clipToBounds().semantics { progressBarRangeInfo=if(progress==null)ProgressBarRangeInfo.Indeterminate else ProgressBarRangeInfo(progress.coerceIn(0f,1f),0f..1f) }) {
        drawRect(track)
        val inset=1.dp.toPx(); val width=(size.width-2*inset).coerceAtLeast(0f); val height=(size.height-2*inset).coerceAtLeast(0f)
        if(progress!=null)drawRect(color,Offset(inset,inset),Size(width*progress.coerceIn(0f,1f),height))
        else indeterminateSegment(phase?.value)?.let { (from, to) -> drawRect(color,Offset(inset+from*width,inset),Size((to-from)*width,height)) }
    }
}

/** An indeterminate line's lit span for sweep [phase] (0..1, left to right, restarting): a 30 % segment entering at the left
 *  and leaving at the right, never moving backwards. Null phase (reduced motion, nothing measured) lights nothing: the old
 *  bar parked a segment at 35–65 %, which players read as "half loaded" (owner screenshot 2026-10-06). */
internal fun indeterminateSegment(phase: Float?): Pair<Float, Float>? = phase?.let { p ->
    val start = p.coerceIn(0f, 1f) * 1.3f - .3f
    start.coerceAtLeast(0f) to (start + .3f).coerceAtMost(1f)
}?.takeIf { (from, to) -> to > from }
@Composable fun CircularProgressIndicator(modifier:Modifier=Modifier,color:Color=Palette.gold,strokeWidth:Dp=4.dp) {
    val reduced=LocalReducedMotion.current
    val phase = if(!reduced) loadingPhase() else null
    Canvas(modifier.size(32.dp).semantics { progressBarRangeInfo=ProgressBarRangeInfo.Indeterminate }) {
        val unit=minOf(size.width,size.height)/5
        val cells=listOf(1 to 0,3 to 0,4 to 1,4 to 3,3 to 4,1 to 4,0 to 3,0 to 1)
        cells.forEachIndexed { index,(x,y) -> drawRect(color.copy(alpha=if(reduced || index==((phase?.value ?: 0f)*8).toInt()%8)1f else .3f),Offset(x*unit,y*unit),Size(unit,unit)) }
    }
}

/** Read animation state in Canvas drawing, so frames do not recompose or remeasure the loading UI.
 * The bar reverses smoothly at each edge; the circular indicator keeps its continuous rotation. */
@Composable private fun loadingPhase(reverse: Boolean = false): State<Float> {
    val transition=rememberInfiniteTransition(label="loading")
    return transition.animateFloat(0f,1f,infiniteRepeatable(
        tween(if(reverse)1400 else 1000,easing=if(reverse)FastOutSlowInEasing else LinearEasing),
        repeatMode=if(reverse)RepeatMode.Reverse else RepeatMode.Restart),label="loading")
}
