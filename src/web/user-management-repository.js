import { parsePositiveInt } from '../utils/validation.js';

export async function trackDeliveryBotUser(pool, botId, user) {
  const id = Number(botId), uid = Number(user?.id);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(uid) || uid <= 0) return;
  await pool.query(`INSERT INTO users (telegram_id, username, first_name, last_name, language_code)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (telegram_id) DO UPDATE SET
    username=EXCLUDED.username, first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
    language_code=EXCLUDED.language_code, last_seen_at=NOW(), updated_at=NOW()`,
    [uid,user.username??null,user.first_name??null,user.last_name??null,user.language_code??null]);
  await pool.query(`INSERT INTO delivery_bot_user_activity (delivery_bot_id,telegram_user_id)
    VALUES ($1,$2) ON CONFLICT (delivery_bot_id,telegram_user_id) DO UPDATE
    SET last_seen_at=NOW(), interaction_count=delivery_bot_user_activity.interaction_count+1`,[id,uid]);
}

export async function listPanelUsers(pool, { isOwner, userId, q = '', botId = '' } = {}) {
  const params=[], clauses=[];
  if (!isOwner) { params.push(Number(userId)); clauses.push(`a.delivery_bot_id IN (SELECT id FROM delivery_bots WHERE owner_telegram_id=$1)`); }
  if (botId) { params.push(parsePositiveInt(botId,'Bot ID')); clauses.push(`a.delivery_bot_id=$${params.length}`); }
  const search=String(q??'').trim().slice(0,100);
  if(search){params.push(`%${search.replace(/[\\%_]/g,'\\$&')}%`);const p=`$${params.length}`;clauses.push(`(u.username ILIKE ${p} ESCAPE '\\' OR u.first_name ILIKE ${p} ESCAPE '\\' OR u.last_name ILIKE ${p} ESCAPE '\\' OR u.telegram_id::text ILIKE ${p})`);}
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  const {rows}=await pool.query(`SELECT u.telegram_id,u.username,u.first_name,u.last_name,u.language_code,u.is_blocked,
    u.started_at,u.last_seen_at,COUNT(DISTINCT a.delivery_bot_id)::int AS bots_used,
    MIN(a.first_seen_at) AS bot_first_seen,MAX(a.last_seen_at) AS bot_last_seen,
    SUM(a.interaction_count)::bigint AS bot_interactions,
    COALESCE(bool_or(m.id IS NOT NULL AND m.status='active' AND m.starts_at<=NOW() AND (m.expires_at IS NULL OR m.expires_at>NOW())),FALSE) AS premium_active
    FROM delivery_bot_user_activity a JOIN users u ON u.telegram_id=a.telegram_user_id
    LEFT JOIN premium_memberships m ON m.user_telegram_id=u.telegram_id AND (${isOwner?'TRUE':'m.owner_telegram_id=$1'})
    ${where} GROUP BY u.telegram_id ORDER BY MAX(a.last_seen_at) DESC LIMIT $${params.length+1}`,[...params,500]);
  return rows;
}

export async function listPanelPremiumMembers(pool,{isOwner,userId,q='',status='all'}={}){
  const params=[],clauses=[];
  if(!isOwner){params.push(Number(userId));clauses.push('m.owner_telegram_id=$1');}
  const st=['all','active','expired','permanent'].includes(status)?status:'all';
  if(st==='active')clauses.push(`m.status='active' AND m.starts_at<=NOW() AND (m.expires_at IS NULL OR m.expires_at>NOW())`);
  if(st==='expired')clauses.push(`m.status='active' AND m.expires_at IS NOT NULL AND m.expires_at<=NOW()`);
  if(st==='permanent')clauses.push(`m.status='active' AND m.expires_at IS NULL`);
  const search=String(q??'').trim().slice(0,100);
  if(search){params.push(`%${search.replace(/[\\%_]/g,'\\$&')}%`);const p=`$${params.length}`;clauses.push(`(u.username ILIKE ${p} ESCAPE '\\' OR u.first_name ILIKE ${p} ESCAPE '\\' OR u.last_name ILIKE ${p} ESCAPE '\\' OR u.telegram_id::text ILIKE ${p})`);}
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  const {rows}=await pool.query(`SELECT m.id,m.user_telegram_id,u.username,u.first_name,u.last_name,m.owner_telegram_id,
    p.name AS plan_name,m.status,m.starts_at,m.expires_at,m.source,
    CASE WHEN m.expires_at IS NULL THEN NULL ELSE GREATEST(0,CEIL(EXTRACT(EPOCH FROM (m.expires_at-NOW()))/86400))::int END AS days_remaining
    FROM premium_memberships m LEFT JOIN users u ON u.telegram_id=m.user_telegram_id
    LEFT JOIN premium_plans p ON p.id=m.plan_id ${where}
    ORDER BY (m.expires_at IS NULL) DESC,m.expires_at DESC NULLS LAST LIMIT 500`,params);
  return rows;
}
