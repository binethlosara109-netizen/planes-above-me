-- Visitors per day and country (no personal data, just counts).
CREATE TABLE IF NOT EXISTS visits (
  day TEXT NOT NULL,
  country TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, country)
);

-- How many aircraft people saw in each ~1° area ("busiest skies").
CREATE TABLE IF NOT EXISTS skies (
  area TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  planes INTEGER NOT NULL,
  ts INTEGER NOT NULL
);

-- Spotting leaderboard: one row per aircraft type a nickname has spotted.
CREATE TABLE IF NOT EXISTS spots (
  nick TEXT NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (nick, type)
);

-- Error reports from visitors' browsers.
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  msg TEXT NOT NULL,
  page TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS errors_ts ON errors (ts);
