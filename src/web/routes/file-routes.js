// Indexed-file management API routes.
export async function handleFileRoutes({ res, method, pathname, ownerScope, pool, sendJson, disableUnusedFilesForOwner, disableFileByIdOrCode }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/files') {
        const hasOwner = ownerScope !== null && ownerScope !== undefined;
        const whereOwner = hasOwner ? 'AND f.uploaded_by = $1' : '';
        const params = hasOwner ? [Number(ownerScope)] : [];
        const { rows } = await pool.query(
          `SELECT f.id, f.file_code, f.file_name, f.file_type, f.file_size, f.created_at,
                  (
                    (SELECT COUNT(*)::int FROM share_links sl WHERE sl.file_id = f.id) +
                    (SELECT COUNT(*)::int FROM share_link_items sli WHERE sli.file_id = f.id) +
                    (SELECT COUNT(*)::int FROM paid_file_links pfl WHERE pfl.file_id = f.id) +
                    (SELECT COUNT(*)::int FROM paid_batch_items pbi WHERE pbi.file_id = f.id)
                  ) AS link_count
           FROM files f
           WHERE f.status = 'active' ${whereOwner}
           ORDER BY f.created_at DESC
           LIMIT 100`,
          params,
        );
        const files = rows.map((r) => ({
          id: Number(r.id),
          fileCode: r.file_code,
          fileName: r.file_name,
          fileType: r.file_type,
          fileSize: Number(r.file_size || 0),
          linkCount: Number(r.link_count || 0),
          createdAt: r.created_at,
        }));
        return respond(res, 200, {
          files,
          unusedCount: files.filter((f) => f.linkCount === 0).length,
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/files/clean-unused') {
        const removedCount = await disableUnusedFilesForOwner(pool, ownerScope);
        return respond(res, 200, { ok: true, removedCount });
      }
  
      const fileDeleteMatch = pathname.match(/^\/api\/panel\/files\/([A-Za-z0-9_-]{1,32})$/);
      if (method === 'DELETE' && fileDeleteMatch) {
        try {
          const result = await disableFileByIdOrCode(pool, fileDeleteMatch[1], ownerScope);
          if (!result.deleted) return respond(res, 404, { error: 'File not found.' });
          return respond(res, 200, { ok: true });
        } catch (error) {
          return respond(res, 409, { error: error.message });
        }
      }
  return false;
}
