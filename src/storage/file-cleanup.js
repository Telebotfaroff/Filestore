export async function cleanupUnreferencedFiles(pool, fileIds, ownerId = null) {
  const uniqueIds = [
    ...new Set(
      (fileIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
  ];
  if (!uniqueIds.length) return 0;

  const hasOwner = ownerId !== null && ownerId !== undefined;
  const ownerClause = hasOwner ? 'AND f.uploaded_by = $2' : '';
  const params = hasOwner ? [uniqueIds, Number(ownerId)] : [uniqueIds];

  const res = await pool.query(
    `UPDATE files f
     SET status = 'disabled', updated_at = NOW()
     WHERE f.id = ANY($1::bigint[])
       AND f.status = 'active'
       ${ownerClause}
       AND NOT EXISTS (SELECT 1 FROM share_links sl WHERE sl.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM share_link_items sli WHERE sli.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM paid_file_links pfl WHERE pfl.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM paid_batch_items pbi WHERE pbi.file_id = f.id)`,
    params,
  );
  return Number(res?.rowCount ?? 0);
}

export async function disableUnusedFilesForOwner(pool, ownerId = null) {
  const hasOwner = ownerId !== null && ownerId !== undefined;
  const ownerClause = hasOwner ? 'AND f.uploaded_by = $1' : '';
  const params = hasOwner ? [Number(ownerId)] : [];

  const res = await pool.query(
    `UPDATE files f
     SET status = 'disabled', updated_at = NOW()
     WHERE f.status = 'active'
       ${ownerClause}
       AND NOT EXISTS (SELECT 1 FROM share_links sl WHERE sl.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM share_link_items sli WHERE sli.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM paid_file_links pfl WHERE pfl.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM paid_batch_items pbi WHERE pbi.file_id = f.id)`,
    params,
  );
  return Number(res?.rowCount ?? 0);
}

export async function countUnusedFilesForOwner(pool, ownerId = null) {
  const hasOwner = ownerId !== null && ownerId !== undefined;
  const ownerClause = hasOwner ? 'AND f.uploaded_by = $1' : '';
  const params = hasOwner ? [Number(ownerId)] : [];

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM files f
     WHERE f.status = 'active'
       ${ownerClause}
       AND NOT EXISTS (SELECT 1 FROM share_links sl WHERE sl.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM share_link_items sli WHERE sli.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM paid_file_links pfl WHERE pfl.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM paid_batch_items pbi WHERE pbi.file_id = f.id)`,
    params,
  );
  return Number(rows[0]?.total ?? 0);
}

export async function disableFileByIdOrCode(pool, idOrCode, ownerId = null) {
  const raw = String(idOrCode ?? '').trim();
  if (!raw) throw new Error('File ID or code is required.');
  const isNumeric = /^\d+$/.test(raw);
  const col = isNumeric ? 'f.id' : 'f.file_code';
  const val = isNumeric ? Number(raw) : raw.toUpperCase();
  const hasOwner = ownerId !== null && ownerId !== undefined;
  const ownerClause = hasOwner ? 'AND f.uploaded_by = $2' : '';
  const params = hasOwner ? [val, Number(ownerId)] : [val];

  const lookup = await pool.query(
    `SELECT f.id, f.file_code, f.file_name, f.status,
       (EXISTS (SELECT 1 FROM share_links sl WHERE sl.file_id = f.id)
        OR EXISTS (SELECT 1 FROM share_link_items sli WHERE sli.file_id = f.id)
        OR EXISTS (SELECT 1 FROM paid_file_links pfl WHERE pfl.file_id = f.id)
        OR EXISTS (SELECT 1 FROM paid_batch_items pbi WHERE pbi.file_id = f.id)) AS in_use
     FROM files f
     WHERE ${col} = $1 AND f.status = 'active' ${ownerClause}
     LIMIT 1`,
    params,
  );
  if (!lookup.rowCount) return { deleted: false, reason: 'not_found' };
  if (lookup.rows[0].in_use) {
    throw new Error('This file is still attached to an active link. Delete the link first.');
  }
  await pool.query("UPDATE files SET status = 'disabled', updated_at = NOW() WHERE id = $1", [lookup.rows[0].id]);
  return { deleted: true, file: lookup.rows[0] };
}
