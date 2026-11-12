-- Flight following: one session per followed flight, with its recorded track and events.
-- A session has its own ID; callsign (DLH400), flight number (LH400) and ICAO24
-- address (3c6444) are different things and only describe it.

CREATE TABLE IF NOT EXISTS flight_sessions (
  id TEXT PRIMARY KEY,               -- e.g. "dlh400-3c6444-202611120930"
  icao24 TEXT NOT NULL,
  callsign TEXT,
  registration TEXT,
  type_code TEXT,
  origin TEXT,                       -- ICAO airport code, if known (from adsbdb)
  destination TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | landed | lost | ended
  phase TEXT,                        -- latest inferred phase
  started_at INTEGER NOT NULL,       -- ms
  last_seen_at INTEGER,              -- ms, time of the latest observation
  ended_at INTEGER,
  points INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS flight_sessions_status ON flight_sessions (status, started_at);

-- Observed data only: exactly what the aircraft reported, with the source's timestamp.
CREATE TABLE IF NOT EXISTS track_points (
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,               -- ms, when the position was observed
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  alt_ft INTEGER,                    -- barometric altitude
  gs_kt INTEGER,
  track_deg INTEGER,
  vrate_fpm INTEGER,
  on_ground INTEGER NOT NULL DEFAULT 0,
  squawk TEXT,
  source TEXT NOT NULL DEFAULT 'adsb.lol',
  PRIMARY KEY (session_id, ts)       -- repeated observations are ignored (dedupe)
);

-- Derived information: phases and events the app inferred from observed data.
CREATE TABLE IF NOT EXISTS flight_events (
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- takeoff | climb | cruise | descent | approach | landing | signal_lost | signal_regained | squawk | started
  detail TEXT,
  inferred INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, ts, kind)
);
