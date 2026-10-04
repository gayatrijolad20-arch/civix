-- Run after schema.sql:  psql "$DATABASE_URL" -f seed.sql

INSERT INTO departments (name) VALUES
  ('Road Maintenance'),
  ('Traffic Maintenance'),
  ('Sanitation Board'),
  ('Electrical Wing'),
  ('Water Supply Dept')
ON CONFLICT (name) DO NOTHING;

-- Areas from the prototype's dropdown. Coordinates are approximate
-- (point is ST_MakePoint(longitude, latitude)); "Sector 9" is a placeholder.
INSERT INTO areas (name, center, radius_m) VALUES
  ('Sector 17',      ST_SetSRID(ST_MakePoint(72.9920, 19.1550), 4326)::geography, 1200),
  ('Kalwa Junction', ST_SetSRID(ST_MakePoint(72.9870, 19.1920), 4326)::geography, 1200),
  ('Airoli Naka',    ST_SetSRID(ST_MakePoint(72.9950, 19.1600), 4326)::geography, 1200),
  ('Sector 9',       ST_SetSRID(ST_MakePoint(72.9980, 19.1650), 4326)::geography, 1200),
  ('Station Road',   ST_SetSRID(ST_MakePoint(72.9980, 19.1480), 4326)::geography, 1200)
ON CONFLICT (name) DO NOTHING;

-- Optional demo issues (the same four as the prototype, no reporter attached).
-- Skip this block in production.
INSERT INTO issues (category, description, priority, status, location, area_id, department_id, upvote_count, resolved_at)
SELECT v.category, v.description, v.priority, v.status,
       ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)::geography,
       (SELECT id FROM areas WHERE name = v.area),
       (SELECT id FROM departments WHERE name = v.dept),
       v.upvotes,
       CASE WHEN v.status = 'Resolved' THEN now() ELSE NULL END
FROM (VALUES
  ('Pothole', 'Huge pothole causing massive traffic congestion near Gate 2.',
   'Critical', 'In Progress', 19.1550, 72.9920, 'Sector 17', 'Road Maintenance', 17),
  ('Damaged Traffic Signal', 'Blinking red light error causing risk of intersection collision.',
   'High', 'In Progress', 19.1920, 72.9870, 'Kalwa Junction', 'Traffic Maintenance', 28),
  ('Garbage Accumulation', 'Uncleaned waste bin overflow near pedestrian crosswalk.',
   'Medium', 'Reported', 19.1480, 72.9980, 'Station Road', 'Sanitation Board', 9),
  ('Broken Streetlight', 'Dark stretch of road at night due to blown light fixture.',
   'Low', 'Resolved', 19.1600, 72.9950, 'Airoli Naka', 'Electrical Wing', 4)
) AS v(category, description, priority, status, lat, lng, area, dept, upvotes);

INSERT INTO issue_status_history (issue_id, status, note)
SELECT id, status, 'Seeded demo data' FROM issues;
