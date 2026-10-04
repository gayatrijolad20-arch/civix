const jwt = require('jsonwebtoken');

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Express 4 doesn't catch rejected promises, so wrap async handlers.
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Attaches req.user if a valid Bearer token is present; never rejects.
function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.user = { id: Number(payload.sub), role: payload.role };
    } catch (_) {
      /* invalid/expired token -> treated as anonymous */
    }
  }
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
}

function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Admin access required'));
  next();
}

const signToken = (user) =>
  jwt.sign({ sub: String(user.id), role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

// 'CIVIX-1031' -> 1031 (or null if malformed)
function parseCode(code) {
  const m = /^CIVIX-(\d{1,15})$/i.exec(String(code || '').trim());
  return m ? Number(m[1]) : null;
}

// Validates lat/lng and returns numbers, or null.
function parseLatLng(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat === undefined || lng === undefined || lat === '' || lng === '') return null;
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  return { lat: la, lng: ln };
}

// "Priya Sharma" -> "Priya S."  (don't expose full names publicly)
function shortName(name) {
  if (!name) return 'Anonymous';
  const [first, second] = String(name).trim().split(/\s+/);
  return second ? `${first} ${second[0].toUpperCase()}.` : first;
}

function errorHandler(err, _req, res, _next) {
  if (err.status) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Photo must be 5 MB or smaller' });
  if (err.name === 'MulterError') return res.status(400).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Already exists' }); // unique violation
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = {
  HttpError,
  asyncH,
  authenticate,
  requireAuth,
  requireAdmin,
  signToken,
  parseCode,
  parseLatLng,
  shortName,
  errorHandler,
};
