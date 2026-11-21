import { wakeDeliveryWorkers } from '../delivery/wake.js';

export async function createCreatorBroadcast(pool, { ownerTelegramId, deliveryBotId, createdBy, messageText }) {
  const owner = Number(ownerTelegramId), botId = Number(deliveryBotId), actor = Number(createdBy);
  const text = String(messageText ?? '').trim();
  if (![owner,botId,actor].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid creator, bot, or sender ID.');
  if (!text || text.length > 4000) throw new Error('Broadcast text must be between 1 and 4000 characters.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bot = await client.query('SELECT id FROM delivery_bots WHERE id=$1 AND owner_telegram_id=$2 AND is_enabled=TRUE LIMIT 1',[botId,owner]);
    if (!bot.rowCount) throw new Error('Creator delivery bot not found or disabled.');
    const recipients = await client.query('SELECT telegram_user_id FROM delivery_bot_user_activity WHERE delivery_bot_id=$1 ORDER BY telegram_user_id',[botId]);
    if (!recipients.rowCount < 1) throw new Error('This delivery bot has no tracked users yet.');
    const created = await client.query('INSERT INTO creator_broadcasts(owner_telegram_id,delivery_bot_id,created_by,message_text,total_recipients) VALUES($1,$2,$3,$4,$5) RETURNING id',[owner,botId,actor,text,recipients.rowCount]);
    const id = created.rows[0].id;
    await client.query('INSERT INTO creator_broadcast_recipients(broadcast_id,telegram_user_id) SELECT $1,telegram_user_id FROM delivery_bot_user_activity WHERE delivery_bot_id=$2',[id,botId]);
    await client.query('COMMIT');
    wakeDeliveryWorkers('broadcast-created');
    return { id, totalRecipients: recipients.rowCount };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function listCreatorBroadcasts(pool, ownerTelegramId, limit=10) {
  const {rows}=await pool.query('SELECT id,delivery_bot_id,status,total_recipients,sent_count,failed_count,created_at,started_at,completed_at,last_error FROM creator_broadcasts WHERE owner_telegram_id=$1 ORDER BY id DESC LIMIT $2',[Number(ownerTelegramId),Math.min(50,Math.max(1,Number(limit)||10))]);
  return rows;
}
export async function claimCreatorBroadcast(pool) {
  const {rows}=await pool.query(`UPDATE creator_broadcasts SET status='processing',started_at=COALESCE(started_at,NOW()) WHERE id=(SELECT id FROM creator_broadcasts WHERE status='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,delivery_bot_id,owner_telegram_id,message_text`);
  return rows[0]??null;
}
export async function claimBroadcastRecipients(pool,broadcastId,limit=20) {
  const {rows}=await pool.query(`SELECT telegram_user_id FROM creator_broadcast_recipients WHERE broadcast_id=$1 AND status='pending' ORDER BY telegram_user_id LIMIT $2`,[broadcastId,Math.min(50,Math.max(1,Number(limit)||20))]);
  return rows;
}
export async function markBroadcastRecipient(pool,broadcastId,userId,status,errorCode=null) {
  const allowed=['sent','failed','skipped']; if(!allowed.includes(status))throw new Error('Invalid recipient state.');
  const client=await pool.connect();try{await client.query('BEGIN');
    const upd=await client.query('UPDATE creator_broadcast_recipients SET status=$3,attempts=attempts+1,error_code=$4,sent_at=CASE WHEN $3=\'sent\' THEN NOW() ELSE sent_at END WHERE broadcast_id=$1 AND telegram_user_id=$2 AND status=\'pending\' RETURNING status',[broadcastId,userId,status,errorCode]);
    if(upd.rowCount)await client.query(`UPDATE creator_broadcasts SET sent_count=sent_count+CASE WHEN $3='sent' THEN 1 ELSE 0 END,failed_count=failed_count+CASE WHEN $3='failed' THEN 1 ELSE 0 END WHERE id=$1`,[broadcastId,userId,status]);
    await client.query('COMMIT');return upd.rowCount>0;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function finalizeCreatorBroadcast(pool,broadcastId) {
  const {rows}=await pool.query(`UPDATE creator_broadcasts b SET status=CASE WHEN EXISTS(SELECT 1 FROM creator_broadcast_recipients r WHERE r.broadcast_id=b.id AND r.status='pending') THEN b.status ELSE 'completed' END,completed_at=CASE WHEN NOT EXISTS(SELECT 1 FROM creator_broadcast_recipients r WHERE r.broadcast_id=b.id AND r.status='pending') THEN NOW() ELSE NULL END WHERE b.id=$1 RETURNING status`,[broadcastId]);
  return rows[0]?.status;
}
export async function setCreatorBroadcastStatus(pool,ownerTelegramId,broadcastId,status) {
  if(!['paused','pending','cancelled'].includes(status))throw new Error('Unsupported broadcast status.');
  const {rowCount}=await pool.query('UPDATE creator_broadcasts SET status=$3 WHERE id=$1 AND owner_telegram_id=$2 AND status IN (\'pending\',\'processing\',\'paused\')',[broadcastId,Number(ownerTelegramId),status]);
  if(status==='cancelled')await pool.query('UPDATE creator_broadcast_recipients SET status=\'skipped\' WHERE broadcast_id=$1 AND status=\'pending\'',[broadcastId]);
  return rowCount>0;
}
