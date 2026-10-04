const router = require('express').Router();
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, tx } = require('../db');
const { HttpError, asyncH, requireAuth, parseCode, parseLatLng } = require('../middleware');
const {
  CATEGORIES, PRIORITIES, STATUSES, POINT,
  getIssue, getHistory, listIssues, findDuplicates,
} = require('../issueQueries');

// ---------------------------------------------------------------- photo upload
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + EXT[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Photo must be a JPEG, PNG or WebP image')),
});
const removeFile = (file) => file && fs.unlink(file.path, () => {});

const DUP_RADIUS = Number(process.env.DUPLICATE_RADIUS_M) || 50;

// ---------------------------------------------------------------- duplicate check
// GET /api/issues/duplicates?lat=..&lng=..&category=Pothole
// Called as soon as the user picks a location so the UI can show the "Similar issue already reported" card.
router.get('/issues/duplicates', asyncH(async (req, res) => {
  const pt = parseLatLng(req.query.lat, req.query.lng);
  if (!pt) throw new HttpError(400, 'Valid lat and lng are required');
  if (!CATEGORIES.includes(req.query.category)) throw new HttpError(400, 'Invalid category');
  const duplicates = await findDuplicates({ query }, { ...pt, category: req.query.category, radiusM: DUP_RADIUS });
  res.json({ duplicates });
}));

// ---------------------------------------------------------------- list / map feed
// GET /api/issues?lat&lng&radius&status&category&area&sort=recent|upvotes|distance|priority&limit&offset
router.get('/issues', asyncH(async (req, res) => {
  const { status, category, area, sort } = req.query;
  if (status && !STATUSES.includes(status)) throw new HttpError(400, 'Invalid status');
  if (category && !CATEGORIES.includes(category)) throw new HttpError(400, 'Invalid category');

  const pt = parseLatLng(req.query.lat, req.query.lng);
  if ((req.query.lat || req.query.lng) && !pt) throw new HttpError(400, 'Invalid lat/lng');
  const radius = Math.min(Number(req.query.radius) || 5000, 50000);

  const items = await listIssues({
    userId: req.user?.id,
    ...(pt || {}),
    radius: pt ? radius : undefined,
    status, category, area, sort,
    limit: req.query.limit, offset: req.query.offset,
  });
  res.json({ items });
}));

// ---------------------------------------------------------------- report an issue
// POST /api/issues   (multipart/form-data)  fields: category, description, priority, lat, lng, address, force, photo
router.post('/issues', requireAuth, upload.single('photo'), asyncH(async (req, res) => {
  try {
    const { category, description: rawDesc, priority = 'Medium', address, force } = req.body;
    const description = String(rawDesc || '').trim();
    const pt = parseLatLng(req.body.lat, req.body.lng);

    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Invalid category');
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'Invalid priority');
    if (description.length < 10 || description.length > 2000) throw new HttpError(400, 'Description must be 10-2000 characters');
    if (!pt) throw new HttpError(400, 'Valid lat and lng are required');

    // Smart duplicate detection: ask the client to confirm before creating a second report.
    if (force !== 'true' && force !== true) {
      const duplicates = await findDuplicates({ query }, { ...pt, category, radiusM: DUP_RADIUS });
      if (duplicates.length) {
        throw new HttpError(409, 'Similar issue already reported nearby', { duplicates });
      }
    }

    const photoUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const id = await tx(async (c) => {
      // Nearest area whose radius contains the point (may be none)
      const { rows: [area] } = await c.query(
        `SELECT id FROM areas
         WHERE ST_DWithin(center, ${POINT('$1', '$2')}, radius_m)
         ORDER BY ST_Distance(center, ${POINT('$1', '$2')}) LIMIT 1`,
        [pt.lng, pt.lat]
      );

      const { rows: [issue] } = await c.query(
        `INSERT INTO issues (category, description, priority, location, address_text, area_id, reporter_id, photo_url)
         VALUES ($1, $2, $3, ${POINT('$4', '$5')}, $6, $7, $8, $9)
         RETURNING id`,
        [category, description, priority, pt.lng, pt.lat, address ? String(address).slice(0, 255) : null,
         area?.id ?? null, req.user.id, photoUrl]
      );

      // The reporter's own report counts as the first upvote (trigger bumps upvote_count)
      await c.query('INSERT INTO issue_upvotes (issue_id, user_id) VALUES ($1, $2)', [issue.id, req.user.id]);
      await c.query(
        `INSERT INTO issue_status_history (issue_id, status, note, changed_by) VALUES ($1, 'Reported', 'Complaint submitted', $2)`,
        [issue.id, req.user.id]
      );
      await c.query('UPDATE users SET points = points + 10 WHERE id = $1', [req.user.id]);
      return issue.id;
    });

    res.status(201).json(await getIssue(id, req.user.id));
  } catch (err) {
    removeFile(req.file); // don't keep orphaned uploads when we reject the report
    throw err;
  }
}));

// ---------------------------------------------------------------- track one complaint
// GET /api/issues/CIVIX-1031  -> issue + timeline for the stepper
router.get('/issues/:code', asyncH(async (req, res) => {
  const id = parseCode(req.params.code);
  if (!id) throw new HttpError(400, 'Invalid tracking code');
  const issue = await getIssue(id, req.user?.id);
  if (!issue) throw new HttpError(404, 'No complaint found with that tracking code');
  res.json({ ...issue, timeline: await getHistory(id) });
}));

// ---------------------------------------------------------------- upvote / un-upvote
// Optional "local citizens only" rule: body { lat, lng } must be within UPVOTE_MAX_DISTANCE_M of the issue.
router.post('/issues/:code/upvote', requireAuth, asyncH(async (req, res) => {
  const id = parseCode(req.params.code);
  if (!id) throw new HttpError(400, 'Invalid tracking code');

  const requireLoc = process.env.UPVOTE_REQUIRE_LOCATION === 'true';
  const pt = parseLatLng(req.body?.lat, req.body?.lng);
  if (requireLoc && !pt) throw new HttpError(400, 'Location is required to upvote');

  const result = await tx(async (c) => {
    const { rows: [issue] } = await c.query('SELECT id, status FROM issues WHERE id = $1', [id]);
    if (!issue) throw new HttpError(404, 'Issue not found');

    if (pt) {
      const maxM = Number(process.env.UPVOTE_MAX_DISTANCE_M) || 5000;
      const { rows: [near] } = await c.query(
        `SELECT ST_DWithin(location, ${POINT('$2', '$3')}, $4::float8) AS ok FROM issues WHERE id = $1`,
        [id, pt.lng, pt.lat, maxM]
      );
      if (!near.ok) throw new HttpError(403, 'You can only upvote issues near your location');
    }

    const ins = await c.query(
      'INSERT INTO issue_upvotes (issue_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, req.user.id]
    );
    if (ins.rowCount) await c.query('UPDATE users SET points = points + 1 WHERE id = $1', [req.user.id]);
    const { rows: [row] } = await c.query('SELECT upvote_count FROM issues WHERE id = $1', [id]);
    return { upvotes: row.upvote_count, hasUpvoted: true, alreadyVoted: !ins.rowCount };
  });
  res.json(result);
}));

router.delete('/issues/:code/upvote', requireAuth, asyncH(async (req, res) => {
  const id = parseCode(req.params.code);
  if (!id) throw new HttpError(400, 'Invalid tracking code');
  await query('DELETE FROM issue_upvotes WHERE issue_id = $1 AND user_id = $2', [id, req.user.id]);
  const { rows: [row] } = await query('SELECT upvote_count FROM issues WHERE id = $1', [id]);
  if (!row) throw new HttpError(404, 'Issue not found');
  res.json({ upvotes: row.upvote_count, hasUpvoted: false });
}));

module.exports = router;
