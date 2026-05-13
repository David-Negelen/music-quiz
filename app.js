// ── State ─────────────────────────────────────────────────────────────────

const state = {
  library: [],
  searchResults: [],
  quizQuestions: [],
  quizIndex: 0,
  quizScore: 0,
  quizAnswers: [],
  quizConfig: { count: 10, types: ['title', 'artist', 'year'] },
};

const audio = document.getElementById('preview-audio');
let timerInterval = null;
let timerSeconds = 30;
let progressInterval = null;

// Web Audio visualizer
let audioCtx = null;
let analyser = null;
let mediaSource = null;
let animFrameId = null;

function ensureAudioGraph() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    mediaSource = audioCtx.createMediaElementSource(audio);
    mediaSource.connect(analyser);
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

// ── Persistence ───────────────────────────────────────────────────────────

function loadLibrary() {
  try {
    state.library = JSON.parse(localStorage.getItem('musikquiz_library') || '[]');
  } catch {
    state.library = [];
  }
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
  // Refresh search result buttons
  document.querySelectorAll(`.add-btn[data-id="${song.id}"]`).forEach(btn => {
    btn.classList.add('added');
    btn.disabled = true;
    btn.title = 'Added';
  });
}

function removeFromLibrary(id) {
  state.library = state.library.filter(s => s.id !== id);
  saveLibrary();
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

// ── Quiz Generation ───────────────────────────────────────────────────────

const QUESTION_LABELS = {
  title: 'What is this song called?',
  artist: 'Who is the artist?',
  year: 'What year was this released?',
};

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

function buildQuiz() {
  const { count, types } = state.quizConfig;
  if (types.length === 0) return null;
  const songs = shuffle(state.library).slice(0, Math.min(count, state.library.length));
  return songs.map(song => {
    const type = types[Math.floor(Math.random() * types.length)];
    return generateQuestion(song, type);
  });
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

  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const progressFill = document.getElementById('progress-fill');
  const timerDisplay = document.getElementById('timer-display');

  timerSeconds = 30;

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

  audio.addEventListener('play', () => { playIcon.textContent = '⏸'; }, { once: false });
  audio.addEventListener('pause', () => { playIcon.textContent = '▶'; }, { once: false });
  audio.addEventListener('ended', () => {
    playIcon.textContent = '▶';
    progressFill.style.width = '100%';
    timerDisplay.textContent = '0:00';
  });

  playBtn.onclick = () => {
    ensureAudioGraph();
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };

  ensureAudioGraph();
  startVisualizer();

  audio.play().catch(() => {
    playIcon.textContent = '▶';
  });
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
  list.innerHTML = state.library.map((song, i) => `
    <div class="song-row">
      <img src="${song.artwork}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="song-row-info">
        <div class="song-row-title">${esc(song.title)}</div>
        <div class="song-row-sub">${esc(song.artist)} · ${song.year}</div>
      </div>
      <button class="remove-btn" data-id="${song.id}" title="Remove">×</button>
    </div>`).join('');

  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeFromLibrary(Number(btn.dataset.id)));
  });
}

function updateLibraryStatus() {
  const el = document.getElementById('library-status');
  const n = state.library.length;
  if (n === 0) el.textContent = 'Add songs to your library first.';
  else if (n < 4) el.textContent = `${n} song${n > 1 ? 's' : ''} in library — need at least 4 to quiz.`;
  else el.textContent = `${n} songs in library.`;
}

// ── Render: Quiz ──────────────────────────────────────────────────────────

function renderQuestion() {
  const q = state.quizQuestions[state.quizIndex];
  const total = state.quizQuestions.length;

  document.getElementById('quiz-progress').textContent = `${state.quizIndex + 1} / ${total}`;
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

  const emoji = pct >= 90 ? '🏆' : pct >= 70 ? '🎵' : pct >= 50 ? '🎶' : '🎸';
  document.getElementById('results-emoji').textContent = emoji;
  document.getElementById('results-score').textContent = `${state.quizScore} / ${total * 10} pts`;

  const byType = {};
  state.quizAnswers.forEach(a => {
    if (!byType[a.type]) byType[a.type] = { correct: 0, total: 0 };
    byType[a.type].total++;
    if (a.correct) byType[a.type].correct++;
  });

  const typeLabels = { title: 'Song title', artist: 'Artist', year: 'Release year' };
  const breakdown = document.getElementById('results-breakdown');
  breakdown.innerHTML = `
    <div class="breakdown-row">
      <span>Correct answers</span>
      <span class="correct-row">${correct} / ${total} (${pct}%)</span>
    </div>
    ${Object.entries(byType).map(([type, stat]) => `
      <div class="breakdown-row">
        <span>${typeLabels[type] || type}</span>
        <span>${stat.correct} / ${stat.total}</span>
      </div>`).join('')}`;
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

// Parse "Artist - Title" or plain "Title" lines from pasted text
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
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=5&country=de`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const results = data.results.filter(r => r.previewUrl);
  if (!results.length) return null;
  // Prefer exact title match if available
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

    // Small delay to avoid hammering the iTunes API
    if (i < entries.length - 1) await new Promise(r => setTimeout(r, 120));
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

function init() {
  loadLibrary();
  renderLibrary();
  updateLibraryStatus();

  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
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
      saveLibrary();
      renderLibrary();
      updateLibraryStatus();
      // Reset add buttons in search results
      document.querySelectorAll('.add-btn.added').forEach(btn => {
        btn.classList.remove('added');
        btn.disabled = false;
        btn.innerHTML = '<span>+</span>';
      });
    }
  });

  // Quiz setup — question count picker
  let qCount = 10;
  const qCountEl = document.getElementById('q-count');
  document.getElementById('q-minus').addEventListener('click', () => {
    if (qCount > 1) { qCount--; qCountEl.textContent = qCount; }
  });
  document.getElementById('q-plus').addEventListener('click', () => {
    if (qCount < 50) { qCount++; qCountEl.textContent = qCount; }
  });

  // Start quiz
  document.getElementById('start-quiz-btn').addEventListener('click', () => {
    const types = [...document.querySelectorAll('input[name="qtype"]:checked')].map(cb => cb.value);
    const setupError = document.getElementById('setup-error');

    if (state.library.length < 4) {
      setupError.textContent = 'Add at least 4 songs to your library first.';
      setupError.style.display = 'block';
      return;
    }
    if (!types.length) {
      setupError.textContent = 'Select at least one question type.';
      setupError.style.display = 'block';
      return;
    }
    setupError.style.display = 'none';

    state.quizConfig = { count: qCount, types };
    state.quizQuestions = buildQuiz();
    state.quizIndex = 0;
    state.quizScore = 0;
    state.quizAnswers = [];

    showView('quiz-active');
    renderQuestion();
  });

  // Next question
  document.getElementById('next-btn').addEventListener('click', advanceQuiz);

  // Results actions
  document.getElementById('retry-btn').addEventListener('click', () => {
    state.quizQuestions = buildQuiz();
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
