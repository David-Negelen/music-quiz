'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const Database = require('better-sqlite3');

// Load .env if present
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const PORT      = process.env.PORT || 3000;
const dbPath    = process.env.DB_PATH    || path.join(__dirname, 'db.sqlite');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const MAX_BACKUPS = 14;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ── Backup helpers ─────────────────────────────────────────────────────────

function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sqlite'))
    .map(f => {
      const fp   = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fp);
      return { name: f, size: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function pruneBackups() {
  const all = listBackups();
  for (const old of all.slice(MAX_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch {}
  }
}

async function createBackup(label) {
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `backup-${ts}-${label}.sqlite`;
  await db.backup(path.join(BACKUP_DIR, name));
  pruneBackups();
  return name;
}

// Startup backup (fire-and-forget)
createBackup('startup').catch(e => console.error('Startup backup failed:', e.message));

// Daily backup
setInterval(() => {
  createBackup('daily').catch(e => console.error('Daily backup failed:', e.message));
}, 24 * 60 * 60 * 1000);

// ── Schema ─────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id              TEXT PRIMARY KEY,
    title           TEXT,
    artist          TEXT,
    year            INT,
    artwork_url     TEXT,
    preview_url     TEXT,
    score_title     INT DEFAULT 0,
    score_artist    INT DEFAULT 0,
    score_year      INT DEFAULT 0,
    attempts_title  INT DEFAULT 0,
    attempts_artist INT DEFAULT 0,
    attempts_year   INT DEFAULT 0,
    sr_interval     INTEGER DEFAULT 1,
    sr_ease         REAL    DEFAULT 2.5,
    sr_due          TEXT    DEFAULT NULL,
    sr_reviews      INTEGER DEFAULT 0,
    added_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at        DATETIME,
    song_count      INTEGER,
    correct_title   INTEGER,
    correct_artist  INTEGER,
    correct_year    INTEGER
  );

  CREATE TABLE IF NOT EXISTS session_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER REFERENCES sessions(id),
    song_id     TEXT REFERENCES songs(id),
    got_title   INTEGER,
    got_artist  INTEGER,
    got_year    INTEGER,
    answered_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrate: add old SR columns to existing databases
for (const [col, def] of [
  ['sr_interval', 'INTEGER DEFAULT 1'],
  ['sr_ease',     'REAL    DEFAULT 2.5'],
  ['sr_due',      'TEXT    DEFAULT NULL'],
  ['sr_reviews',  'INTEGER DEFAULT 0'],
]) {
  try { db.prepare(`ALTER TABLE songs ADD COLUMN ${col} ${def}`).run(); } catch {}
}

// Migrate: add per-field SR columns
const perFieldSRCols = [
  ['sr_interval_title', 'INTEGER DEFAULT 0'],
  ['sr_interval_artist', 'INTEGER DEFAULT 0'],
  ['sr_interval_year', 'INTEGER DEFAULT 0'],
  ['sr_ease_title', 'REAL DEFAULT 2.5'],
  ['sr_ease_artist', 'REAL DEFAULT 2.5'],
  ['sr_ease_year', 'REAL DEFAULT 2.5'],
  ['sr_due_title', 'TEXT DEFAULT NULL'],
  ['sr_due_artist', 'TEXT DEFAULT NULL'],
  ['sr_due_year', 'TEXT DEFAULT NULL'],
  ['sr_reviews_title', 'INTEGER DEFAULT 0'],
  ['sr_reviews_artist', 'INTEGER DEFAULT 0'],
  ['sr_reviews_year', 'INTEGER DEFAULT 0'],
];

for (const [col, def] of perFieldSRCols) {
  try { db.prepare(`ALTER TABLE songs ADD COLUMN ${col} ${def}`).run(); } catch {}
}

// Migrate: add genre column
try { db.prepare('ALTER TABLE songs ADD COLUMN genre TEXT DEFAULT NULL').run(); } catch {}

// Migrate: track which storefront the preview was fetched from
try { db.prepare('ALTER TABLE songs ADD COLUMN preview_country TEXT DEFAULT NULL').run(); } catch {}

// Migrate: tier tracking fields
for (const [col, def] of [
  ['first_seen',    'TEXT    DEFAULT NULL'],
  ['last_result',   'INTEGER DEFAULT NULL'],
  ['last_reviewed', 'TEXT    DEFAULT NULL'],
  ['streak',        'INTEGER DEFAULT 0'],
]) {
  try { db.prepare(`ALTER TABLE songs ADD COLUMN ${col} ${def}`).run(); } catch {}
}

// Migrate: store actual guesses in session_results
for (const col of ['guess_title', 'guess_artist', 'guess_year']) {
  try { db.prepare(`ALTER TABLE session_results ADD COLUMN ${col} TEXT DEFAULT NULL`).run(); } catch {}
}

// Migrate: backfill tier fields for songs that already have session history
try {
  db.prepare(`
    UPDATE songs SET
      first_seen    = (SELECT date(MIN(answered_at)) FROM session_results WHERE song_id = songs.id),
      last_reviewed = (SELECT date(MAX(answered_at)) FROM session_results WHERE song_id = songs.id),
      last_result   = (SELECT got_title + got_artist + got_year FROM session_results
                       WHERE song_id = songs.id ORDER BY answered_at DESC LIMIT 1)
    WHERE first_seen IS NULL
      AND (SELECT COUNT(*) FROM session_results WHERE song_id = songs.id) > 0
  `).run();
} catch (e) {
  console.error('Tier fields backfill failed:', e.message);
}

// Migrate data from old columns to per-field columns if old columns have data
try {
  const rows = db.prepare('SELECT id, sr_interval, sr_ease, sr_due, sr_reviews FROM songs WHERE sr_interval > 0 OR sr_ease != 2.5 OR sr_due IS NOT NULL OR sr_reviews > 0').all();
  for (const row of rows) {
    db.prepare(`
      UPDATE songs SET
        sr_interval_title = ?, sr_interval_artist = ?, sr_interval_year = ?,
        sr_ease_title = ?, sr_ease_artist = ?, sr_ease_year = ?,
        sr_due_title = ?, sr_due_artist = ?, sr_due_year = ?,
        sr_reviews_title = ?, sr_reviews_artist = ?, sr_reviews_year = ?
      WHERE id = ?
    `).run(
      row.sr_interval, row.sr_interval, row.sr_interval,
      row.sr_ease, row.sr_ease, row.sr_ease,
      row.sr_due, row.sr_due, row.sr_due,
      row.sr_reviews, row.sr_reviews, row.sr_reviews,
      row.id
    );
  }
} catch {}

// Drop old SR columns if migration succeeded
try {
  db.prepare('ALTER TABLE songs DROP COLUMN sr_interval').run();
  db.prepare('ALTER TABLE songs DROP COLUMN sr_ease').run();
  db.prepare('ALTER TABLE songs DROP COLUMN sr_due').run();
  db.prepare('ALTER TABLE songs DROP COLUMN sr_reviews').run();
} catch {}

// Migrate: replay session_results into SR fields for songs that have history but no SR data
// This fixes sessions that were played before per-result SR updates were added.
try {
  const needsRebuild = db.prepare(`
    SELECT DISTINCT sr.song_id
    FROM session_results sr
    JOIN songs s ON s.id = sr.song_id
    WHERE s.sr_due_title IS NULL AND s.sr_due_artist IS NULL AND s.sr_due_year IS NULL
  `).all().map(r => r.song_id);

  if (needsRebuild.length > 0) {
    const getHistory = db.prepare(`
      SELECT got_title, got_artist, got_year, answered_at
      FROM session_results WHERE song_id = ? ORDER BY answered_at ASC
    `);
    const updateSong = (songId, field, interval, ease, reviews, due) => {
      db.prepare(`UPDATE songs SET sr_interval_${field}=?, sr_ease_${field}=?, sr_reviews_${field}=?, sr_due_${field}=? WHERE id=?`)
        .run(interval, ease, reviews, due, songId);
    };

    for (const songId of needsRebuild) {
      const rows = getHistory.all(songId);
      const state = {
        title:  { interval: 0, ease: 2.5, reviews: 0, due: null },
        artist: { interval: 0, ease: 2.5, reviews: 0, due: null },
        year:   { interval: 0, ease: 2.5, reviews: 0, due: null },
      };
      for (const row of rows) {
        const date = row.answered_at.slice(0, 10);
        for (const field of ['title', 'artist', 'year']) {
          const got = row[`got_${field}`] ? 1 : 0;
          const s = state[field];
          const q = got ? 5 : 1;
          if (q >= 3) {
            if      (s.reviews === 0) s.interval = 1;
            else if (s.reviews === 1) s.interval = 3;
            else                      s.interval = Math.round(s.interval * s.ease);
            s.ease    = Math.max(1.3, s.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
            s.reviews = s.reviews + 1;
          } else {
            s.interval = 1;
            s.ease     = Math.max(1.3, s.ease - 0.2);
            s.reviews  = 0;
          }
          const due = new Date(date);
          due.setDate(due.getDate() + s.interval);
          s.due = due.toISOString().split('T')[0];
        }
      }
      for (const field of ['title', 'artist', 'year']) {
        const s = state[field];
        if (s.due) updateSong(songId, field, s.interval, s.ease, s.reviews, s.due);
      }
    }
    console.log(`Rebuilt SR data for ${needsRebuild.length} songs from session history`);
  }
} catch (e) {
  console.error('SR rebuild failed:', e.message);
}

// ── Prepared statements ────────────────────────────────────────────────────

const SCORE_FIELDS = new Set([
  'score_title',   'score_artist',   'score_year',
  'attempts_title','attempts_artist','attempts_year',
  'genre', 'preview_url', 'artwork_url', 'preview_country',
  'title', 'artist', 'year',
]);

const SR_FIELDS = new Set([
  'sr_interval_title', 'sr_interval_artist', 'sr_interval_year',
  'sr_ease_title', 'sr_ease_artist', 'sr_ease_year',
  'sr_due_title', 'sr_due_artist', 'sr_due_year',
  'sr_reviews_title', 'sr_reviews_artist', 'sr_reviews_year',
]);

const SESSION_PATCH_FIELDS = new Set([
  'ended_at', 'song_count', 'correct_title', 'correct_artist', 'correct_year',
]);

const stmts = {
  allSongs:    db.prepare('SELECT * FROM songs ORDER BY added_at DESC'),
  getSong:     db.prepare('SELECT * FROM songs WHERE id = ?'),
  insertSong:  db.prepare(`
    INSERT OR IGNORE INTO songs (id, title, artist, year, artwork_url, preview_url, genre)
    VALUES (@id, @title, @artist, @year, @artwork_url, @preview_url, @genre)
  `),
  deleteSong:  db.prepare('DELETE FROM songs WHERE id = ?'),
  newSession:  db.prepare('INSERT INTO sessions DEFAULT VALUES'),
  listSessions: db.prepare(
    'SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ? OFFSET ?'
  ),
  countSessions: db.prepare('SELECT COUNT(*) as n FROM sessions WHERE ended_at IS NOT NULL'),
  sessionResults: db.prepare(`
    SELECT sr.*, s.title, s.artist, s.artwork_url
    FROM session_results sr
    JOIN songs s ON s.id = sr.song_id
    WHERE sr.session_id = ?
    ORDER BY sr.answered_at
  `),
  insertResult: db.prepare(`
    INSERT INTO session_results (session_id, song_id, got_title, got_artist, got_year, guess_title, guess_artist, guess_year)
    VALUES (@session_id, @song_id, @got_title, @got_artist, @got_year, @guess_title, @guess_artist, @guess_year)
  `),
};

// ── Helpers ────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── SM-2 Scheduling ────────────────────────────────────────────────────────

function updateSR(interval, ease, reviews, got, baseDate) {
  const q = got ? 5 : 1;
  let newInterval, newEase, newReviews;

  if (q >= 3) {
    if      (reviews === 0) newInterval = 1;
    else if (reviews === 1) newInterval = 3;
    else                    newInterval = Math.round(interval * ease);
    newEase    = Math.max(1.3, ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    newReviews = reviews + 1;
  } else {
    newInterval = 1;
    newEase     = Math.max(1.3, ease - 0.2);
    newReviews  = 0;
  }

  const due = baseDate ? new Date(baseDate) : new Date();
  due.setDate(due.getDate() + newInterval);

  return {
    interval: newInterval,
    ease: newEase,
    reviews: newReviews,
    due: due.toISOString().split('T')[0]
  };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function computeSongTier(song) {
  const attempts    = song.attempts_title || 0;
  const correct     = (song.score_title || 0) + (song.score_artist || 0) + (song.score_year || 0);
  const accuracy    = attempts > 0 ? correct / (attempts * 3) : 0;
  const lastResult  = song.last_result != null ? song.last_result : 0;
  if (attempts === 0)                       return 'new';
  if (lastResult <= 1 || accuracy < 0.50)  return 'struggling';
  if (accuracy < 0.80)                      return 'learning';
  return 'mastered';
}

// ── Route handlers ─────────────────────────────────────────────────────────

async function handlePostSong(req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }
  const row = {
    id:          String(body.trackId || body.id),
    title:       body.trackName  || body.title  || null,
    artist:      body.artistName || body.artist || null,
    year:        parseInt(String(body.releaseDate || body.year || '').slice(0, 4)) || null,
    artwork_url: (body.artworkUrl100 || body.artwork || '').replace('100x100bb', '300x300bb'),
    preview_url: body.previewUrl || null,
    genre:       body.primaryGenreName || body.genre || null,
  };
  stmts.insertSong.run(row);
  return json(res, 201, stmts.getSong.get(row.id));
}

async function handlePatchSong(id, req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }
  const fields = Object.keys(body).filter(k => SCORE_FIELDS.has(k));
  if (fields.length) {
    const sql = `UPDATE songs SET ${fields.map(f => `${f} = @${f}`).join(', ')} WHERE id = @id`;
    db.prepare(sql).run({ ...Object.fromEntries(fields.map(f => [f, body[f]])), id });
  }
  return json(res, 200, { ok: true });
}

async function handlePatchSongSR(id, req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }

  // Accept field-specific SR updates: { field: "title"|"artist"|"year", got: 0|1 }
  const field = body.field;
  const got = body.got;

  if (field && typeof got !== 'undefined') {
    if (!['title', 'artist', 'year'].includes(field)) {
      return json(res, 400, { error: 'Invalid field' });
    }

    // Get current SR state for this field
    const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
    if (!song) return json(res, 404, { error: 'Song not found' });

    const interval = song[`sr_interval_${field}`] || 0;
    const ease = song[`sr_ease_${field}`] || 2.5;
    const reviews = song[`sr_reviews_${field}`] || 0;

    // Calculate new SR state
    const newSR = updateSR(interval, ease, reviews, got);

    // Update the database
    db.prepare(`
      UPDATE songs SET
        sr_interval_${field} = ?,
        sr_ease_${field} = ?,
        sr_reviews_${field} = ?,
        sr_due_${field} = ?
      WHERE id = ?
    `).run(newSR.interval, newSR.ease, newSR.reviews, newSR.due, id);

    return json(res, 200, { ok: true, sr: newSR });
  }

  // Legacy support: direct column updates
  const fields = Object.keys(body).filter(k => SR_FIELDS.has(k));
  if (fields.length) {
    const sql = `UPDATE songs SET ${fields.map(f => `${f} = @${f}`).join(', ')} WHERE id = @id`;
    db.prepare(sql).run({ ...Object.fromEntries(fields.map(f => [f, body[f]])), id });
  }
  return json(res, 200, { ok: true });
}

function handleGetSessions(req, res) {
  const qs     = new URL(req.url, 'http://x').searchParams;
  const limit  = Math.min(50, Math.max(1, parseInt(qs.get('limit')  || '10')));
  const offset = Math.max(0,              parseInt(qs.get('offset') || '0'));
  return json(res, 200, {
    rows:  stmts.listSessions.all(limit, offset),
    total: stmts.countSessions.get().n,
  });
}

async function handlePatchSession(id, req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }
  const fields = Object.keys(body).filter(k => SESSION_PATCH_FIELDS.has(k));
  if (fields.length) {
    const sql = `UPDATE sessions SET ${fields.map(f => `${f} = @${f}`).join(', ')} WHERE id = @id`;
    db.prepare(sql).run({ ...Object.fromEntries(fields.map(f => [f, body[f]])), id });
  }
  return json(res, 200, { ok: true });
}

function applySRUpdate(songId, field, got, today) {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
  if (!song) return;
  const newSR = updateSR(
    song[`sr_interval_${field}`] || 0,
    song[`sr_ease_${field}`]     || 2.5,
    song[`sr_reviews_${field}`]  || 0,
    got,
    today,
  );
  db.prepare(`UPDATE songs SET sr_interval_${field}=?, sr_ease_${field}=?, sr_reviews_${field}=?, sr_due_${field}=? WHERE id=?`)
    .run(newSR.interval, newSR.ease, newSR.reviews, newSR.due, songId);
}

async function handlePostSessionResult(sessionId, req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }
  const songId = String(body.song_id);
  const gotTitle  = body.got_title  ? 1 : 0;
  const gotArtist = body.got_artist ? 1 : 0;
  const gotYear   = body.got_year   ? 1 : 0;
  const guessTitle  = body.guess_title  != null ? String(body.guess_title)  : null;
  const guessArtist = body.guess_artist != null ? String(body.guess_artist) : null;
  const guessYear   = body.guess_year   != null ? String(body.guess_year)   : null;
  stmts.insertResult.run({ session_id: parseInt(sessionId), song_id: songId, got_title: gotTitle, got_artist: gotArtist, got_year: gotYear, guess_title: guessTitle, guess_artist: guessArtist, guess_year: guessYear });
  const today = new Date().toISOString().split('T')[0];
  applySRUpdate(songId, 'title',  gotTitle,  today);
  applySRUpdate(songId, 'artist', gotArtist, today);
  applySRUpdate(songId, 'year',   gotYear,   today);
  // Update tier tracking fields
  const songRow  = db.prepare('SELECT first_seen, streak FROM songs WHERE id = ?').get(songId);
  const newResult = gotTitle + gotArtist + gotYear;
  const newStreak = newResult === 3 ? ((songRow && songRow.streak) || 0) + 1 : 0;
  db.prepare(`UPDATE songs SET first_seen=COALESCE(first_seen,?), last_result=?, last_reviewed=?, streak=? WHERE id=?`)
    .run(today, newResult, today, newStreak, songId);
  return json(res, 201, { ok: true });
}

function handleGetSongNetwork(res) {
  const KNOWN_TITLE  = `(CASE WHEN attempts_title  > 0 AND score_title  >= 1 AND CAST(score_title  AS REAL)/attempts_title  >= 0.5 THEN 1 ELSE 0 END)`;
  const KNOWN_ARTIST = `(CASE WHEN attempts_artist > 0 AND score_artist >= 1 AND CAST(score_artist AS REAL)/attempts_artist >= 0.5 THEN 1 ELSE 0 END)`;
  const KNOWN_YEAR   = `(CASE WHEN attempts_year   > 0 AND score_year   >= 1 AND CAST(score_year   AS REAL)/attempts_year   >= 0.5 THEN 1 ELSE 0 END)`;
  const rows = db.prepare(`
    SELECT id, title, artist, attempts_title, kn,
      CASE kn WHEN 0 THEN 'k0' WHEN 1 THEN 'k1' WHEN 2 THEN 'k2' ELSE 'k3' END as tier,
      ROUND(kn / 3.0, 3) as accuracy
    FROM (
      SELECT *, ${KNOWN_TITLE} + ${KNOWN_ARTIST} + ${KNOWN_YEAR} as kn
      FROM songs WHERE attempts_title > 0
    )
    ORDER BY artist, kn
  `).all();
  return json(res, 200, rows);
}

function handleGetStats(res) {
  const totalSongs = db.prepare('SELECT COUNT(*) as n FROM songs').get().n;

  const { count: sessionsPlayed, avg } = db.prepare(
    'SELECT COUNT(*) as count, AVG(song_count) as avg FROM sessions WHERE ended_at IS NOT NULL'
  ).get();

  const uniqueReviewed = db.prepare(
    'SELECT COUNT(DISTINCT song_id) as n FROM session_results'
  ).get().n;

  const krow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN attempts_title  > 0 AND score_title  >= 1
               AND CAST(score_title  AS REAL)/attempts_title  >= 0.5 THEN 1 ELSE 0 END) as known_title,
      SUM(CASE WHEN attempts_artist > 0 AND score_artist >= 1
               AND CAST(score_artist AS REAL)/attempts_artist >= 0.5 THEN 1 ELSE 0 END) as known_artist,
      SUM(CASE WHEN attempts_year   > 0 AND score_year   >= 1
               AND CAST(score_year   AS REAL)/attempts_year   >= 0.5 THEN 1 ELSE 0 END) as known_year
    FROM songs
  `).get();

  const hardestSongs = db.prepare(`
    SELECT id, title, artist, artwork_url,
      score_title, score_artist, score_year,
      attempts_title, attempts_artist, attempts_year
    FROM songs
    WHERE attempts_title + attempts_artist + attempts_year > 0
    ORDER BY (
      COALESCE(CAST(score_title  AS REAL) / NULLIF(attempts_title,  0), 0) +
      COALESCE(CAST(score_artist AS REAL) / NULLIF(attempts_artist, 0), 0) +
      COALESCE(CAST(score_year   AS REAL) / NULLIF(attempts_year,   0), 0)
    ) ASC
    LIMIT 8
  `).all();

  const recentSessions = db.prepare(`
    SELECT id, started_at, ended_at, song_count, correct_title, correct_artist, correct_year
    FROM sessions WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 20
  `).all();

  const allDates = db.prepare(
    `SELECT DISTINCT date(started_at) as d FROM sessions WHERE ended_at IS NOT NULL ORDER BY d`
  ).all().map(r => r.d);

  let bestStreak = allDates.length ? 1 : 0;
  let cur = allDates.length ? 1 : 0;
  for (let i = 1; i < allDates.length; i++) {
    const diff = (new Date(allDates[i]) - new Date(allDates[i - 1])) / 86400000;
    cur = diff === 1 ? cur + 1 : 1;
    if (cur > bestStreak) bestStreak = cur;
  }

  const dueCounts = computeDueCounts();

  // Tier breakdown (mirrors computeSongTier JS logic)
  const ACC = `CAST(COALESCE(score_title,0)+COALESCE(score_artist,0)+COALESCE(score_year,0) AS REAL) / (attempts_title * 3)`;
  const STRUGGLING = `(COALESCE(last_result,0) <= 1 OR ${ACC} < 0.50)`;
  const tierRow = db.prepare(`
    SELECT
      SUM(CASE WHEN attempts_title = 0 THEN 1 ELSE 0 END)                                       AS new_c,
      SUM(CASE WHEN attempts_title > 0 AND (${STRUGGLING})                   THEN 1 ELSE 0 END) AS struggling_c,
      SUM(CASE WHEN attempts_title > 0 AND NOT (${STRUGGLING}) AND ${ACC} < 0.80 THEN 1 ELSE 0 END) AS learning_c,
      SUM(CASE WHEN attempts_title > 0 AND NOT (${STRUGGLING}) AND ${ACC} >= 0.80 THEN 1 ELSE 0 END) AS mastered_c
    FROM songs
  `).get();

  // Per-day activity for the last 91 days (heatmap)
  const activityData = db.prepare(`
    SELECT date(started_at) as day,
           COUNT(*) as sessions,
           SUM(COALESCE(song_count, 0)) as songs
    FROM sessions
    WHERE ended_at IS NOT NULL AND song_count > 0
      AND started_at >= date('now', '-91 days')
    GROUP BY date(started_at)
    ORDER BY day
  `).all();

  return json(res, 200, {
    totalSongs,
    sessionsPlayed,
    avgSessionSize: Math.round(avg || 0),
    uniqueReviewed,
    knowledge: {
      total:    krow.total,
      heard:    uniqueReviewed,
      title:    krow.known_title  || 0,
      artist:   krow.known_artist || 0,
      year:     krow.known_year   || 0,
    },
    tierBreakdown: {
      new:        tierRow.new_c        || 0,
      struggling: tierRow.struggling_c || 0,
      learning:   tierRow.learning_c   || 0,
      mastered:   tierRow.mastered_c   || 0,
    },
    hardestSongs,
    recentSessions,
    bestStreak,
    dueCounts,
    activityData,
  });
}

function handleGetSongHistory(id, res) {
  const rows = db.prepare(`
    SELECT sr.answered_at, sr.got_title, sr.got_artist, sr.got_year,
           sr.guess_title, sr.guess_artist, sr.guess_year, sr.session_id
    FROM session_results sr
    JOIN sessions s ON s.id = sr.session_id
    WHERE sr.song_id = ?
    ORDER BY sr.answered_at ASC
  `).all(id);
  return json(res, 200, rows);
}

function handleGetQueue(req, res) {
  const qs = new URL(req.url, 'http://x').searchParams;
  const countParam  = qs.get('count');
  const batchSize   = countParam ? Math.max(4, parseInt(countParam, 10)) : 0; // 0 = unlimited

  const genresParam = qs.get('genres');
  let allSongs = db.prepare('SELECT * FROM songs ORDER BY added_at ASC').all();
  if (genresParam) {
    const allowed = new Set(genresParam.split(','));
    allSongs = allSongs.filter(s => allowed.has(s.genre || '__unknown__'));
  }

  const unheard = allSongs.filter(s => !s.attempts_title);
  const heard   = allSongs.filter(s =>  s.attempts_title);

  let queue;

  if (unheard.length > 0) {
    // Phase 1: still have songs never quizzed — put them first, shuffle heard songs after
    unheard.sort((a, b) => (a.added_at || '').localeCompare(b.added_at || ''));
    queue = [...unheard, ...shuffleInPlace([...heard])];
  } else {
    // Phase 2: every song heard at least once — apply tier ordering
    const tiers = { struggling: [], learning: [], mastered: [] };
    for (const song of heard) tiers[computeSongTier(song)].push(song);

    tiers.struggling.sort((a, b) => (a.last_reviewed || '').localeCompare(b.last_reviewed || ''));
    tiers.learning.sort((a, b)   => (a.last_reviewed || '').localeCompare(b.last_reviewed || ''));

    queue = [...tiers.struggling, ...tiers.learning, ...shuffleInPlace([...tiers.mastered])];
  }

  if (batchSize > 0) queue = queue.slice(0, batchSize);

  const breakdown = {
    new:       unheard.length > 0 ? Math.min(unheard.length, queue.length) : 0,
    struggling: 0,
    learning:  0,
    mastered:  0,
  };
  if (unheard.length === 0) {
    for (const s of queue) {
      const t = computeSongTier(s);
      if (t !== 'new') breakdown[t]++;
    }
  }

  return json(res, 200, {
    queue,
    breakdown,
    tierCounts: {
      new:       unheard.length,
      struggling: heard.filter(s => computeSongTier(s) === 'struggling').length,
      learning:  heard.filter(s => computeSongTier(s) === 'learning').length,
      mastered:  heard.filter(s => computeSongTier(s) === 'mastered').length,
    },
  });
}

function computeDueCounts(res) {
  const today = new Date().toISOString().split('T')[0];
  const songs = db.prepare('SELECT * FROM songs').all();

  let dueToday = 0, newSongs = 0, learned = 0, notDue = 0;

  for (const song of songs) {
    const isNew = !song.sr_due_title && !song.sr_due_artist && !song.sr_due_year;
    const allDue = [song.sr_due_title, song.sr_due_artist, song.sr_due_year];
    const anyDueNow = allDue.some(d => d && d <= today);
    const allLearned = song.sr_reviews_title >= 3 && song.sr_reviews_artist >= 3 && song.sr_reviews_year >= 3;
    const allFuture = allDue.every(d => d === null || d > today);

    if (isNew) {
      newSongs++;
    } else if (anyDueNow) {
      dueToday++;
    } else if (allLearned && allFuture) {
      learned++;
    } else {
      notDue++;
    }
  }

  return { dueToday, newSongs, learned, notDue };
}

// ── API dispatcher ─────────────────────────────────────────────────────────

async function handleApi(req, res) {
  const { method } = req;
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  // parts = ['api', resource, id?, sub?]
  const resource = parts[1];
  const id       = parts[2] || null;
  const sub      = parts[3] || null;

  if (resource === 'config' && !id && method === 'GET') {
    return json(res, 200, { lastfmKey: process.env.LASTFM_API_KEY || '' });
  }


  if (resource === 'stats' && !id && method === 'GET') {
    const stats = handleGetStats(res);
    // Note: handleGetStats calls json directly, so we return early
    return;
  }

  if (resource === 'audio-proxy' && method === 'GET') {
    const qs  = new URLSearchParams(req.url.split('?')[1] || '');
    const url = qs.get('url') || '';
    if (!/^https?:\/\/[a-z0-9.-]*(apple\.com|mzstatic\.com)\//i.test(url)) {
      return json(res, 400, { error: 'Invalid URL' });
    }
    return new Promise((resolve) => {
      function fetch(target, hops) {
        if (hops > 5) { if (!res.headersSent) json(res, 502, { error: 'Too many redirects' }); return resolve(); }
        const mod = target.startsWith('https') ? https : http;
        mod.get(target, { headers: { 'User-Agent': 'Mozilla/5.0' } }, upstream => {
          const { statusCode, headers: h } = upstream;
          if ([301, 302, 303, 307, 308].includes(statusCode) && h.location) {
            upstream.resume();
            return fetch(h.location, hops + 1);
          }
          res.writeHead(statusCode, {
            'Content-Type': h['content-type'] || 'audio/mpeg',
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
          });
          upstream.pipe(res);
          upstream.on('end', resolve);
          upstream.on('error', resolve);
        }).on('error', () => {
          if (!res.headersSent) json(res, 502, { error: 'Upstream failed' });
          resolve();
        });
      }
      fetch(url, 0);
    });
  }

  if (resource === 'songs') {
    if (!id && method === 'GET')                          return json(res, 200, stmts.allSongs.all());
    if (!id && method === 'POST')                         return handlePostSong(req, res);
    if (id === 'queue'   && method === 'GET')              return handleGetQueue(req, res);
    if (id === 'network' && method === 'GET')             return handleGetSongNetwork(res);
    if (id && !sub && method === 'DELETE')                { stmts.deleteSong.run(id); return json(res, 200, { ok: true }); }
    if (id && !sub && method === 'PATCH')                 return handlePatchSong(id, req, res);
    if (id && sub === 'sr' && method === 'PATCH')         return handlePatchSongSR(id, req, res);
    if (id && sub === 'history' && method === 'GET')      return handleGetSongHistory(id, res);
  }

  if (resource === 'sessions') {
    if (!id && method === 'GET')                          return handleGetSessions(req, res);
    if (!id && method === 'POST')                         { const r = stmts.newSession.run(); return json(res, 201, { id: r.lastInsertRowid }); }
    if (id && !sub && method === 'PATCH')                 return handlePatchSession(id, req, res);
    if (id && sub === 'results' && method === 'GET')      return json(res, 200, stmts.sessionResults.all(id));
    if (id && sub === 'results' && method === 'POST')     return handlePostSessionResult(id, req, res);
  }

  if (resource === 'backups') {
    if (!id && method === 'GET') {
      return json(res, 200, listBackups());
    }
    if (!id && method === 'POST') {
      const name = await createBackup('manual');
      return json(res, 201, { name });
    }
    if (id && !sub && method === 'GET') {
      const name = path.basename(decodeURIComponent(id));
      const fp   = path.join(BACKUP_DIR, name);
      if (!name.endsWith('.sqlite') || !fs.existsSync(fp)) return json(res, 404, { error: 'Not found' });
      const stat = fs.statSync(fp);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': stat.size,
      });
      fs.createReadStream(fp).pipe(res);
      return;
    }
    if (id && !sub && method === 'DELETE') {
      const name = path.basename(decodeURIComponent(id));
      const fp   = path.join(BACKUP_DIR, name);
      if (!name.endsWith('.sqlite') || !fs.existsSync(fp)) return json(res, 404, { error: 'Not found' });
      fs.unlinkSync(fp);
      return json(res, 200, { ok: true });
    }
    if (id && sub === 'restore' && method === 'POST') {
      const name = path.basename(decodeURIComponent(id));
      const fp   = path.join(BACKUP_DIR, name);
      if (!name.endsWith('.sqlite') || !fs.existsSync(fp)) return json(res, 404, { error: 'Not found' });
      await createBackup('pre-restore');
      json(res, 200, { ok: true });
      setTimeout(() => { db.close(); fs.copyFileSync(fp, dbPath); process.exit(0); }, 300);
      return;
    }
  }

  json(res, 404, { error: 'Not found' });
}

// ── Static file server ─────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
};

// ── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    try { await handleApi(req, res); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(__dirname, urlPath));
  if (!filePath.startsWith(__dirname + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Musik Quiz → http://localhost:${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Stop the existing process first.`);
    process.exit(1);
  }
  throw err;
});
