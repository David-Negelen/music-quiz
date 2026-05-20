// ── State ─────────────────────────────────────────────────────────────────

const state = {
  library: [],
  searchResults: [],
  quizQuestions: [],
  quizIndex: 0,
  quizScore: 0,
  quizStreak: 0,
  quizAnswers: [],
  quizConfig: { count: null },
  preMastery: {},
  currentSessionId: null,
  sessionStartTime: 0,
  historyOffset: 0,
  librarySort: 'title',
};

const audio = document.getElementById('preview-audio');
let timerInterval = null;
let timerSeconds = 30;
let progressInterval = null;

// Visualizer
let animFrameId = null;
let currentVolume = 1;

function startVisualizer() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  const canvas = document.getElementById('visualizer');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = (canvas.offsetWidth || 360) * dpr;
  canvas.height = (canvas.offsetHeight || 160) * dpr;

  const ctx2d = canvas.getContext('2d');
  const N = 72;
  const freq = Array.from({ length: N }, () => 0.6 + Math.random() * 0.8);
  const phase = Array.from({ length: N }, () => Math.random() * Math.PI * 2);
  let t = 0;

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    const W = canvas.width;
    const H = canvas.height;
    const gap = 2 * dpr;
    const barW = (W - gap * (N - 1)) / N;

    ctx2d.clearRect(0, 0, W, H);

    ctx2d.fillStyle = 'rgba(252, 60, 68, 0.12)';
    ctx2d.fillRect(0, H / 2 - dpr, W, 2 * dpr);

    if (audio.paused) return;

    t += 0.035;
    const playhead = (audio.duration && !isNaN(audio.duration)) ? audio.currentTime / audio.duration : 0;
    for (let i = 0; i < N; i++) {
      const v = Math.max(0.04,
        (Math.sin(t * freq[i] + phase[i]) * 0.35 + 0.55) *
        (Math.sin(t * freq[i] * 0.45 + phase[i] * 1.3) * 0.2 + 0.8)
      );
      const halfH = Math.max(2 * dpr, v * H * 0.44);
      ctx2d.fillStyle = (i / N < playhead) ? '#ff5252' : 'rgba(255,82,82,0.28)';
      ctx2d.fillRect(i * (barW + gap), H / 2 - halfH, barW, halfH * 2);
    }
    // Playhead vertical line
    const px = playhead * W;
    ctx2d.fillStyle = '#ff5252';
    ctx2d.fillRect(px - dpr, 0, 2 * dpr, H);
  }

  draw();
}

// ── Answer checking ───────────────────────────────────────────────────────

function normalizeAnswer(str) {
  return String(str)
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAnswerCorrect(userInput, correct, type) {
  if (type === 'year') return userInput.trim() === String(correct).trim();
  const a = normalizeAnswer(userInput);
  const b = normalizeAnswer(correct);
  const stripThe = s => s.replace(/^the\s+/, '');
  return a === b || stripThe(a) === stripThe(b);
}

// ── Stats & Mastery ───────────────────────────────────────────────────────

let songStats = {};

function recordAnswer(id, type, correct) {
  const key = String(id);
  if (!songStats[key]) songStats[key] = {};
  if (!songStats[key][type]) songStats[key][type] = { a: 0, c: 0 };
  songStats[key][type].a++;
  if (correct) songStats[key][type].c++;
  const st = songStats[key][type];
  fetch(`/api/songs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [`score_${type}`]: st.c, [`attempts_${type}`]: st.a }),
  }).catch(() => {});
}

// Mastery: 'unheard' | 's0' | 's1' | 's2' | 's3'
// Score = number of question types the user knows (title, artist, year)
// A type is "known" if: at least 1 correct AND ≥50% correct overall
const MASTERY_LABEL = { unheard: 'Unheard', s0: '0 / 3', s1: '1 / 3', s2: '2 / 3', s3: '3 / 3' };

function getMastery(id) {
  const key = String(id);
  const s = songStats[key];
  if (!s) return 'unheard';
  let hasAny = false;
  let known = 0;
  for (const type of ['title', 'artist', 'year']) {
    const st = s[type];
    if (st && st.a > 0) {
      hasAny = true;
      if (st.c >= 1 && st.c / st.a >= 0.5) known++;
    }
  }
  return hasAny ? `s${known}` : 'unheard';
}

function getMasteryStats() {
  const counts = { unheard: 0, s0: 0, s1: 0, s2: 0, s3: 0 };
  state.library.forEach(s => counts[getMastery(s.id)]++);
  return counts;
}

function getFieldMastery(id) {
  const key = String(id);
  const s = songStats[key];
  const result = {};
  for (const type of ['title', 'artist', 'year']) {
    const st = s && s[type];
    if (!st || st.a === 0) result[type] = 'unheard';
    else if (st.c >= 1 && st.c / st.a >= 0.5) result[type] = 'known';
    else result[type] = 'wrong';
  }
  return result;
}

function knowledgeScore(id) {
  const s = songStats[String(id)];
  if (!s) return -1;
  const a = (s.title?.a || 0) + (s.artist?.a || 0) + (s.year?.a || 0);
  if (!a) return -1;
  return ((s.title?.c || 0) + (s.artist?.c || 0) + (s.year?.c || 0)) / a;
}

function getFieldAccuracyStats() {
  const total = state.library.length;
  if (!total) return { title: null, artist: null, year: null };
  const result = {};
  for (const type of ['title', 'artist', 'year']) {
    let known = 0;
    for (const song of state.library) {
      const st = songStats[String(song.id)]?.[type];
      if (st && st.a > 0 && st.c >= 1 && st.c / st.a >= 0.5) known++;
    }
    result[type] = Math.round((known / total) * 100);
  }
  return result;
}

// ── Persistence ───────────────────────────────────────────────────────────

async function loadLibrary() {
  try {
    const res = await fetch('/api/songs');
    const rows = await res.json();
    state.library = rows.map(r => ({
      id:         r.id,
      title:      r.title,
      artist:     r.artist,
      year:       r.year != null ? String(r.year) : '????',
      artwork:    r.artwork_url || '',
      previewUrl: r.preview_url || '',
      genre:      r.genre || '',
      // Per-field SR for title
      srInterval_title: r.sr_interval_title || 0,
      srEase_title:     r.sr_ease_title     || 2.5,
      srDue_title:      r.sr_due_title      || null,
      srReviews_title:  r.sr_reviews_title  || 0,
      // Per-field SR for artist
      srInterval_artist: r.sr_interval_artist || 0,
      srEase_artist:     r.sr_ease_artist     || 2.5,
      srDue_artist:      r.sr_due_artist      || null,
      srReviews_artist:  r.sr_reviews_artist  || 0,
      // Per-field SR for year
      srInterval_year: r.sr_interval_year || 0,
      srEase_year:     r.sr_ease_year     || 2.5,
      srDue_year:      r.sr_due_year      || null,
      srReviews_year:  r.sr_reviews_year  || 0,
    }));
    songStats = {};
    for (const r of rows) {
      if (r.attempts_title || r.attempts_artist || r.attempts_year) {
        songStats[r.id] = {
          title:  { a: r.attempts_title  || 0, c: r.score_title  || 0 },
          artist: { a: r.attempts_artist || 0, c: r.score_artist || 0 },
          year:   { a: r.attempts_year   || 0, c: r.score_year   || 0 },
        };
      }
    }
  } catch {
    state.library = [];
    songStats = {};
  }
}

function inLibrary(id) {
  return state.library.some(s => s.id === id);
}

async function addToLibrary(song) {
  if (inLibrary(song.id)) return;
  song = await resolveOriginalYear(song);
  state.library.push(song);
  renderLibrary();
  updateLibraryStatus();
  document.querySelectorAll(`.add-btn[data-id="${song.id}"]`).forEach(btn => {
    btn.classList.add('added');
    btn.disabled = true;
    btn.title = 'Added';
  });
  try {
    await fetch('/api/songs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(song),
    });
  } catch {
    state.library = state.library.filter(s => s.id !== song.id);
    renderLibrary();
    updateLibraryStatus();
    document.querySelectorAll(`.add-btn[data-id="${song.id}"]`).forEach(btn => {
      btn.classList.remove('added');
      btn.disabled = false;
      btn.title = 'Add to library';
    });
  }
}

async function removeFromLibrary(id) {
  state.library = state.library.filter(s => s.id !== id);
  delete songStats[String(id)];
  renderLibrary();
  updateLibraryStatus();
  document.querySelectorAll(`.add-btn[data-id="${id}"]`).forEach(btn => {
    btn.classList.remove('added');
    btn.disabled = false;
    btn.title = 'Add to library';
  });
  await fetch(`/api/songs/${id}`, { method: 'DELETE' }).catch(() => {});
}

// ── iTunes Search API ─────────────────────────────────────────────────────

async function searchSongs(query) {
  const makeUrl = attr =>
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=30${attr}`;

  const [r1, r2] = await Promise.all([
    fetch(makeUrl('&attribute=artistTerm')),
    fetch(makeUrl('')),
  ]);

  if (!r1.ok && !r2.ok) throw new Error('Search failed');

  const [d1, d2] = await Promise.all([
    r1.ok ? r1.json() : { results: [] },
    r2.ok ? r2.json() : { results: [] },
  ]);

  const toSongs = data =>
    (data.results || [])
      .filter(r => r.previewUrl)
      .map(r => ({
        id: r.trackId,
        title: r.trackName,
        artist: r.artistName,
        album: r.collectionName || '',
        year: r.releaseDate ? r.releaseDate.slice(0, 4) : '????',
        previewUrl: r.previewUrl,
        artwork: (r.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
        genre: r.primaryGenreName || '',
      }));

  // Artist-matched results first, then general — deduplicate by id
  const seen = new Set();
  const results = [];
  for (const song of [...toSongs(d1), ...toSongs(d2)]) {
    if (!seen.has(song.id)) { seen.add(song.id); results.push(song); }
  }
  return results;
}

async function resolveOriginalYear(song) {
  if (!/remaster/i.test(song.title)) return song;

  const cleanTitle = song.title
    .replace(/\s*[\(\[][^\)\]]*remaster[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*[^-]*remaster\w*/gi, '')
    .trim();

  if (!cleanTitle) return song;

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle + ' ' + song.artist)}&media=music&entity=song&limit=50`;
    const res = await fetch(url);
    if (!res.ok) return song;
    const data = await res.json();

    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const titleNorm  = norm(cleanTitle);
    const artistNorm = norm(song.artist);

    const years = (data.results || [])
      .filter(r => r.releaseDate && norm(r.trackName) === titleNorm && norm(r.artistName) === artistNorm)
      .map(r => parseInt(r.releaseDate.slice(0, 4)))
      .filter(y => !isNaN(y));

    if (years.length > 0) {
      const earliest = Math.min(...years);
      if (earliest < parseInt(song.year)) return { ...song, year: String(earliest) };
    }
  } catch {}

  return song;
}

// ── Study Session ─────────────────────────────────────────────────────────

const TYPE_LABELS = { title: 'Song title', artist: 'Artist', year: 'Release year' };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function buildStudySession() {
  const { count, genres } = state.quizConfig;

  try {
    const qs = new URLSearchParams();
    if (count !== null) qs.append('count', count);
    if (genres !== null) qs.append('genres', genres.join(','));
    const res = await fetch(`/api/songs/queue?${qs}`);
    const data = await res.json();
    const songs = data.queue || [];
    
    if (data.note) {
      console.log('Queue note:', data.note);
    }
    
    if (!songs.length) return null;
    return songs.map(raw => ({
      song: {
        id:         raw.id,
        title:      raw.title,
        artist:     raw.artist,
        album:      raw.album || '',
        year:       raw.year != null ? String(raw.year) : '????',
        artwork:    raw.artwork_url || '',
        previewUrl: raw.preview_url || '',
        genre:      raw.genre || '',
        srInterval_title: raw.sr_interval_title || 0,
        srEase_title:     raw.sr_ease_title     || 2.5,
        srDue_title:      raw.sr_due_title      || null,
        srReviews_title:  raw.sr_reviews_title  || 0,
        srInterval_artist: raw.sr_interval_artist || 0,
        srEase_artist:     raw.sr_ease_artist     || 2.5,
        srDue_artist:      raw.sr_due_artist      || null,
        srReviews_artist:  raw.sr_reviews_artist  || 0,
        srInterval_year: raw.sr_interval_year || 0,
        srEase_year:     raw.sr_ease_year     || 2.5,
        srDue_year:      raw.sr_due_year      || null,
        srReviews_year:  raw.sr_reviews_year  || 0,
      },
      submitted: false,
    }));
  } catch (e) {
    console.error('Failed to build study session:', e);
    return null;
  }
}

// ── Audio Player ──────────────────────────────────────────────────────────

function stopAudio() {
  audio.pause();
  audio.src = '';
  clearInterval(timerInterval);
  clearInterval(progressInterval);
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

function startAudio(url) {
  stopAudio();
  audio.src = url;
  audio.volume = currentVolume;

  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const progressFill = document.getElementById('progress-fill');
  const timerDisplay = document.getElementById('timer-display');

  function updateProgress() {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    progressFill.style.width = `${pct}%`;
    const remaining = Math.max(0, Math.ceil(audio.duration - audio.currentTime));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timerDisplay.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }

  progressInterval = setInterval(updateProgress, 250);

  // Use property assignment so each new song replaces the previous handler
  audio.onplay = () => { playIcon.textContent = '⏸'; };
  audio.onpause = () => { playIcon.textContent = '▶'; };
  audio.onended = () => {
    playIcon.textContent = '▶';
    progressFill.style.width = '100%';
    timerDisplay.textContent = '0:00';
  };

  playBtn.onclick = () => {
    if (!audio.paused) { audio.pause(); return; }
    audio.play().catch(() => {});
  };

  startVisualizer();
  audio.play().catch(() => { playIcon.textContent = '▶'; });
}

// ── Views ─────────────────────────────────────────────────────────────────

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name || (name.startsWith('quiz') && b.dataset.view === 'quiz-setup'));
  });
  if (!name.startsWith('quiz')) stopAudio();
}

// ── Render: Search Results ────────────────────────────────────────────────

function renderSearchResults(songs) {
  const container = document.getElementById('search-results');
  if (!songs.length) {
    container.innerHTML = '<p class="hint" style="padding:8px 0">No results found.</p>';
    return;
  }
  container.innerHTML = songs.map(song => {
    const added = inLibrary(song.id);
    return `
      <div class="song-card">
        <img src="${song.artwork}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="song-card-info">
          <div class="song-card-title" title="${esc(song.title)}">${esc(song.title)}</div>
          <div class="song-card-sub">${esc(song.artist)} · ${song.year}</div>
        </div>
        <button class="add-btn ${added ? 'added' : ''}" data-id="${song.id}" data-idx="${songs.indexOf(song)}"
          title="${added ? 'Added' : 'Add to library'}" ${added ? 'disabled' : ''}>
          ${added ? '' : '<span>+</span>'}
        </button>
      </div>`;
  }).join('');

  container.querySelectorAll('.add-btn:not(.added)').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      addToLibrary(state.searchResults[idx]);
    });
  });
}

// ── Render: Library ───────────────────────────────────────────────────────

function renderLibrary() {
  const list = document.getElementById('library-songs');
  const empty = document.getElementById('library-empty');
  const count = document.getElementById('library-count');

  count.textContent = state.library.length;

  if (!state.library.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  const sorted = [...state.library].sort((a, b) => {
    if (state.librarySort === 'artist')    return a.artist.localeCompare(b.artist);
    if (state.librarySort === 'year')      return (a.year || 0) - (b.year || 0);
    if (state.librarySort === 'knowledge') return knowledgeScore(a.id) - knowledgeScore(b.id);
    if (state.librarySort === 'added')     return 0; // DB returns newest-first already
    return a.title.localeCompare(b.title); // default: title
  });
  list.innerHTML = sorted.map((song) => {
    const fm = getFieldMastery(song.id);
    const mark = s => s === 'known' ? '✓' : '✗';
    const tooltip = `Title ${mark(fm.title)} · Artist ${mark(fm.artist)} · Year ${mark(fm.year)}`;
    return `
    <div class="song-row">
      <img src="${song.artwork}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="song-row-info">
        <div class="song-row-title">${esc(song.title)}</div>
        <div class="song-row-sub">${esc(song.artist)} · ${song.year}</div>
      </div>
      <span class="mastery-dots" title="${tooltip}">
        <span class="mastery-dot-field mastery-field-${fm.title}"></span>
        <span class="mastery-dot-field mastery-field-${fm.artist}"></span>
        <span class="mastery-dot-field mastery-field-${fm.year}"></span>
      </span>
      <button class="history-btn" data-id="${song.id}" title="View history"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg></button>
      <button class="remove-btn" data-id="${song.id}" title="Remove">×</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeFromLibrary(Number(btn.dataset.id)));
  });

  list.querySelectorAll('.history-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const song = state.library.find(s => String(s.id) === btn.dataset.id);
      if (song) openSongHistory(song);
    });
  });
}

function renderMasteryOverview() {
  const el = document.getElementById('mastery-overview');
  if (!el) return;
  if (!state.library.length) { el.innerHTML = ''; return; }

  const today = new Date().toISOString().slice(0, 10);
  let dueToday = 0, newSongs = 0, learned = 0, notDue = 0;

  for (const s of state.library) {
    // New: all three sr_due_* are null
    const isNew = !s.srDue_title && !s.srDue_artist && !s.srDue_year;
    
    if (isNew) {
      newSongs++;
    } else {
      // Check if any field is due today
      const fields = ['title', 'artist', 'year'];
      const anyDue = fields.some(f => {
        const due = s[`srDue_${f}`];
        return due && due <= today;
      });

      if (anyDue) {
        dueToday++;
      } else {
        // Check if learned: all three have >= 3 reviews and all are in future
        const allLearned = 
          (s.srReviews_title >= 3) && (s.srReviews_artist >= 3) && (s.srReviews_year >= 3);
        const allFuture = 
          (!s.srDue_title || s.srDue_title > today) &&
          (!s.srDue_artist || s.srDue_artist > today) &&
          (!s.srDue_year || s.srDue_year > today);
        
        if (allLearned && allFuture) {
          learned++;
        } else {
          notDue++;
        }
      }
    }
  }

  el.innerHTML = `<p class="sr-due-line">Due today: <span class="sr-due-count">${dueToday}</span> &nbsp;·&nbsp; New: <span class="sr-due-count">${newSongs}</span> &nbsp;·&nbsp; Learned: <span class="sr-due-count">${learned}</span> &nbsp;·&nbsp; Not due: <span class="sr-due-count">${notDue}</span></p>`;
}

function renderGenreFilter() {
  const group = document.getElementById('genre-filter-group');
  const container = document.getElementById('genre-checkboxes');
  if (!group || !container) return;

  // Collect genres from library
  const counts = {};
  for (const s of state.library) {
    const g = s.genre || '__unknown__';
    counts[g] = (counts[g] || 0) + 1;
  }
  const genres = Object.keys(counts).sort((a, b) => {
    if (a === '__unknown__') return 1;
    if (b === '__unknown__') return -1;
    return a.localeCompare(b);
  });

  // Hide if only one distinct genre bucket
  if (genres.length <= 1) { group.style.display = 'none'; return; }
  group.style.display = 'block';

  // Restore saved selection from localStorage
  let saved;
  try { saved = JSON.parse(localStorage.getItem('musik-quiz-genres')); } catch {}
  const savedSet = saved ? new Set(saved) : null;

  container.innerHTML = genres.map(g => {
    const label = g === '__unknown__' ? 'Unknown' : g;
    const checked = savedSet ? savedSet.has(g) : true;
    return `<label class="checkbox-label">
      <input type="checkbox" class="genre-cb" value="${esc(g)}" ${checked ? 'checked' : ''}>
      <span>${esc(label)} <span class="genre-count">(${counts[g]})</span></span>
    </label>`;
  }).join('');

  // Save selection on change
  container.querySelectorAll('.genre-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = [...container.querySelectorAll('.genre-cb')].filter(c => c.checked).map(c => c.value);
      localStorage.setItem('musik-quiz-genres', JSON.stringify(checked));
    });
  });
}

function updateLibraryStatus() {
  const el = document.getElementById('library-status');
  const n = state.library.length;
  if (n === 0) el.textContent = 'Add songs to your library first.';
  else if (n < 2) el.textContent = `${n} song in library — add at least one more to start.`;
  else el.textContent = `${n} songs in library.`;
  renderMasteryOverview();
  renderGenreFilter();
}

// ── Render: Study Question ────────────────────────────────────────────────

function getDropdownItems(type, query) {
  if (type === 'year') return [];
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const field = type === 'title' ? 'title' : 'artist';
  const seen = new Set();
  const results = [];
  for (const s of state.library) {
    const val = s[field];
    if (seen.has(val)) continue;
    if (val.toLowerCase().includes(q)) {
      seen.add(val);
      results.push({ main: val, sub: null, value: val });
    }
  }
  return results.slice(0, 8);
}

function showDropdown(ddEl, items, inputEl) {
  ddEl.innerHTML = items.map((item, i) =>
    `<li data-value="${esc(item.value)}" data-idx="${i}">
      <span class="ac-main">${esc(item.main)}</span>
      ${item.sub ? `<span class="ac-sub">${esc(item.sub)}</span>` : ''}
    </li>`
  ).join('');
  ddEl.style.display = 'block';
  ddEl.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', e => {
      e.preventDefault();
      inputEl.value = li.dataset.value;
      ddEl.style.display = 'none';
      ddEl.innerHTML = '';
    });
  });
}

function hideAllDropdowns() {
  for (const type of ['title', 'artist', 'year']) {
    const dd = document.getElementById(`dropdown-${type}`);
    if (dd) { dd.style.display = 'none'; dd.innerHTML = ''; }
  }
}

function navigateDropdownEl(ddEl, dir) {
  if (!ddEl || ddEl.style.display === 'none') return;
  const items = [...ddEl.querySelectorAll('li')];
  if (!items.length) return;
  const activeIdx = items.findIndex(li => li.classList.contains('ac-active'));
  items.forEach(li => li.classList.remove('ac-active'));
  const next = activeIdx === -1 ? (dir > 0 ? 0 : items.length - 1) : (activeIdx + dir + items.length) % items.length;
  items[next].classList.add('ac-active');
  items[next].scrollIntoView({ block: 'nearest' });
}

function renderQuestion() {
  const q = state.quizQuestions[state.quizIndex];
  const total = state.quizQuestions.length;

  document.getElementById('quiz-progress').textContent = `${state.quizIndex + 1} / ${total}`;
  const progressFillEl = document.getElementById('quiz-progress-fill');
  if (progressFillEl) progressFillEl.style.width = `${((state.quizIndex + 1) / total) * 100}%`;
  document.getElementById('quiz-score').textContent = `${state.quizScore} pts`;
  document.getElementById('next-btn').style.display = 'none';
  const submitBtn = document.getElementById('submit-answer-btn');
  submitBtn.style.display = 'block';
  submitBtn.disabled = false;

  for (const type of ['title', 'artist', 'year']) {
    const input = document.getElementById(`answer-${type}`);
    const dd = document.getElementById(`dropdown-${type}`);
    const resultEl = document.getElementById(`result-${type}`);

    input.value = '';
    input.disabled = false;
    input.className = 'answer-input';
    dd.style.display = 'none';
    dd.innerHTML = '';
    resultEl.textContent = '';
    resultEl.className = 'field-result';
    const hintEl = document.getElementById(`hint-${type}`);
    if (hintEl) hintEl.textContent = '';

    input.oninput = () => {
      if (state.quizQuestions[state.quizIndex].submitted) return;
      const items = getDropdownItems(type, input.value);
      if (items.length) showDropdown(dd, items, input);
      else { dd.style.display = 'none'; dd.innerHTML = ''; }
    };

    input.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (dd.style.display !== 'none') {
          e.preventDefault();
          navigateDropdownEl(dd, e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
      }
      if (e.key === 'Escape') { dd.style.display = 'none'; dd.innerHTML = ''; return; }
      if (e.key === 'Enter') {
        const active = dd.querySelector('li.ac-active');
        if (active) {
          input.value = active.dataset.value;
          dd.style.display = 'none';
          dd.innerHTML = '';
        } else {
          handleAnswer();
        }
      }
    };

    input.onblur = () => { dd.style.display = 'none'; dd.innerHTML = ''; };
  }

  submitBtn.onclick = handleAnswer;
  setTimeout(() => document.getElementById('answer-title').focus(), 50);

  if (q.song.previewUrl) startAudio(q.song.previewUrl);
  else startVisualizer();
}

function handleAnswer() {
  const q = state.quizQuestions[state.quizIndex];
  if (q.submitted) return;
  q.submitted = true;

  hideAllDropdowns();
  stopAudio();

  const values = {
    title: document.getElementById('answer-title').value.trim(),
    artist: document.getElementById('answer-artist').value.trim(),
    year: document.getElementById('answer-year').value.trim(),
  };

  const correct = {
    title: isAnswerCorrect(values.title, q.song.title, 'title'),
    artist: isAnswerCorrect(values.artist, q.song.artist, 'artist'),
    year: isAnswerCorrect(values.year, q.song.year, 'year'),
  };

  const correctCount = Object.values(correct).filter(Boolean).length;
  state.quizScore += correctCount * 10;
  if (correctCount === 3) { state.quizStreak++; fireConfetti(); } else { state.quizStreak = 0; }
  updateStreakDisplay();
  state.quizAnswers.push({ song: q.song, correct });

  for (const type of ['title', 'artist', 'year']) {
    recordAnswer(q.song.id, type, correct[type]);
  }

  document.getElementById('quiz-score').textContent = `${state.quizScore} pts`;

  const answers = { title: q.song.title, artist: q.song.artist, year: q.song.year };
  for (const type of ['title', 'artist', 'year']) {
    const input = document.getElementById(`answer-${type}`);
    const resultEl = document.getElementById(`result-${type}`);
    input.disabled = true;
    const hintEl = document.getElementById(`hint-${type}`);
    if (correct[type]) {
      input.value = answers[type];
      input.className = 'answer-input correct';
      resultEl.textContent = '✓';
      resultEl.className = 'field-result correct';
      if (hintEl) hintEl.textContent = '';
    } else {
      input.className = 'answer-input wrong';
      resultEl.textContent = '✗';
      resultEl.className = 'field-result wrong';
      if (hintEl) hintEl.textContent = answers[type];
    }
  }

  document.getElementById('submit-answer-btn').style.display = 'none';
  document.getElementById('next-btn').style.display = 'block';
}

async function advanceQuiz() {
  const idx = state.quizIndex;
  const q   = state.quizQuestions[idx];
  const ans = state.quizAnswers[idx];

  if (ans) {
    applySmTwo(q.song, ans.correct);

    if (state.currentSessionId) {
      fetch(`/api/sessions/${state.currentSessionId}/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          song_id:    q.song.id,
          got_title:  ans.correct.title  ? 1 : 0,
          got_artist: ans.correct.artist ? 1 : 0,
          got_year:   ans.correct.year   ? 1 : 0,
        }),
      }).catch(() => {});
    }
  }

  state.quizIndex++;
  if (state.quizIndex >= state.quizQuestions.length) {
    await closeSession();
    showReview();
  } else {
    renderQuestion();
  }
}

function applySmTwo(song, correct) {
  // correct = { title, artist, year } - booleans
  const fields = ['title', 'artist', 'year'];
  
  // Update local state for each field and make parallel PATCH calls
  const updates = fields.map(field => {
    const got = correct[field] ? 1 : 0;
    const interval = song[`srInterval_${field}`] || 0;
    const ease = song[`srEase_${field}`] || 2.5;
    const reviews = song[`srReviews_${field}`] || 0;

    // Calculate new SR state using SM-2
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

    const due = new Date();
    due.setDate(due.getDate() + newInterval);
    const newDue = due.toISOString().split('T')[0];

    // Update local state
    song[`srInterval_${field}`] = newInterval;
    song[`srEase_${field}`] = newEase;
    song[`srReviews_${field}`] = newReviews;
    song[`srDue_${field}`] = newDue;

    // Return fetch promise
    return fetch(`/api/songs/${song.id}/sr`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, got }),
    }).catch(() => {});
  });

  // Fire all updates in parallel but don't wait for them
  Promise.all(updates).catch(() => {});
}

function closeSession() {
  if (!state.currentSessionId) return Promise.resolve();
  const answers = state.quizAnswers;
  return fetch(`/api/sessions/${state.currentSessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ended_at:       new Date().toISOString(),
      song_count:     answers.length,
      correct_title:  answers.filter(a => a.correct.title).length,
      correct_artist: answers.filter(a => a.correct.artist).length,
      correct_year:   answers.filter(a => a.correct.year).length,
    }),
  }).catch(() => {});
}

// ── Review (post-session screen) ──────────────────────────────────────────

function showReview() {
  showView('results');

  const answers = state.quizAnswers;
  const elapsed = Math.round((Date.now() - state.sessionStartTime) / 60000);
  const n = answers.length;

  document.getElementById('review-subtitle').textContent =
    `${n} song${n !== 1 ? 's' : ''} · ${elapsed} min`;

  const totals = { title: 0, artist: 0, year: 0 };
  for (const a of answers) {
    for (const t of ['title', 'artist', 'year']) if (a.correct[t]) totals[t]++;
  }

  document.getElementById('review-stat-boxes').innerHTML = `
    <div class="review-stat-box"><span class="review-stat-num">${totals.title}/${n}</span><span class="review-stat-label">Title</span></div>
    <div class="review-stat-box"><span class="review-stat-num">${totals.artist}/${n}</span><span class="review-stat-label">Artist</span></div>
    <div class="review-stat-box"><span class="review-stat-num">${totals.year}/${n}</span><span class="review-stat-label">Year</span></div>
  `;

  const allGood = answers.filter(a => a.correct.title && a.correct.artist && a.correct.year);
  const missed  = answers.filter(a => !(a.correct.title && a.correct.artist && a.correct.year));

  const songRow = a => `
    <div class="review-song-row">
      <img src="${esc(a.song.artwork)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" width="32" height="32">
      <div class="review-song-info">
        <div class="review-song-title">${esc(a.song.title)}</div>
        <div class="review-song-sub">${esc(a.song.artist)}</div>
      </div>
      <span class="review-dots">
        <span class="review-dot ${a.correct.title  ? 'got' : 'miss'}"></span>
        <span class="review-dot ${a.correct.artist ? 'got' : 'miss'}"></span>
        <span class="review-dot ${a.correct.year   ? 'got' : 'miss'}"></span>
      </span>
    </div>`;

  let html = '';
  if (missed.length) {
    html += `<div class="review-group">
      <div class="review-group-label">Missed something &middot; ${missed.length}</div>
      ${missed.map(songRow).join('')}
    </div>`;
  }
  if (allGood.length) {
    html += `<details class="review-group">
      <summary class="review-group-label">Got all 3 &middot; ${allGood.length}</summary>
      ${allGood.map(songRow).join('')}
    </details>`;
  }

  document.getElementById('review-song-list').innerHTML = html || '<p class="hint" style="padding:12px 14px">No songs this session.</p>';
}

// ── Stats page ────────────────────────────────────────────────────────────

async function renderStats() {
  let data;
  try {
    const res = await fetch('/api/stats');
    data = await res.json();
  } catch {
    document.getElementById('stats-overview').innerHTML = '<p class="hint">Could not load stats.</p>';
    return;
  }

  document.getElementById('stats-overview').innerHTML = `
    <div class="stat-chip"><span class="stat-num">${data.totalSongs}</span><span class="stat-label">Songs</span></div>
    <div class="stat-chip"><span class="stat-num">${data.sessionsPlayed}</span><span class="stat-label">Sessions</span></div>
    <div class="stat-chip"><span class="stat-num">${data.uniqueReviewed}</span><span class="stat-label">Reviewed</span></div>
    <div class="stat-chip"><span class="stat-num">${data.avgSessionSize}</span><span class="stat-label">Avg size</span></div>
  `;

  const kn = data.knowledge;
  const total = Math.max(kn.total, 1);
  document.getElementById('stats-knowledge').innerHTML = ['title', 'artist', 'year'].map(t => {
    const known = kn[t] || 0;
    const pct   = Math.round((known / total) * 100);
    return `<div class="knowledge-bar-row">
      <span class="knowledge-bar-label">${t.charAt(0).toUpperCase() + t.slice(1)}</span>
      <div class="knowledge-bar-track"><div class="knowledge-bar-fill" style="width:${pct}%"></div></div>
      <span class="knowledge-bar-pct">${pct}%</span>
      <span class="knowledge-bar-sub">${known} of ${kn.total}</span>
    </div>`;
  }).join('');

  if (data.hardestSongs.length) {
    document.getElementById('stats-hardest').innerHTML = data.hardestSongs.map(s => {
      const fm = {
        title:  s.attempts_title  > 0 ? (s.score_title  >= 1 && s.score_title  / s.attempts_title  >= 0.5 ? 'known' : 'wrong') : 'unheard',
        artist: s.attempts_artist > 0 ? (s.score_artist >= 1 && s.score_artist / s.attempts_artist >= 0.5 ? 'known' : 'wrong') : 'unheard',
        year:   s.attempts_year   > 0 ? (s.score_year   >= 1 && s.score_year   / s.attempts_year   >= 0.5 ? 'known' : 'wrong') : 'unheard',
      };
      return `<div class="song-row">
        <img src="${esc(s.artwork_url || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="song-row-info">
          <div class="song-row-title">${esc(s.title)}</div>
          <div class="song-row-sub">${esc(s.artist)}</div>
        </div>
        <span class="mastery-dots">
          <span class="mastery-dot-field mastery-field-${fm.title}"></span>
          <span class="mastery-dot-field mastery-field-${fm.artist}"></span>
          <span class="mastery-dot-field mastery-field-${fm.year}"></span>
        </span>
      </div>`;
    }).join('');
  } else {
    document.getElementById('stats-hardest').innerHTML = '<p class="hint" style="padding:8px 0">No data yet — play some sessions first.</p>';
  }

  document.getElementById('stats-streak').innerHTML = `
    <div class="streak-display">
      <span class="streak-num">${data.bestStreak}</span>
      <span class="streak-label">day${data.bestStreak !== 1 ? 's' : ''} best streak</span>
    </div>`;

  setTimeout(() => drawSessionsChart(data.recentSessions), 0);

  state.historyOffset = 0;
  await loadSessionHistory(false);
}

function drawSessionsChart(sessions) {
  const canvas = document.getElementById('stats-chart');
  if (!canvas) return;
  const reversed = [...sessions].reverse();
  if (!reversed.length) { canvas.style.display = 'none'; return; }
  canvas.style.display = 'block';

  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth || 620;
  const H   = 80;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const maxCount = Math.max(...reversed.map(s => s.song_count || 0), 1);
  const n = reversed.length;
  const gap  = 3;
  const barW = Math.max(4, (W - gap * (n + 1)) / n);

  reversed.forEach((s, i) => {
    const correct  = (s.correct_title || 0) + (s.correct_artist || 0) + (s.correct_year || 0);
    const possible = (s.song_count || 0) * 3;
    const pct  = possible > 0 ? correct / possible : 0;
    const barH = Math.max(2, ((s.song_count || 0) / maxCount) * (H - 8));
    const x    = gap + i * (barW + gap);
    const y    = H - barH;

    ctx.fillStyle = `rgba(29, 206, 150, ${0.25 + pct * 0.75})`;
    ctx.fillRect(x, y, barW, barH);
  });
}

async function loadSessionHistory(append) {
  const container   = document.getElementById('stats-history');
  const loadMoreBtn = document.getElementById('stats-load-more');
  if (!container) return;

  try {
    const res = await fetch(`/api/sessions?limit=10&offset=${state.historyOffset}`);
    const { rows, total } = await res.json();

    if (!append) container.innerHTML = '';

    if (!rows.length && !append) {
      container.innerHTML = '<p class="hint" style="padding:8px 0">No sessions yet.</p>';
      loadMoreBtn.style.display = 'none';
      return;
    }

    for (const session of rows) {
      const el  = document.createElement('div');
      el.className  = 'history-session';
      el.dataset.id = session.id;

      const raw     = session.started_at.includes('Z') ? session.started_at : session.started_at.replace(' ', 'T') + 'Z';
      const dt      = new Date(raw);
      const dateStr = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) +
        ' · ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const n    = session.song_count || 0;
      const tPct = n ? Math.round(((session.correct_title  || 0) / n) * 100) : 0;
      const aPct = n ? Math.round(((session.correct_artist || 0) / n) * 100) : 0;
      const yPct = n ? Math.round(((session.correct_year   || 0) / n) * 100) : 0;

      el.innerHTML = `
        <div class="history-session-header">
          <span class="history-date">${dateStr}</span>
          <span class="history-summary">${n} songs &nbsp;·&nbsp; T ${tPct}% &nbsp;A ${aPct}% &nbsp;Y ${yPct}%</span>
        </div>
        <div class="history-session-detail" style="display:none"></div>`;
      el.querySelector('.history-session-header').addEventListener('click', () => toggleHistorySession(el));
      container.appendChild(el);
    }

    state.historyOffset += rows.length;
    loadMoreBtn.style.display = state.historyOffset < total ? 'block' : 'none';
  } catch {
    if (!append) container.innerHTML = '<p class="hint">Could not load history.</p>';
  }
}

async function toggleHistorySession(el) {
  const detail = el.querySelector('.history-session-detail');
  const isOpen = detail.style.display !== 'none';
  if (isOpen) { detail.style.display = 'none'; return; }

  detail.style.display = 'block';
  if (detail.dataset.loaded) return;
  detail.dataset.loaded = '1';
  detail.innerHTML = '<p class="hint" style="padding:8px 14px">Loading…</p>';

  try {
    const res     = await fetch(`/api/sessions/${el.dataset.id}/results`);
    const results = await res.json();
    if (!results.length) { detail.innerHTML = '<p class="hint" style="padding:8px 14px">No results.</p>'; return; }
    detail.innerHTML = results.map(r => `
      <div class="review-song-row">
        <img src="${esc(r.artwork_url || '')}" alt="" width="32" height="32" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="review-song-info">
          <div class="review-song-title">${esc(r.title)}</div>
          <div class="review-song-sub">${esc(r.artist)}</div>
        </div>
        <span class="review-dots">
          <span class="review-dot ${r.got_title  ? 'got' : 'miss'}"></span>
          <span class="review-dot ${r.got_artist ? 'got' : 'miss'}"></span>
          <span class="review-dot ${r.got_year   ? 'got' : 'miss'}"></span>
        </span>
      </div>`).join('');
  } catch {
    detail.innerHTML = '<p class="hint" style="padding:8px 14px">Failed to load.</p>';
  }
}

// ── Utility ───────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateStreakDisplay() {
  const el = document.getElementById('quiz-streak');
  if (!el) return;
  if (state.quizStreak >= 2) {
    el.textContent = `${state.quizStreak}×`;
    el.style.display = 'inline-flex';
    el.classList.remove('streak-bump');
    void el.offsetWidth;
    el.classList.add('streak-bump');
  } else {
    el.style.display = 'none';
  }
}

function fireConfetti() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const colors = ['#ff5252', '#1dce96', '#ffd60a', '#ff9f0a', '#c084fc', '#60a5fa'];
  const cx = canvas.width / 2;
  const cy = canvas.height * 0.42;
  const particles = Array.from({ length: 90 }, () => {
    const a = Math.random() * Math.PI * 2;
    const s = 4 + Math.random() * 9;
    return {
      x: cx + (Math.random() - 0.5) * 60,
      y: cy,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s - 2,
      w: 7 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.4,
      color: colors[Math.floor(Math.random() * colors.length)],
    };
  });
  let start = null;
  const duration = 1300;
  function frame(ts) {
    if (!start) start = ts;
    const t = (ts - start) / duration;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.22; p.vx *= 0.985; p.rot += p.spin;
      const alpha = t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.45);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < 1) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

// ── Chart Import ─────────────────────────────────────────────────────────

async function fetchChartSongs(genreId, limit) {
  const base = `https://itunes.apple.com/us/rss/topsongs/limit=${limit}`;
  const url = genreId ? `${base}/genre=${genreId}/json` : `${base}/json`;
  const rssRes = await fetch(url);
  if (!rssRes.ok) throw new Error('Chart unavailable');
  const rssData = await rssRes.json();
  const entries = rssData.feed?.entry || [];

  // Extract track IDs — prefer ?i= from the link URL, fall back to im:id attribute
  const ids = entries.map(e => {
    const link = e.id?.label || '';
    const m = link.match(/[?&]i=(\d+)/);
    return m ? m[1] : e.id?.attributes?.['im:id'];
  }).filter(Boolean);

  if (!ids.length) return [];

  // Batch lookup in chunks (iTunes caps URL length)
  const songs = [];
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const res = await fetch(`https://itunes.apple.com/lookup?id=${chunk.join(',')}`);
    if (!res.ok) continue;
    const data = await res.json();
    for (const r of data.results || []) {
      if (r.kind === 'song' && r.previewUrl) {
        songs.push({
          id:         r.trackId,
          title:      r.trackName,
          artist:     r.artistName,
          album:      r.collectionName || '',
          year:       r.releaseDate ? r.releaseDate.slice(0, 4) : '????',
          previewUrl: r.previewUrl,
          artwork:    (r.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
          genre:      r.primaryGenreName || '',
        });
      }
    }
  }
  return songs;
}

async function runChartImport() {
  const genreId = document.getElementById('chart-genre').value;
  const limit   = parseInt(document.getElementById('chart-count').value, 10);

  const progressEl   = document.getElementById('import-progress');
  const progressFill = document.getElementById('import-progress-fill');
  const statusEl     = document.getElementById('import-status');
  const resultEl     = document.getElementById('import-result');
  const runBtn       = document.getElementById('import-run-btn');
  const cancelBtn    = document.getElementById('import-cancel-btn');

  progressEl.style.display = 'block';
  resultEl.style.display   = 'none';
  runBtn.disabled          = true;
  cancelBtn.disabled       = true;
  progressFill.style.width = '5%';
  statusEl.textContent     = 'Fetching chart from iTunes…';

  let songs;
  try {
    songs = await fetchChartSongs(genreId, limit);
  } catch {
    statusEl.textContent = 'Could not fetch chart. Check your connection and try again.';
    runBtn.disabled = cancelBtn.disabled = false;
    return;
  }

  if (!songs.length) {
    statusEl.textContent = 'No songs with previews found on this chart.';
    runBtn.disabled = cancelBtn.disabled = false;
    return;
  }

  let added = 0, skipped = 0;

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    progressFill.style.width = `${5 + ((i + 1) / songs.length) * 95}%`;
    statusEl.textContent = `Adding ${i + 1} / ${songs.length}: ${song.artist} – ${song.title}`;

    if (inLibrary(song.id)) { skipped++; continue; }

    state.library.push(song);
    try {
      await fetch('/api/songs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(song),
      });
      added++;
    } catch {
      state.library = state.library.filter(s => s.id !== song.id);
    }
  }

  renderLibrary();
  updateLibraryStatus();

  progressFill.style.width = '100%';
  statusEl.textContent = 'Done.';

  let msg = `Added ${added} song${added !== 1 ? 's' : ''}`;
  if (skipped) msg += `, ${skipped} already in library`;
  msg += '.';
  resultEl.className   = `import-result ${added > 0 ? 'success' : 'partial'}`;
  resultEl.textContent = msg;
  resultEl.style.display = 'block';

  runBtn.disabled    = false;
  runBtn.textContent = 'Close';
  runBtn.onclick     = closeModal;
  cancelBtn.disabled = false;
}

// ── Bulk Import ───────────────────────────────────────────────────────────

function parsePasteLines(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => {
      const dash = l.indexOf(' - ');
      if (dash !== -1) {
        return { artist: l.slice(0, dash).trim(), title: l.slice(dash + 3).trim() };
      }
      return { artist: '', title: l };
    });
}

async function searchBestMatch({ artist, title }) {
  const query = artist ? `${artist} ${title}` : title;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=10`;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2500 * attempt));
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) continue;
      if (!res.ok) return null;
      const data = await res.json();
      const results = data.results.filter(r => r.previewUrl);
      if (!results.length) return null;
      const lower = title.toLowerCase();
      const exact = results.find(r => r.trackName.toLowerCase() === lower);
      const r = exact || results[0];
      return {
        id: r.trackId,
        title: r.trackName,
        artist: r.artistName,
        album: r.collectionName || '',
        year: r.releaseDate ? r.releaseDate.slice(0, 4) : '????',
        previewUrl: r.previewUrl,
        artwork: (r.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
        genre: r.primaryGenreName || '',
      };
    } catch { /* network blip — retry */ }
  }
  return null;
}

async function runBulkImport(entries) {
  const progressEl = document.getElementById('import-progress');
  const progressFill = document.getElementById('import-progress-fill');
  const statusEl = document.getElementById('import-status');
  const resultEl = document.getElementById('import-result');
  const runBtn = document.getElementById('import-run-btn');
  const cancelBtn = document.getElementById('import-cancel-btn');

  progressEl.style.display = 'block';
  resultEl.style.display = 'none';
  runBtn.disabled = true;
  cancelBtn.disabled = true;

  let added = 0;
  let skipped = 0;
  let failed = 0;
  const notFound = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    statusEl.textContent = `Searching ${i + 1} / ${entries.length}: ${entry.artist ? entry.artist + ' – ' : ''}${entry.title}`;
    progressFill.style.width = `${((i + 1) / entries.length) * 100}%`;

    // Skip the iTunes lookup entirely if title+artist already match a library entry.
    const normTitle = normalizeAnswer(entry.title);
    const normArtist = entry.artist ? normalizeAnswer(entry.artist) : null;
    if (state.library.some(s => {
      if (normalizeAnswer(s.title) !== normTitle) return false;
      return !normArtist || normalizeAnswer(s.artist) === normArtist;
    })) {
      skipped++;
      continue;
    }

    try {
      const song = await searchBestMatch(entry);
      if (song) {
        if (inLibrary(song.id)) {
          skipped++;
        } else {
          addToLibrary(song);
          added++;
        }
      } else {
        failed++;
        notFound.push(entry.artist ? `${entry.artist} – ${entry.title}` : entry.title);
      }
    } catch {
      failed++;
      notFound.push(entry.artist ? `${entry.artist} – ${entry.title}` : entry.title);
    }

    if (i < entries.length - 1) {
      // Longer pause every 10 songs to stay well under the iTunes rate limit
      const delay = (i + 1) % 10 === 0 ? 3000 : 400;
      if ((i + 1) % 10 === 0) statusEl.textContent = `Pausing briefly to avoid rate limits…`;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  statusEl.textContent = 'Done.';
  resultEl.style.display = 'block';

  let msg = `Added ${added} song${added !== 1 ? 's' : ''}`;
  if (skipped) msg += `, ${skipped} already in library`;
  if (failed) msg += `, ${failed} not found`;
  msg += '.';
  if (notFound.length) msg += `\n\nNot found:\n${notFound.slice(0, 10).join('\n')}${notFound.length > 10 ? `\n…and ${notFound.length - 10} more` : ''}`;

  resultEl.className = `import-result ${failed === 0 ? 'success' : 'partial'}`;
  resultEl.style.whiteSpace = 'pre-line';
  resultEl.textContent = msg;

  runBtn.disabled = false;
  runBtn.textContent = 'Close';
  runBtn.onclick = closeModal;
  cancelBtn.disabled = false;
}

// ── Song History Modal ────────────────────────────────────────────────────

function utcDate(raw) {
  return new Date(raw.includes('Z') ? raw : raw.replace(' ', 'T') + 'Z');
}

function formatHistoryDate(raw) {
  return utcDate(raw).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function openSongHistory(song) {
  document.getElementById('shm-art').src    = song.artwork;
  document.getElementById('shm-title').textContent  = song.title;
  document.getElementById('shm-artist').textContent = song.artist;
  document.getElementById('shm-subheader').textContent = 'Loading…';
  document.getElementById('shm-body').innerHTML = '';

  const overlay = document.getElementById('song-history-modal');
  overlay.style.display = 'flex';

  try {
    const res     = await fetch(`/api/songs/${song.id}/history`);
    const history = await res.json();
    renderSongHistoryBody(history);
  } catch {
    document.getElementById('shm-body').innerHTML = '<p class="shm-empty">Failed to load history.</p>';
  }
}

function renderSongHistoryBody(history) {
  const n = history.length;

  // Subheader
  let sub = `${n} attempt${n !== 1 ? 's' : ''}`;
  if (n > 0) {
    sub += ` · first tried ${formatHistoryDate(history[0].answered_at)}`;
    const first3 = history.find(h => h.got_title && h.got_artist && h.got_year);
    sub += first3 ? ` · known since ${formatHistoryDate(first3.answered_at)}` : ' · known since —';
  }
  document.getElementById('shm-subheader').textContent = sub;

  const body = document.getElementById('shm-body');

  if (n === 0) {
    body.innerHTML = '<p class="shm-empty">No quiz history for this song yet.</p>';
    return;
  }

  // Sparkline SVG
  const fields = ['got_title', 'got_artist', 'got_year'];
  const labels = ['T', 'A', 'Y'];
  const r = 5, gap = 14, labelW = 16, rowH = 18, padV = 5;
  const svgW = labelW + n * gap + r;
  const svgH = fields.length * rowH + padV * 2;

  let svg = `<svg class="shm-sparkline" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">`;
  fields.forEach((field, fi) => {
    const cy = padV + fi * rowH + rowH / 2;
    svg += `<text x="0" y="${cy + 4}" font-size="10" fill="rgba(255,255,255,0.35)" font-family="inherit">${labels[fi]}</text>`;
    history.forEach((h, i) => {
      svg += `<circle cx="${labelW + i * gap + r}" cy="${cy}" r="${r}" fill="${h[field] ? '#1dce96' : '#ff5252'}" opacity="0.85"/>`;
    });
  });
  svg += '</svg>';

  // Table
  const pill = got => `<span class="result-pill ${got ? 'pill-correct' : 'pill-wrong'}">${got ? '✓' : '✗'}</span>`;
  let table = `<table class="shm-table">
    <thead><tr><th>Date</th><th>Title</th><th>Artist</th><th>Year</th></tr></thead><tbody>`;
  for (const h of history) {
    table += `<tr>
      <td class="shm-date">${formatHistoryDate(h.answered_at)}</td>
      <td>${pill(h.got_title)}</td><td>${pill(h.got_artist)}</td><td>${pill(h.got_year)}</td>
    </tr>`;
  }
  table += '</tbody></table>';

  body.innerHTML = svg + table;
}

function closeSongHistory() {
  document.getElementById('song-history-modal').style.display = 'none';
}

function openModal(startTab) {
  const modal = document.getElementById('import-modal');
  modal.style.display = 'flex';
  document.getElementById('paste-input').value = '';
  document.getElementById('file-label').textContent = 'Choose file or drag & drop';
  document.getElementById('import-progress').style.display = 'none';
  document.getElementById('import-result').style.display = 'none';
  document.getElementById('import-run-btn').textContent = 'Import';
  document.getElementById('import-run-btn').onclick = handleImportRun;
  document.getElementById('import-cancel-btn').disabled = false;
  switchImportTab(startTab || 'paste');
}

function closeModal() {
  document.getElementById('import-modal').style.display = 'none';
}

function switchImportTab(name) {
  document.querySelectorAll('.import-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.import-tab-content').forEach(c => c.classList.toggle('active', c.id === `import-tab-${name}`));
}

// Parse Apple Music exported playlist (.txt tab-separated)
// Supports both English and German Music.app column names
function parseAppleMusicExport(text) {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r\n|\r|\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const nameIdx = headers.indexOf('name');
  const artistIdx = headers.findIndex(h => h === 'artist' || h === 'künstler:in' || h === 'künstler');
  const yearIdx = headers.findIndex(h => h === 'year' || h === 'erscheinungsdatum');
  if (nameIdx === -1) return [];
  return lines.slice(1).map(line => {
    const cols = line.split('\t');
    const rawYear = yearIdx !== -1 ? (cols[yearIdx] || '').trim() : '';
    const year = rawYear.match(/\d{4}/) ? rawYear.match(/\d{4}/)[0] : '';
    return {
      title: (cols[nameIdx] || '').trim(),
      artist: artistIdx !== -1 ? (cols[artistIdx] || '').trim() : '',
      year,
    };
  }).filter(e => e.title);
}

let pendingFileEntries = null;

function handleImportRun() {
  const activeTab = document.querySelector('.import-tab.active').dataset.tab;

  if (activeTab === 'charts') { runChartImport(); return; }

  let entries = [];

  if (activeTab === 'paste') {
    const text = document.getElementById('paste-input').value.trim();
    if (!text) return;
    entries = parsePasteLines(text);
  } else {
    if (!pendingFileEntries || !pendingFileEntries.length) return;
    entries = pendingFileEntries;
  }

  if (!entries.length) return;
  runBulkImport(entries);
}

// ── Event Wiring ──────────────────────────────────────────────────────────

async function startSession() {
  const setupError = document.getElementById('setup-error');

  if (state.library.length < 2) {
    setupError.textContent = 'Add at least 2 songs to your library first.';
    setupError.style.display = 'block';
    return;
  }
  setupError.style.display = 'none';

  const studyAllCheckbox = document.getElementById('study-all');
  const studyAll = studyAllCheckbox ? studyAllCheckbox.checked : true;
  const count = studyAll ? null : parseInt(document.getElementById('q-count').textContent, 10);

  const genreBoxes = document.querySelectorAll('.genre-cb');
  let genres = null;
  if (genreBoxes.length > 0) {
    const checked = [...genreBoxes].filter(cb => cb.checked).map(cb => cb.value);
    // null means all — only filter if not everything is checked
    if (checked.length < genreBoxes.length) genres = checked;
  }

  state.quizConfig = { count, genres };
  state.preMastery = {};
  state.library.forEach(s => { state.preMastery[String(s.id)] = getMastery(s.id); });

  state.quizQuestions = await buildStudySession();
  
  if (!state.quizQuestions) {
    setupError.textContent = genres
      ? 'No songs match the selected genres.'
      : 'No songs in queue. Your library may be too small.';
    setupError.style.display = 'block';
    return;
  }
  
  state.quizIndex = 0;
  state.quizScore = 0;
  state.quizAnswers = [];

  try {
    const r = await fetch('/api/sessions', { method: 'POST' });
    const d = await r.json();
    state.currentSessionId = d.id;
  } catch {
    state.currentSessionId = null;
  }
  state.sessionStartTime = Date.now();
  state.quizStreak = 0;
  updateStreakDisplay();

  showView('quiz-active');
  renderQuestion();
}

async function init() {
  await loadLibrary();

  // One-time migration: if the DB is empty and localStorage has songs, import them.
  if (state.library.length === 0) {
    const localLib = JSON.parse(localStorage.getItem('musikquiz_library') || '[]');
    if (localLib.length) {
      const localStats = JSON.parse(localStorage.getItem('musikquiz_stats') || '{}');
      for (const song of localLib) {
        await fetch('/api/songs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(song),
        }).catch(() => {});
        const id = String(song.id);
        if (localStats[id]) {
          const patch = {};
          for (const type of ['title', 'artist', 'year']) {
            const st = localStats[id][type];
            if (st) { patch[`score_${type}`] = st.c || 0; patch[`attempts_${type}`] = st.a || 0; }
          }
          if (Object.keys(patch).length) {
            await fetch(`/api/songs/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            }).catch(() => {});
          }
        }
      }
      localStorage.removeItem('musikquiz_library');
      localStorage.removeItem('musikquiz_stats');
      await loadLibrary();
    }
  }

  renderLibrary();
  updateLibraryStatus();

  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      showView(btn.dataset.view);
      if (btn.dataset.view === 'quiz-setup') { renderMasteryOverview(); renderGenreFilter(); }
      if (btn.dataset.view === 'stats')      renderStats();
    });
  });

  // Search
  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const searchLoading = document.getElementById('search-loading');
  const searchError = document.getElementById('search-error');

  async function doSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    searchLoading.style.display = 'block';
    searchError.style.display = 'none';
    document.getElementById('search-results').innerHTML = '';
    searchBtn.disabled = true;
    try {
      state.searchResults = await searchSongs(q);
      renderSearchResults(state.searchResults);
    } catch (err) {
      searchError.textContent = 'Search failed. Check your connection and try again.';
      searchError.style.display = 'block';
    } finally {
      searchLoading.style.display = 'none';
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  // Song history modal
  document.getElementById('shm-close').addEventListener('click', closeSongHistory);
  document.getElementById('song-history-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('song-history-modal')) closeSongHistory();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('song-history-modal').style.display !== 'none') closeSongHistory();
      else closeModal();
    }
  });

  // Import modal
  document.getElementById('library-sort').addEventListener('change', e => {
    state.librarySort = e.target.value;
    renderLibrary();
  });

  document.getElementById('import-btn').addEventListener('click', () => openModal());
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('import-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('import-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('import-modal')) closeModal();
  });
  document.getElementById('import-run-btn').addEventListener('click', handleImportRun);

  document.querySelectorAll('.import-tab').forEach(tab => {
    tab.addEventListener('click', () => switchImportTab(tab.dataset.tab));
  });

  // File upload
  const fileInput = document.getElementById('file-input');
  const fileDrop = document.getElementById('file-drop');
  const fileLabel = document.getElementById('file-label');

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const buffer = e.target.result;
      const bytes = new Uint8Array(buffer, 0, 4);
      let encoding = 'utf-8';
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = 'utf-16le';
      else if (bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = 'utf-16be';
      const text = new TextDecoder(encoding).decode(buffer);
      pendingFileEntries = parseAppleMusicExport(text);
      if (pendingFileEntries.length) {
        fileLabel.textContent = `${file.name} — ${pendingFileEntries.length} tracks found`;
      } else {
        fileLabel.textContent = `${file.name} — no tracks recognized`;
        pendingFileEntries = null;
      }
    };
    reader.readAsArrayBuffer(file);
  }

  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
  fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.classList.add('drag-over'); });
  fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag-over'));
  fileDrop.addEventListener('drop', e => {
    e.preventDefault();
    fileDrop.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });


  // Songs per session picker
  let qCount = 10;
  const qCountEl = document.getElementById('q-count');
  const studyAllCheckbox = document.getElementById('study-all');
  const countPicker = document.getElementById('count-picker');

  function updateCountDisplay() { qCountEl.textContent = qCount; }

  if (studyAllCheckbox) {
    studyAllCheckbox.addEventListener('change', () => {
      countPicker.style.display = studyAllCheckbox.checked ? 'none' : 'flex';
    });
  }

  document.getElementById('q-minus').addEventListener('click', () => {
    if (qCount > 1) { qCount--; updateCountDisplay(); }
  });
  document.getElementById('q-plus').addEventListener('click', () => {
    if (qCount < 200) { qCount++; updateCountDisplay(); }
  });

  // Volume slider
  const volumeSlider = document.getElementById('volume-slider');
  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      currentVolume = parseFloat(volumeSlider.value);
      audio.volume = currentVolume;
    });
  }

  // Start session
  document.getElementById('start-quiz-btn').addEventListener('click', startSession);

  // Next question
  document.getElementById('next-btn').addEventListener('click', advanceQuiz);

  // End session early
  document.getElementById('end-session-btn').addEventListener('click', async () => {
    stopAudio();
    await closeSession();
    showReview();
  });

  // Review screen
  document.getElementById('back-quiz-btn').addEventListener('click', () => {
    renderMasteryOverview();
    showView('quiz-setup');
  });

  // Stats history — load more
  document.getElementById('stats-load-more').addEventListener('click', () => {
    loadSessionHistory(true);
  });
}

init();
