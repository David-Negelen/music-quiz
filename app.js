// ── State ─────────────────────────────────────────────────────────────────

const state = {
  library: [],
  searchResults: [],
  quizQuestions: [],
  quizIndex: 0,
  quizScore: 0,
  quizAnswers: [],
  quizConfig: { count: null, types: ['title', 'artist', 'year'] }, // count null = all
  preMastery: {}, // mastery snapshot taken before each session
};

const audio = document.getElementById('preview-audio');
let timerInterval = null;
let timerSeconds = 30;
let progressInterval = null;

// Web Audio visualizer
let audioCtx = null;
let analyser = null;
let gainNode = null;
let mediaSource = null;
let animFrameId = null;
let currentVolume = 1;

// Must be called synchronously inside a user-gesture handler so the
// AudioContext is created/resumed while the activation is still live.
function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1;
    mediaSource = audioCtx.createMediaElementSource(audio);
    mediaSource.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {}
}

function startVisualizer() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  const canvas = document.getElementById('visualizer');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = (canvas.offsetWidth || 360) * dpr;
  canvas.height = (canvas.offsetHeight || 160) * dpr;

  const ctx2d = canvas.getContext('2d');
  const BIN_COUNT = 72;
  const dataArray = new Uint8Array(128);

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    if (analyser) analyser.getByteFrequencyData(dataArray);

    const W = canvas.width;
    const H = canvas.height;
    const count = Math.min(BIN_COUNT, dataArray.length);
    const gap = 2 * dpr;
    const barW = (W - gap * (count - 1)) / count;

    ctx2d.clearRect(0, 0, W, H);

    for (let i = 0; i < count; i++) {
      const v = dataArray[i] / 255;
      const bH = Math.max(2 * dpr, v * H * 0.95);
      ctx2d.fillStyle = `rgba(252, 60, 68, ${0.25 + v * 0.75})`;
      ctx2d.fillRect(i * (barW + gap), H - bH, barW, bH);
    }
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

function loadStats() {
  try { songStats = JSON.parse(localStorage.getItem('musikquiz_stats') || '{}'); }
  catch { songStats = {}; }
}

function saveStats() {
  localStorage.setItem('musikquiz_stats', JSON.stringify(songStats));
}

function recordAnswer(id, type, correct) {
  const key = String(id);
  if (!songStats[key]) songStats[key] = {};
  if (!songStats[key][type]) songStats[key][type] = { a: 0, c: 0 };
  songStats[key][type].a++;
  if (correct) songStats[key][type].c++;
  saveStats();
}

const MASTERY_ORDER = { new: 0, learning: 1, familiar: 2, mastered: 3 };
const MASTERY_LABEL = { new: 'New', learning: 'Learning', familiar: 'Familiar', mastered: 'Mastered' };

// Returns overall mastery for a song based on all studied types
function getMastery(id) {
  const key = String(id);
  const s = songStats[key];
  if (!s) return 'new';
  let a = 0, c = 0;
  for (const type of ['title', 'artist', 'year']) {
    const t = s[type] || { a: 0, c: 0 };
    a += t.a;
    c += t.c;
  }
  if (a === 0) return 'new';
  const acc = c / a;
  if (acc >= 0.85 && a >= 4) return 'mastered';
  if (acc >= 0.55) return 'familiar';
  return 'learning';
}

function getMasteryStats() {
  const counts = { new: 0, learning: 0, familiar: 0, mastered: 0 };
  state.library.forEach(s => counts[getMastery(s.id)]++);
  return counts;
}

// ── Persistence ───────────────────────────────────────────────────────────

function loadLibrary() {
  try {
    state.library = JSON.parse(localStorage.getItem('musikquiz_library') || '[]');
  } catch {
    state.library = [];
  }
  loadStats();
}

function saveLibrary() {
  localStorage.setItem('musikquiz_library', JSON.stringify(state.library));
}

function inLibrary(id) {
  return state.library.some(s => s.id === id);
}

function addToLibrary(song) {
  if (inLibrary(song.id)) return;
  state.library.push(song);
  saveLibrary();
  renderLibrary();
  updateLibraryStatus();
  document.querySelectorAll(`.add-btn[data-id="${song.id}"]`).forEach(btn => {
    btn.classList.add('added');
    btn.disabled = true;
    btn.title = 'Added';
  });
}

function removeFromLibrary(id) {
  state.library = state.library.filter(s => s.id !== id);
  delete songStats[String(id)];
  saveLibrary();
  saveStats();
  renderLibrary();
  updateLibraryStatus();
  document.querySelectorAll(`.add-btn[data-id="${id}"]`).forEach(btn => {
    btn.classList.remove('added');
    btn.disabled = false;
    btn.title = 'Add to library';
  });
}

// ── iTunes Search API ─────────────────────────────────────────────────────

async function searchSongs(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=24&country=de`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Search failed');
  const data = await res.json();
  return data.results
    .filter(r => r.previewUrl)
    .map(r => ({
      id: r.trackId,
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName || '',
      year: r.releaseDate ? r.releaseDate.slice(0, 4) : '????',
      previewUrl: r.previewUrl,
      artwork: (r.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
    }));
}

// ── Study Session ─────────────────────────────────────────────────────────

const QUESTION_LABELS = {
  title: 'What is this song called?',
  artist: 'Who is the artist?',
  year: 'What year was this released?',
};

const TYPE_NAMES = { title: 'Title', artist: 'Artist', year: 'Year' };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateQuestion(song, type) {
  const correct = type === 'title' ? song.title
    : type === 'artist' ? song.artist
    : song.year;
  return { song, type, question: QUESTION_LABELS[type], correct, answered: null };
}

function buildStudySession() {
  const { count, types } = state.quizConfig;
  if (!types.length) return null;

  // Group songs by mastery level, shuffle within each group so the order
  // isn't predictable, but weaker songs still come before stronger ones.
  const groups = { new: [], learning: [], familiar: [], mastered: [] };
  state.library.forEach(s => groups[getMastery(s.id)].push(s));
  const sorted = [
    ...shuffle(groups.new),
    ...shuffle(groups.learning),
    ...shuffle(groups.familiar),
    ...shuffle(groups.mastered),
  ];

  const limit = (count === null || count >= state.library.length) ? state.library.length : count;
  const songs = sorted.slice(0, limit);

  const questions = [];
  for (const song of songs) {
    for (const type of types) {
      questions.push(generateQuestion(song, type));
    }
  }
  return questions;
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

  // resume() returns an already-resolved Promise when the context is running,
  // so .then() fires in the current microtask and stays within the user-gesture
  // activation window on Chrome/Firefox/Safari desktop.
  playBtn.onclick = () => {
    ensureAudioGraph();
    if (!audio.paused) { audio.pause(); return; }
    const p = audioCtx ? audioCtx.resume() : Promise.resolve();
    p.then(() => audio.play().catch(() => {}));
  };

  startVisualizer();

  // Autoplay — callers (startSession / next-btn / retry-btn) call
  // ensureAudioGraph() first, so audioCtx is already created and running.
  const p = audioCtx ? audioCtx.resume() : Promise.resolve();
  p.then(() => audio.play().catch(() => { playIcon.textContent = '▶'; }));
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
  list.innerHTML = state.library.map((song) => {
    const mastery = getMastery(song.id);
    return `
    <div class="song-row">
      <img src="${song.artwork}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="song-row-info">
        <div class="song-row-title">${esc(song.title)}</div>
        <div class="song-row-sub">${esc(song.artist)} · ${song.year}</div>
      </div>
      <span class="mastery-dot mastery-${mastery}" title="${MASTERY_LABEL[mastery]}"></span>
      <button class="remove-btn" data-id="${song.id}" title="Remove">×</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeFromLibrary(Number(btn.dataset.id)));
  });
}

function renderMasteryOverview() {
  const el = document.getElementById('mastery-overview');
  if (!el) return;
  if (!state.library.length) { el.innerHTML = ''; return; }
  const counts = getMasteryStats();
  el.innerHTML = [
    ['mastered', '✓'],
    ['familiar', '◑'],
    ['learning', '◔'],
    ['new', '○'],
  ]
    .filter(([level]) => counts[level] > 0)
    .map(([level, icon]) =>
      `<span class="mastery-pill mastery-pill-${level}">${icon} ${counts[level]} ${MASTERY_LABEL[level]}</span>`
    )
    .join('');
}

function updateLibraryStatus() {
  const el = document.getElementById('library-status');
  const n = state.library.length;
  if (n === 0) el.textContent = 'Add songs to your library first.';
  else if (n < 2) el.textContent = `${n} song in library — add at least one more to start.`;
  else el.textContent = `${n} songs in library.`;
  renderMasteryOverview();
}

// ── Render: Study Question ────────────────────────────────────────────────

function renderQuestion() {
  const q = state.quizQuestions[state.quizIndex];
  const typesCount = state.quizConfig.types.length;
  const currentSong = Math.floor(state.quizIndex / typesCount) + 1;
  const totalSongs = Math.floor(state.quizQuestions.length / typesCount);

  document.getElementById('quiz-progress').textContent =
    `Song ${currentSong} / ${totalSongs} · ${TYPE_NAMES[q.type]}`;
  document.getElementById('quiz-score').textContent = `${state.quizScore} pts`;
  document.getElementById('question-text').textContent = q.question;

  const nextBtn = document.getElementById('next-btn');
  nextBtn.style.display = 'none';

  const answerInput = document.getElementById('answer-input');
  const submitBtn = document.getElementById('submit-answer-btn');
  const feedbackEl = document.getElementById('answer-feedback');

  answerInput.value = '';
  answerInput.disabled = false;
  answerInput.placeholder = q.type === 'year' ? 'Enter the release year…' : 'Type your answer…';
  submitBtn.disabled = false;
  feedbackEl.style.display = 'none';
  feedbackEl.className = 'answer-feedback';

  function submit() {
    const val = answerInput.value.trim();
    if (!val) return;
    handleAnswer(val);
  }

  submitBtn.onclick = submit;
  answerInput.onkeydown = e => { if (e.key === 'Enter') submit(); };
  setTimeout(() => answerInput.focus(), 50);

  if (q.song.previewUrl) startAudio(q.song.previewUrl);
  else startVisualizer();
}

function handleAnswer(userInput) {
  const q = state.quizQuestions[state.quizIndex];
  if (q.answered !== null) return;
  q.answered = userInput;

  stopAudio();

  const isCorrect = isAnswerCorrect(userInput, q.correct, q.type);
  state.quizScore += isCorrect ? 10 : 0;
  state.quizAnswers.push({ correct: isCorrect, song: q.song, type: q.type });

  recordAnswer(q.song.id, q.type, isCorrect);

  document.getElementById('quiz-score').textContent = `${state.quizScore} pts`;

  const answerInput = document.getElementById('answer-input');
  const submitBtn = document.getElementById('submit-answer-btn');
  const feedbackEl = document.getElementById('answer-feedback');

  answerInput.disabled = true;
  submitBtn.disabled = true;
  feedbackEl.style.display = 'block';

  if (isCorrect) {
    feedbackEl.className = 'answer-feedback correct';
    feedbackEl.textContent = 'Correct!';
  } else {
    feedbackEl.className = 'answer-feedback wrong';
    let hint = q.correct;
    if (q.type === 'title') hint += ` — ${q.song.artist}`;
    else if (q.type === 'artist') hint += ` (${q.song.title})`;
    feedbackEl.textContent = `Wrong. Answer: ${hint}`;
  }

  document.getElementById('next-btn').style.display = 'block';
}

function advanceQuiz() {
  state.quizIndex++;
  if (state.quizIndex >= state.quizQuestions.length) {
    showResults();
  } else {
    renderQuestion();
  }
}

// ── Results ───────────────────────────────────────────────────────────────

function showResults() {
  showView('results');

  const correct = state.quizAnswers.filter(a => a.correct).length;
  const total = state.quizAnswers.length;
  const pct = Math.round((correct / total) * 100);

  // Count mastery improvements during this session
  let improved = 0, newlyMastered = 0;
  const seenSongs = new Set();
  state.quizQuestions.forEach(q => {
    const id = String(q.song.id);
    if (seenSongs.has(id)) return;
    seenSongs.add(id);
    const before = state.preMastery[id] || 'new';
    const after = getMastery(q.song.id);
    if (MASTERY_ORDER[after] > MASTERY_ORDER[before]) {
      improved++;
      if (after === 'mastered') newlyMastered++;
    }
  });

  const emoji = pct >= 90 ? '🏆' : pct >= 70 ? '🎵' : pct >= 50 ? '🎶' : '🎸';
  document.getElementById('results-emoji').textContent = emoji;
  document.getElementById('results-score').textContent = `${correct} / ${total}`;

  const byType = {};
  state.quizAnswers.forEach(a => {
    if (!byType[a.type]) byType[a.type] = { correct: 0, total: 0 };
    byType[a.type].total++;
    if (a.correct) byType[a.type].correct++;
  });

  const typeLabels = { title: 'Song title', artist: 'Artist', year: 'Release year' };
  const masteryAfter = getMasteryStats();
  const masteryIcons = { mastered: '✓', familiar: '◑', learning: '◔', new: '○' };

  const libraryProgress = ['mastered', 'familiar', 'learning', 'new']
    .filter(l => masteryAfter[l] > 0)
    .map(l => `${masteryIcons[l]} ${masteryAfter[l]}`)
    .join('  ');

  const breakdown = document.getElementById('results-breakdown');
  breakdown.innerHTML = `
    <div class="breakdown-row">
      <span>Accuracy</span>
      <span>${pct}%</span>
    </div>
    ${improved > 0 ? `
    <div class="breakdown-row">
      <span>Songs improved</span>
      <span class="correct-row">${improved}${newlyMastered > 0 ? ` · ${newlyMastered} mastered` : ''}</span>
    </div>` : ''}
    ${Object.entries(byType).map(([type, stat]) => `
    <div class="breakdown-row">
      <span>${typeLabels[type] || type}</span>
      <span>${stat.correct} / ${stat.total}</span>
    </div>`).join('')}
    <div class="breakdown-row">
      <span>Library progress</span>
      <span class="mastery-summary">${libraryProgress}</span>
    </div>`;
}

// ── Utility ───────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function startSession() {
  const types = [...document.querySelectorAll('input[name="qtype"]:checked')].map(cb => cb.value);
  const setupError = document.getElementById('setup-error');

  if (state.library.length < 2) {
    setupError.textContent = 'Add at least 2 songs to your library first.';
    setupError.style.display = 'block';
    return;
  }
  if (!types.length) {
    setupError.textContent = 'Select at least one question type.';
    setupError.style.display = 'block';
    return;
  }
  setupError.style.display = 'none';

  const studyAllCheckbox = document.getElementById('study-all');
  const studyAll = studyAllCheckbox ? studyAllCheckbox.checked : true;
  const count = studyAll ? null : parseInt(document.getElementById('q-count').textContent, 10);

  ensureAudioGraph(); // must happen synchronously inside this click handler
  state.quizConfig = { count, types };

  // Snapshot mastery before session so results can show improvements
  state.preMastery = {};
  state.library.forEach(s => { state.preMastery[String(s.id)] = getMastery(s.id); });

  state.quizQuestions = buildStudySession();
  state.quizIndex = 0;
  state.quizScore = 0;
  state.quizAnswers = [];

  showView('quiz-active');
  renderQuestion();
}

function init() {
  loadLibrary();
  renderLibrary();
  updateLibraryStatus();

  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      showView(btn.dataset.view);
      if (btn.dataset.view === 'quiz-setup') renderMasteryOverview();
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

  // Import modal
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

  // Clear library
  document.getElementById('clear-library-btn').addEventListener('click', () => {
    if (!state.library.length) return;
    if (confirm(`Remove all ${state.library.length} songs from your library?`)) {
      state.library = [];
      songStats = {};
      saveLibrary();
      saveStats();
      renderLibrary();
      updateLibraryStatus();
      document.querySelectorAll('.add-btn.added').forEach(btn => {
        btn.classList.remove('added');
        btn.disabled = false;
        btn.innerHTML = '<span>+</span>';
      });
    }
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
  document.getElementById('next-btn').addEventListener('click', () => {
    ensureAudioGraph();
    advanceQuiz();
  });

  // Results actions
  document.getElementById('retry-btn').addEventListener('click', () => {
    ensureAudioGraph();
    state.preMastery = {};
    state.library.forEach(s => { state.preMastery[String(s.id)] = getMastery(s.id); });
    state.quizQuestions = buildStudySession();
    state.quizIndex = 0;
    state.quizScore = 0;
    state.quizAnswers = [];
    showView('quiz-active');
    renderQuestion();
  });

  document.getElementById('back-library-btn').addEventListener('click', () => {
    showView('library');
  });
}

init();
