const router = require('express').Router();
const { query } = require('../db');
const { asyncH } = require('../middleware');
const { CATEGORIES, PRIORITIES, STATUSES } = require('../issueQueries');

// Dropdown data for the report form / admin table, so the frontend doesn't hard-code it.
router.get('/meta', asyncH(async (_req, res) => {
  const [depts, areas] = await Promise.all([
    query('SELECT name FROM departments ORDER BY name'),
    query(`SELECT name, ST_Y(center::geometry) AS lat, ST_X(center::geometry) AS lng, radius_m FROM areas ORDER BY name`),
  ]);
  res.json({
    categories: CATEGORIES,
    priorities: PRIORITIES,
    statuses: STATUSES,
    departments: depts.rows.map((r) => r.name),
    areas: areas.rows,
  });
}));

// Public counters for the Home page cards
router.get('/stats', asyncH(async (_req, res) => {
  const { rows: [t] } = await query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'Reported')::int AS pending,
           COUNT(*) FILTER (WHERE status IN ('Assigned', 'In Progress'))::int AS in_progress,
           COUNT(*) FILTER (WHERE status = 'Resolved')::int AS resolved
    FROM issues`);
  res.json(t);
}));

/**
 * "Civic Area Health" score, 0-100, recalculated on every request.
 *
 *   score = 100
 *         - min(open_weight * 2, 60)              open issues, weighted by priority
 *                                                 (Critical 10, High 6, Medium 3, Low 1)
 *         - min(avg_resolution_hours / 24 * 3, 20) slow fixes (3 pts per average day, capped at 20)
 *         + resolved_share_30d * 10               share of the last 30 days' reports now resolved
 *
 * clamped to 0-100. Tweak the weights below to suit your city.
 */
router.get('/areas/health', asyncH(async (_req, res) => {
  const { rows } = await query(`
    WITH s AS (
      SELECT a.id, a.name,
             COUNT(i.id) FILTER (WHERE i.status <> 'Resolved')::int AS open_issues,
             COALESCE(SUM(CASE i.priority WHEN 'Critical' THEN 10 WHEN 'High' THEN 6 WHEN 'Medium' THEN 3 ELSE 1 END)
                      FILTER (WHERE i.status <> 'Resolved'), 0)     AS open_weight,
             COUNT(i.id) FILTER (WHERE i.created_at > now() - interval '30 days')                              AS recent_total,
             COUNT(i.id) FILTER (WHERE i.created_at > now() - interval '30 days' AND i.status = 'Resolved')    AS recent_resolved,
             AVG(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at)) / 3600)
                 FILTER (WHERE i.status = 'Resolved')               AS avg_hours
      FROM areas a
      LEFT JOIN issues i ON i.area_id = a.id
      GROUP BY a.id, a.name
    )
    SELECT name, open_issues,
           ROUND(avg_hours::numeric, 1) AS avg_resolution_hours,
           GREATEST(0, LEAST(100, ROUND(
             100
             - LEAST(open_weight * 2, 60)
             - LEAST(COALESCE(avg_hours, 0) / 24.0 * 3, 20)
             + CASE WHEN recent_total > 0 THEN recent_resolved::numeric / recent_total * 10 ELSE 0 END
           )))::int AS score
    FROM s
    ORDER BY score ASC, name`);

  res.json({
    items: rows.map((r) => ({
      ...r,
      band: r.score >= 80 ? 'good' : r.score >= 55 ? 'moderate' : 'attention', // emerald / amber / rose
    })),
  });
}));

module.exports = router;
