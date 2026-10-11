package gg.pixelkingdomwars.nativeclient.ui.layout

/** Navigation intent only: never save, apply or purchase when leaving to BUILD. */
internal class LayoutBuildExit(private val model: LayoutEditorViewModel, private val openBuild: () -> Unit) {
    private var pending = false
    fun request() {
        val state = model.currentEditorState()
        if (!state.open || state.local.busy != null || state.local.discardOpen) return
        pending = true
        model.close()
        finish()
    }
    fun confirmDiscard() {
        if (!model.currentEditorState().local.discardOpen) return
        model.confirmDiscard()
        finish()
    }
    fun cancelDiscard() { pending = false; model.cancelDiscard() }
    fun clear() { pending = false }
    private fun finish() {
        if (pending && !model.currentEditorState().open) { pending = false; openBuild() }
    }
}
