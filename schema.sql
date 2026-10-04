-- =====================================================================
-- CIVIX database schema  (PostgreSQL 14+ with PostGIS)
-- Run:  psql "$DATABASE_URL" -f schema.sql
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- Users (citizens + municipal admins)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT        NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  email         CITEXT      NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'citizen' CHECK (role IN ('citizen', 'admin')),
  points        INT         NOT NULL DEFAULT 0,          -- "Civic Champion" points
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Municipal departments (issues get assigned to one)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id   SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------
-- Areas / sectors (used for the "Civic Area Health" score).
-- Each area is a centre point + radius; an issue joins the nearest area
-- whose radius contains it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS areas (
  id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  center   GEOGRAPHY(Point, 4326) NOT NULL,
  radius_m INT NOT NULL DEFAULT 1500 CHECK (radius_m > 0)
);

-- ---------------------------------------------------------------------
-- Issues  (public tracking code = 'CIVIX-' || id, ids start at 1000)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issues (
  id            BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 1000) PRIMARY KEY,
  category      TEXT NOT NULL CHECK (category IN (
                  'Pothole', 'Broken Streetlight', 'Garbage Accumulation',
                  'Water Leakage', 'Damaged Traffic Signal')),
  description   TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 2000),
  priority      TEXT NOT NULL DEFAULT 'Medium'
                CHECK (priority IN ('Low', 'Medium', 'High', 'Critical')),
  status        TEXT NOT NULL DEFAULT 'Reported'
                CHECK (status IN ('Reported', 'Assigned', 'In Progress', 'Resolved')),
  location      GEOGRAPHY(Point, 4326) NOT NULL,          -- lng/lat of the problem
  address_text  TEXT,
  area_id       INT      REFERENCES areas(id)       ON DELETE SET NULL,
  department_id SMALLINT REFERENCES departments(id) ON DELETE SET NULL,
  reporter_id   BIGINT   REFERENCES users(id)       ON DELETE SET NULL,
  photo_url     TEXT,
  upvote_count  INT NOT NULL DEFAULT 0,                    -- maintained by trigger
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS issues_location_gix ON issues USING GIST (location);
CREATE INDEX IF NOT EXISTS issues_status_idx   ON issues (status);
CREATE INDEX IF NOT EXISTS issues_category_idx ON issues (category);
CREATE INDEX IF NOT EXISTS issues_area_idx     ON issues (area_id);
CREATE INDEX IF NOT EXISTS issues_reporter_idx ON issues (reporter_id);
CREATE INDEX IF NOT EXISTS issues_created_idx  ON issues (created_at DESC);

-- ---------------------------------------------------------------------
-- Upvotes: one vote per citizen per issue (composite PK enforces it)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issue_upvotes (
  issue_id   BIGINT      NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id    BIGINT      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX IF NOT EXISTS issue_upvotes_user_idx ON issue_upvotes (user_id);

-- ---------------------------------------------------------------------
-- Status history: powers the "Resolution Timeline" on the Track tab
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issue_status_history (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id   BIGINT      NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  status     TEXT        NOT NULL,
  note       TEXT,
  changed_by BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issue_history_issue_idx ON issue_status_history (issue_id, changed_at);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_issues_updated_at ON issues;
CREATE TRIGGER trg_issues_updated_at
  BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keep issues.upvote_count in sync with issue_upvotes
CREATE OR REPLACE FUNCTION sync_upvote_count() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE issues SET upvote_count = upvote_count + 1 WHERE id = NEW.issue_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE issues SET upvote_count = GREATEST(upvote_count - 1, 0) WHERE id = OLD.issue_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_upvote_count ON issue_upvotes;
CREATE TRIGGER trg_upvote_count
  AFTER INSERT OR DELETE ON issue_upvotes
  FOR EACH ROW EXECUTE FUNCTION sync_upvote_count();
