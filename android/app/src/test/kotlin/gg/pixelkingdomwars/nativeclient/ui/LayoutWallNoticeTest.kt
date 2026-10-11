package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutEditorState
import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutLocal
import org.junit.Assert.*
import org.junit.Test

class LayoutWallNoticeTest {
    @Test fun `successful layout notices are not exposed as editor refusals`() {
        val ui = LayoutEditorState(local = LayoutLocal(notice = "HOME SAVED")).wallUi
        assertEquals("HOME SAVED", ui.notice)
        assertNull(ui.refusal)
    }
}
