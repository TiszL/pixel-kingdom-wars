package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job
class RetirementViewModel(private val repository:RetirementRepository,val wallet:CharterWallet?=null):ScreenViewModel(){
 val state=repository.state;private var last:Job?=null
 private fun action(block:suspend()->Unit)=run(block).also{if(it!=null)last=it}
 suspend fun foreground(){last?.join();action{repository.awaitIdle();repository.open()}?.join()}
 fun select(key:String)=action{repository.select(key)}
 fun begin(clan:String)=action{repository.begin(clan)}
 fun retry()=action{repository.retryOriginal()}
 fun check()=action{repository.check()}
 fun command(name:String)=action{repository.command(name)}
 fun review()=action{repository.review()}
 fun approve()=action{repository.approve()}
 fun upload()=action{repository.upload()}
 fun deliver()=action{repository.deliver()}
 fun dismiss()=repository.dismiss()
}
