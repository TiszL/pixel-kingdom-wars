package gg.pixelkingdomwars.nativeclient.scene

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.doOnAttach
import androidx.fragment.app.FragmentActivity
import com.badlogic.gdx.backends.android.AndroidApplicationConfiguration
import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import com.badlogic.gdx.files.FileHandle
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.content.SceneContentLeases
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineFlags
import gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineGuard
import gg.pixelkingdomwars.nativeclient.scene.world.WorldGdxStatics
import gg.pixelkingdomwars.nativeclient.scene.world.WorldGl30Listener
import gg.pixelkingdomwars.nativeclient.scene.world.WorldLog
import java.io.File

@Composable fun WorldSurface(assets: File, camera: GlobeView, details: List<GlobeDetailSource>, art: GlobeArt, motion: Boolean, selection: GlobeSelection, modifier: Modifier,
                             onView: (GlobeView,GlobeViewport)->Unit, onPick:(GlobePick)->Unit, onError:(String)->Unit, onReady:()->Unit = {}, onDetailError:(String?)->Unit = {}, detailRetry: Int = 0, assetSource: GlobeAssetSource? = null) {
    val activity=requireNotNull(LocalActivity.current as? FragmentActivity)
    val tag="fantasy-globe-${assets.name}"
    val id=remember { View.generateViewId() }
    val fragment=remember(tag) { WorldFragment() }
    val changed by rememberUpdatedState(onView);val picked by rememberUpdatedState(onPick);val failed by rememberUpdatedState(onError)
    val ready by rememberUpdatedState(onReady)
    val detailFailed by rememberUpdatedState(onDetailError)
    SideEffect { fragment.onView={view,viewport->changed(view,viewport)};fragment.onPick={picked(it)};fragment.onError={failed(it)};fragment.onReady={ready()};fragment.onDetailError={detailFailed(it)} }
    LaunchedEffect(detailRetry) { if(detailRetry>0)fragment.renderer?.retryDetails() }
    LaunchedEffect(camera) { fragment.camera=camera;fragment.renderer?.setView(camera) }
    LaunchedEffect(selection) { fragment.selection=selection;fragment.renderer?.setSelection(selection) }
    LaunchedEffect(motion) { fragment.motion=motion;fragment.renderer?.setMotion(motion && android.animation.ValueAnimator.areAnimatorsEnabled()) }
    val remove:()->Unit=remember(fragment) { {
        if (!activity.isDestroyed && !activity.supportFragmentManager.isDestroyed && fragment.isAdded)
            activity.supportFragmentManager.beginTransaction().remove(fragment).commitNowAllowingStateLoss()
    } }
    Box(modifier.then(FragmentTeardownElement(remove))) {
        AndroidView(modifier=Modifier.fillMaxSize(),factory={context->FrameLayout(context).also { container ->
            container.withoutSceneInputFocus()
            container.id=id;fragment.assetPath=assets.absolutePath;fragment.assetSource=assetSource;fragment.camera=camera;fragment.details=details;fragment.art=art;fragment.motion=motion;fragment.selection=selection
            container.doOnAttach { if(!fragment.isAdded && !activity.supportFragmentManager.isStateSaved) activity.supportFragmentManager.beginTransaction().add(id,fragment,tag).commitNow() }
        }})
    }
    DisposableEffect(fragment) { onDispose { remove() } }
}

class WorldFragment : WorldApplicationFragment() {
    var art:GlobeArt?=null;var motion=true;var selection=GlobeSelection()
    var assetPath="";var camera=GlobeView();var details:List<GlobeDetailSource> = emptyList()
    var assetSource:GlobeAssetSource?=null
    var onView:(GlobeView,GlobeViewport)->Unit={_,_->};var onPick:(GlobePick)->Unit={};var onError:(String)->Unit={}
    var onReady:()->Unit={}
    var onDetailError:(String?)->Unit={}
    var renderer:FantasyGlobeRenderer?=null
    private var rendererEpoch:Any?=null
    override fun onCreateView(inflater:LayoutInflater,container:ViewGroup?,state:Bundle?):View {
        // MainActivity discards OS-restored instances before view creation. Only a composition
        // with freshly admitted world content may initialize a GL surface and acquire its lease.
        check(assetPath.isNotEmpty() && details.isNotEmpty() && art!=null) { "World content has not been admitted" }
        val root=File(requireContext().noBackupFilesDir,storageNamespace(BuildConfig.API_ORIGIN,"world-content"))
        val directory=File(assetPath)
        val owner=directory.parentFile
        require(owner==root || (owner?.parentFile==File(root,"groups") && owner.name=="overview")) { "World overview escapes its verified cache" }
        val lease=SceneContentLeases.acquire(requireNotNull(owner),directory)
        val epoch=Any();rendererEpoch=epoch
        fun publish(action:()->Unit) { activity?.runOnUiThread { if(rendererEpoch===epoch)action() } }
        return try {
            val game=FantasyGlobeRenderer(FileHandle(assetPath),camera,details,requireNotNull(art),motion && android.animation.ValueAnimator.areAnimatorsEnabled(),
                {view,viewport->publish { onView(view,viewport) }},
                {pick->publish { onPick(pick) }},
                {error->publish { onError(error) }},{lease.close()},
                {publish { onReady() }},{message->publish { onDetailError(message) }},assetSource=assetSource)
            game.setSelection(selection)
            renderer=game
            val config=AndroidApplicationConfiguration().apply { useAccelerometer=false;useCompass=false;useGyroscope=false;useImmersiveMode=false;numSamples=0 }
            // N0 (GLOBE-NATIVE-PLAN §3.3): the GL30 world surface runs only behind the debug flag; otherwise this is the
            // unchanged legacy globe on libGDX's own ES 2 surface.
            val admitted=WorldEngineGuard.admitContext(BuildConfig.DEBUG && WorldEngineFlags.gl30Requested,
                (requireContext().getSystemService(android.app.ActivityManager::class.java)?.deviceConfigurationInfo?.reqGlEsVersion ?: 0))
            val surface=if(admitted.gl30) {
                config.useGL30=true
                val log:(String)->Unit=WorldLog.line
                initializeWorldView(WorldGl30Listener(game,{ worldGraphics },File(requireContext().noBackupFilesDir,"world-programs"),BuildConfig.VERSION_CODE.toLong(),BuildConfig.DEBUG,log),
                    config,WorldContextFactory(3,log),FramePacer(requireContext(),60,log))
            } else initializeForView(game,config)
            surface.withoutSceneInputFocus().also { mounted0 ->
                mounted0.doOnAttach { mounted -> mounted.post { if(mounted.isAttachedToWindow)mounted.rootView.postInvalidateOnAnimation() } }
            }
        } catch(error:Exception) { rendererEpoch=null;lease.close();throw error }
    }
    override fun onResume() { super.onResume();renderer?.setMotion(motion && android.animation.ValueAnimator.areAnimatorsEnabled()) }
    override fun onDestroyView() { rendererEpoch=null;renderer=null;super.onDestroyView();if(worldGraphics!=null)WorldGdxStatics.clearGl30() }
}
