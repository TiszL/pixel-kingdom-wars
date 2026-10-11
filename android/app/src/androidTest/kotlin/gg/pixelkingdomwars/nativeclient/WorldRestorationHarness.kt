package gg.pixelkingdomwars.nativeclient

import android.app.Activity
import android.app.Application
import android.app.Instrumentation
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentManager
import androidx.lifecycle.Lifecycle
import gg.pixelkingdomwars.nativeclient.scene.KingdomFragment
import gg.pixelkingdomwars.nativeclient.scene.WorldFragment
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Exercises World and Kingdom AndroidX restoration without opening a map or accessing an account.
 * Both fixtures are capped at CREATED so an unfixed build fails an assertion, rather than
 * reproducing libGDX's indefinite destroy wait and blocking the instrumentation process. */
internal object WorldRestorationHarness {
    fun verify(instrumentation: Instrumentation) {
        check(BuildConfig.DEBUG && Build.HARDWARE=="ranchu" && Build.VERSION.SDK_INT>=29)
        val context=instrumentation.targetContext
        val directory=File(context.noBackupFilesDir,"world-restoration")
        check(directory.mkdir()) { "Preserve the previous restoration receipt before rerunning" }
        val app=context.applicationContext as Application
        val original=AtomicReference<MainActivity?>()
        val replacement=AtomicReference<MainActivity?>()
        val recreated=CountDownLatch(1)
        val restored=AtomicInteger();val destroyed=AtomicInteger();val views=AtomicInteger()
        val kingdomRestored=AtomicInteger();val kingdomDestroyed=AtomicInteger();val kingdomViews=AtomicInteger()
        val remainingAtCreated=AtomicInteger(-1)
        val kingdomTag="native-kingdom-restoration-regression"
        var stage="launch-offline-preview"
        fun receipt(status: String) {
            File(directory,"receipt.txt").writeText("$status\nstage=$stage\nrestored=${restored.get()}\ndestroyed=${destroyed.get()}\nviews=${views.get()}\n"+
                "kingdomRestored=${kingdomRestored.get()}\nkingdomDestroyed=${kingdomDestroyed.get()}\nkingdomViews=${kingdomViews.get()}\nremainingAtCreated=${remainingAtCreated.get()}\noffline=true\n")
        }
        val callbacks=object : Application.ActivityLifecycleCallbacks {
            override fun onActivityPreCreated(activity: Activity,state: Bundle?) {
                if(activity !is MainActivity || state==null) return
                replacement.set(activity)
                activity.supportFragmentManager.registerFragmentLifecycleCallbacks(object : FragmentManager.FragmentLifecycleCallbacks() {
                    override fun onFragmentCreated(manager: FragmentManager,fragment: Fragment,state: Bundle?) {
                        if(fragment is WorldFragment) restored.incrementAndGet()
                        if(fragment is KingdomFragment && fragment.tag==kingdomTag) kingdomRestored.incrementAndGet()
                    }
                    override fun onFragmentViewCreated(manager: FragmentManager,fragment: Fragment,view: View,state: Bundle?) {
                        if(fragment is WorldFragment) views.incrementAndGet()
                        if(fragment is KingdomFragment && fragment.tag==kingdomTag) kingdomViews.incrementAndGet()
                    }
                    override fun onFragmentDestroyed(manager: FragmentManager,fragment: Fragment) {
                        if(fragment is WorldFragment) destroyed.incrementAndGet()
                        if(fragment is KingdomFragment && fragment.tag==kingdomTag) kingdomDestroyed.incrementAndGet()
                    }
                },false)
            }
            override fun onActivityPostCreated(activity: Activity,state: Bundle?) {
                if(activity===replacement.get()) {
                    remainingAtCreated.set((activity as MainActivity).supportFragmentManager.fragments.count { it is WorldFragment || it is KingdomFragment })
                    recreated.countDown()
                }
            }
            override fun onActivityCreated(activity: Activity,state: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity,state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        }
        app.registerActivityLifecycleCallbacks(callbacks)
        try {
            receipt("running")
            val activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java)
                .putExtra("preview","base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            original.set(activity)
            stage="save-cold-gl-fragments";receipt("running")
            instrumentation.runOnMainSync {
                val fragment=WorldFragment()
                val kingdom=KingdomFragment()
                activity.supportFragmentManager.beginTransaction()
                    .add(fragment,"fantasy-globe-restoration-regression")
                    .setMaxLifecycle(fragment,Lifecycle.State.CREATED)
                    .add(kingdom,kingdomTag).setMaxLifecycle(kingdom,Lifecycle.State.CREATED).commitNow()
                check(fragment.lifecycle.currentState==Lifecycle.State.CREATED && fragment.view==null && fragment.renderer==null)
                check(kingdom.lifecycle.currentState==Lifecycle.State.CREATED && kingdom.view==null && kingdom.renderer==null)
                activity.recreate()
            }
            stage="restore-before-gl-views";receipt("running")
            check(recreated.await(20,TimeUnit.SECONDS)) { "Activity recreation did not complete" }
            instrumentation.runOnMainSync {
                val next=requireNotNull(replacement.get())
                check(next!==activity && next.intent.getStringExtra("preview")=="base")
                check(next.supportFragmentManager.fragments.none { it is WorldFragment })
                check(next.supportFragmentManager.findFragmentByTag(kingdomTag)==null)
            }
            check(restored.get()==1) { "The fixture must actually pass through AndroidX restoration" }
            check(destroyed.get()==1 && views.get()==0) { "Cold restored worlds must be removed before creating a GL view" }
            check(kingdomRestored.get()==1 && kingdomDestroyed.get()==1 && kingdomViews.get()==0) {
                "Cold restored kingdoms must be removed before creating a GL view"
            }
            check(remainingAtCreated.get()==0) { "No restored GL fragment may survive Activity.onCreate" }
            stage="complete";receipt("passed")
        } catch(error: Exception) {
            receipt("failed");throw error
        } finally {
            app.unregisterActivityLifecycleCallbacks(callbacks)
            instrumentation.runOnMainSync { (replacement.get() ?: original.get())?.let { if(!it.isDestroyed)it.finish() } }
        }
    }
}
