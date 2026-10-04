const { query } = require('./db');
const { shortName } = require('./middleware');

const CATEGORIES = [
  'Pothole',
  'Broken Streetlight',
  'Garbage Accumulation',
  'Water Leakage',
  'Damaged Traffic Signal',
];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const STATUSES = ['Reported', 'Assigned', 'In Progress', 'Resolved'];

// $1 is ALWAYS the current user id (or NULL) so has_upvoted can be computed.
const issueSelect = (extraCols = '') => `
  SELECT i.id,
         'CIVIX-' || i.id                    AS code,
         i.category                          AS type,
         a.name                              AS area,
         i.address_text,
         ST_Y(i.location::geometry)          AS lat,
         ST_X(i.location::geometry)          AS lng,
         i.description, i.priority, i.status,
         COALESCE(d.name, 'Unassigned')      AS dept,
         i.upvote_count                      AS upvotes,
         i.photo_url, i.created_at, i.updated_at, i.resolved_at,
         u.name                              AS reporter_name,
         ($1::bigint IS NOT NULL AND EXISTS (
            SELECT 1 FROM issue_upvotes v WHERE v.issue_id = i.id AND v.user_id = $1::bigint
         ))                                  AS has_upvoted
         ${extraCols ? ', ' + extraCols : ''}
  FROM issues i
  LEFT JOIN areas a       ON a.id = i.area_id
  LEFT JOIN departments d ON d.id = i.department_id
  LEFT JOIN users u       ON u.id = i.reporter_id`;

// Same field names the prototype's `complaints` array uses, plus extras.
function mapIssue(r) {
  return {
    id: r.code,
    type: r.type,
    location: r.area || 'Unmapped area',
    address: r.address_text,
    lat: r.lat,
    lng: r.lng,
    description: r.description,
    priority: r.priority,
    status: r.status,
    dept: r.dept,
    upvotes: r.upvotes,
    photoUrl: r.photo_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
    reporter: shortName(r.reporter_name),
    hasUpvoted: r.has_upvoted,
    ...(r.distance_m !== undefined && r.distance_m !== null
      ? { distanceM: Math.round(r.distance_m) }
      : {}),
  };
}

const POINT = (lngParam, latParam) =>
  `ST_SetSRID(ST_MakePoint(${lngParam}::float8, ${latParam}::float8), 4326)::geography`;

async function getIssue(id, userId = null) {
  const { rows } = await query(`${issueSelect()} WHERE i.id = $2`, [userId, id]);
  return rows[0] ? mapIssue(rows[0]) : null;
}

async function getHistory(id) {
  const { rows } = await query(
    `SELECT status, note, changed_at FROM issue_status_history
     WHERE issue_id = $1 ORDER BY changed_at, id`,
    [id]
  );
  return rows.map((r) => ({ status: r.status, note: r.note, at: r.changed_at }));
}

/**
 * Flexible list/search used by the public feed, the map, "my reports" and the admin table.
 * opts: userId, lat, lng, radius, status, category, area, reporterId, q, sort, limit, offset
 */
async function listIssues(opts = {}) {
  const params = [opts.userId ?? null]; // $1
  const where = [];
  let extra = '';
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  const hasGeo = Number.isFinite(opts.lat) && Number.isFinite(opts.lng);
  if (hasGeo) {
    const lngP = add(opts.lng); // $2
    const latP = add(opts.lat); // $3
    extra = `ST_Distance(i.location, ${POINT(lngP, latP)}) AS distance_m`;
    if (opts.radius) {
      where.push(`ST_DWithin(i.location, ${POINT(lngP, latP)}, ${add(opts.radius)}::float8)`);
    }
  }
  if (opts.status) where.push(`i.status = ${add(opts.status)}`);
  if (opts.category) where.push(`i.category = ${add(opts.category)}`);
  if (opts.area) where.push(`a.name = ${add(opts.area)}`);
  if (opts.reporterId) where.push(`i.reporter_id = ${add(opts.reporterId)}`);
  if (opts.q) {
    const like = `%${String(opts.q).replace(/[%_\\]/g, '\\$&')}%`;
    const p = add(like);
    where.push(`(('CIVIX-' || i.id) ILIKE ${p} OR i.category ILIKE ${p} OR a.name ILIKE ${p})`);
  }

  const ORDER = {
    recent: 'i.created_at DESC',
    upvotes: 'i.upvote_count DESC, i.created_at DESC',
    priority: `CASE i.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, i.upvote_count DESC`,
    distance: hasGeo ? 'distance_m ASC' : 'i.created_at DESC',
  };
  const orderBy = ORDER[opts.sort] || ORDER.recent;

  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), opts.maxLimit || 100);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);

  const sql = `${issueSelect(extra)}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}
    LIMIT ${add(limit)} OFFSET ${add(offset)}`;

  const { rows } = await query(sql, params);
  return rows.map(mapIssue);
}

// Open issues of the same category within `radiusM` metres of a point.
async function findDuplicates(client, { lat, lng, category, radiusM }) {
  const { rows } = await client.query(
    `SELECT 'CIVIX-' || i.id AS id, i.category AS type, i.status, i.upvote_count AS upvotes,
            i.description,
            ST_Distance(i.location, ${POINT('$1', '$2')}) AS distance_m
     FROM issues i
     WHERE i.category = $3
       AND i.status <> 'Resolved'
       AND ST_DWithin(i.location, ${POINT('$1', '$2')}, $4::float8)
     ORDER BY distance_m
     LIMIT 5`,
    [lng, lat, category, radiusM]
  );
  return rows.map((r) => ({ ...r, distanceM: Math.round(r.distance_m), distance_m: undefined }));
}

module.exports = {
  CATEGORIES,
  PRIORITIES,
  STATUSES,
  POINT,
  getIssue,
  getHistory,
  listIssues,
  findDuplicates,
};
