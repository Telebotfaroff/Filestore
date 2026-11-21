export async function recordLinkOpen(pool, kind, linkId, userId, botId = null) {
  if (!['share','paid_file','paid_batch'].includes(kind)) return;
  const id=Number(linkId), viewer=Number(userId), deliveryBot=botId==null?null:Number(botId);
  if (!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(viewer)||viewer<=0) return;
  await pool.query('INSERT INTO link_open_events (link_kind,link_id,viewer_telegram_id,delivery_bot_id) VALUES ($1,$2,$3,$4)',[kind,id,viewer,Number.isSafeInteger(deliveryBot)&&deliveryBot>0?deliveryBot:null]);
}
export async function getOwnerLinkAnalytics(pool, limit=50) {
  const {rows}=await pool.query(`WITH all_links AS (
    SELECT id,link_code AS code,title,link_type AS type,created_by,created_at,'share' AS kind FROM share_links
    UNION ALL SELECT id,public_code AS code,file_name AS title,'single' AS type,created_by,created_at,'paid_file' AS kind FROM paid_file_links
    UNION ALL SELECT id,public_code AS code,title,'batch' AS type,created_by,created_at,'paid_batch' AS kind FROM paid_batch_links
  ), views AS (
    SELECT link_kind,link_id,COUNT(*)::int AS view_count,COUNT(DISTINCT viewer_telegram_id)::int AS unique_viewers,
    MAX(opened_at) AS last_opened FROM link_open_events GROUP BY link_kind,link_id
  )
  SELECT l.id,l.code,l.title,l.type,l.kind,l.created_by,COALESCE(v.view_count,0)::int AS views,
  COALESCE(v.unique_viewers,0)::int AS unique_viewers,v.last_opened,
  COALESCE((SELECT json_agg(json_build_object('userId',e.viewer_telegram_id,'username',u.username,'firstName',u.first_name,'lastName',u.last_name,'views',e.count) ORDER BY e.count DESC) FROM
    (SELECT viewer_telegram_id,COUNT(*)::int AS count FROM link_open_events WHERE link_kind=l.kind AND link_id=l.id GROUP BY viewer_telegram_id ORDER BY count DESC LIMIT 10) e
    LEFT JOIN users u ON u.telegram_id=e.viewer_telegram_id), '[]'::json) AS viewers
  FROM all_links l LEFT JOIN views v ON v.link_kind=l.kind AND v.link_id=l.id
  ORDER BY COALESCE(v.view_count,0) DESC,l.created_at DESC LIMIT $1`,[Math.min(Math.max(Number(limit)||50,1),100)]);
  return rows;
}
