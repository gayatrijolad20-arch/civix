require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');
const { authenticate, errorHandler } = require('./middleware');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set to a random string of at least 32 characters (see .env.example)');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // correct client IPs for rate limiting behind a proxy/load balancer

// CSP is off because the prototype loads Tailwind/Leaflet/Chart.js from CDNs with inline scripts.
// Once you build the frontend properly, turn it back on and whitelist your sources.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (origins.length) app.use(cors({ origin: origins }));

app.use(express.json({ limit: '100kb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api', authenticate);

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/areas'));
app.use('/api', require('./routes/issues'));
app.use('/api', require('./routes/admin'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Uploaded complaint photos + the frontend (drop civix_management_system.html into /public as index.html)
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), { fallthrough: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(errorHandler);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`CIVIX API listening on http://localhost:${port}`));
