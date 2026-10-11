package gg.pixelkingdomwars.nativeclient.ui.battle

/** Web RaidUI `battle:done` → commitRaid, and its clock-end effect: a rendered 100% stream asks the server
 * to prove the target is already destroyed, and a due raid clock posts FINISH without a tap. Each trigger
 * posts at most once per raid, so a 100% request refused with RAID_CLOCK_NOT_DUE (a timing correction on the
 * web, not a failed battle) is simply asked again once the clock is due, and any other refusal leaves the
 * existing error line plus CHECK RESULT. Only the server's result ends the battle; this never infers one. */
internal class BattleAutoFinish {
    private var requestedAtDestruction = false
    private var requestedAtDue = false
    /** True exactly when the caller must post FINISH now. `destroyed` is the canonical HUD ledger percentage. */
    fun shouldFinish(destroyed: Int?, running: Boolean, settled: Boolean, ready: Boolean, due: Boolean): Boolean {
        if (!running || settled || !ready) return false
        if (due) { if (requestedAtDue) return false; requestedAtDue = true; return true }
        if (destroyed == 100 && !requestedAtDestruction) { requestedAtDestruction = true; return true }
        return false
    }
}
