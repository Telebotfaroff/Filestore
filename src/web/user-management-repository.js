import { parsePositiveInt } from '../utils/validation.js';

export async function trackDeliveryBotUser(pool, botId, user) {
  const id=Number(botId), uid=Number(user?.id);
  if(!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(uid)||uid<=0)return;
  await pool.query(`INSERT INTO users (telegram_id,username,first_name,last_name,language_code) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,language_code=EXCLUDED.language_code,last_seen_at=NOW(),updated_at=NOW()`,[uid,user.username??null,user.first_name??null,user.last_name??null,user.language_code??null]);
  await pool.query(`INSERT INTO delivery_bot_user_activity (delivery_bot_id,telegram_user_id) VALUES ($1,$2) ON CONFLICT (delivery_bot_id,telegram_user_id) DO UPDATE SET last_seen_at=NOW(),interaction_count=delivery_bot_user_activity.interaction_count+1`,[id,uid]);
}

export async function listPanelUsers(pool,{isOwner,userId,q='',botId=''}={}){
  const bot=botId?parsePositiveInt(botId,'Bot ID'):null, search=String(q||'').trim().slice(0,100);
  const {rows}=await pool.query(`SELECT u.telegram_id,u.username,u.first_name,u.last_name,u.language_code,u.is_blocked,u.started_at,u.last_seen_at,COUNT(DISTINCT a.delivery_bot_id)::int AS bots_used,MIN(a.first_seen_at) AS bot_first_seen,MAX(a.last_seen_at) AS bot_last_seen,COALESCE(SUM(a.interaction_count),0)::bigint AS bot_interactions,EXISTS(SELECT 1 FROM premium_memberships m WHERE m.user_telegram_id=u.telegram_id AND ($2::boolean OR m.owner_telegram_id=$1) AND m.status='active' AND m.starts_at<=NOW() AND (m.expires_at IS NULL OR m.expires_at>NOW())) AS premium_active FROM users u LEFT JOIN delivery_bot_user_activity a ON a.telegram_user_id=u.telegram_id LEFT JOIN delivery_bots d ON d.id=a.delivery_bot_id WHERE ($2::boolean OR d.owner_telegram_id=$1) AND ($3::bigint IS NULL OR a.delivery_bot_id=$3) AND ($4='' OR u.username ILIKE '%'||$4||'%' OR u.first_name ILIKE '%'||$4||'%' OR u.last_name ILIKE '%'||$4||'%' OR u.telegram_id::text ILIKE '%'||$4||'%') GROUP BY u.telegram_id ORDER BY COALESCE(MAX(a.last_seen_at),u.last_seen_at) DESC LIMIT 500`,[Number(userId),Boolean(isOwner),bot,search]);
  return rows;
}
export async function listPanelPremiumMembers(pool,{isOwner,userId,q='',status='all'}={}){
  const search=String(q||'').trim().slice(0,100),st=['all','active','expired','permanent'].includes(status)?status:'all';
  const {rows}=await pool.query(`SELECT m.id,m.user_telegram_id,u.username,u.first_name,u.last_name,m.owner_telegram_id,p.name AS plan_name,m.status,m.starts_at,m.expires_at,m.source,CASE WHEN m.expires_at IS NULL THEN NULL ELSE GREATEST(0,CEIL(EXTRACT(EPOCH FROM (m.expires_at-NOW()))/86400))::int END AS days_remaining FROM premium_memberships m LEFT JOIN users u ON u.telegram_id=m.user_telegram_id LEFT JOIN premium_plans p ON p.id=m.plan_id WHERE ($2::boolean OR m.owner_telegram_id=$1) AND ($3='all' OR ($3='active' AND m.status='active' AND m.starts_at<=NOW() AND (m.expires_at IS NULL OR m.expires_at>NOW())) OR ($3='expired' AND m.status='active' AND m.expires_at IS NOT NULL AND m.expires_at<=NOW()) OR ($3='permanent' AND m.status='active' AND m.expires_at IS NULL)) AND ($4='' OR u.username ILIKE '%'||$4||'%' OR u.first_name ILIKE '%'||$4||'%' OR u.last_name ILIKE '%'||$4||'%' OR u.telegram_id::text ILIKE '%'||$4||'%') ORDER BY (m.expires_at IS NULL) DESC,m.expires_at DESC NULLS LAST LIMIT 500`,[Number(userId),Boolean(isOwner),st,search]);return rows;
}
