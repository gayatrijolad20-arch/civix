const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { HttpError, asyncH, requireAuth, signToken } = require('../middleware');
const { listIssues } = require('../issueQueries');

// Slow down password guessing
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, points: u.points });

// Level 1 = 0-49 pts, +1 level every 50 pts (matches "Level 3 Civic Champion (140 Points)")
const levelFor = (points) => Math.floor(points / 50) + 1;

router.post('/auth/register', authLimiter, asyncH(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Name must be 2-80 characters');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Invalid email address');
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8-128 characters');

  const hash = await bcrypt.hash(password, 12);
  let user;
  try {
    ({ rows: [user] } = await query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       RETURNING id, name, email, role, points`,
      [name, email, hash]
    ));
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists');
    throw err;
  }
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

router.post('/auth/login', authLimiter, asyncH(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const { rows: [user] } = await query(
    'SELECT id, name, email, role, points, password_hash FROM users WHERE email = $1',
    [email]
  );
  // Same message for unknown email and wrong password
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) throw new HttpError(401, 'Invalid email or password');

  res.json({ token: signToken(user), user: publicUser(user) });
}));

// Citizen Hub header + counters
router.get('/me', requireAuth, asyncH(async (req, res) => {
  const { rows: [u] } = await query(
    `SELECT u.id, u.name, u.email, u.role, u.points,
            (SELECT COUNT(*)::int FROM issues       WHERE reporter_id = u.id)                        AS reports,
            (SELECT COUNT(*)::int FROM issue_upvotes WHERE user_id = u.id)                           AS upvoted,
            (SELECT COUNT(*)::int FROM issues       WHERE reporter_id = u.id AND status = 'Resolved') AS resolved
     FROM users u WHERE u.id = $1`,
    [req.user.id]
  );
  if (!u) throw new HttpError(404, 'User not found');
  res.json({ ...publicUser(u), level: levelFor(u.points), stats: { reports: u.reports, upvoted: u.upvoted, resolved: u.resolved } });
}));

// "My Submitted Complaints"
router.get('/me/issues', requireAuth, asyncH(async (req, res) => {
  const items = await listIssues({ userId: req.user.id, reporterId: req.user.id, sort: 'recent', limit: req.query.limit });
  res.json({ items });
}));

module.exports = router;
