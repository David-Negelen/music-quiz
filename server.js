'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = 3000;
const db   = new Database(path.join(__dirname, 'db.sqlite'));

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

// Migrate: add SR columns to existing databases that predate this schema
for (const [col, def] of [
  ['sr_interval', 'INTEGER DEFAULT 1'],
  ['sr_ease',     'REAL    DEFAULT 2.5'],
  ['sr_due',      'TEXT    DEFAULT NULL'],
  ['sr_reviews',  'INTEGER DEFAULT 0'],
]) {
  try { db.prepare(`ALTER TABLE songs ADD COLUMN ${col} ${def}`).run(); } catch {}
}

// ── Prepared statements ────────────────────────────────────────────────────

const SCORE_FIELDS = new Set([
  'score_title',   'score_artist',   'score_year',
  'attempts_title','attempts_artist','attempts_year',
]);

const SR_FIELDS = new Set(['sr_interval', 'sr_ease', 'sr_due', 'sr_reviews']);

const SESSION_PATCH_FIELDS = new Set([
  'ended_at', 'song_count', 'correct_title', 'correct_artist', 'correct_year',
]);

const stmts = {
  allSongs:    db.prepare('SELECT * FROM songs ORDER BY added_at DESC'),
  getSong:     db.prepare('SELECT * FROM songs WHERE id = ?'),
  insertSong:  db.prepare(`
    INSERT OR IGNORE INTO songs (id, title, artist, year, artwork_url, preview_url)
    VALUES (@id, @title, @artist, @year, @artwork_url, @preview_url)
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
    INSERT INTO session_results (session_id, song_id, got_title, got_artist, got_year)
    VALUES (@session_id, @song_id, @got_title, @got_artist, @got_year)
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

async function handlePostSessionResult(sessionId, req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }
  stmts.insertResult.run({
    session_id: parseInt(sessionId),
    song_id:    String(body.song_id),
    got_title:  body.got_title  ? 1 : 0,
    got_artist: body.got_artist ? 1 : 0,
    got_year:   body.got_year   ? 1 : 0,
  });
  return json(res, 201, { ok: true });
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

  return json(res, 200, {
    totalSongs,
    sessionsPlayed,
    avgSessionSize: Math.round(avg || 0),
    uniqueReviewed,
    knowledge: {
      total:  krow.total,
      title:  krow.known_title  || 0,
      artist: krow.known_artist || 0,
      year:   krow.known_year   || 0,
    },
    hardestSongs,
    recentSessions,
    bestStreak,
  });
}

// ── API dispatcher ─────────────────────────────────────────────────────────

async function handleApi(req, res) {
  const { method } = req;
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  // parts = ['api', resource, id?, sub?]
  const resource = parts[1];
  const id       = parts[2] || null;
  const sub      = parts[3] || null;

  if (resource === 'stats' && !id && method === 'GET') return handleGetStats(res);

  if (resource === 'songs') {
    if (!id && method === 'GET')                          return json(res, 200, stmts.allSongs.all());
    if (!id && method === 'POST')                         return handlePostSong(req, res);
    if (id && !sub && method === 'DELETE')                { stmts.deleteSong.run(id); return json(res, 200, { ok: true }); }
    if (id && !sub && method === 'PATCH')                 return handlePatchSong(id, req, res);
    if (id && sub === 'sr' && method === 'PATCH')         return handlePatchSongSR(id, req, res);
  }

  if (resource === 'sessions') {
    if (!id && method === 'GET')                          return handleGetSessions(req, res);
    if (!id && method === 'POST')                         { const r = stmts.newSession.run(); return json(res, 201, { id: r.lastInsertRowid }); }
    if (id && !sub && method === 'PATCH')                 return handlePatchSession(id, req, res);
    if (id && sub === 'results' && method === 'GET')      return json(res, 200, stmts.sessionResults.all(id));
    if (id && sub === 'results' && method === 'POST')     return handlePostSessionResult(id, req, res);
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
