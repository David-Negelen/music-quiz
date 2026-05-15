'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = 3000;
const db   = new Database(path.join(__dirname, 'db.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id             TEXT PRIMARY KEY,
    title          TEXT,
    artist         TEXT,
    year           INT,
    artwork_url    TEXT,
    preview_url    TEXT,
    score_title    INT DEFAULT 0,
    score_artist   INT DEFAULT 0,
    score_year     INT DEFAULT 0,
    attempts_title  INT DEFAULT 0,
    attempts_artist INT DEFAULT 0,
    attempts_year   INT DEFAULT 0,
    added_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Prepared statements ────────────────────────────────────────────────────

const stmts = {
  all:    db.prepare('SELECT * FROM songs ORDER BY added_at DESC'),
  get:    db.prepare('SELECT * FROM songs WHERE id = ?'),
  insert: db.prepare(`
    INSERT OR IGNORE INTO songs (id, title, artist, year, artwork_url, preview_url)
    VALUES (@id, @title, @artist, @year, @artwork_url, @preview_url)
  `),
  delete: db.prepare('DELETE FROM songs WHERE id = ?'),
};

const SCORE_FIELDS = new Set([
  'score_title',   'score_artist',   'score_year',
  'attempts_title','attempts_artist','attempts_year',
]);

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

// ── API handler ────────────────────────────────────────────────────────────

async function handleApi(req, res) {
  const { method, url } = req;
  const id = url.replace(/^\/api\/songs\/?/, '').split('?')[0].split('/')[0] || null;

  // GET /api/songs
  if (!id && method === 'GET') {
    return json(res, 200, stmts.all.all());
  }

  // POST /api/songs
  if (!id && method === 'POST') {
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
    stmts.insert.run(row);
    return json(res, 201, stmts.get.get(row.id));
  }

  // DELETE /api/songs/:id
  if (id && method === 'DELETE') {
    stmts.delete.run(id);
    return json(res, 200, { ok: true });
  }

  // PATCH /api/songs/:id
  if (id && method === 'PATCH') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }
    const fields = Object.keys(body).filter(k => SCORE_FIELDS.has(k));
    if (fields.length) {
      const sql = `UPDATE songs SET ${fields.map(f => `${f} = @${f}`).join(', ')} WHERE id = @id`;
      db.prepare(sql).run({ ...Object.fromEntries(fields.map(f => [f, body[f]])), id });
    }
    return json(res, 200, { ok: true });
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
  if (req.url.startsWith('/api/songs')) {
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
