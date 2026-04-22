/* ============================================================
   Somatica Library - app.js v2 (2026-04-20)
   Galerie des clips vidéo stockés sur Cloudflare R2.
   Backend : Supabase (table video_library).

   Optimisations par rapport à v1 :
   - SELECT explicite (exclut analysis_raw, transcript_text, audio_summary, etc.)
   - Filtres côté serveur via .eq/.gte/.contains
   - Pagination .range() + infinite scroll (IntersectionObserver)
   - Lazy-load des vignettes via IntersectionObserver
   - Utilise thumbnail_url (JPG 600px) quand dispo, fallback video preload=metadata
   - Persistance localStorage des filtres
   ============================================================ */

// ---------- CONFIG ----------
const SUPABASE_URL = 'https://zrdlvoovrnglxcgoyyeb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ukrn7WQHygY5FUtNiMxxfA_E-esyAUs';
const JEROME_USER_ID = 'ffaaef6d-7636-417a-837c-7823751adcdd';
const PAGE_SIZE = 60;

// ---------- PICKER MODE (retour SomaticaEdit) ----------
// Activé via ?mode=picker&return=<edit_project_id>
// Quand actif : bouton "Envoyer" devient "Valider la sélection",
// la sélection est injectée comme layer video-sequence dans le projet Edit existant,
// puis on redirige vers SomaticaEdit (?p=<return_id>).
const _urlParams = new URLSearchParams(window.location.search);
const PICKER_MODE = _urlParams.get('mode') === 'picker';
const RETURN_PROJECT_ID = _urlParams.get('return') || '';

// Colonnes utiles UNIQUEMENT. On exclut les champs lourds (transcript, analysis_raw)
// qui ne servent pas au rendu grid et plombaient le download.
const LIGHT_COLS = [
  'id', 'file_name', 'r2_url', 'r2_key', 'thumbnail_url', 'thumbnail_generated_at',
  'duration_seconds', 'width', 'height', 'size_bytes',
  'created_at_source', 'created_at', 'updated_at',
  'status', 'analysis_status', 'analyzed_at', 'analysis_prompt_version',
  'description_short', 'notes', 'tags',
  'ambiance', 'movement', 'lighting',
  'quality_score', 'persons_count', 'persons_detected',
  'music_present', 'has_speech', 'emotional_intensity', 'emotional_states',
  'usable_for_reel', 'location_name',
].join(',');

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
window.sb = sb;
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

// ---------- STATE ----------
const DEFAULT_FILTERS = {
  search: '',
  sort: 'source_desc',
  status: 'available',
  analysis: '',
  duration: '',
  ambiance: '',
  movement: '',
  lighting: '',
  location: '',
  persons: '',
  qualityMin: 0,
  intensity: '',
  music: '',     // '' | 'with' | 'without'
  speech: '',    // '' | 'with' | 'without'
  usableReel: false,
  usage: '',     // '' | 'unused' | 'used'
  emotions: [],  // multi
  tags: [],      // multi
  personsNames: [],  // multi (noms Apple)
};

const state = {
  clips: [],                  // cumul paginé
  selection: new Set(),
  currentModalId: null,
  session: null,
  filters: loadFilters(),
  cols: null,
  page: 0,
  totalRows: null,
  filteredCount: null,
  loading: false,
  finished: false,
  // Catalogues remplis depuis la DB (distinct values)
  catalog: {
    ambiances: [], movements: [], lightings: [], locations: [],
    emotions: [], tags: [], personsNames: [],
  },
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const authScreen = $('auth-screen');
const app = $('app');
const emailInput = $('email-input');
const sendLinkBtn = $('send-link');
const codeInput = $('code-input');
const verifyCodeBtn = $('verify-code');
const changeEmailLink = $('change-email');
const stepEmail = $('step-email');
const stepCode = $('step-code');
const authMsg = $('auth-msg');
const totalCount = $('total-count');
const filteredCount = $('filtered-count');
const searchInput = $('search-input');
const sortSelect = $('sort-select');
const usableReelChip = $('usable-reel');
const qualitySlider = $('quality-slider');
const qualityVal = $('quality-val');
const personsFilter = $('persons-filter');
const intensityFilter = $('intensity-filter');
const chipMusicWith = $('chip-music-with');
const chipMusicWithout = $('chip-music-without');
const chipSpeechWith = $('chip-speech-with');
const chipSpeechWithout = $('chip-speech-without');
const ambianceFilter = $('ambiance-filter');
const movementFilter = $('movement-filter');
const lightingFilter = $('lighting-filter');
const locationFilter = $('location-filter');
const durationFilter = $('duration-filter');
const statusFilter = $('status-filter');
const analysisFilter = $('analysis-filter');
const resetFiltersBtn = $('reset-filters');
const btnOpenDrawer = $('btn-open-drawer');
const drawerOverlay = $('drawer-overlay');
const filtersDrawer = $('filters-drawer');
const drawerClose = $('drawer-close');
const drawerApply = $('drawer-apply');
const activeFiltersBadge = $('active-filters-badge');
const presetsRow = $('presets-row');
const activeChipsRow = $('active-chips-row');
const gallery = $('gallery');
const selectionBar = $('selection-bar');
const selCount = $('sel-count');
const selMeta = $('sel-meta');
const clearSelectionBtn = $('clear-selection');
const sendToEditBtn = $('send-to-edit');
const modalBg = $('modal-bg');
const modalTitle = $('modal-title');
const modalVideo = $('modal-video');
const modalBody = $('modal-body');
const modalActions = $('modal-actions');
const modalClose = $('modal-close');

// ---------- UTILS ----------
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtDuration(sec) {
  if (sec == null) return '—';
  sec = Math.round(Number(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, '0')}`;
}

function fmtDurationLong(sec) {
  if (sec == null || sec === 0) return '0s';
  sec = Math.round(Number(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2,'0')}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2,'0')}`;
  return `${s}s`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function loadFilters() {
  try {
    const raw = localStorage.getItem('library_filters_v2');
    if (!raw) return { ...DEFAULT_FILTERS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch { return { ...DEFAULT_FILTERS }; }
}

function saveFilters() {
  try { localStorage.setItem('library_filters_v2', JSON.stringify(state.filters)); } catch (e) {}
}

// ---------- AUTH ----------
async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  if (session) {
    authScreen.style.display = 'none';
    app.style.display = 'block';
    syncFiltersToUI();
    await bootstrapCatalogs();
    await loadFirstPage();
  } else {
    authScreen.style.display = 'flex';
    app.style.display = 'none';
  }
}

let pendingEmail = '';

sendLinkBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email) {
    authMsg.className = 'msg error';
    authMsg.textContent = 'Entre ton email';
    return;
  }
  sendLinkBtn.disabled = true;
  sendLinkBtn.textContent = 'Envoi...';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: window.location.origin + window.location.pathname,
    },
  });
  sendLinkBtn.disabled = false;
  sendLinkBtn.textContent = 'Recevoir un code';
  if (error) {
    authMsg.className = 'msg error';
    authMsg.textContent = error.message;
  } else {
    pendingEmail = email;
    stepEmail.style.display = 'none';
    stepCode.style.display = 'block';
    authMsg.className = 'msg';
    authMsg.textContent = `Code envoyé à ${email}. Saisis-le ci-dessus.`;
    setTimeout(() => codeInput.focus(), 100);
  }
});

verifyCodeBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim();
  if (!code || !pendingEmail) {
    authMsg.className = 'msg error';
    authMsg.textContent = 'Saisis le code reçu par email';
    return;
  }
  verifyCodeBtn.disabled = true;
  verifyCodeBtn.textContent = 'Vérification...';
  const { error } = await sb.auth.verifyOtp({
    email: pendingEmail,
    token: code,
    type: 'email',
  });
  verifyCodeBtn.disabled = false;
  verifyCodeBtn.textContent = 'Se connecter';
  if (error) {
    authMsg.className = 'msg error';
    authMsg.textContent = error.message;
  } else {
    authMsg.className = 'msg';
    authMsg.textContent = 'Connexion réussie';
  }
});

codeInput && codeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') verifyCodeBtn.click();
});
emailInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendLinkBtn.click();
});
changeEmailLink && changeEmailLink.addEventListener('click', e => {
  e.preventDefault();
  pendingEmail = '';
  stepCode.style.display = 'none';
  stepEmail.style.display = 'block';
  authMsg.textContent = '';
  emailInput.focus();
});

sb.auth.onAuthStateChange((_event, session) => {
  state.session = session;
  if (session) {
    authScreen.style.display = 'none';
    app.style.display = 'block';
    if (!state.clips.length) {
      syncFiltersToUI();
      bootstrapCatalogs().then(loadFirstPage);
    }
  } else {
    authScreen.style.display = 'flex';
    app.style.display = 'none';
  }
});

// ---------- CATALOGS (distinct values pour multi-select) ----------
async function bootstrapCatalogs() {
  // On récupère les valeurs distinctes depuis un échantillon pour nourrir les multi-select.
  // Plus simple que des GROUP BY : on lit les 1000 premières lignes analysées.
  const { data, error } = await sb
    .from('video_library')
    .select('ambiance,movement,lighting,location_name,emotional_states,tags,persons_detected,analysis_status')
    .limit(2000);
  if (error) { console.warn('catalog load error', error); return; }

  const amb = new Map(), mov = new Map(), lig = new Map(), loc = new Map();
  const emo = new Map(), tag = new Map(), persons = new Map();
  for (const r of data || []) {
    if (r.ambiance) amb.set(r.ambiance, (amb.get(r.ambiance) || 0) + 1);
    if (r.movement) mov.set(r.movement, (mov.get(r.movement) || 0) + 1);
    if (r.lighting) lig.set(r.lighting, (lig.get(r.lighting) || 0) + 1);
    if (r.location_name) loc.set(r.location_name, (loc.get(r.location_name) || 0) + 1);
    (r.emotional_states || []).forEach(e => emo.set(e, (emo.get(e) || 0) + 1));
    (r.tags || []).forEach(t => tag.set(t, (tag.get(t) || 0) + 1));
    // noms de personnes (filtrer _UNKNOWN_ et doublons dans la même vidéo)
    const uniq = new Set((r.persons_detected || []).filter(n => n && n !== '_UNKNOWN_'));
    uniq.forEach(n => persons.set(n, (persons.get(n) || 0) + 1));
  }
  const toSorted = (m) => [...m.entries()].sort((a,b) => b[1]-a[1]).map(([v, c]) => ({ value: v, count: c }));
  state.catalog.ambiances = toSorted(amb);
  state.catalog.movements = toSorted(mov);
  state.catalog.lightings = toSorted(lig);
  state.catalog.locations = toSorted(loc);
  state.catalog.emotions  = toSorted(emo);
  state.catalog.tags      = toSorted(tag);
  state.catalog.personsNames = toSorted(persons);

  populateSelect(ambianceFilter, state.catalog.ambiances, 'Toutes ambiances');
  populateSelect(movementFilter, state.catalog.movements, 'Tous mouvements');
  populateSelect(lightingFilter, state.catalog.lightings, 'Tous éclairages');
  populateSelect(locationFilter, state.catalog.locations, 'Tous lieux');
  populateMultiSelect('emotions', state.catalog.emotions);
  populateMultiSelect('tags', state.catalog.tags);
  populateMultiSelect('personsNames', state.catalog.personsNames);

  // Restaurer les valeurs après populate
  ambianceFilter.value = state.filters.ambiance || '';
  movementFilter.value = state.filters.movement || '';
  lightingFilter.value = state.filters.lighting || '';
  locationFilter.value = state.filters.location || '';
  updateMultiSelectBtn('emotions');
  updateMultiSelectBtn('tags');
  updateMultiSelectBtn('personsNames');
}

function populateSelect(el, items, placeholder) {
  const cur = el.value;
  el.innerHTML = `<option value="">${placeholder}</option>` +
    items.map(({ value, count }) => `<option value="${escapeAttr(value)}">${escapeHtml(value)} (${count})</option>`).join('');
  el.value = cur;
}

function populateMultiSelect(kind, items) {
  const panel = document.getElementById(`${kind}-panel`);
  panel.innerHTML = '';
  for (const { value, count } of items) {
    const opt = document.createElement('div');
    opt.className = 'opt';
    opt.dataset.value = value;
    opt.innerHTML = `
      <div class="tick">${state.filters[kind].includes(value) ? '✓' : ''}</div>
      <span>${escapeHtml(value)}</span>
      <span class="cnt">${count}</span>
    `;
    if (state.filters[kind].includes(value)) opt.classList.add('selected');
    opt.addEventListener('click', () => toggleMulti(kind, value));
    panel.appendChild(opt);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

function toggleMulti(kind, value) {
  const arr = state.filters[kind];
  const idx = arr.indexOf(value);
  if (idx > -1) arr.splice(idx, 1); else arr.push(value);
  // Re-render le panel
  const panel = document.getElementById(`${kind}-panel`);
  for (const opt of panel.querySelectorAll('.opt')) {
    const v = opt.dataset.value;
    const selected = arr.includes(v);
    opt.classList.toggle('selected', selected);
    opt.querySelector('.tick').textContent = selected ? '✓' : '';
  }
  updateMultiSelectBtn(kind);
  saveFilters();
  resetAndReload();
}

function updateMultiSelectBtn(kind) {
  const btn = document.getElementById(`${kind}-btn`);
  if (!btn) return;
  const arr = state.filters[kind];
  const labels = {
    emotions: 'Émotion',
    tags: 'Tags',
    personsNames: '👤 Personnes',
  };
  const label = labels[kind] || kind;
  if (arr.length) {
    btn.querySelector('span:first-child').textContent = `${label} (${arr.length})`;
    btn.classList.add('has-selection');
  } else {
    btn.querySelector('span:first-child').textContent = label;
    btn.classList.remove('has-selection');
  }
}

// Open/close multi-select panels
document.addEventListener('click', (e) => {
  document.querySelectorAll('.multi-select').forEach(ms => {
    if (ms.contains(e.target) && e.target.closest('.multi-select-btn')) {
      ms.classList.toggle('open');
    } else if (!ms.contains(e.target)) {
      ms.classList.remove('open');
    }
  });
});

// ---------- DATA FETCH ----------
function buildQuery() {
  let q = sb.from('video_library').select(LIGHT_COLS, { count: 'exact' });

  const f = state.filters;

  if (f.status) q = q.eq('status', f.status);
  if (f.analysis) q = q.eq('analysis_status', f.analysis);
  if (f.ambiance) q = q.eq('ambiance', f.ambiance);
  if (f.movement) q = q.eq('movement', f.movement);
  if (f.lighting) q = q.eq('lighting', f.lighting);
  if (f.location) q = q.eq('location_name', f.location);
  if (f.intensity) q = q.eq('emotional_intensity', f.intensity);

  if (f.qualityMin > 0) q = q.gte('quality_score', f.qualityMin);

  if (f.usableReel) q = q.eq('usable_for_reel', true);

  if (f.persons === '0') q = q.eq('persons_count', 0);
  else if (f.persons === '1') q = q.eq('persons_count', 1);
  else if (f.persons === '2+') q = q.gte('persons_count', 2);

  if (f.music === 'with') q = q.eq('music_present', true);
  else if (f.music === 'without') q = q.eq('music_present', false);

  if (f.speech === 'with') q = q.eq('has_speech', true);
  else if (f.speech === 'without') q = q.eq('has_speech', false);

  if (f.duration === 'short') q = q.lt('duration_seconds', 15);
  else if (f.duration === 'medium') q = q.gte('duration_seconds', 15).lt('duration_seconds', 60);
  else if (f.duration === 'long') q = q.gte('duration_seconds', 60);

  if (f.emotions.length) q = q.contains('emotional_states', f.emotions);
  if (f.tags.length) q = q.contains('tags', f.tags);
  if (f.personsNames && f.personsNames.length) q = q.overlaps('persons_detected', f.personsNames);

  if (f.search) {
    const s = f.search.replace(/[%_]/g, '');
    // ilike sur plusieurs colonnes via or()
    q = q.or([
      `description_short.ilike.%${s}%`,
      `notes.ilike.%${s}%`,
      `file_name.ilike.%${s}%`,
      `ambiance.ilike.%${s}%`,
      `location_name.ilike.%${s}%`,
    ].join(','));
  }

  // Tri
  switch (f.sort) {
    case 'upload_desc':
      q = q.order('created_at', { ascending: false, nullsFirst: false });
      break;
    case 'upload_asc':
      q = q.order('created_at', { ascending: true, nullsFirst: false });
      break;
    case 'source_asc':
      q = q.order('created_at_source', { ascending: true, nullsFirst: false });
      break;
    case 'location_asc':
      q = q.order('location_name', { ascending: true, nullsFirst: false })
           .order('created_at_source', { ascending: false, nullsFirst: false });
      break;
    case 'quality_desc':
      q = q.order('quality_score', { ascending: false, nullsFirst: false })
           .order('created_at_source', { ascending: false, nullsFirst: false });
      break;
    case 'quality_asc':
      q = q.order('quality_score', { ascending: true, nullsFirst: false })
           .order('created_at_source', { ascending: false, nullsFirst: false });
      break;
    case 'duration_asc':
      q = q.order('duration_seconds', { ascending: true, nullsFirst: false });
      break;
    case 'duration_desc':
      q = q.order('duration_seconds', { ascending: false, nullsFirst: false });
      break;
    case 'source_desc':
    default:
      q = q.order('created_at_source', { ascending: false, nullsFirst: false });
      break;
  }

  return q;
}

async function loadFirstPage() {
  state.clips = [];
  state.page = 0;
  state.finished = false;
  state.totalRows = null;
  state.filteredCount = null;
  _usedIdsCache = null; // force refresh (peut-être qu'un clip vient d'être utilisé)
  gallery.innerHTML = '<div class="loading">Chargement...</div>';
  await loadMore();
}

async function loadMore() {
  if (state.loading || state.finished) return;
  state.loading = true;
  const from = state.page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  let q = buildQuery();
  // Si filtre usage, on doit d'abord récupérer les IDs concernés (unused = NOT IN, used = IN)
  if (state.filters.usage) {
    const usedIds = await getAllUsedVideoIds();
    if (state.filters.usage === 'unused') {
      if (usedIds.length) q = q.not('id', 'in', `(${usedIds.map(id => `"${id}"`).join(',')})`);
    } else if (state.filters.usage === 'used') {
      if (!usedIds.length) {
        state.loading = false;
        state.finished = true;
        state.filteredCount = 0;
        renderGallery();
        return;
      }
      q = q.in('id', usedIds);
    }
  }
  const { data, error, count } = await q.range(from, to);
  state.loading = false;
  if (error) {
    console.error(error);
    gallery.innerHTML = `<div class="empty-state"><h2>Erreur</h2><p>${error.message}</p></div>`;
    return;
  }
  if (count != null) {
    state.filteredCount = count;
    updateCounts();
  }
  if (!data || !data.length) {
    state.finished = true;
    renderGallery();
    return;
  }
  // Enrichir avec l'usage (vw_video_library_usage) avant d'afficher
  await enrichWithUsage(data);
  state.clips.push(...data);
  state.page += 1;
  if (data.length < PAGE_SIZE) state.finished = true;
  renderGallery();
}

// Cache des IDs "utilisés" pour le filtre usage (rechargé quand filtre change)
let _usedIdsCache = null;
async function getAllUsedVideoIds() {
  if (_usedIdsCache) return _usedIdsCache;
  const { data, error } = await sb
    .from('reel_library_sources')
    .select('video_library_id');
  if (error) { console.warn('getAllUsedVideoIds', error); return []; }
  const uniq = [...new Set((data || []).map(r => r.video_library_id).filter(Boolean))];
  _usedIdsCache = uniq;
  return uniq;
}

// Pour chaque clip chargé, récupère son usage (count, feed_image_ids, last_used_at)
// depuis vw_video_library_usage et l'attache au clip.
async function enrichWithUsage(clips) {
  if (!clips || !clips.length) return;
  const ids = clips.map(c => c.id);
  const { data, error } = await sb
    .from('vw_video_library_usage')
    .select('video_library_id,usage_count,feed_image_ids,last_used_at')
    .in('video_library_id', ids);
  if (error) { console.warn('enrichWithUsage', error); return; }
  const byId = {};
  for (const row of data || []) byId[row.video_library_id] = row;
  for (const c of clips) {
    const row = byId[c.id];
    c.usage_count = row?.usage_count || 0;
    c.usage_feed_image_ids = row?.feed_image_ids || [];
    c.usage_last_at = row?.last_used_at || null;
  }
}

function resetAndReload() {
  saveFilters();
  if (typeof renderActiveChips === 'function') renderActiveChips();
  if (typeof updateFiltersBadge === 'function') updateFiltersBadge();
  loadFirstPage();
}

function updateCounts() {
  const totalDur = state.clips.reduce((s, c) => s + (Number(c.duration_seconds) || 0), 0);
  const loaded = state.clips.length;
  const filtered = state.filteredCount != null ? state.filteredCount : loaded;
  totalCount.textContent = `${filtered} clips`;
  filteredCount.innerHTML = `<b>${loaded}</b> / ${filtered} affichés · ~${fmtDurationLong(totalDur)} chargés`;
}

// ---------- GALLERY RENDER ----------
// IntersectionObserver pour lazy-load des vignettes (image ou video)
let thumbObserver = null;
function getThumbObserver() {
  if (thumbObserver) return thumbObserver;
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      const srcImg = el.dataset.imgSrc;
      const srcVid = el.dataset.vidSrc;
      if (srcImg && el.tagName === 'IMG' && !el.src) {
        el.src = srcImg;
      } else if (srcVid && el.tagName === 'VIDEO' && !el.src) {
        el.src = srcVid;
      }
      thumbObserver.unobserve(el);
    }
  }, { rootMargin: '400px 0px' });
  return thumbObserver;
}

// Sentinel pour infinite scroll
let scrollObserver = null;
function getScrollObserver() {
  if (scrollObserver) return scrollObserver;
  scrollObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) loadMore();
    }
  }, { rootMargin: '300px 0px' });
  return scrollObserver;
}

function renderGallery() {
  if (!state.clips.length) {
    gallery.innerHTML = '<div class="empty-state"><h2>Aucun clip</h2><p>Ajuste tes filtres.</p></div>';
    updateCounts();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const c of state.clips) {
    frag.appendChild(makeCard(c));
  }
  // Ajouter le sentinel si pas fini
  if (!state.finished) {
    const sentinel = document.createElement('div');
    sentinel.className = 'sentinel';
    sentinel.id = 'sentinel';
    sentinel.textContent = 'Chargement...';
    frag.appendChild(sentinel);
  } else if (state.clips.length > PAGE_SIZE) {
    const end = document.createElement('div');
    end.className = 'sentinel';
    end.textContent = `— fin (${state.clips.length} clips) —`;
    frag.appendChild(end);
  }
  gallery.innerHTML = '';
  gallery.appendChild(frag);
  updateCounts();

  // Observer le sentinel
  const sentinel = document.getElementById('sentinel');
  if (sentinel) getScrollObserver().observe(sentinel);
}

function makeCard(c) {
  const card = document.createElement('div');
  const classes = ['card'];
  if (state.selection.has(c.id)) classes.push('selected');
  if (c.status === 'archived') classes.push('archived');
  if (c.status === 'rejected') classes.push('rejected');
  card.className = classes.join(' ');
  card.dataset.id = c.id;

  // zone thumb
  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  // Priorité : thumbnail_url (JPG léger, 1 requête légère) sinon <video preload=metadata>
  if (c.thumbnail_url) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.imgSrc = c.thumbnail_url;
    img.alt = c.ambiance || c.file_name || 'clip';
    thumb.appendChild(img);
    getThumbObserver().observe(img);

    // Hover → swap vers <video> pour preview (desktop)
    thumb.addEventListener('mouseenter', () => {
      if (thumb.querySelector('video')) return;
      const v = document.createElement('video');
      v.src = c.r2_url;
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.style.position = 'absolute';
      v.style.inset = '0';
      thumb.appendChild(v);
    });
    thumb.addEventListener('mouseleave', () => {
      const v = thumb.querySelector('video');
      if (v) v.remove();
    });
  } else {
    // Fallback : video preload=metadata lazy via observer
    const video = document.createElement('video');
    video.dataset.vidSrc = c.r2_url;
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('mouseenter', () => { video.play().catch(() => {}); });
    video.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
    thumb.appendChild(video);
    getThumbObserver().observe(video);
  }

  const playIcon = document.createElement('div');
  playIcon.className = 'play-icon';
  thumb.appendChild(playIcon);

  // badge analyse
  const as = c.analysis_status || 'pending';
  if (as !== 'analyzed') {
    const b = document.createElement('div');
    b.className = `status-badge ${as}`;
    b.textContent = as === 'pending' ? 'à analyser' : as === 'processing' ? 'analyse…' : as === 'skipped' ? 'skip' : 'échec';
    thumb.appendChild(b);
  }

  // quality badge (si analysé)
  if (c.quality_score != null) {
    const qb = document.createElement('div');
    qb.className = 'quality-score';
    qb.textContent = `⭐ ${Number(c.quality_score).toFixed(1)}`;
    thumb.appendChild(qb);
  }

  // usable for reel pastille
  if (c.usable_for_reel) {
    const ub = document.createElement('div');
    ub.className = 'usable-badge';
    ub.textContent = '✨ REEL';
    thumb.appendChild(ub);
  }

  // badge "Utilisé Nx" si le clip apparaît déjà dans au moins un Reel
  if (c.usage_count && c.usage_count > 0) {
    const usb = document.createElement('div');
    usb.className = 'usage-badge';
    usb.textContent = `↻ ${c.usage_count}`;
    const lastDate = c.usage_last_at ? fmtDate(c.usage_last_at) : '';
    const countLabel = c.usage_count === 1 ? '1 Reel' : `${c.usage_count} Reels`;
    usb.title = lastDate
      ? `Utilisé dans ${countLabel} — dernier le ${lastDate}`
      : `Utilisé dans ${countLabel}`;
    thumb.appendChild(usb);
  }

  // durée
  const dur = document.createElement('div');
  dur.className = 'duration';
  dur.textContent = fmtDuration(c.duration_seconds);
  thumb.appendChild(dur);

  // checkbox sélection
  const cb = document.createElement('div');
  cb.className = 'select-checkbox';
  cb.textContent = state.selection.has(c.id) ? '✓' : '';
  cb.addEventListener('click', e => {
    e.stopPropagation();
    toggleSelection(c.id);
  });
  thumb.appendChild(cb);

  card.appendChild(thumb);

  // info
  const info = document.createElement('div');
  info.className = 'info';
  const amb = document.createElement('div');
  amb.className = 'amb';
  amb.textContent = c.ambiance || (c.description_short ? c.description_short.slice(0, 40) : 'Non analysé');
  info.appendChild(amb);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [];
  if (c.persons_count != null) bits.push(c.persons_count === 0 ? 'solo' : `${c.persons_count} pers.`);
  if (c.movement) bits.push(c.movement);
  if (c.lighting) bits.push(c.lighting);
  if (!bits.length && c.created_at_source) bits.push(fmtDate(c.created_at_source));
  meta.textContent = bits.slice(0, 2).join(' · ');
  info.appendChild(meta);

  card.appendChild(info);

  card.addEventListener('click', () => openModal(c.id));

  return card;
}

// ---------- FILTERS UI WIRE ----------
function syncFiltersToUI() {
  const f = state.filters;
  searchInput.value = f.search || '';
  sortSelect.value = f.sort;
  usableReelChip.classList.toggle('active', !!f.usableReel);
  qualitySlider.value = f.qualityMin;
  qualityVal.textContent = f.qualityMin;
  personsFilter.value = f.persons;
  intensityFilter.value = f.intensity;
  chipMusicWith.classList.toggle('active', f.music === 'with');
  chipMusicWithout.classList.toggle('active', f.music === 'without');
  chipSpeechWith.classList.toggle('active', f.speech === 'with');
  chipSpeechWithout.classList.toggle('active', f.speech === 'without');
  durationFilter.value = f.duration;
  statusFilter.value = f.status;
  analysisFilter.value = f.analysis;
  if (ambianceFilter) ambianceFilter.value = f.ambiance;
  if (movementFilter) movementFilter.value = f.movement;
  if (lightingFilter) lightingFilter.value = f.lighting;
  if (locationFilter) locationFilter.value = f.location;
  const uf = document.getElementById('usage-filter');
  if (uf) uf.value = f.usage || '';
}

searchInput.addEventListener('input', debounce(e => {
  state.filters.search = e.target.value;
  resetAndReload();
}, 300));

sortSelect.addEventListener('change', e => {
  state.filters.sort = e.target.value;
  resetAndReload();
});

usableReelChip.addEventListener('click', () => {
  state.filters.usableReel = !state.filters.usableReel;
  usableReelChip.classList.toggle('active', state.filters.usableReel);
  resetAndReload();
});

qualitySlider.addEventListener('input', e => {
  const v = Number(e.target.value);
  qualityVal.textContent = v;
  state.filters.qualityMin = v;
});
qualitySlider.addEventListener('change', () => resetAndReload());

personsFilter.addEventListener('change', e => { state.filters.persons = e.target.value; resetAndReload(); });
intensityFilter.addEventListener('change', e => { state.filters.intensity = e.target.value; resetAndReload(); });

function wireTripleChip(withEl, withoutEl, key) {
  withEl.addEventListener('click', () => {
    state.filters[key] = state.filters[key] === 'with' ? '' : 'with';
    withEl.classList.toggle('active', state.filters[key] === 'with');
    withoutEl.classList.remove('active');
    resetAndReload();
  });
  withoutEl.addEventListener('click', () => {
    state.filters[key] = state.filters[key] === 'without' ? '' : 'without';
    withoutEl.classList.toggle('active', state.filters[key] === 'without');
    withEl.classList.remove('active');
    resetAndReload();
  });
}
wireTripleChip(chipMusicWith, chipMusicWithout, 'music');
wireTripleChip(chipSpeechWith, chipSpeechWithout, 'speech');

ambianceFilter.addEventListener('change', e => { state.filters.ambiance = e.target.value; resetAndReload(); });
movementFilter.addEventListener('change', e => { state.filters.movement = e.target.value; resetAndReload(); });
lightingFilter.addEventListener('change', e => { state.filters.lighting = e.target.value; resetAndReload(); });
locationFilter.addEventListener('change', e => { state.filters.location = e.target.value; resetAndReload(); });
durationFilter.addEventListener('change', e => { state.filters.duration = e.target.value; resetAndReload(); });
statusFilter.addEventListener('change', e => { state.filters.status = e.target.value; resetAndReload(); });
analysisFilter.addEventListener('change', e => { state.filters.analysis = e.target.value; resetAndReload(); });

resetFiltersBtn.addEventListener('click', () => {
  state.filters = {
    ...DEFAULT_FILTERS,
    emotions: [],
    tags: [],
    personsNames: [],
  };
  syncFiltersToUI();
  updateMultiSelectBtn('emotions');
  updateMultiSelectBtn('tags');
  updateMultiSelectBtn('personsNames');
  populateMultiSelect('emotions', state.catalog.emotions);
  populateMultiSelect('tags', state.catalog.tags);
  populateMultiSelect('personsNames', state.catalog.personsNames);
  resetAndReload();
});

// ---------- DRAWER ----------
function openDrawer() {
  if (!filtersDrawer) return;
  filtersDrawer.classList.add('open');
  drawerOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  if (!filtersDrawer) return;
  filtersDrawer.classList.remove('open');
  drawerOverlay.classList.remove('open');
  document.body.style.overflow = '';
}
btnOpenDrawer && btnOpenDrawer.addEventListener('click', openDrawer);
drawerClose && drawerClose.addEventListener('click', closeDrawer);
drawerOverlay && drawerOverlay.addEventListener('click', closeDrawer);
drawerApply && drawerApply.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && filtersDrawer && filtersDrawer.classList.contains('open')) closeDrawer();
});

// ---------- PRESETS ----------
const PRESETS = {
  reel:           { usableReel: true, sort: 'quality_desc' },
  calm:           { intensity: 'calm' },
  intense:        { intensity: 'intense' },
  neutral:        { intensity: 'neutral' },
  to_analyze:     { analysis: 'pending' },
  no_face:        { persons: '0' },
  with_music:     { music: 'with' },
  with_location:  { sort: 'location_asc' },
};

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  // Réinitialiser puis appliquer le preset
  state.filters = {
    ...DEFAULT_FILTERS,
    emotions: [],
    tags: [],
    personsNames: [],
    ...preset,
  };
  syncFiltersToUI();
  updateMultiSelectBtn('emotions');
  updateMultiSelectBtn('tags');
  updateMultiSelectBtn('personsNames');
  populateMultiSelect('emotions', state.catalog.emotions);
  populateMultiSelect('tags', state.catalog.tags);
  populateMultiSelect('personsNames', state.catalog.personsNames);
  // Active state visuel sur les pills preset
  if (presetsRow) {
    presetsRow.querySelectorAll('.preset').forEach(p => {
      p.classList.toggle('active', p.dataset.preset === name);
    });
  }
  resetAndReload();
}

if (presetsRow) {
  presetsRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset');
    if (!btn) return;
    const name = btn.dataset.preset;
    if (btn.classList.contains('active')) {
      // Retirer le preset (reset)
      btn.classList.remove('active');
      resetFiltersBtn.click();
    } else {
      applyPreset(name);
    }
  });
}

// ---------- ACTIVE CHIPS ----------
const FILTER_LABELS = {
  search:       (v) => `Recherche : ${v}`,
  status:       (v) => `Statut : ${v}`,
  analysis:     (v) => `Analyse : ${v}`,
  duration:     (v) => ({ short: 'Court (<15s)', medium: 'Moyen (15-60s)', long: 'Long (>60s)' }[v] || v),
  ambiance:     (v) => `Ambiance : ${v}`,
  movement:     (v) => `Mouvement : ${v}`,
  lighting:     (v) => `Éclairage : ${v}`,
  location:     (v) => `Lieu : ${v}`,
  persons:      (v) => ({ '0': 'Sans personne', '1': '1 personne', '2+': '2+ personnes' }[v] || v),
  intensity:    (v) => `Intensité : ${v}`,
  music:        (v) => v === 'with' ? '🎵 Avec musique' : '🔇 Sans musique',
  speech:       (v) => v === 'with' ? '💬 Avec paroles' : '🤐 Sans paroles',
  usableReel:   () => '✨ Reel-ready',
  qualityMin:   (v) => `Qualité ≥ ${v}`,
};

function isActiveValue(key, val) {
  if (key === 'usableReel') return val === true;
  if (key === 'qualityMin') return Number(val) > 0;
  if (key === 'status') return val && val !== 'available'; // 'available' = défaut
  if (key === 'sort') return false; // sort caché des chips
  if (Array.isArray(val)) return val.length > 0;
  return val !== '' && val != null;
}

function renderActiveChips() {
  if (!activeChipsRow) return;
  const chips = [];
  const f = state.filters;

  for (const [key, val] of Object.entries(f)) {
    if (!isActiveValue(key, val)) continue;
    if (Array.isArray(val)) {
      val.forEach((v) => chips.push({ key, val: v, label: `${key === 'emotions' ? 'Émotion' : key === 'tags' ? 'Tag' : '👤'} : ${v}`, isMulti: true }));
    } else if (FILTER_LABELS[key]) {
      chips.push({ key, val, label: FILTER_LABELS[key](val), isMulti: false });
    }
  }

  if (chips.length === 0) {
    activeChipsRow.classList.remove('has-chips');
    activeChipsRow.innerHTML = '';
    return;
  }

  activeChipsRow.classList.add('has-chips');
  activeChipsRow.innerHTML = chips.map((c, i) =>
    `<span class="active-chip" data-key="${c.key}" data-val="${escapeAttr(String(c.val))}" data-multi="${c.isMulti ? '1' : '0'}">${escapeHtml(c.label)}<span class="x">×</span></span>`
  ).join('') + `<button class="btn-clear-all" id="chips-clear-all">Tout effacer</button>`;

  // Wire clicks
  activeChipsRow.querySelectorAll('.active-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const k = chip.dataset.key;
      const v = chip.dataset.val;
      const multi = chip.dataset.multi === '1';
      if (multi) {
        const arr = state.filters[k];
        const idx = arr.indexOf(v);
        if (idx > -1) arr.splice(idx, 1);
        updateMultiSelectBtn(k);
        populateMultiSelect(k, state.catalog[k === 'emotions' ? 'emotions' : k === 'tags' ? 'tags' : 'personsNames']);
      } else {
        // Reset à valeur par défaut
        state.filters[k] = DEFAULT_FILTERS[k];
      }
      syncFiltersToUI();
      saveFilters();
      resetAndReload();
    });
  });

  const clearAll = document.getElementById('chips-clear-all');
  if (clearAll) clearAll.addEventListener('click', () => resetFiltersBtn.click());
}

// ---------- BADGE COUNT ----------
function updateFiltersBadge() {
  if (!activeFiltersBadge) return;
  const f = state.filters;
  let count = 0;
  for (const [key, val] of Object.entries(f)) {
    if (isActiveValue(key, val)) {
      if (Array.isArray(val)) count += val.length;
      else count += 1;
    }
  }
  if (count > 0) {
    activeFiltersBadge.textContent = count;
    activeFiltersBadge.style.display = 'inline-flex';
  } else {
    activeFiltersBadge.style.display = 'none';
  }
}

// Premier rendu après chargement initial
setTimeout(() => { renderActiveChips(); updateFiltersBadge(); }, 100);

// ---------- SELECTION ----------
function toggleSelection(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  updateSelectionBar();
  const card = gallery.querySelector(`.card[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('selected', state.selection.has(id));
    const cb = card.querySelector('.select-checkbox');
    if (cb) cb.textContent = state.selection.has(id) ? '✓' : '';
  }
}

function updateSelectionBar() {
  const n = state.selection.size;
  if (n === 0) { selectionBar.classList.remove('active'); return; }
  selectionBar.classList.add('active');
  selCount.textContent = n;
  let total = 0;
  for (const id of state.selection) {
    const c = state.clips.find(x => x.id === id);
    if (c?.duration_seconds) total += Number(c.duration_seconds);
  }
  selMeta.textContent = `${fmtDuration(total)} au total`;
}

clearSelectionBtn.addEventListener('click', () => {
  state.selection.clear();
  updateSelectionBar();
  renderGallery();
});

sendToEditBtn.addEventListener('click', sendToSomaticaEdit);

// ---------- MODAL ----------
function openModal(id) {
  const c = state.clips.find(x => x.id === id);
  if (!c) return;
  state.currentModalId = id;
  modalTitle.textContent = c.ambiance ? c.ambiance : (c.file_name || 'Clip');
  modalVideo.src = c.r2_url;
  modalVideo.currentTime = 0;

  modalBody.innerHTML = '';
  const rows = [
    { label: 'Durée', value: fmtDuration(c.duration_seconds) },
    { label: 'Dimensions', value: c.width && c.height ? `${c.width}×${c.height}` : '—' },
    { label: 'Date source', value: fmtDate(c.created_at_source) },
    { label: 'Qualité', value: c.quality_score != null ? `${c.quality_score}/10` : '—' },
    { label: 'Personnes', value: c.persons_count != null ? `${c.persons_count}` : '—' },
    { label: 'Musique', value: c.music_present ? 'oui' : (c.music_present === false ? 'non' : '—') },
    { label: 'Paroles', value: c.has_speech ? 'oui' : (c.has_speech === false ? 'non' : '—') },
    { label: 'Intensité', value: c.emotional_intensity || '—' },
    { label: 'Émotions', value: (c.emotional_states || []).join(', ') || '—' },
    { label: 'Usable Reel', value: c.usable_for_reel ? '✨ oui' : 'non' },
    { label: 'Statut', value: c.status || 'available' },
    { label: 'Analyse', value: c.analysis_status || 'pending' },
    { label: 'Analysé le', value: c.analyzed_at ? `${fmtDate(c.analyzed_at)} · prompt v${c.analysis_prompt_version ?? '?'}` : '—' },
  ];
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="label">${r.label}</span><span class="value">${escapeHtml(r.value)}</span>`;
    modalBody.appendChild(row);
  }

  addEditableField('Description', 'description_short', c.description_short, false);
  addEditableField('Ambiance', 'ambiance', c.ambiance, false);
  addEditableField('Tags (séparés par virgule)', 'tags', (c.tags || []).join(', '), false);
  addEditableField('Notes', 'notes', c.notes, true);

  // Panneau Analyses complémentaires
  renderSuppAnalyses(c.id);

  modalActions.innerHTML = '';
  const actions = [];
  actions.push({ label: '💾 Enregistrer', cls: 'primary', onClick: () => saveModal(c.id) });
  if ((c.status || 'available') !== 'archived') actions.push({ label: '📦 Archiver', cls: '', onClick: () => setStatus(c.id, 'archived') });
  if ((c.status || 'available') !== 'rejected') actions.push({ label: '🚫 Rejeter', cls: 'danger', onClick: () => setStatus(c.id, 'rejected') });
  if ((c.status || 'available') !== 'available') actions.push({ label: '↩︎ Réactiver', cls: '', onClick: () => setStatus(c.id, 'available') });
  actions.push({ label: '🔄 Re-analyser', cls: '', onClick: () => reanalyze(c.id) });
  actions.push({ label: 'Fermer', cls: '', onClick: closeModal });

  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${a.cls}`;
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    modalActions.appendChild(btn);
  }

  modalBg.classList.add('active');
}

function addEditableField(label, key, value, multi) {
  const row = document.createElement('div');
  row.style.marginTop = '12px';
  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:12px;font-weight:500;color:rgba(235,211,160,0.6);margin-bottom:4px;';
  lbl.textContent = label;
  row.appendChild(lbl);
  const input = multi ? document.createElement('textarea') : document.createElement('input');
  input.dataset.key = key;
  input.value = value || '';
  row.appendChild(input);
  modalBody.appendChild(row);
}

function closeModal() {
  modalBg.classList.remove('active');
  modalVideo.pause();
  modalVideo.src = '';
  state.currentModalId = null;
}

// ---------- ANALYSES COMPLÉMENTAIRES ----------
const SUPP_KINDS = [
  { key: 'reel_pitch', label: '🎯 Pitchs Reel (3 angles)' },
  { key: 'cut_points', label: '✂︎ Points de coupe' },
  { key: 'captions', label: '📝 Captions overlay (3 stratégies)' },
];

async function renderSuppAnalyses(clipId) {
  let section = document.getElementById('supp-section');
  if (!section) {
    section = document.createElement('div');
    section.id = 'supp-section';
    section.className = 'supp-section';
    section.innerHTML = `
      <div class="supp-title">Analyses complémentaires Gemini</div>
      <div id="supp-rows"></div>
    `;
    modalBody.appendChild(section);
  } else {
    modalBody.appendChild(section);
  }
  const rowsWrap = section.querySelector('#supp-rows');
  rowsWrap.innerHTML = '<div style="opacity:0.6;font-size:12px;padding:8px 0;">Chargement...</div>';

  // Fetch existing rows
  const { data, error } = await sb
    .from('clip_supplementary_analyses')
    .select('id,kind,status,prompt_version,result,error_message,created_at,completed_at')
    .eq('clip_id', clipId)
    .order('created_at', { ascending: false });

  if (error) {
    rowsWrap.innerHTML = `<div style="color:#ff9a9a;font-size:12px;">Erreur : ${escapeHtml(error.message)}</div>`;
    return;
  }

  // Garder uniquement la ligne la plus récente par kind
  const latestByKind = {};
  for (const r of data || []) {
    if (!latestByKind[r.kind]) latestByKind[r.kind] = r;
  }

  rowsWrap.innerHTML = '';
  for (const kind of SUPP_KINDS) {
    const row = latestByKind[kind.key];
    const kindEl = document.createElement('div');
    kindEl.className = 'supp-kind-row';
    const status = row?.status || 'none';
    const chipLabel = status === 'done'
      ? `v${row.prompt_version}`
      : status === 'processing' ? 'en cours...'
      : status === 'error' ? 'erreur'
      : 'jamais';
    const metaDate = status === 'done' && row?.completed_at
      ? `<span class="supp-meta" style="opacity:0.55;font-size:11px;margin-left:6px;">${fmtDate(row.completed_at)}</span>`
      : '';
    kindEl.innerHTML = `
      <span class="label">${kind.label}</span>
      <span class="status-chip ${status}">${chipLabel}</span>
      ${metaDate}
      <div class="actions">
        ${row && status === 'done' ? `<button class="btn-sm" data-act="view" data-kind="${kind.key}">Voir</button>` : ''}
        <button class="btn-sm primary" data-act="run" data-kind="${kind.key}">${row ? 'Régénérer' : 'Lancer'}</button>
      </div>
    `;
    rowsWrap.appendChild(kindEl);
    kindEl.dataset.clipId = clipId;
    kindEl.dataset.kind = kind.key;
  }

  rowsWrap.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.kind;
      const act = btn.dataset.act;
      const row = latestByKind[kind];
      if (act === 'view' && row?.result) {
        showSuppResult(btn.closest('.supp-kind-row'), kind, row.result);
      } else if (act === 'run') {
        runSupp(clipId, kind, btn);
      }
    });
  });
}

function showSuppResult(rowEl, kind, result) {
  // Toggle : si déjà affiché, on retire
  const existing = rowEl.nextElementSibling;
  if (existing && existing.classList.contains('supp-result')) {
    existing.remove();
    return;
  }
  const panel = document.createElement('div');
  panel.className = 'supp-result';
  panel.innerHTML = formatSuppResult(kind, result);
  rowEl.after(panel);
}

function formatSuppResult(kind, r) {
  try {
    if (kind === 'reel_pitch' && Array.isArray(r.pitches)) {
      return r.pitches.map((p, i) => `
        <div class="pitch">
          <h5>Pitch ${i + 1} — ${escapeHtml(p.angle || '')}</h5>
          <div class="hook">« ${escapeHtml(p.hook || '')} »</div>
          <div class="meta">Émotion visée : ${escapeHtml(p.target_emotion || '—')}</div>
          <div style="margin:6px 0;">${escapeHtml(p.caption || '').replace(/\n/g, '<br>')}</div>
          <div class="meta"><strong>CTA :</strong> ${escapeHtml(p.cta_in_caption || '')}</div>
          <div>${(p.hashtags || []).map(h => `<span class="tag">#${escapeHtml(h)}</span>`).join('')}</div>
          <div class="meta" style="margin-top:4px;font-style:italic;">${escapeHtml(p.rationale || '')}</div>
        </div>
      `).join('');
    }
    if (kind === 'cut_points' && Array.isArray(r.segments)) {
      const header = r.detected_duration_seconds
        ? `<div class="meta">Durée détectée : ${r.detected_duration_seconds}s</div>`
        : '';
      return header + r.segments.map((s, i) => `
        <div class="segment">
          <h5>Coupe ${i + 1} · ${s.start_seconds}s → ${s.end_seconds}s <span style="opacity:0.6;font-size:12px;">(${s.duration_seconds}s)</span></h5>
          <div class="meta">${escapeHtml(s.label || '')} · <span class="tag">${escapeHtml(s.use_case || '')}</span> · qualité ${s.quality_for_cut}/10</div>
          <div style="opacity:0.85;">${escapeHtml(s.rationale || '')}</div>
        </div>
      `).join('');
    }
    if (kind === 'captions' && Array.isArray(r.strategies)) {
      return r.strategies.map((s, i) => `
        <div class="strategy">
          <h5>${escapeHtml(s.strategy_name || 'Stratégie ' + (i + 1))}</h5>
          <div class="meta">Émotion visée : ${escapeHtml(s.target_emotion || '—')}</div>
          ${(s.captions || []).map(c => `
            <div style="margin:4px 0;padding:4px 8px;background:rgba(255,255,255,0.03);border-radius:4px;font-size:12px;">
              <span style="opacity:0.6;font-variant-numeric:tabular-nums;">${c.start_seconds}s → ${c.end_seconds}s</span>
              <span class="tag">${escapeHtml(c.position || '')}</span>
              <span class="tag">${escapeHtml(c.role || '')}</span>
              <div style="margin-top:2px;">${escapeHtml(c.text || '')}</div>
            </div>
          `).join('')}
          <div class="meta" style="margin-top:6px;"><strong>CTA final :</strong> ${escapeHtml(s.final_cta || '')}</div>
        </div>
      `).join('');
    }
    return `<pre>${escapeHtml(JSON.stringify(r, null, 2))}</pre>`;
  } catch (e) {
    return `<pre>${escapeHtml(JSON.stringify(r, null, 2))}</pre>`;
  }
}

async function runSupp(clipId, kind, btn) {
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Analyse...';
  const row = btn.closest('.supp-kind-row');
  const chip = row?.querySelector('.status-chip');
  if (chip) {
    chip.className = 'status-chip processing';
    chip.textContent = 'en cours...';
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/analyze-clip-supplementary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ clip_id: clipId, kind, force: true }),
    });
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(json.error || `HTTP ${resp.status}`);
    // Recharger la section
    await renderSuppAnalyses(clipId);
  } catch (e) {
    console.error('runSupp', e);
    if (chip) {
      chip.className = 'status-chip error';
      chip.textContent = 'erreur';
    }
    btn.disabled = false;
    btn.textContent = originalLabel;
    alert(`Analyse ${kind} échouée : ${e.message}`);
  }
}

modalClose.addEventListener('click', closeModal);
modalBg.addEventListener('click', e => { if (e.target === modalBg) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modalBg.classList.contains('active')) closeModal();
});

async function saveModal(id) {
  const inputs = modalBody.querySelectorAll('[data-key]');
  const patch = {};
  for (const inp of inputs) {
    const key = inp.dataset.key;
    let v = inp.value.trim();
    if (key === 'tags') {
      patch.tags = v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else {
      patch[key] = v || null;
    }
  }
  patch.updated_at = new Date().toISOString();
  const { error } = await sb.from('video_library').update(patch).eq('id', id);
  if (error) { toast(error.message, 'error'); return; }
  const idx = state.clips.findIndex(x => x.id === id);
  if (idx > -1) Object.assign(state.clips[idx], patch);
  toast('Enregistré', 'success');
}

async function setStatus(id, status) {
  const { error } = await sb
    .from('video_library')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) { toast(error.message, 'error'); return; }
  const idx = state.clips.findIndex(x => x.id === id);
  if (idx > -1) state.clips[idx].status = status;
  toast(`Statut → ${status}`, 'success');
  closeModal();
  resetAndReload();
}

async function reanalyze(id) {
  const { error } = await sb
    .from('video_library')
    .update({ analysis_status: 'pending', analyzed_at: null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) { toast(error.message, 'error'); return; }
  const idx = state.clips.findIndex(x => x.id === id);
  if (idx > -1) {
    state.clips[idx].analysis_status = 'pending';
    state.clips[idx].analyzed_at = null;
  }
  toast('Remis en file d\'analyse', 'success');
  resetAndReload();
}

// ---------- SEND TO SOMATICAEDIT ----------
async function sendToSomaticaEdit() {
  const ids = [...state.selection];
  if (!ids.length) return;

  const ordered = state.clips.filter(c => state.selection.has(c.id));
  if (!ordered.length) { toast('Sélection vide', 'error'); return; }

  // Mode PICKER : on renvoie les clips vers un projet SomaticaEdit existant
  if (PICKER_MODE && RETURN_PROJECT_ID) {
    return sendToSomaticaEditPicker(ordered);
  }

  // Mode STANDARD (hérité) : on crée un nouveau projet brouillon
  return sendToSomaticaEditDraft(ordered);
}

// Mode STANDARD : crée un nouveau projet Reel brouillon (scène par clip).
// Conservé pour rétro-compatibilité si on ouvre Library sans ?mode=picker.
async function sendToSomaticaEditDraft(ordered) {
  const now = Date.now();
  const project_id = `p_REEL_DRAFT_${now}`;
  const scenes = ordered.map((c, i) => ({
    id: `scene_${i + 1}`,
    name: c.ambiance || c.description_short?.slice(0, 30) || `Scène ${i + 1}`,
    format: 'story',
    background: { type: 'color', color: '#0d1e25' },
    duration: Math.min(Number(c.duration_seconds) || 6, 10),
    layers: [{
      id: `l_v${i + 1}`,
      type: 'video',
      name: 'Clip',
      visible: true,
      locked: false,
      x: 540, y: 960,
      timeline: { start: 0, end: Math.min(Number(c.duration_seconds) || 6, 10) },
      props: {
        url: c.r2_url,
        width: 1080, height: 1920,
        opacity: 1, rotation: 0,
        muted: true, loop: false,
        video_id: c.id,
      },
    }],
  }));

  const data = {
    version: '1.0',
    id: project_id,
    name: `Reel brouillon ${new Date().toLocaleDateString('fr-FR')}`,
    format: 'reel',
    scenes,
    source: 'library',
  };

  const { error } = await sb.from('edit_projects').upsert({
    user_id: JEROME_USER_ID,
    project_id,
    name: data.name,
    format: 'reel',
    data,
    source: 'library',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,project_id' });

  if (error) { toast(error.message, 'error'); return; }

  toast(`Projet ${project_id} créé — ${ordered.length} clips`, 'success');
  window.open(`https://edit.somatica-feed.com/?p=${project_id}`, '_blank');
  state.selection.clear();
  updateSelectionBar();
  renderGallery();
}

// Mode PICKER : on injecte les clips dans un projet SomaticaEdit existant.
// Format : 1 seul layer type="video-sequence" dans scenes[0].layers
// avec props.clips[] = [{ video_id, url, order_index, start_trim, end_trim, audio_enabled }]
// Miroir : INSERT dans reel_library_sources pour la traçabilité bidirectionnelle.
async function sendToSomaticaEditPicker(ordered) {
  const btn = sendToEditBtn;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Envoi vers Edit...';

  try {
    // 1. Charger le projet existant
    const { data: proj, error: loadErr } = await sb
      .from('edit_projects')
      .select('data, name, format')
      .eq('user_id', JEROME_USER_ID)
      .eq('project_id', RETURN_PROJECT_ID)
      .single();
    if (loadErr || !proj) {
      throw new Error(`Projet ${RETURN_PROJECT_ID} introuvable : ${loadErr?.message || 'not found'}`);
    }

    const projectData = proj.data || {};
    const scenes = Array.isArray(projectData.scenes) ? [...projectData.scenes] : [];
    if (!scenes.length) {
      // Projet vide : on ajoute une scène 0 minimaliste
      scenes.push({
        id: 'scene_1',
        name: 'Séquence Reel',
        format: 'reel',
        background: { type: 'color', color: '#0d1e25' },
        duration: 0,
        layers: [],
      });
    }

    // 2. Construire le layer video-sequence
    const clipsForLayer = ordered.map((c, i) => ({
      video_id: c.id,
      url: c.r2_url,
      order_index: i,
      start_trim: 0,
      end_trim: c.duration_seconds != null ? Number(c.duration_seconds) : null,
      audio_enabled: true,
      duration_seconds: Number(c.duration_seconds) || null,
      thumbnail_url: c.thumbnail_url || null,
      ambiance: c.ambiance || null,
    }));
    const totalDuration = clipsForLayer.reduce(
      (s, c) => s + (c.end_trim != null && c.start_trim != null ? c.end_trim - c.start_trim : 0),
      0
    );

    const videoSequenceLayer = {
      id: 'l_vseq',
      type: 'video-sequence',
      name: 'Séquence vidéo',
      visible: true,
      locked: false,
      x: 540, y: 960,
      timeline: { start: 0, end: totalDuration },
      props: {
        clips: clipsForLayer,
        width: 1080,
        height: 1920,
      },
    };

    // 3. Remplacer/ajouter le layer video-sequence dans scenes[0].layers
    const scene0 = { ...scenes[0] };
    const existingLayers = Array.isArray(scene0.layers) ? [...scene0.layers] : [];
    const idx = existingLayers.findIndex(l => l?.type === 'video-sequence');
    if (idx >= 0) existingLayers[idx] = videoSequenceLayer;
    else existingLayers.unshift(videoSequenceLayer);
    scene0.layers = existingLayers;
    // Durée de la scène = max entre durée actuelle et durée totale clips
    const currentDur = Number(scene0.duration) || 0;
    if (totalDuration > currentDur) scene0.duration = totalDuration;
    scenes[0] = scene0;

    const newData = { ...projectData, scenes, source_type: 'library' };

    // 4. Upsert du projet
    const { error: upErr } = await sb.from('edit_projects').upsert({
      user_id: JEROME_USER_ID,
      project_id: RETURN_PROJECT_ID,
      name: proj.name || `Reel ${RETURN_PROJECT_ID}`,
      format: proj.format || 'reel',
      data: newData,
      source: 'library',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,project_id' });
    if (upErr) throw new Error(`Upsert edit_projects: ${upErr.message}`);

    // 5. Miroir dans reel_library_sources : on cherche le feed_image_id lié au projet
    const { data: fiRows, error: fiErr } = await sb
      .from('feed_images')
      .select('id')
      .eq('edit_project_id', RETURN_PROJECT_ID)
      .limit(1);
    if (fiErr) console.warn('feed_images lookup', fiErr);
    const feedImageId = fiRows && fiRows[0]?.id;

    if (feedImageId) {
      // Purge les sources existantes pour ce feed_image_id puis réinsère
      const { error: delErr } = await sb
        .from('reel_library_sources')
        .delete()
        .eq('feed_image_id', feedImageId);
      if (delErr) console.warn('delete reel_library_sources', delErr);

      const rows = clipsForLayer.map((c, i) => ({
        feed_image_id: feedImageId,
        video_library_id: c.video_id,
        order_index: i,
        start_trim: c.start_trim,
        end_trim: c.end_trim,
      }));
      if (rows.length) {
        const { error: insErr } = await sb.from('reel_library_sources').insert(rows);
        if (insErr) console.warn('insert reel_library_sources', insErr);
      }

      // On marque feed_images.source_type = 'library' pour cohérence spec v4
      const { error: ftErr } = await sb
        .from('feed_images')
        .update({ source_type: 'library', updated_at: new Date().toISOString() })
        .eq('id', feedImageId);
      if (ftErr) console.warn('feed_images.source_type update', ftErr);
    } else {
      console.warn('Aucun feed_image lié à', RETURN_PROJECT_ID, '- traçabilité BD non posée');
    }

    // 6. Retour SomaticaEdit
    toast(`${ordered.length} clips injectés — retour SomaticaEdit`, 'success');
    state.selection.clear();
    updateSelectionBar();

    const editUrl = `https://edit.somatica-feed.com/?p=${encodeURIComponent(RETURN_PROJECT_ID)}`;
    // Si la Library a été ouverte depuis Edit (window.opener), on revient dans l'onglet d'origine
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.location.href = editUrl;
        window.opener.focus();
        window.close();
        return;
      } catch (e) {
        // Cross-origin bloque, fallback redirect direct
      }
    }
    window.location.replace(editUrl);
  } catch (e) {
    console.error('sendToSomaticaEditPicker', e);
    toast(e.message || 'Erreur envoi', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// ---------- ZOOM / DENSITÉ GRILLE ----------
const zoomButtons = document.querySelectorAll('#zoom-control button');
const COLS_MIN = 1, COLS_MAX = 4;
const DEFAULT_COLS = window.innerWidth < 768 ? 2 : 3;

function applyCols(cols) {
  cols = Math.max(COLS_MIN, Math.min(COLS_MAX, parseInt(cols) || DEFAULT_COLS));
  document.documentElement.style.setProperty('--cols', cols);
  gallery.dataset.dense = cols >= 4 ? '2' : (cols >= 3 ? '1' : '0');
  zoomButtons.forEach(b => b.classList.toggle('active', parseInt(b.dataset.cols) === cols));
  try { localStorage.setItem('library_cols', String(cols)); } catch (e) {}
  state.cols = cols;
  return cols;
}

state.cols = applyCols(parseInt(localStorage.getItem('library_cols')) || DEFAULT_COLS);

zoomButtons.forEach(btn => {
  btn.addEventListener('click', () => applyCols(btn.dataset.cols));
});

// Pinch-to-zoom mobile
let pinchStart = null;
gallery.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchStart = { dist: Math.hypot(dx, dy), cols: state.cols };
  }
}, { passive: true });

gallery.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchStart) {
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    const ratio = dist / pinchStart.dist;
    let target = pinchStart.cols;
    if (ratio > 1.25) target = pinchStart.cols - 1;
    else if (ratio > 1.6) target = pinchStart.cols - 2;
    else if (ratio < 0.8) target = pinchStart.cols + 1;
    else if (ratio < 0.5) target = pinchStart.cols + 2;
    if (target !== state.cols) applyCols(target);
  }
}, { passive: false });

gallery.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) pinchStart = null;
}, { passive: true });

let lastTap = 0;
gallery.addEventListener('touchend', (e) => {
  if (e.changedTouches.length !== 1) return;
  const now = Date.now();
  if (now - lastTap < 300 && e.target.closest('.card') === null) {
    applyCols(state.cols === 1 ? 3 : 1);
  }
  lastTap = now;
}, { passive: true });

// ---------- PICKER MODE : UI (bannière + bouton) ----------
function initPickerModeUI() {
  if (!PICKER_MODE || !RETURN_PROJECT_ID) return;
  // Afficher la bannière
  const banner = document.getElementById('picker-banner');
  if (banner) {
    banner.style.display = 'flex';
    const idEl = document.getElementById('picker-return-id');
    if (idEl) idEl.textContent = RETURN_PROJECT_ID;
  }
  // Renommer le bouton "Envoyer"
  if (sendToEditBtn) sendToEditBtn.textContent = 'Valider la sélection →';
  // Par défaut en picker mode : on pré-filtre "Non utilisé" pour éviter les doublons
  if (!state.filters.usage) {
    state.filters.usage = 'unused';
    const usageFilter = document.getElementById('usage-filter');
    if (usageFilter) usageFilter.value = 'unused';
  }
  // Bouton Annuler : retour SomaticaEdit sans modification
  const cancelBtn = document.getElementById('picker-cancel');
  if (cancelBtn && !cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = '1';
    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.focus();
          window.close();
          return;
        }
      } catch (err) { /* cross-origin, fallback */ }
      const editUrl = `https://edit.somatica-feed.com/?p=${encodeURIComponent(RETURN_PROJECT_ID)}`;
      window.location.replace(editUrl);
    });
  }
}

// ---------- USAGE FILTER (wire) ----------
const usageFilter = document.getElementById('usage-filter');
if (usageFilter) {
  usageFilter.addEventListener('change', e => {
    state.filters.usage = e.target.value;
    resetAndReload();
  });
}

// ---------- INIT ----------
checkSession().then(() => initPickerModeUI());
// Au cas où la session existe déjà (onAuthStateChange), on s'assure que la bannière s'affiche
setTimeout(() => initPickerModeUI(), 300);
