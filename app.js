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
      previewUrl:      r.preview_url || '',
      previewCountry:  r.preview_country || null,
      genre:           r.genre || '',
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
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=30&country=de${attr}`;

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
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle + ' ' + song.artist)}&media=music&entity=song&limit=50&country=de`;
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

  const playBtn     = document.getElementById('play-btn');
  const playIcon    = document.getElementById('play-icon');
  const progressFill = document.getElementById('progress-fill');
  const timerDisplay = document.getElementById('timer-display');
  const arc          = document.getElementById('timer-ring-arc');
  const circumference = 2 * Math.PI * 19;

  if (arc) arc.style.strokeDashoffset = '0';

  function updateProgress() {
    if (!audio.duration) return;
    const pct = audio.currentTime / audio.duration;
    progressFill.style.width = `${pct * 100}%`;
    if (arc) arc.style.strokeDashoffset = String(circumference * pct);
    const remaining = Math.max(0, Math.ceil(audio.duration - audio.currentTime));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timerDisplay.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }

  progressInterval = setInterval(updateProgress, 250);

  audio.onplay  = () => { if (playIcon) playIcon.textContent = '⏸'; };
  audio.onpause = () => { if (playIcon) playIcon.textContent = '▶'; };
  audio.onended = () => {
    if (playIcon) playIcon.textContent = '▶';
    progressFill.style.width = '100%';
    timerDisplay.textContent = '0:00';
    if (arc) arc.style.strokeDashoffset = String(circumference);
  };

  playBtn.onclick = () => {
    if (!audio.paused) { audio.pause(); return; }
    audio.play().catch(() => {});
  };

  startVisualizer();
  audio.play().catch(() => { if (playIcon) playIcon.textContent = '▶'; });
}

// ── Views ─────────────────────────────────────────────────────────────────

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name || (name.startsWith('quiz') && b.dataset.view === 'quiz-setup'));
  });
  if (!name.startsWith('quiz')) stopAudio();
  if (['library', 'stats', 'quiz-setup'].includes(name)) {
    history.replaceState(null, '', `#${name}`);
  }
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
    list.className = 'song-list';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  const sorted = [...state.library].sort((a, b) => {
    if (state.librarySort === 'artist')    return a.artist.localeCompare(b.artist);
    if (state.librarySort === 'year')      return (a.year || 0) - (b.year || 0);
    if (state.librarySort === 'knowledge') return knowledgeScore(a.id) - knowledgeScore(b.id);
    if (state.librarySort === 'added')     return 0;
    return a.title.localeCompare(b.title);
  });

  const viewMode = localStorage.getItem('muzquiz_libview') || 'list';

  if (viewMode === 'card') {
    list.className = 'song-grid-cards';
    list.innerHTML = sorted.map(song => {
      const maxInterval = Math.max(
        song.srInterval_title  || 0,
        song.srInterval_artist || 0,
        song.srInterval_year   || 0,
      );
      const blocks = maxInterval === 0 ? 0 : maxInterval <= 1 ? 1 : maxInterval <= 3 ? 2 : maxInterval <= 7 ? 3 : maxInterval <= 14 ? 4 : 5;
      return `
        <div class="song-card-grid" data-id="${song.id}">
          <div class="scg-top">
            <img class="scg-art" src="${esc(song.artwork)}" alt="" width="48" height="48" loading="lazy" onerror="this.style.visibility='hidden'">
            <div class="scg-info">
              <div class="scg-title">${esc(song.title)}</div>
              <div class="scg-artist">${esc(song.artist)}</div>
            </div>
          </div>
          <div class="scg-meta">
            <span class="scg-year">${song.year}</span>
            ${song.genre ? `<span class="scg-genre">${esc(song.genre)}</span>` : ''}
          </div>
          <div class="scg-knowledge">
            ${[0,1,2,3,4].map(i => `<span class="scg-kb-block${i < blocks ? ' scg-kb-block--filled' : ''}"></span>`).join('')}
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.song-card-grid').forEach(card => {
      card.addEventListener('click', () => {
        const song = state.library.find(s => String(s.id) === card.dataset.id);
        if (song) openSongHistory(song);
      });
    });
  } else {
    list.className = 'song-list';
    list.innerHTML = sorted.map(song => {
      const fm = getFieldMastery(song.id);
      const mark = s => s === 'known' ? '✓' : '✗';
      const tooltip = `Title ${mark(fm.title)} · Artist ${mark(fm.artist)} · Year ${mark(fm.year)}`;
      return `
        <div class="song-row">
          <img src="${esc(song.artwork)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
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

  const total = state.library.length;
  const duePct     = total ? (dueToday / total) * 100 : 0;
  const newPct     = total ? (newSongs  / total) * 100 : 0;
  const learnedPct = total ? (learned   / total) * 100 : 0;
  const notDuePct  = total ? (notDue    / total) * 100 : 0;

  el.innerHTML = `
    <div class="mastery-seg-bar-track">
      <div class="msb-seg msb-due"     style="width:${duePct}%"></div>
      <div class="msb-seg msb-new"     style="width:${newPct}%"></div>
      <div class="msb-seg msb-learned" style="width:${learnedPct}%"></div>
      <div class="msb-seg msb-notdue"  style="width:${notDuePct}%"></div>
    </div>
    <div class="mastery-seg-legend">
      <span class="msl-item"><span class="msl-dot" style="background:var(--accent)"></span>${dueToday} due</span>
      <span class="msl-item"><span class="msl-dot" style="background:var(--warning)"></span>${newSongs} new</span>
      <span class="msl-item"><span class="msl-dot" style="background:var(--success)"></span>${learned} learned</span>
      <span class="msl-item"><span class="msl-dot" style="background:var(--text-3)"></span>${notDue} not due</span>
    </div>`;
}

async function backfillGenres() {
  const unknowns = state.library.filter(s => !s.genre);
  if (!unknowns.length) return;

  const btn = document.getElementById('genre-backfill-btn');
  const statusEl = document.getElementById('genre-backfill-status');
  if (btn) btn.disabled = true;

  let fixed = 0;
  let failed = 0;

  for (let i = 0; i < unknowns.length; i++) {
    const song = unknowns[i];
    if (statusEl) statusEl.textContent = `Fixing ${i + 1} / ${unknowns.length}…`;

    try {
      const res = await fetch(`https://itunes.apple.com/lookup?id=${song.id}`);
      const data = await res.json();
      const genre = data.results?.[0]?.primaryGenreName;
      if (genre) {
        await fetch(`/api/songs/${song.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ genre }),
        });
        const lib = state.library.find(s => s.id === song.id);
        if (lib) lib.genre = genre;
        fixed++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }

    if (i < unknowns.length - 1) {
      const delay = (i + 1) % 20 === 0 ? 2000 : 150;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  if (statusEl) statusEl.textContent = `Done — fixed ${fixed}${failed ? `, ${failed} not found` : ''}.`;
  renderGenreGrid();
}

async function refreshPreviews() {
  const todo = state.library.filter(s => s.previewCountry === null);
  if (!todo.length) {
    const statusEl = document.getElementById('refresh-previews-status');
    if (statusEl) statusEl.textContent = 'All songs already checked.';
    return;
  }

  const btn      = document.getElementById('refresh-previews-btn');
  const statusEl = document.getElementById('refresh-previews-status');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = `0 / ${todo.length}…`;

  let updated = 0, failed = 0;

  for (let i = 0; i < todo.length; i++) {
    const song = todo[i];

    if (statusEl) statusEl.textContent = `${i + 1} / ${todo.length}…`;

    try {
      let r = null;
      let country = null;

      const deRes  = await fetch(`https://itunes.apple.com/lookup?id=${song.id}&country=de`);
      const deData = await deRes.json();
      if (deData.results?.[0]?.previewUrl) {
        r = deData.results[0];
        country = 'de';
      } else {
        // Fallback: US storefront
        const usRes  = await fetch(`https://itunes.apple.com/lookup?id=${song.id}`);
        const usData = await usRes.json();
        if (usData.results?.[0]?.previewUrl) {
          r = usData.results[0];
          country = 'us';
        }
      }

      if (r) {
        const artwork = (r.artworkUrl100 || '').replace('100x100bb', '300x300bb');
        const patchRes = await fetch(`/api/songs/${song.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preview_url: r.previewUrl, artwork_url: artwork, preview_country: country }),
        });
        if (patchRes.ok) {
          song.previewUrl     = r.previewUrl;
          song.artwork_url    = artwork;
          song.previewCountry = country;
          updated++;
        } else {
          failed++;
        }
      } else {
        // Mark as checked so it's skipped on future runs
        const patchRes = await fetch(`/api/songs/${song.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preview_country: 'none' }),
        });
        if (patchRes.ok) song.previewCountry = 'none';
        failed++;
      }
    } catch {
      failed++;
    }

    if (i < todo.length - 1) {
      const delay = (i + 1) % 20 === 0 ? 2000 : 150;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  if (btn) btn.disabled = false;
  if (statusEl) statusEl.textContent = `Done — ${updated} updated${failed ? `, ${failed} not found` : ''}.`;
}

function genreStats(songs) {
  const today = new Date().toISOString().slice(0, 10);
  let newCount = 0, due = 0, learned = 0, notDue = 0;
  for (const s of songs) {
    const isNew = !s.srDue_title && !s.srDue_artist && !s.srDue_year;
    if (isNew) { newCount++; continue; }
    const anyDue = ['title', 'artist', 'year'].some(f => { const d = s[`srDue_${f}`]; return d && d <= today; });
    if (anyDue) { due++; continue; }
    const allLearned = s.srReviews_title >= 3 && s.srReviews_artist >= 3 && s.srReviews_year >= 3;
    if (allLearned) learned++; else notDue++;
  }
  return { total: songs.length, new: newCount, due, learned, notDue };
}

function renderGenreGrid() {
  const grid = document.getElementById('genre-grid');
  if (!grid) return;

  const genreSongs = {};
  for (const s of state.library) {
    const g = s.genre || '__unknown__';
    if (!genreSongs[g]) genreSongs[g] = [];
    genreSongs[g].push(s);
  }

  const genres = Object.keys(genreSongs).filter(g => genreSongs[g].length >= 10).sort((a, b) => {
    if (a === '__unknown__') return 1;
    if (b === '__unknown__') return -1;
    return genreSongs[b].length - genreSongs[a].length;
  });

  let expandedGenre = null;

  const today = new Date().toISOString().slice(0, 10);

  function songStatus(s) {
    const isNew = !s.srDue_title && !s.srDue_artist && !s.srDue_year;
    if (isNew) return 'new';
    const anyDue = ['title', 'artist', 'year'].some(f => { const d = s[`srDue_${f}`]; return d && d <= today; });
    if (anyDue) return 'due';
    const allLearned = s.srReviews_title >= 3 && s.srReviews_artist >= 3 && s.srReviews_year >= 3;
    return allLearned ? 'learned' : 'not-due';
  }

  const statusOrder = { due: 0, new: 1, 'not-due': 2, learned: 3 };

  function renderCards() {
    grid.innerHTML = genres.map(g => {
      const songs = genreSongs[g];
      const st = genreStats(songs);
      const label = g === '__unknown__' ? 'Unknown' : g;
      const isExpanded = expandedGenre === g;
      const masteryPct = st.total > 0 ? Math.round((st.learned / st.total) * 100) : 0;

      const tot = st.total || 1;
      const duePct2     = (st.due     / tot) * 100;
      const newPct2     = (st.new     / tot) * 100;
      const learnedPct2 = (st.learned / tot) * 100;
      const notDuePct2  = (st.notDue  / tot) * 100;

      const accentClass = st.due > 0
        ? 'genre-card--has-due'
        : st.new === st.total ? 'genre-card--all-new' : '';

      const miniBar = `<div class="gc-mini-bar">
        <div class="gc-mb-seg gc-mb-due"     style="width:${duePct2}%"></div>
        <div class="gc-mb-seg gc-mb-new"     style="width:${newPct2}%"></div>
        <div class="gc-mb-seg gc-mb-learned" style="width:${learnedPct2}%"></div>
        <div class="gc-mb-seg gc-mb-notdue"  style="width:${notDuePct2}%"></div>
      </div>`;

      const expandedHtml = isExpanded ? `
        <div class="genre-card-detail">
          <div class="gc-top-row">
            <div class="gc-stat-row">
              <div class="gc-stat"><span class="gc-stat-num">${st.total}</span><span class="gc-stat-label">songs</span></div>
              <div class="gc-stat"><span class="gc-stat-num gc-new">${st.new}</span><span class="gc-stat-label">new</span></div>
              <div class="gc-stat"><span class="gc-stat-num gc-due">${st.due}</span><span class="gc-stat-label">due</span></div>
              <div class="gc-stat"><span class="gc-stat-num">${st.notDue}</span><span class="gc-stat-label">not due</span></div>
              <div class="gc-stat"><span class="gc-stat-num gc-ok">${st.learned}</span><span class="gc-stat-label">learned</span></div>
            </div>
            <div class="gc-mastery-bar-wrap">
              <div class="gc-mastery-bar"><div class="gc-mastery-fill" style="width:${masteryPct}%"></div></div>
              <span class="gc-mastery-label">${masteryPct}% mastered</span>
            </div>
          </div>
          <div class="gc-song-list">
            ${[...songs].sort((a, b) => statusOrder[songStatus(a)] - statusOrder[songStatus(b)]).map(s => {
              const status = songStatus(s);
              return `<div class="gc-song-row" data-id="${s.id}">
                <img class="gc-song-art" src="${esc(s.artwork || '')}" alt="" width="30" height="30" onerror="this.style.display='none'">
                <div class="gc-song-info">
                  <span class="gc-song-title">${esc(s.title)}</span>
                  <span class="gc-song-artist">${esc(s.artist)}</span>
                </div>
                <span class="gc-song-status gc-song-status--${status}">${status === 'not-due' ? 'not due' : status}</span>
              </div>`;
            }).join('')}
          </div>
        </div>` : '';

      return `<div class="genre-card${isExpanded ? ' expanded' : ''} ${accentClass}" data-genre="${esc(g)}">
        <div class="genre-card-main">
          <div class="genre-card-text">
            <span class="genre-card-name">${esc(label)}</span>
            <div class="genre-card-count">${st.total} songs</div>
            ${miniBar}
          </div>
          <button class="genre-card-practice-btn btn-primary" data-genre="${esc(g)}">Practice</button>
        </div>
        ${expandedHtml}
      </div>`;
    }).join('');

    grid.querySelectorAll('.genre-card').forEach(card => {
      card.querySelector('.genre-card-main').addEventListener('click', () => {
        expandedGenre = expandedGenre === card.dataset.genre ? null : card.dataset.genre;
        renderCards();
      });
    });

    grid.querySelectorAll('.genre-card-practice-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        state.quizConfig = { count: null, genres: [btn.dataset.genre] };
        startSession();
      });
    });

    grid.querySelectorAll('.gc-song-row').forEach(row => {
      row.addEventListener('click', e => {
        e.stopPropagation();
        const song = state.library.find(s => String(s.id) === row.dataset.id);
        if (song) openSongHistory(song);
      });
    });
  }

  renderCards();

  const unknownCount = genreSongs['__unknown__']?.length || 0;
  const backfillRow = document.getElementById('genre-backfill-row');
  const backfillBtn = document.getElementById('genre-backfill-btn');
  if (backfillRow && backfillBtn) {
    if (unknownCount > 0) {
      backfillRow.style.display = 'flex';
      backfillBtn.textContent = `Fix ${unknownCount} unknown genres`;
      backfillBtn.onclick = backfillGenres;
    } else {
      backfillRow.style.display = 'none';
    }
  }
}

function updateLibraryStatus() {
  const el = document.getElementById('library-status');
  const n = state.library.length;
  if (n === 0) el.textContent = 'Add songs to your library first.';
  else if (n < 2) el.textContent = `${n} song in library — add at least one more to start.`;
  else el.textContent = `${n} songs in library.`;
  renderMasteryOverview();
  renderGenreGrid();
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

  // Update album art section
  const artBg    = document.getElementById('quiz-art-bg');
  const artThumb = document.getElementById('quiz-art-thumb');
  if (artBg && q.song.artwork) {
    artBg.style.backgroundImage = `url(${q.song.artwork})`;
  }
  if (artThumb) {
    artThumb.src = q.song.artwork || '';
    artThumb.style.display = q.song.artwork ? 'block' : 'none';
  }

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
    if (hintEl) { hintEl.textContent = ''; hintEl.classList.remove('visible'); }

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
      if (hintEl) { hintEl.textContent = ''; hintEl.classList.remove('visible'); }
    } else {
      input.className = 'answer-input wrong';
      resultEl.textContent = '✗';
      resultEl.className = 'field-result wrong';
      if (hintEl) {
        hintEl.classList.remove('visible');
        hintEl.textContent = answers[type];
        void hintEl.offsetWidth; // force reflow for animation
        hintEl.classList.add('visible');
      }
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
  // Update local in-memory state only; server updates SR when it saves the session result.
  for (const field of ['title', 'artist', 'year']) {
    const got = correct[field] ? 1 : 0;
    const interval = song[`srInterval_${field}`] || 0;
    const ease     = song[`srEase_${field}`]     || 2.5;
    const reviews  = song[`srReviews_${field}`]  || 0;
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
    song[`srInterval_${field}`] = newInterval;
    song[`srEase_${field}`]     = newEase;
    song[`srReviews_${field}`]  = newReviews;
    song[`srDue_${field}`]      = due.toISOString().split('T')[0];
  }
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

  // Score hero
  let hero = document.getElementById('review-score-hero');
  if (!hero) {
    hero = document.createElement('div');
    hero.id = 'review-score-hero';
    hero.className = 'review-score-hero';
    const statBoxes = document.getElementById('review-stat-boxes');
    statBoxes.parentNode.insertBefore(hero, statBoxes);
  }
  const totalCorrect = totals.title + totals.artist + totals.year;
  const totalPossible = n * 3;
  const overallPct = totalPossible > 0 ? Math.round((totalCorrect / totalPossible) * 100) : 0;
  hero.innerHTML = `<div class="review-score-number">${overallPct}%</div>`;

  const tPct = n > 0 ? Math.round((totals.title  / n) * 100) : 0;
  const aPct = n > 0 ? Math.round((totals.artist / n) * 100) : 0;
  const yPct = n > 0 ? Math.round((totals.year   / n) * 100) : 0;

  document.getElementById('review-stat-boxes').innerHTML = `
    <div class="review-stat-box">
      <span class="review-stat-pct">${tPct}%</span>
      <span class="review-stat-label">Title</span>
      <div class="review-stat-bar-track"><div class="review-stat-bar-fill" style="width:${tPct}%"></div></div>
    </div>
    <div class="review-stat-box">
      <span class="review-stat-pct">${aPct}%</span>
      <span class="review-stat-label">Artist</span>
      <div class="review-stat-bar-track"><div class="review-stat-bar-fill" style="width:${aPct}%"></div></div>
    </div>
    <div class="review-stat-box">
      <span class="review-stat-pct">${yPct}%</span>
      <span class="review-stat-label">Year</span>
      <div class="review-stat-bar-track"><div class="review-stat-bar-fill" style="width:${yPct}%"></div></div>
    </div>
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
      const attempts = (s.attempts_title || 0) + (s.attempts_artist || 0) + (s.attempts_year || 0);
      const correct  = (s.score_title  || 0) + (s.score_artist  || 0) + (s.score_year  || 0);
      const accuracyPct = attempts > 0 ? Math.round((correct / attempts) * 100) : 0;
      const fm = {
        title:  s.attempts_title  > 0 ? (s.score_title  >= 1 && s.score_title  / s.attempts_title  >= 0.5 ? 'known' : 'wrong') : 'unheard',
        artist: s.attempts_artist > 0 ? (s.score_artist >= 1 && s.score_artist / s.attempts_artist >= 0.5 ? 'known' : 'wrong') : 'unheard',
        year:   s.attempts_year   > 0 ? (s.score_year   >= 1 && s.score_year   / s.attempts_year   >= 0.5 ? 'known' : 'wrong') : 'unheard',
      };
      return `<div class="hardest-song-row">
        <div class="hardest-row-bg" style="width:${accuracyPct}%"></div>
        <img src="${esc(s.artwork_url || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" style="position:relative;z-index:1;width:28px;height:28px;border-radius:4px;object-fit:cover;flex-shrink:0">
        <div class="hardest-song-info">
          <div class="hardest-song-title">${esc(s.title)}</div>
          <div class="hardest-song-artist">${esc(s.artist)}</div>
        </div>
        <span class="mastery-dots" style="position:relative;z-index:1">
          <span class="mastery-dot-field mastery-field-${fm.title}"></span>
          <span class="mastery-dot-field mastery-field-${fm.artist}"></span>
          <span class="mastery-dot-field mastery-field-${fm.year}"></span>
        </span>
        <span class="hardest-pct">${accuracyPct}%</span>
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

  const counts   = reversed.map(s => s.song_count || 0);
  const maxCount = Math.max(...counts, 1);
  const sorted   = [...counts].sort((a, b) => a - b);
  const mid      = Math.floor(sorted.length / 2);
  const median   = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const n    = reversed.length;
  const gap  = 3;
  const barW = Math.max(4, (W - gap * (n + 1)) / n);

  reversed.forEach((s, i) => {
    const count = s.song_count || 0;
    const barH  = Math.max(2, (count / maxCount) * (H - 8));
    const x     = gap + i * (barW + gap);
    const y     = H - barH;

    const ratio = median > 0 ? count / median : 1;
    let color;
    if (ratio < 0.6)       color = 'rgba(120,120,120,0.7)';
    else if (ratio < 1.4)  color = 'rgba(245,158,11,0.85)';
    else                   color = 'rgba(232,71,58,0.9)';

    ctx.fillStyle = color;
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

// ── All-Time Import (Last.fm) ─────────────────────────────────────────────

async function fetchLastFmTracks(tag, limit, apiKey) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=tag.gettoptracks&tag=${encodeURIComponent(tag)}&api_key=${encodeURIComponent(apiKey)}&format=json&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Last.fm request failed');
  const data = await res.json();
  if (data.error) throw new Error(data.message || 'Last.fm error');
  const tracks = data.tracks?.track || [];
  return tracks.map(t => ({ title: t.name, artist: t.artist?.name || '' })).filter(t => t.title && t.artist);
}

async function runAllTimeImport() {
  const tag   = document.getElementById('chart-genre').value;
  const limit = parseInt(document.getElementById('chart-count').value, 10);

  const progressEl   = document.getElementById('import-progress');
  const statusEl     = document.getElementById('import-status');
  const progressFill = document.getElementById('import-progress-fill');
  const runBtn       = document.getElementById('import-run-btn');
  const cancelBtn    = document.getElementById('import-cancel-btn');

  progressEl.style.display = 'block';
  document.getElementById('import-result').style.display = 'none';
  runBtn.disabled = cancelBtn.disabled = true;
  progressFill.style.width = '0%';
  statusEl.textContent = 'Fetching Last.fm chart…';

  let apiKey;
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    apiKey = cfg.lastfmKey;
  } catch {
    apiKey = '';
  }

  if (!apiKey) {
    statusEl.textContent = 'No Last.fm API key configured. Add LASTFM_API_KEY to your .env file and restart the server.';
    runBtn.disabled = cancelBtn.disabled = false;
    return;
  }

  let entries;
  try {
    entries = await fetchLastFmTracks(tag, limit, apiKey);
  } catch (e) {
    statusEl.textContent = `Failed: ${e.message}`;
    runBtn.disabled = cancelBtn.disabled = false;
    return;
  }

  if (!entries.length) {
    statusEl.textContent = 'No tracks found for this genre.';
    runBtn.disabled = cancelBtn.disabled = false;
    return;
  }

  runBulkImport(entries);
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
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=10&country=de`;

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
  let apiCalls = 0;
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

    let madeRequest = false;
    try {
      const song = await searchBestMatch(entry);
      madeRequest = true;
      apiCalls++;
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
      madeRequest = true;
      apiCalls++;
      failed++;
      notFound.push(entry.artist ? `${entry.artist} – ${entry.title}` : entry.title);
    }

    // Only delay after real iTunes requests (skipped entries need no pause)
    if (madeRequest && i < entries.length - 1) {
      const delay = apiCalls % 10 === 0 ? 3000 : 400;
      if (apiCalls % 10 === 0) statusEl.textContent = `Pausing briefly to avoid rate limits…`;
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

  if (activeTab === 'charts') { runAllTimeImport(); return; }

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

  if (!state.quizConfig) state.quizConfig = { count: null, genres: null };
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

// ── Toast ─────────────────────────────────────────────────────────────────

function showToast(msg) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  container.innerHTML = '';
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function init() {
  // ── Toast container ──────────────────────────────────────────────────────
  const toastContainer = document.createElement('div');
  toastContainer.id = 'toast-container';
  toastContainer.className = 'toast-container';
  document.body.appendChild(toastContainer);

  // ── Quiz art section: wrap canvas + inject bg + thumb ────────────────────
  const visualizerEl = document.getElementById('visualizer');
  if (visualizerEl) {
    const artSection = document.createElement('div');
    artSection.className = 'quiz-art-section';

    const artBg = document.createElement('div');
    artBg.id = 'quiz-art-bg';
    artBg.className = 'quiz-art-bg';

    const artThumb = document.createElement('img');
    artThumb.id = 'quiz-art-thumb';
    artThumb.alt = '';

    visualizerEl.parentNode.insertBefore(artSection, visualizerEl);
    artSection.appendChild(artBg);
    artSection.appendChild(visualizerEl);
    artSection.appendChild(artThumb);
  }

  // ── Timer ring: wrap play button in SVG ring ─────────────────────────────
  const playBtnEl = document.getElementById('play-btn');
  if (playBtnEl) {
    const ring = document.createElement('div');
    ring.className = 'play-ring';
    const circ = (2 * Math.PI * 19).toFixed(2);
    ring.innerHTML = `<svg class="play-ring-svg" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
      <circle cx="22" cy="22" r="19" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2.5"/>
      <circle id="timer-ring-arc" cx="22" cy="22" r="19" fill="none" stroke="var(--accent)" stroke-width="2.5"
        stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="0"
        transform="rotate(-90 22 22)"/>
    </svg>`;
    playBtnEl.parentNode.insertBefore(ring, playBtnEl);
    ring.appendChild(playBtnEl);
  }

  // ── Sort pills: replace <select> with pill buttons ───────────────────────
  const sortSelect = document.getElementById('library-sort');
  if (sortSelect) {
    const sortPills = document.createElement('div');
    sortPills.className = 'sort-pills';
    const sortOpts = [
      { value: 'title',     label: 'Title' },
      { value: 'artist',    label: 'Artist' },
      { value: 'year',      label: 'Year' },
      { value: 'knowledge', label: 'Weakest' },
      { value: 'added',     label: 'Added' },
    ];
    sortOpts.forEach(opt => {
      const pill = document.createElement('button');
      pill.className = 'sort-pill' + (state.librarySort === opt.value ? ' active' : '');
      pill.textContent = opt.label;
      pill.dataset.value = opt.value;
      pill.addEventListener('click', () => {
        state.librarySort = opt.value;
        sortPills.querySelectorAll('.sort-pill').forEach(p =>
          p.classList.toggle('active', p.dataset.value === opt.value));
        renderLibrary();
      });
      sortPills.appendChild(pill);
    });
    sortSelect.parentNode.insertBefore(sortPills, sortSelect);
  }

  // ── View toggle button (list ↔ card) ─────────────────────────────────────
  const libActions = document.querySelector('.library-actions');
  if (libActions) {
    const listIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
    const gridIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>`;
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn-ghost btn-sm view-toggle-btn';
    toggleBtn.id = 'lib-view-toggle';
    const savedView = localStorage.getItem('muzquiz_libview') || 'list';
    toggleBtn.innerHTML = savedView === 'card' ? listIcon : gridIcon;
    toggleBtn.title = savedView === 'card' ? 'Switch to list' : 'Switch to grid';
    libActions.insertBefore(toggleBtn, libActions.firstChild);
    toggleBtn.addEventListener('click', () => {
      const cur = localStorage.getItem('muzquiz_libview') || 'list';
      const next = cur === 'list' ? 'card' : 'list';
      localStorage.setItem('muzquiz_libview', next);
      toggleBtn.innerHTML = next === 'card' ? listIcon : gridIcon;
      toggleBtn.title = next === 'card' ? 'Switch to list' : 'Switch to grid';
      renderLibrary();
    });
  }

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
      if (btn.dataset.view === 'quiz-setup') { renderMasteryOverview(); renderGenreGrid(); }
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

  document.getElementById('refresh-previews-btn').addEventListener('click', refreshPreviews);
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


  // Volume slider
  const volumeSlider = document.getElementById('volume-slider');
  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      currentVolume = parseFloat(volumeSlider.value);
      audio.volume = currentVolume;
    });
  }

  // Practice All button
  document.getElementById('start-quiz-btn').addEventListener('click', () => {
    state.quizConfig = { count: null, genres: null };
    startSession();
  });

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
    renderGenreGrid();
    showView('quiz-setup');
  });

  // Stats history — load more
  document.getElementById('stats-load-more').addEventListener('click', () => {
    loadSessionHistory(true);
  });

  // Restore tab from URL hash on load / browser back-forward
  function navigateToHash() {
    const hash = window.location.hash.slice(1);
    if (['library', 'stats', 'quiz-setup'].includes(hash)) {
      showView(hash);
      if (hash === 'quiz-setup') { renderMasteryOverview(); renderGenreGrid(); }
      if (hash === 'stats') renderStats();
    }
  }
  window.addEventListener('hashchange', navigateToHash);
  navigateToHash();
}

init();
