# CIVIX backend

Node.js + Express API on PostgreSQL/PostGIS for the CIVIX civic-issue portal
(potholes, streetlights, sanitation, water, traffic signals; geolocated; upvoted by citizens).

## Setup

```bash
# 1. PostgreSQL 14+ with PostGIS (Docker is the easiest way)
docker run -d --name civix-db -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=civix postgis/postgis:16-3.4

# 2. Install + configure
npm install
cp .env.example .env          # set JWT_SECRET (32+ random chars) and DATABASE_URL

# 3. Create tables and seed departments, areas and demo issues
npm run db:init               # needs psql; or run schema.sql then seed.sql in any SQL client

# 4. Create your first admin account
npm run create-admin -- "Admin" admin@city.gov 'a-strong-password'

# 5. Run
npm run dev                   # http://localhost:3000
```

The prototype is already wired up at `public/index.html` (login/register modal, real GPS, duplicate check, upvotes, tracking, citizen hub and admin portal all call the API). The same server serves it, so there is no CORS setup.

## Database

| Table | Purpose |
|---|---|
| `users` | citizens and admins (bcrypt hashes, role, points) |
| `departments` | Road Maintenance, Traffic Maintenance, Sanitation Board, Electrical Wing, Water Supply Dept |
| `areas` | sector name + centre point + radius, used for area health scores |
| `issues` | the reports; `location` is `GEOGRAPHY(Point,4326)` with a GiST index |
| `issue_upvotes` | one row per (issue, user); the primary key makes double voting impossible |
| `issue_status_history` | feeds the Reported -> Assigned -> In Progress -> Resolved timeline |

Triggers keep `issues.upvote_count` and `updated_at` current. The public tracking ID is `'CIVIX-' || id` (ids start at 1000).

## API

All paths are under `/api`. Send `Authorization: Bearer <token>` where auth is needed.

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/auth/register` | - | `{name, email, password}` -> `{token, user}` |
| POST | `/auth/login` | - | `{email, password}` -> `{token, user}` |
| GET | `/me` | user | Citizen Hub header: points, level, counters |
| GET | `/me/issues` | user | "My Submitted Complaints" |
| GET | `/meta` | - | categories, priorities, statuses, departments, areas (fill dropdowns) |
| GET | `/issues/duplicates?lat&lng&category` | - | open same-category issues within `DUPLICATE_RADIUS_M` (default 50 m) |
| GET | `/issues?lat&lng&radius&status&category&area&sort&limit&offset` | optional | community feed and map markers; `sort=recent\|upvotes\|distance\|priority` |
| POST | `/issues` | user | multipart: `category, description, priority, lat, lng, address, photo, force`. Returns **409 + `duplicates`** if a similar open issue is nearby, unless `force=true` |
| GET | `/issues/CIVIX-1031` | - | one issue plus `timeline` (Track tab) |
| POST / DELETE | `/issues/CIVIX-1031/upvote` | user | add or remove your vote |
| GET | `/stats` | - | public totals for the Home cards |
| GET | `/areas/health` | - | live 0-100 score per area (formula documented in `routes/areas.js`) |
| GET | `/admin/stats` | admin | KPI cards, category chart, 7-day resolved trend |
| GET | `/admin/issues?q&status&category` | admin | management table |
| PATCH | `/admin/issues/CIVIX-1031` | admin | `{status?, department?, priority?, note?}` |
| DELETE | `/admin/issues/CIVIX-1031` | admin | remove a report |
| GET | `/admin/export.csv` | admin | CSV export |

Issue objects use the same field names as the prototype's `complaints` array
(`id, type, location, lat, lng, description, priority, status, dept, upvotes, reporter`) plus
`createdAt`, `photoUrl`, `hasUpvoted` and (for geo queries) `distanceM`.

## Before going live

- **Not yet run against a live database.** I only syntax-checked the JS here, so run `db:init` and try each endpoint once before relying on it.
- Serve over HTTPS and keep `JWT_SECRET` out of version control.
- Photos are stored on local disk (`uploads/`). For multiple servers or real traffic, switch to S3 or similar object storage.
- Location is self-reported by the browser and can be spoofed. `UPVOTE_REQUIRE_LOCATION=true` raises the bar for "local citizens only" voting but isn't proof.
- The seeded area coordinates are approximate and "Sector 9" is a placeholder; replace them with real data.
