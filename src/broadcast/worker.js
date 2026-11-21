import { wakeDeliveryWorkers, subscribeDeliveryWorkerWake } from '../delivery/wake.js';
import { claimCreatorBroadcast, claimBroadcastRecipients, markBroadcastRecipient, getBroadcastState, finalizeCreatorBroadcast } from './repository.js';

export function createCreatorBroadcastWorker(telegram,pool,logger,deliveryBotId) {
 const botId=Number(deliveryBotId);let stopped=true,busy=false,pending=false,timer,unsubscribe;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function processOne(){
  const job=await claimCreatorBroadcast(pool,botId);if(!job)return false;
  try{
   while(!stopped){
    const state=await getBroadcastState(pool,job.id);if(state!=='processing')break;
    const users=await claimBroadcastRecipients(pool,job.id,25);if(!users.length)break;
    for(const u of users){if(stopped)break;if(await getBroadcastState(pool,job.id)!=='processing')break;
     try{await telegram.sendMessage(u.telegram_user_id,job.message_text,{disable_web_page_preview:true});await markBroadcastRecipient(pool,job.id,u.telegram_user_id,'sent');}
     catch(e){const code=e?.response?.error_code??e?.code??'send_failed';await markBroadcastRecipient(pool,job.id,u.telegram_user_id,'failed',String(code).slice(0,120));}
     await sleep(55);
    }
   }
   await finalizeCreatorBroadcast(pool,job.id);
  }catch(e){logger.error({broadcastId:job.id,error:e.message},'Creator broadcast worker failed');await pool.query("UPDATE creator_broadcasts SET status='pending',last_error=$2 WHERE id=$1 AND status='processing'",[String(e.message).slice(0,400),job.id]).catch(()=>{});}
  return true;
 }
 async function run(){if(stopped)return;if(busy){pending=true;return;}busy=true;pending=false;try{while(!stopped){const had=await processOne();if(!had)break;}}catch(e){logger.error({botId,error:e.message},'Broadcast worker loop error');}finally{busy=false;if(!stopped&&pending)void run();}}
 function wake(){if(stopped)return;pending=true;if(!busy)void run();}
 return {start(){if(!stopped)return;stopped=false;unsubscribe=subscribeDeliveryWorkerWake(wake);timer=setInterval(wake,60000);timer.unref?.();void pool.query("UPDATE creator_broadcasts SET status='pending' WHERE delivery_bot_id=$1 AND status='processing'",[botId]).then(run).catch(e=>logger.warn({botId,error:e.message},'Broadcast recovery failed'));logger.info({botId},'Creator broadcast worker started');},stop(){stopped=true;if(timer)clearInterval(timer);timer=undefined;unsubscribe?.();unsubscribe=undefined;}};
}
