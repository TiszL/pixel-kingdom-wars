package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job
class TournamentViewModel(private val repository:TournamentRepository,val wallet:CharterWallet?=null):ScreenViewModel() {
 val state=repository.state;private var last:Job?=null
 private fun action(block:suspend ()->Unit)=run(block).also{if(it!=null)last=it}
 suspend fun foreground(){last?.join();refresh()?.join()}
 fun refresh(cursor:String?=null)=action{repository.awaitIdle();repository.open(cursor)}
 fun select(id:String)=action{repository.selectEvent(id)}
 fun operation(id:String)=action{repository.selectOperation(id)}
 fun enter(clan:String)=action{repository.enter(clan)}
 fun clear()=action{repository.clear()}
 fun command(name:String)=action{repository.command(name)}
 fun check()=action{repository.check()}
 fun retry(key:String)=action{repository.retry(key)}
 fun recover(key:String)=action{repository.recoverIntent(key)}
 fun closeAbsent(key:String)=action{repository.closeAbsent(key)}
 fun review()=action{repository.review()}
 fun approve()=action{repository.approve()}
 fun upload()=action{repository.upload()}
 fun deliver()=action{repository.deliver()}
 fun raid(base:String)=action{repository.raid(base)}
 fun cancelRaid(key:String)=action{repository.cancelRaid(key)}
 fun play(key:String)=action{repository.play(key)}
 fun claim(base:String)=action{repository.claim(base)}
 fun closeEvent()=action{repository.closeEvent()}
 fun dismiss()=repository.dismiss()
}
