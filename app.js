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
  'tri_status', 'tri_rating', 'tri_note', 'tri_tags', 'tri_participante', 'codec', 'content_hash', 'flagged',
].join(',');

// Le navigateur sait-il décoder le HEVC/H.265 ? (Safari oui, Chrome souvent non)
const HEVC_SUPPORTED = (() => {
  try { const v = document.createElement('video'); return !!(v.canPlayType('video/mp4; codecs="hvc1"') || v.canPlayType('video/mp4; codecs="hev1"')); }
  catch (e) { return false; }
})();
function clipPreviewable(c) { return !(c && c.codec === 'hevc' && !HEVC_SUPPORTED); }

// 3 sources média (boutons header). photo = image_library, image = generated_images (IA).
const MEDIA = {
  video: { table: 'video_library',    label: 'Vidéo',  participante: true },
  photo: { table: 'image_library',    label: 'Photo',  participante: true },
  image: { table: 'generated_images', label: 'Images', participante: false },
};
function mediaTable() { return (MEDIA[state.mediaType] || MEDIA.video).table; }
function isVideoMode() { return state.mediaType === 'video'; }

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
  triHide: false, // mode tri : masquer les clips déjà triés
  triRefused: false, // mode tri : afficher uniquement les refusés
  triBug: false, // mode tri : afficher uniquement les buggés
  triStatus: '',       // filtre drawer : statut de tri
  flaggedOnly: false,  // 📌 n'afficher que ma sélection (colonne flagged)
  triRatingMin: 0,     // filtre drawer : note minimale
  triPratique: '',     // filtre : tag pratique
  triContexte: '',     // filtre drawer : tag contexte / cas
  triParticipante: '', // filtre : participante
  triFacilitateur: '', // filtre photo : facilitateur (facil_*)
  triSalle: '',        // filtre photo : salle / lieu
  triTagged: '',       // filtre photo : '' | 'untagged' (sans étiquette) | 'tagged'
  emotions: [],  // multi
  tags: [],      // multi
  personsNames: [],  // multi (noms Apple)
};

const state = {
  clips: [],                  // cumul paginé
  selection: new Set(),
  triMode: false,             // mode tri actif (panneau de tri par carte)
  mediaType: 'video',         // 'video' | 'photo' | 'image' (3 boutons du header)
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
    emotions: [], tags: [], personsNames: [], participantes: new Set(),
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
    .select('ambiance,movement,lighting,location_name,emotional_states,tags,persons_detected,analysis_status,tri_participante')
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

  // Participantes déjà saisies (pour l'autocomplétion)
  const participantes = new Set();
  for (const r of data || []) {
    if (r.tri_participante) String(r.tri_participante).split(/[,;&]/).forEach(s => { const t = s.trim(); if (t) participantes.add(t); });
  }
  state.catalog.participantes = participantes;
  populateParticipantesDatalist();
  populateTriParticipanteSelect();

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
// ===================== FLUX PHOTO / IMAGES IA =====================
function imageCols() {
  return state.mediaType === 'photo'
    ? 'id,r2_url,r2_key,filename,subject,category,ambiance,tags,quality_score,status,created_at,tri_status,tri_rating,tri_note,tri_tags,tri_participante,tri_salle,flagged'
    : 'id,r2_url,r2_key,prompt,model,source,tags,created_at,tri_status,tri_rating,tri_note,tri_tags,tri_participante,flagged';
}
function buildImageQuery() {
  let q = sb.from(mediaTable()).select(imageCols(), { count: 'exact' });
  const f = state.filters;
  if (f.triStatus) q = q.eq('tri_status', f.triStatus);
  if (f.triRatingMin > 0) q = q.gte('tri_rating', f.triRatingMin);
  if (f.triParticipante === '__none__') q = q.is('tri_participante', null);
  else if (f.triParticipante) q = q.ilike('tri_participante', `%${f.triParticipante}%`);
  if (f.triPratique === '__none__') q = q.not('tri_tags', 'ov', '{innerdance,breathwork,qi_cleansing,cacao}');
  else if (f.triPratique) q = q.contains('tri_tags', [f.triPratique]);
  if (state.mediaType === 'photo') {
    if (f.triFacilitateur === '__none__') q = q.not('tri_tags', 'ov', '{facil_jerome,facil_nath,facil_duo}');
    else if (f.triFacilitateur) q = q.contains('tri_tags', [f.triFacilitateur]);
    if (f.triContexte === '__none__') q = q.not('tri_tags', 'ov', '{formation,seance,individuel}');
    else if (f.triContexte) q = q.contains('tri_tags', [f.triContexte]);
    if (f.triSalle === '__none__') q = q.is('tri_salle', null);
    else if (f.triSalle) q = q.ilike('tri_salle', `%${f.triSalle}%`);
    // Sans étiquette : aucun tag, pas de participante, pas de salle (tri_tags normalisé en '{}')
    if (f.triTagged === 'untagged') q = q.is('tri_participante', null).is('tri_salle', null).eq('tri_tags', '{}');
    else if (f.triTagged === 'tagged') q = q.or('tri_participante.not.is.null,tri_salle.not.is.null,tri_tags.neq.{}');
  }
  if (f.triBug) q = q.eq('tri_status', 'bug');
  else if (f.triRefused) q = q.eq('tri_status', 'refuse');
  else if (f.triHide) q = q.eq('tri_status', 'a_trier');
  if (f.flaggedOnly) q = q.eq('flagged', true);
  if (f.search) {
    const s = f.search.replace(/[%_]/g, '');
    const cols = state.mediaType === 'photo' ? ['filename', 'subject', 'category', 'ambiance'] : ['prompt', 'model', 'source'];
    q = q.or(cols.map(c => `${c}.ilike.%${s}%`).join(','));
  }
  return q.order('created_at', { ascending: false, nullsFirst: false });
}
function imageLabel(c) {
  if (state.mediaType === 'photo') return c.subject || c.category || c.filename || 'photo';
  return c.prompt ? c.prompt.slice(0, 60) : (c.model || 'image IA');
}
function makeImageCard(c) {
  const card = document.createElement('div');
  card.className = state.selection.has(c.id) ? 'card selected' : 'card';
  card.dataset.id = c.id;
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const img = document.createElement('img');
  img.loading = 'lazy'; img.decoding = 'async';
  img.dataset.imgSrc = c.r2_url;
  img.alt = imageLabel(c);
  thumb.appendChild(img);
  getThumbObserver().observe(img);
  const cb = document.createElement('div');
  cb.className = 'select-checkbox';
  cb.textContent = state.selection.has(c.id) ? '✓' : '';
  cb.addEventListener('click', e => { e.stopPropagation(); handleSelectClick(c.id, e.shiftKey); });
  thumb.appendChild(cb);
  const tagOv = document.createElement('div');
  tagOv.className = 'card-tags';
  thumb.appendChild(tagOv);
  card.appendChild(thumb);
  const info = document.createElement('div');
  info.className = 'info';
  const amb = document.createElement('div');
  amb.className = 'amb';
  amb.textContent = imageLabel(c);
  info.appendChild(amb);
  card.appendChild(info);
  setCardTriVisual(card, c);
  paintCardTagOverlay(card, c);
  card.appendChild(makeImageTriPanel(c, card));
  card.addEventListener('click', (e) => {
    if (state.triMode) handleSelectClick(c.id, e.shiftKey);
    else openImageModal(c);
  });
  card.addEventListener('mouseenter', () => { hoveredCardId = c.id; });
  card.addEventListener('mouseleave', () => { if (hoveredCardId === c.id) hoveredCardId = null; });
  return card;
}
function makeImageTriPanel(c, card) {
  const p = document.createElement('div');
  p.className = 'tri-panel';
  p.addEventListener('click', e => e.stopPropagation());
  // OK / Refusé / Bug
  const rowS = document.createElement('div');
  rowS.className = 'tri-row';
  const reflect = () => {
    okB.classList.toggle('on', c.tri_status === 'ok');
    noB.classList.toggle('on', c.tri_status === 'refuse');
    bugB.classList.toggle('on', c.tri_status === 'bug');
  };
  const mk = (cls, label, st) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tri-status-btn ' + cls; b.textContent = label;
    b.addEventListener('click', () => { setTriStatus(c, card, c.tri_status === st ? 'a_trier' : st); reflect(); });
    return b;
  };
  const okB = mk('ok', 'OK', 'ok');
  const noB = mk('refuse', 'Refusé', 'refuse');
  const bugB = mk('bug', 'Bug', 'bug');
  reflect();
  rowS.appendChild(okB); rowS.appendChild(noB); rowS.appendChild(bugB);
  // Étoiles (+ participante sur les photos)
  const rowR = document.createElement('div');
  rowR.className = 'tri-row tri-toprow';
  const stars = document.createElement('div');
  stars.className = 'tri-stars';
  const ratingVal = document.createElement('span');
  ratingVal.className = 'tri-rating-val';
  const showVal = (n) => { ratingVal.textContent = n ? `${n}/10` : ''; };
  for (let i = 1; i <= 10; i++) {
    const s = document.createElement('span');
    s.className = 'st'; s.innerHTML = '&#9733;';
    s.addEventListener('click', () => {
      const nv = (c.tri_rating === i) ? 0 : i;
      updateTri(c, card, { tri_rating: nv });
      paintStars(stars, nv); showVal(nv);
    });
    stars.appendChild(s);
  }
  paintStars(stars, c.tri_rating || 0);
  showVal(c.tri_rating || 0);
  rowR.appendChild(stars);
  rowR.appendChild(ratingVal);
  if (MEDIA[state.mediaType] && MEDIA[state.mediaType].participante) {
    const part = document.createElement('input');
    part.className = 'tri-field tri-participante';
    part.type = 'text'; part.placeholder = 'participante…';
    part.setAttribute('list', 'participantes-list');
    part.value = c.tri_participante || '';
    const savePart = () => {
      const v = part.value.trim();
      const ids = triTargets(c);
      for (const id of ids) {
        const cc = state.clips.find(x => x.id === id);
        if (!cc) continue;
        if ((cc.tri_participante || '') !== v) updateTri(cc, cardEl(id), { tri_participante: v || null });
        if (id !== c.id) { const el = cardEl(id); const inp = el && el.querySelector('.tri-participante'); if (inp) inp.value = v; }
      }
      harvestParticipantes(v);
      if (ids.length > 1) { applyLiveFilterHide(ids, 'sync'); renderGallery(); } else applyLiveFilterHide(ids);
    };
    part.addEventListener('change', savePart);
    part.addEventListener('blur', savePart);
    rowR.appendChild(part);
  }
  p.appendChild(rowR);
  p.appendChild(triDivider());
  // Tags (photos uniquement) : facilitateur (exclusif) + contexte + pratiques + salle
  if (state.mediaType === 'photo') {
    p.appendChild(renderTriTagWrap(c, card, TRI_FACILITATEUR, 'g4', true));
    p.appendChild(renderTriTagWrap(c, card, TRI_CTX1));
    p.appendChild(renderTriTagWrap(c, card, TRI_PRACTICES, 'g3'));
    const salle = document.createElement('input');
    salle.className = 'tri-field tri-salle';
    salle.type = 'text'; salle.placeholder = 'salle / lieu…';
    salle.setAttribute('list', 'salles-list');
    salle.value = c.tri_salle || '';
    const saveSalle = () => {
      const v = salle.value.trim();
      const ids = triTargets(c);
      for (const id of ids) {
        const cc = state.clips.find(x => x.id === id);
        if (!cc) continue;
        if ((cc.tri_salle || '') !== v) updateTri(cc, cardEl(id), { tri_salle: v || null });
        if (id !== c.id) { const el = cardEl(id); const inp = el && el.querySelector('.tri-salle'); if (inp) inp.value = v; }
      }
      harvestSalles(v);
      if (ids.length > 1) { applyLiveFilterHide(ids, 'sync'); renderGallery(); } else applyLiveFilterHide(ids);
    };
    salle.addEventListener('change', saveSalle);
    salle.addEventListener('blur', saveSalle);
    p.appendChild(salle);
    p.appendChild(triDivider());
  }
  // Commentaire
  const note = document.createElement('input');
  note.className = 'tri-field tri-comment';
  note.type = 'text'; note.placeholder = 'commentaire…';
  note.value = c.tri_note || '';
  const saveNote = () => {
    const v = note.value.trim();
    const ids = triTargets(c);
    for (const id of ids) {
      const cc = state.clips.find(x => x.id === id);
      if (!cc) continue;
      if ((cc.tri_note || '') !== v) updateTri(cc, cardEl(id), { tri_note: v || null });
      if (id !== c.id) { const el = cardEl(id); const inp = el && el.querySelector('.tri-comment'); if (inp) inp.value = v; }
    }
  };
  note.addEventListener('change', saveNote);
  note.addEventListener('blur', saveNote);
  p.appendChild(note);
  p.appendChild(triDivider());
  p.appendChild(rowS);
  return p;
}
function openImageModal(c) {
  if (activePreview) activePreview.stop();
  document.body.classList.add('modal-open');
  state.currentModalId = c.id;
  modalTitle.textContent = imageLabel(c);
  modalVideo.pause(); modalVideo.removeAttribute('src'); try { modalVideo.load(); } catch (e) {}
  modalVideo.style.display = 'none';
  const container = modalVideo.parentElement;
  let im = container.querySelector('.modal-img');
  if (!im) { im = document.createElement('img'); im.className = 'modal-img'; container.appendChild(im); }
  im.src = c.r2_url; im.style.display = '';
  modalBody.innerHTML = '';
  const rows = state.mediaType === 'photo'
    ? [['Sujet', c.subject], ['Catégorie', c.category], ['Ambiance', c.ambiance], ['Qualité', c.quality_score != null ? c.quality_score + '/10' : null], ['Tags', (c.tags || []).join(', ')]]
    : [['Prompt', c.prompt], ['Modèle', c.model], ['Source', c.source], ['Tags', (c.tags || []).join(', ')]];
  for (const [label, value] of rows) {
    if (!value) continue;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div>`;
    modalBody.appendChild(row);
  }
  modalBg.classList.add('active');
}
function setMediaType(type) {
  if (!MEDIA[type] || type === state.mediaType) return;
  state.mediaType = type;
  document.querySelectorAll('#media-switch .media-btn').forEach(b => b.classList.toggle('active', b.dataset.media === type));
  document.body.classList.toggle('media-non-video', type !== 'video');
  document.body.dataset.media = type;
  state.selection.clear();
  lastSelIndex = null;
  updateSelectionBar();
  buildBatchTriBar();
  populateTriParticipanteSelect();
  if (type === 'photo') loadPhotoCatalog();
  syncFiltersToUI();
  reloadColsForMode();
  loadFirstPage();
  if (state.triMode) updateTriProgress();
  updateFlaggedCount();
}

function buildQuery() {
  if (!isVideoMode()) return buildImageQuery();
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

  // "Afficher les refusés" prime : on ne montre que les refusés.
  // Sinon "Masquer les déjà triées" : trié = Refusé, OU OK avec au moins 1 étoile ;
  // on garde visibles les pas-décidés et les OK sans étoile.
  if (f.triBug) {
    q = q.eq('tri_status', 'bug');
  } else if (f.triRefused) {
    q = q.eq('tri_status', 'refuse');
  } else if (f.triHide) {
    q = q.or('tri_status.eq.a_trier,and(tri_status.eq.ok,tri_rating.is.null),and(tri_status.eq.ok,tri_rating.eq.0)');
  }

  // Filtres "Mon tri" (drawer)
  if (f.triStatus) q = q.eq('tri_status', f.triStatus);
  if (f.triRatingMin > 0) q = q.gte('tri_rating', f.triRatingMin);
  if (f.triPratique && f.triPratique !== '__none__') q = q.contains('tri_tags', [f.triPratique]);
  if (f.triContexte && f.triContexte !== '__none__') q = q.contains('tri_tags', [f.triContexte]);
  if (f.triParticipante === '__none__') q = q.is('tri_participante', null);
  else if (f.triParticipante) q = q.ilike('tri_participante', `%${f.triParticipante}%`);

  if (f.flaggedOnly) q = q.eq('flagged', true);

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
  if (!isVideoMode()) return;
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
let activePreview = null; // une seule vidéo d'aperçu décodée à la fois (anti-freeze)
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
  if (!isVideoMode()) return makeImageCard(c);
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

  // Aperçu : lecture AVEC son au survol (ordi). Réglette en overlay bas de vignette,
  // visible en Mode tri : déplace la lecture SANS la couper (et défile l'image sur mobile).
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.className = 'scrub';
  scrub.min = '0'; scrub.max = '1000'; scrub.value = '0';
  scrub.title = 'Avancer dans la vidéo';
  let scrubbing = false;
  scrub.addEventListener('click', e => e.stopPropagation());
  scrub.addEventListener('pointerdown', e => { e.stopPropagation(); scrubbing = true; });
  const endScrub = () => { scrubbing = false; };
  scrub.addEventListener('pointerup', endScrub);
  scrub.addEventListener('change', endScrub);

  const preview = {
    video: null, canvas: null, ctx: null, raf: 0, pendingRatio: null,
    _draw() {
      const v = this.video, cv = this.canvas;
      if (v && cv && v.videoWidth) {
        if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
        try { this.ctx.drawImage(v, 0, 0, cv.width, cv.height); } catch (e) {}
      }
      this.raf = requestAnimationFrame(() => this._draw());
    },
    ensure() {
      if (activePreview && activePreview !== this) activePreview.stop(); // une seule à la fois
      activePreview = this;
      if (!this.video) {
        // Vidéo cachée (décode + son) ; l'image est dessinée dans un canvas (rendu fiable, pas d'overlay matériel)
        const v = document.createElement('video');
        v.src = c.r2_url;
        v.playsInline = true;
        v.loop = true;
        v.muted = true;
        v.style.position = 'absolute';
        v.style.width = '1px'; v.style.height = '1px'; v.style.opacity = '0'; v.style.pointerEvents = 'none';
        v.addEventListener('timeupdate', () => {
          if (!scrubbing && v.duration) scrub.value = String(Math.round((v.currentTime / v.duration) * 1000));
        });
        v.addEventListener('seeked', () => {
          if (this.pendingRatio != null && v.duration) {
            const t = this.pendingRatio; this.pendingRatio = null;
            if (Math.abs((v.currentTime / v.duration) - t) > 0.01) v.currentTime = t * v.duration;
          }
        });
        const cv = document.createElement('canvas');
        cv.className = 'preview-canvas';
        thumb.appendChild(v);
        thumb.appendChild(cv);
        this.video = v; this.canvas = cv; this.ctx = cv.getContext('2d');
        thumb.classList.add('previewing');
        if (!this.raf) this._draw();
      }
      return this.video;
    },
    play() {
      if (!clipPreviewable(c)) return; // HEVC non décodable : on garde la vignette fixe
      const v = this.ensure();
      v.muted = false; v.volume = 0.85;
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    },
    seek(ratio) {
      if (!clipPreviewable(c)) return;
      const v = this.ensure();
      const go = () => {
        if (!v.duration) return;
        if (v.seeking) { this.pendingRatio = ratio; return; }
        v.currentTime = ratio * v.duration;
      };
      if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
    },
    stop() {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      if (this.video) {
        this.video.pause();
        this.video.removeAttribute('src');
        try { this.video.load(); } catch (e) {}
        this.video.remove();
        this.video = null;
      }
      if (this.canvas) { this.canvas.remove(); this.canvas = null; this.ctx = null; }
      this.pendingRatio = null;
      thumb.classList.remove('previewing');
      if (activePreview === this) activePreview = null;
    },
  };
  card._preview = preview;
  scrub.addEventListener('input', () => preview.seek(Number(scrub.value) / 1000));

  if (c.thumbnail_url) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.imgSrc = c.thumbnail_url;
    img.alt = c.ambiance || c.file_name || 'clip';
    thumb.appendChild(img);
    getThumbObserver().observe(img);
  } else {
    // Fallback : video preload=metadata lazy via observer
    const video = document.createElement('video');
    video.dataset.vidSrc = c.r2_url;
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    thumb.appendChild(video);
    getThumbObserver().observe(video);
  }

  // Survol (ordi) : lecture avec son ; sortie : on coupe l'aperçu.
  thumb.addEventListener('mouseenter', () => preview.play());
  thumb.addEventListener('mouseleave', () => preview.stop());

  thumb.appendChild(scrub);

  const playIcon = document.createElement('div');
  playIcon.className = 'play-icon';
  playIcon.title = 'Ouvrir le lecteur';
  playIcon.addEventListener('click', (e) => { e.stopPropagation(); openModal(c.id); });
  thumb.appendChild(playIcon);

  if (!clipPreviewable(c)) {
    const cdb = document.createElement('div');
    cdb.className = 'codec-badge';
    cdb.textContent = 'HEVC';
    cdb.title = 'Format HEVC non lisible dans ce navigateur, à ré-encoder en H.264';
    thumb.appendChild(cdb);
  }

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
    handleSelectClick(c.id, e.shiftKey);
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

  // Panneau de tri (visible seulement en mode tri, géré en CSS via body.tri-on)
  setCardTriVisual(card, c);
  card.appendChild(makeTriPanel(c, card));

  card.addEventListener('click', (e) => {
    if (state.triMode) handleSelectClick(c.id, e.shiftKey); // en mode tri, clic = sélection
    else openModal(c.id);
  });
  card.addEventListener('mouseenter', () => { hoveredCardId = c.id; });
  card.addEventListener('mouseleave', () => { if (hoveredCardId === c.id) hoveredCardId = null; });

  return card;
}

// ---------- MODE TRI ----------
const TRI_CTX1 = [
  ['formation', 'Formation'],
  ['seance', 'Séance'],
  ['individuel', 'Individuel'],
];
const TRI_CTX2 = [
  ['nathalie_facilite', 'Nath. facilite'],
  ['nathalie_sol', 'Nath. au sol'],
  ['duo_jerome_nathalie', 'Duo Jérôme & Nathalie'],
];
const TRI_TAGS = [...TRI_CTX1, ...TRI_CTX2]; // combiné (pour les actions groupées)
// Cas montage / son, sur leur propre ligne
const TRI_CASES = [
  ['deja_monte', 'Déjà monté'],
  ['texte_incruste', 'Texte incrusté'],
  ['son_origine', "Son d'origine ++"],
];

// Pratiques de transe (Innerdance couvre aussi la Kundalini Activation)
const TRI_PRACTICES = [
  ['innerdance', 'Innerdance'],
  ['breathwork', 'Breathwork'],
  ['qi_cleansing', 'Qi cleansing'],
  ['cacao', 'Cacao'],
];

// Facilitateur (photos) : qui anime sur l'image (exclusif)
const TRI_FACILITATEUR = [
  ['facil_jerome', 'Jérôme'],
  ['facil_nath', 'Nath'],
  ['facil_duo', 'Les deux'],
];

// Rendu d'une ligne de cases à cocher (tags) pour une liste donnée
function triDivider() {
  const d = document.createElement('div');
  d.className = 'tri-sep';
  return d;
}
// Rendu d'un groupe de tags en boutons-pastilles (toggle).
// exclusive = un seul actif à la fois dans le groupe (radio).
function renderTriTagWrap(c, card, list, variant, exclusive) {
  const wrap = document.createElement('div');
  wrap.className = 'tri-chips';
  const btns = [];
  for (const [val, label] of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tri-chip' + (variant ? ' ' + variant : '');
    if (triHas(c, val)) b.classList.add('on');
    b.textContent = label;
    b.dataset.val = val;
    b.addEventListener('click', () => {
      const newOn = !b.classList.contains('on');
      if (exclusive && newOn) {
        for (const ob of btns) {
          if (ob !== b && ob.classList.contains('on')) {
            ob.classList.remove('on');
            toggleTriTag(c, card, ob.dataset.val, false);
          }
        }
      }
      toggleTriTag(c, card, val, newOn);
      b.classList.toggle('on', newOn);
    });
    btns.push(b);
    wrap.appendChild(b);
  }
  return wrap;
}
// Autocomplétion des participantes : datalist alimenté par les noms déjà saisis
function populateParticipantesDatalist() {
  const dl = document.getElementById('participantes-list');
  if (!dl) return;
  const names = [...(state.catalog.participantes || [])].sort((a, b) => a.localeCompare(b));
  dl.innerHTML = names.map(n => `<option value="${escapeAttr(n)}"></option>`).join('');
}
function populateTriParticipanteSelect() {
  const names = [...(state.catalog.participantes || [])].sort((a, b) => a.localeCompare(b));
  const opts = '<option value="">Toutes</option><option value="__none__">Sans participante</option>' + names.map(n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');
  for (const id of ['tri-participante-filter', 'pf-participante']) {
    const el = document.getElementById(id);
    if (!el) continue;
    const cur = el.value;
    el.innerHTML = opts;
    el.value = cur;
  }
}
function harvestParticipantes(v) {
  if (!v) return;
  if (!state.catalog.participantes) state.catalog.participantes = new Set();
  v.split(/[,;&]/).forEach(s => { const t = s.trim(); if (t) state.catalog.participantes.add(t); });
  populateParticipantesDatalist();
  populateTriParticipanteSelect();
}
// ----- Salles / lieux (photos) : autocomplétion + filtre -----
function populateSallesDatalist() {
  const dl = document.getElementById('salles-list');
  if (!dl) return;
  const names = [...(state.catalog.salles || [])].sort((a, b) => a.localeCompare(b));
  dl.innerHTML = names.map(n => `<option value="${escapeAttr(n)}"></option>`).join('');
}
function populateSalleSelect() {
  const el = document.getElementById('pf-salle');
  if (!el) return;
  const cur = el.value;
  const names = [...(state.catalog.salles || [])].sort((a, b) => a.localeCompare(b));
  el.innerHTML = '<option value="">Toutes salles</option><option value="__none__">Sans salle</option>' + names.map(n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');
  el.value = cur;
}
function harvestSalles(v) {
  if (!v) return;
  if (!state.catalog.salles) state.catalog.salles = new Set();
  v.split(/[,;&]/).forEach(s => { const t = s.trim(); if (t) state.catalog.salles.add(t); });
  populateSallesDatalist();
  populateSalleSelect();
}
// Charge les salles + participantes déjà saisies sur les photos (image_library)
let _photoCatalogLoaded = false;
async function loadPhotoCatalog(force) {
  if (_photoCatalogLoaded && !force) return;
  _photoCatalogLoaded = true;
  try {
    const { data, error } = await sb.from('image_library').select('tri_salle,tri_participante').limit(3000);
    if (error) { _photoCatalogLoaded = false; return; }
    const salles = new Set();
    if (!state.catalog.participantes) state.catalog.participantes = new Set();
    for (const r of data || []) {
      if (r.tri_salle) String(r.tri_salle).split(/[,;&]/).forEach(s => { const t = s.trim(); if (t) salles.add(t); });
      if (r.tri_participante) String(r.tri_participante).split(/[,;&]/).forEach(s => { const t = s.trim(); if (t) state.catalog.participantes.add(t); });
    }
    state.catalog.salles = salles;
    populateSallesDatalist();
    populateSalleSelect();
    populateParticipantesDatalist();
    populateTriParticipanteSelect();
  } catch (e) { _photoCatalogLoaded = false; }
}

function triHas(c, tag) { return Array.isArray(c.tri_tags) && c.tri_tags.includes(tag); }

function setCardTriVisual(card, c) {
  card.classList.toggle('tri-ok', c.tri_status === 'ok');
  card.classList.toggle('tri-refuse', c.tri_status === 'refuse');
  card.classList.toggle('tri-bug', c.tri_status === 'bug');
}
function triStatusLabel(s) { return s === 'ok' ? 'OK' : s === 'refuse' ? 'Refusé' : s === 'bug' ? 'Bug' : 'à trier'; }

// Reflète localement la règle du trigger SQL vid_tri_sync (pour la pastille ✨ REEL)
function recomputeUsable(c) {
  c.usable_for_reel = !(c.tri_status === 'refuse' || c.tri_status === 'bug' || triHas(c, 'nathalie_sol'));
}

// Valeurs de tags par dimension (photos) + libellés courts pour l'overlay vignette
const FACIL_VALUES = ['facil_jerome', 'facil_nath', 'facil_duo'];
const PRATIQUE_VALUES = ['innerdance', 'breathwork', 'qi_cleansing', 'cacao'];
const CTX_VALUES = ['formation', 'seance', 'individuel'];
const TAG_SHORT = { facil_jerome: 'Jérôme', facil_nath: 'Nath', facil_duo: 'Les deux', formation: 'Formation', seance: 'Séance', individuel: 'Individuel', innerdance: 'Inner', breathwork: 'Breath', qi_cleansing: 'Qi', cacao: 'Cacao' };
const TAG_CLASS = { facil_jerome: 'ct-facil', facil_nath: 'ct-facil', facil_duo: 'ct-facil', formation: 'ct-ctx', seance: 'ct-ctx', individuel: 'ct-ctx', innerdance: 'ct-prat', breathwork: 'ct-prat', qi_cleansing: 'ct-prat', cacao: 'ct-prat' };
function hasAnyTag(c, arr) { return Array.isArray(c.tri_tags) && c.tri_tags.some(t => arr.includes(t)); }
function isPhotoTagged(c) { return (Array.isArray(c.tri_tags) && c.tri_tags.length > 0) || !!c.tri_participante || !!c.tri_salle; }

// La carte (photo/image) correspond-elle encore aux filtres actifs ? (miroir de buildImageQuery)
function photoMatchesFilters(c) {
  const f = state.filters;
  if (f.triStatus && c.tri_status !== f.triStatus) return false;
  if (f.triRatingMin > 0 && (Number(c.tri_rating) || 0) < f.triRatingMin) return false;
  if (f.triParticipante === '__none__') { if (c.tri_participante) return false; }
  else if (f.triParticipante) { if (!String(c.tri_participante || '').toLowerCase().includes(f.triParticipante.toLowerCase())) return false; }
  if (f.triPratique === '__none__') { if (hasAnyTag(c, PRATIQUE_VALUES)) return false; }
  else if (f.triPratique) { if (!triHas(c, f.triPratique)) return false; }
  if (state.mediaType === 'photo') {
    if (f.triFacilitateur === '__none__') { if (hasAnyTag(c, FACIL_VALUES)) return false; }
    else if (f.triFacilitateur) { if (!triHas(c, f.triFacilitateur)) return false; }
    if (f.triContexte === '__none__') { if (hasAnyTag(c, CTX_VALUES)) return false; }
    else if (f.triContexte) { if (!triHas(c, f.triContexte)) return false; }
    if (f.triSalle === '__none__') { if (c.tri_salle) return false; }
    else if (f.triSalle) { if (!String(c.tri_salle || '').toLowerCase().includes(f.triSalle.toLowerCase())) return false; }
    if (f.triTagged === 'untagged') { if (isPhotoTagged(c)) return false; }
    else if (f.triTagged === 'tagged') { if (!isPhotoTagged(c)) return false; }
  }
  if (f.triBug) { if (c.tri_status !== 'bug') return false; }
  else if (f.triRefused) { if (c.tri_status !== 'refuse') return false; }
  else if (f.triHide) { if (c.tri_status !== 'a_trier') return false; }
  return true;
}

// Retire de la grille les photos qui ne correspondent plus aux filtres après un tag.
function applyLiveFilterHide(ids, mode) {
  if (isVideoMode()) return false;
  const remove = ids.filter(id => { const c = state.clips.find(x => x.id === id); return c && !photoMatchesFilters(c); });
  if (!remove.length) return false;
  if (remove.length === 1 && mode !== 'sync') {
    const c = state.clips.find(x => x.id === remove[0]);
    const card = cardEl(remove[0]);
    if (c && card && card.isConnected) { removeCardFromGrid(c, card); return true; }
  }
  const set = new Set(remove);
  state.clips = state.clips.filter(x => !set.has(x.id));
  if (state.filteredCount != null) state.filteredCount = Math.max(0, state.filteredCount - remove.length);
  updateCounts();
  return true;
}

// Overlay des tags sur la vignette (mode tri) : voir comment chaque photo est taguée d'un coup d'œil
function paintCardTagOverlay(card, c) {
  const ov = card && card.querySelector('.card-tags');
  if (!ov) return;
  const out = [];
  const tags = Array.isArray(c.tri_tags) ? c.tri_tags : [];
  for (const t of tags) { const lbl = TAG_SHORT[t]; if (lbl) out.push(`<span class="ct ${TAG_CLASS[t] || ''}">${lbl}</span>`); }
  if (c.tri_participante) out.push(`<span class="ct ct-part">${escapeHtml(c.tri_participante)}</span>`);
  if (c.tri_salle) out.push(`<span class="ct ct-salle">📍${escapeHtml(c.tri_salle)}</span>`);
  ov.innerHTML = out.join('');
}

async function updateTri(c, card, patch) {
  Object.assign(c, patch);
  recomputeUsable(c);
  if (card) setCardTriVisual(card, c);
  if (card && !isVideoMode()) paintCardTagOverlay(card, c);
  const { error } = await sb.from(mediaTable()).update(patch).eq('id', c.id);
  if (error) { console.error('updateTri', error); toast('Tri non sauvegardé', 'error'); return false; }
  return true;
}

// Cible d'une action du panneau : toute la sélection si la carte en fait partie
// (et qu'il y en a plusieurs), sinon juste cette carte.
function triTargets(c) {
  return (state.selection.has(c.id) && state.selection.size > 1) ? [...state.selection] : [c.id];
}
function cardEl(id) { return gallery.querySelector(`.card[data-id="${id}"]`); }

function toggleTriTag(c, card, tag, on) {
  const ids = triTargets(c);
  for (const id of ids) {
    const cc = state.clips.find(x => x.id === id);
    if (!cc) continue;
    const tags = Array.isArray(cc.tri_tags) ? [...cc.tri_tags] : [];
    const i = tags.indexOf(tag);
    if (on && i < 0) tags.push(tag);
    if (!on && i >= 0) tags.splice(i, 1);
    updateTri(cc, cardEl(id), { tri_tags: tags });
  }
  if (ids.length > 1) { toast(`${ids.length} ${isVideoMode() ? 'clips' : 'éléments'} taggés`); applyLiveFilterHide(ids, 'sync'); renderGallery(); }
  else { applyLiveFilterHide(ids); }
}

// Applique un statut à la carte, ou à toute la sélection si la carte en fait partie (multi).
function setTriStatus(c, card, status) {
  const ids = triTargets(c);
  for (const id of ids) {
    const cc = state.clips.find(x => x.id === id);
    if (cc) updateTri(cc, cardEl(id), { tri_status: status });
  }
  updateTriProgress();
  if (ids.length > 1) {
    toast(`${ids.length} ${isVideoMode() ? 'clips' : 'éléments'} → ${triStatusLabel(status)}`);
    if (isVideoMode()) {
      if (state.filters.triHide && !state.filters.triRefused && !state.filters.triBug) {
        const remove = new Set(ids.filter(id => { const cc = state.clips.find(x => x.id === id); return cc && isTriaged(cc); }));
        if (remove.size) {
          state.clips = state.clips.filter(x => !remove.has(x.id));
          if (state.filteredCount != null) state.filteredCount = Math.max(0, state.filteredCount - remove.size);
        }
      }
    } else {
      applyLiveFilterHide(ids, 'sync');
    }
    state.selection.clear();
    lastSelIndex = null;
    updateSelectionBar();
    renderGallery();
  } else {
    if (isVideoMode()) maybeHideTriaged(c, card);
    else applyLiveFilterHide(ids);
  }
}

function paintStars(container, n) {
  container.querySelectorAll('.st').forEach((s, idx) => s.classList.toggle('on', idx < n));
}
// Repeint les étoiles d'une carte depuis l'extérieur (notation clavier)
function paintCardStars(card, n) {
  if (!card) return;
  card.querySelectorAll('.tri-stars .st').forEach((s, idx) => s.classList.toggle('on', idx < n));
  const rv = card.querySelector('.tri-rating-val');
  if (rv) rv.textContent = n ? `${n}/10` : '';
}

// "Trié" : Refusé tout court, OU OK avec une note écrite.
function isTriaged(c) {
  if (c.tri_status === 'refuse' || c.tri_status === 'bug') return true;
  if (c.tri_status === 'ok') return (Number(c.tri_rating) || 0) > 0; // OK trié = au moins 1 étoile
  return false;
}
function removeCardFromGrid(c, card) {
  card.style.transition = 'opacity .25s ease, transform .25s ease';
  card.style.opacity = '0';
  card.style.transform = 'scale(0.92)';
  setTimeout(() => {
    card.remove();
    const i = state.clips.findIndex(x => x.id === c.id);
    if (i >= 0) state.clips.splice(i, 1);
    if (state.filteredCount != null) state.filteredCount = Math.max(0, state.filteredCount - 1);
    updateCounts();
  }, 250);
}
// Masque la vignette au fur et à mesure si le filtre "Masquer les déjà triées" est actif.
function maybeHideTriaged(c, card) {
  if (state.filters.triHide && !state.filters.triRefused && !state.filters.triBug && isTriaged(c) && card.isConnected) removeCardFromGrid(c, card);
}

function makeTriPanel(c, card) {
  const p = document.createElement('div');
  p.className = 'tri-panel';
  p.addEventListener('click', e => e.stopPropagation());

  // Boutons OK / Refusé (créés ici, placés en bas du panneau)
  const rowS = document.createElement('div');
  rowS.className = 'tri-row';
  const okB = document.createElement('button');
  okB.className = 'tri-status-btn ok';
  okB.textContent = 'OK';
  const noB = document.createElement('button');
  noB.className = 'tri-status-btn refuse';
  noB.textContent = 'Refusé';
  let bugB = null;
  const reflectStatus = () => {
    okB.classList.toggle('on', c.tri_status === 'ok');
    noB.classList.toggle('on', c.tri_status === 'refuse');
    if (bugB) bugB.classList.toggle('on', c.tri_status === 'bug');
  };
  okB.addEventListener('click', () => { setTriStatus(c, card, c.tri_status === 'ok' ? 'a_trier' : 'ok'); reflectStatus(); });
  noB.addEventListener('click', () => { setTriStatus(c, card, c.tri_status === 'refuse' ? 'a_trier' : 'refuse'); reflectStatus(); });
  reflectStatus();
  rowS.appendChild(okB);
  rowS.appendChild(noB);

  // Note (étoiles) + Participante sur la même ligne
  const rowR = document.createElement('div');
  rowR.className = 'tri-row tri-toprow';
  const stars = document.createElement('div');
  stars.className = 'tri-stars';
  const ratingVal = document.createElement('span');
  ratingVal.className = 'tri-rating-val';
  const showVal = (n) => { ratingVal.textContent = n ? `${n}/10` : ''; };
  for (let i = 1; i <= 10; i++) {
    const s = document.createElement('span');
    s.className = 'st';
    s.innerHTML = '&#9733;';
    s.addEventListener('click', () => {
      const nv = (c.tri_rating === i) ? 0 : i;
      updateTri(c, card, { tri_rating: nv });
      paintStars(stars, nv);
      showVal(nv);
      maybeHideTriaged(c, card);
    });
    stars.appendChild(s);
  }
  paintStars(stars, c.tri_rating || 0);
  showVal(c.tri_rating || 0);
  rowR.appendChild(stars);
  rowR.appendChild(ratingVal);

  const part = document.createElement('input');
  part.className = 'tri-field tri-participante';
  part.type = 'text';
  part.placeholder = 'participante…';
  part.setAttribute('list', 'participantes-list');
  part.value = c.tri_participante || '';
  const savePart = () => {
    const v = part.value.trim();
    const ids = triTargets(c);
    for (const id of ids) {
      const cc = state.clips.find(x => x.id === id);
      if (!cc) continue;
      if ((cc.tri_participante || '') !== v) updateTri(cc, cardEl(id), { tri_participante: v || null });
      if (id !== c.id) { const el = cardEl(id); const inp = el && el.querySelector('.tri-participante'); if (inp) inp.value = v; }
    }
    harvestParticipantes(v);
    if (ids.length > 1 && v) toast(`Participante copiée sur ${ids.length} clips`);
  };
  part.addEventListener('change', savePart);
  part.addEventListener('blur', savePart);
  rowR.appendChild(part);
  p.appendChild(rowR);
  p.appendChild(triDivider());

  // Contexte : 2 lignes (Formation/Séance/Individuel, puis Nath/Nath/Duo)
  p.appendChild(renderTriTagWrap(c, card, TRI_CTX1));
  p.appendChild(renderTriTagWrap(c, card, TRI_CTX2));
  p.appendChild(triDivider());

  // Montage & son
  p.appendChild(renderTriTagWrap(c, card, TRI_CASES, 'g2'));
  p.appendChild(triDivider());

  // Pratique
  p.appendChild(renderTriTagWrap(c, card, TRI_PRACTICES, 'g3'));
  p.appendChild(triDivider());

  // Commentaire + bouton Bug (à côté)
  const rowC = document.createElement('div');
  rowC.className = 'tri-comment-row';
  const note = document.createElement('input');
  note.className = 'tri-field tri-comment';
  note.type = 'text';
  note.placeholder = 'commentaire…';
  note.value = c.tri_note || '';
  const saveNote = () => {
    const v = note.value.trim();
    const ids = triTargets(c);
    let changed = 0;
    for (const id of ids) {
      const cc = state.clips.find(x => x.id === id);
      if (!cc) continue;
      if ((cc.tri_note || '') !== v) { updateTri(cc, cardEl(id), { tri_note: v || null }); changed++; }
      if (id !== c.id) { const el = cardEl(id); const inp = el && el.querySelector('.tri-comment'); if (inp) inp.value = v; }
    }
    if (ids.length > 1 && changed) toast(`Commentaire copié sur ${ids.length} clips`);
  };
  note.addEventListener('change', saveNote);
  note.addEventListener('blur', saveNote);
  bugB = document.createElement('button');
  bugB.type = 'button';
  bugB.className = 'tri-status-btn bug';
  bugB.textContent = 'Bug';
  bugB.title = 'Vidéo qui bugge, à reprendre après';
  bugB.addEventListener('click', () => { setTriStatus(c, card, c.tri_status === 'bug' ? 'a_trier' : 'bug'); reflectStatus(); });
  rowC.appendChild(note);
  rowC.appendChild(bugB);
  p.appendChild(rowC);
  reflectStatus();
  p.appendChild(triDivider());

  // Validation
  p.appendChild(rowS);

  return p;
}

let _triProgT = null;
function updateTriProgressDebounced() {
  clearTimeout(_triProgT);
  _triProgT = setTimeout(updateTriProgress, 700);
}
async function updateTriProgress() {
  const el = document.getElementById('tri-progress');
  if (!el) return;
  try {
    const head = (st) => { let qq = sb.from(mediaTable()).select('id', { count: 'exact', head: true }).eq('tri_status', st); if (state.mediaType === 'video') qq = qq.eq('status', 'available'); return qq; };
    const [a, o, r, b] = await Promise.all([head('a_trier'), head('ok'), head('refuse'), head('bug')]);
    el.textContent = `À trier : ${a.count ?? '?'} · OK : ${o.count ?? '?'} · Refusé : ${r.count ?? '?'} · Bug : ${b.count ?? '?'}`;
  } catch (e) { /* silencieux */ }
}

function setTriMode(on) {
  state.triMode = !!on;
  document.body.classList.toggle('tri-on', state.triMode);
  const btn = document.getElementById('tri-mode-btn');
  if (btn) btn.classList.toggle('active', state.triMode);
  try { localStorage.setItem('library_tri_mode', state.triMode ? '1' : '0'); } catch (e) {}
  if (state.triMode) updateTriProgress();
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
  const th = document.getElementById('tri-hide-checkbox');
  if (th) th.checked = !!f.triHide;
  const tr = document.getElementById('tri-refused-checkbox');
  if (tr) tr.checked = !!f.triRefused;
  const tb = document.getElementById('tri-bug-checkbox');
  if (tb) tb.checked = !!f.triBug;
  const setSel = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setSel('tri-status-filter', f.triStatus || '');
  setSel('tri-rating-filter', String(f.triRatingMin || 0));
  setSel('tri-pratique-filter', f.triPratique || '');
  setSel('tri-contexte-filter', f.triContexte || '');
  setSel('tri-participante-filter', f.triParticipante || '');
  // Filtres photos en haut
  setSel('pf-status', f.triStatus || '');
  setSel('pf-rating', String(f.triRatingMin || 0));
  setSel('pf-facil', f.triFacilitateur || '');
  setSel('pf-contexte', f.triContexte || '');
  setSel('pf-pratique', f.triPratique || '');
  setSel('pf-salle', f.triSalle || '');
  setSel('pf-participante', f.triParticipante || '');
  setSel('pf-tagged', f.triTagged || '');
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

const wireTriSel = (id, key, asNum) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', e => { state.filters[key] = asNum ? Number(e.target.value) : e.target.value; resetAndReload(); });
};
wireTriSel('tri-status-filter', 'triStatus', false);
wireTriSel('tri-rating-filter', 'triRatingMin', true);
wireTriSel('tri-pratique-filter', 'triPratique', false);
wireTriSel('tri-contexte-filter', 'triContexte', false);
wireTriSel('tri-participante-filter', 'triParticipante', false);
// Filtres photos en haut (mêmes clés de state.filters)
wireTriSel('pf-status', 'triStatus', false);
wireTriSel('pf-rating', 'triRatingMin', true);
wireTriSel('pf-facil', 'triFacilitateur', false);
wireTriSel('pf-contexte', 'triContexte', false);
wireTriSel('pf-pratique', 'triPratique', false);
wireTriSel('pf-salle', 'triSalle', false);
wireTriSel('pf-participante', 'triParticipante', false);
wireTriSel('pf-tagged', 'triTagged', false);

const mediaSwitch = document.getElementById('media-switch');
if (mediaSwitch) mediaSwitch.addEventListener('click', (e) => { const b = e.target.closest('.media-btn'); if (b) setMediaType(b.dataset.media); });
// 📌 Sélection à signaler : on REUTILISE la sélection existante (cases ✓, state.selection),
// on la persiste dans flagged pour que Claude puisse la lire.
const selFlag = document.getElementById('sel-flag');
if (selFlag) selFlag.addEventListener('click', async () => {
  const ids = [...state.selection];
  if (!ids.length) { if (typeof toast === 'function') toast('Coche d\'abord des cartes (✓), puis Signaler'); return; }
  const { error } = await sb.from(mediaTable()).update({ flagged: true }).in('id', ids);
  if (error) { console.error('signaler', error); if (typeof toast === 'function') toast('Erreur : ' + error.message); return; }
  ids.forEach(id => { const cc = state.clips.find(x => x.id === id); if (cc) cc.flagged = true; });
  if (typeof toast === 'function') toast(`${ids.length} dans ma sélection 📌`);
  state.selection.clear();
  if (typeof renderGallery === 'function') renderGallery();
  updateFlaggedCount();
});
const selView = document.getElementById('sel-view');
if (selView) selView.addEventListener('click', () => {
  state.filters.flaggedOnly = !state.filters.flaggedOnly;
  selView.classList.toggle('active', state.filters.flaggedOnly);
  loadFirstPage();
});
const selClear = document.getElementById('sel-clear');
if (selClear) selClear.addEventListener('click', async () => {
  const { error } = await sb.from(mediaTable()).update({ flagged: false }).eq('flagged', true);
  if (error) { console.error('vider', error); return; }
  if (typeof toast === 'function') toast('Sélection vidée');
  if (state.filters.flaggedOnly) { state.filters.flaggedOnly = false; if (selView) selView.classList.remove('active'); }
  loadFirstPage();
  updateFlaggedCount();
});
async function updateFlaggedCount() {
  try {
    const { count } = await sb.from(mediaTable()).select('id', { count: 'exact', head: true }).eq('flagged', true);
    const el = document.getElementById('sel-count');
    if (el) el.textContent = count ? `(${count})` : '';
  } catch (e) { /* silencieux */ }
}
updateFlaggedCount();
document.body.dataset.media = state.mediaType || 'video';

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

// ---------- MODE TRI WIRING ----------
const triModeBtn = $('tri-mode-btn');
const triHideCheckbox = $('tri-hide-checkbox');
const triRefusedCheckbox = $('tri-refused-checkbox');
const triBugCheckbox = $('tri-bug-checkbox');
triModeBtn && triModeBtn.addEventListener('click', () => setTriMode(!state.triMode));
triHideCheckbox && triHideCheckbox.addEventListener('change', () => {
  state.filters.triHide = triHideCheckbox.checked;
  resetAndReload();
});
triRefusedCheckbox && triRefusedCheckbox.addEventListener('change', () => {
  state.filters.triRefused = triRefusedCheckbox.checked;
  resetAndReload();
});
triBugCheckbox && triBugCheckbox.addEventListener('change', () => {
  state.filters.triBug = triBugCheckbox.checked;
  resetAndReload();
});
const selectAllBtn = $('select-all-visible');
selectAllBtn && selectAllBtn.addEventListener('click', selectAllVisible);
// Restaurer l'état du mode tri + les cases
if (triHideCheckbox) triHideCheckbox.checked = !!state.filters.triHide;
if (triRefusedCheckbox) triRefusedCheckbox.checked = !!state.filters.triRefused;
if (triBugCheckbox) triBugCheckbox.checked = !!state.filters.triBug;
const triProgressEl = document.getElementById('tri-progress');
if (triProgressEl) { triProgressEl.title = 'Cliquer pour rafraîchir'; triProgressEl.addEventListener('click', updateTriProgress); }
buildBatchTriBar();
setTriMode((() => { try { return localStorage.getItem('library_tri_mode') === '1'; } catch (e) { return false; } })());

// Notation au clavier : en mode tri, souris au-dessus d'une vignette + pavé num.
// 0 = 1 étoile, 9 = 10 étoiles (touche + 1).
let hoveredCardId = null;
document.addEventListener('keydown', (e) => {
  if (!state.triMode || !hoveredCardId) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && ae.type !== 'range'))) return;
  let digit = null;
  if (/^Numpad[0-9]$/.test(e.code)) digit = +e.code.slice(6);
  else if (/^Digit[0-9]$/.test(e.code)) digit = +e.code.slice(5);
  if (digit === null) return;
  e.preventDefault();
  const note = digit + 1;
  const c = state.clips.find(x => x.id === hoveredCardId);
  if (!c) return;
  const card = cardEl(hoveredCardId);
  updateTri(c, card, { tri_rating: note });
  paintCardStars(card, note);
  maybeHideTriaged(c, card);
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
  if (key === 'triRatingMin') return Number(val) > 0;
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
let lastSelIndex = null;
function paintCardSelection(id) {
  const card = gallery.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
  const sel = state.selection.has(id);
  card.classList.toggle('selected', sel);
  const cb = card.querySelector('.select-checkbox');
  if (cb) cb.textContent = sel ? '✓' : '';
}
function toggleSelection(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  updateSelectionBar();
  paintCardSelection(id);
}
// Clic sur une case : sans shift = coche/décoche ; avec shift = sélectionne toute
// la plage depuis la dernière case cochée (sélection en série).
function handleSelectClick(id, shift) {
  const idx = state.clips.findIndex(x => x.id === id);
  if (shift && lastSelIndex != null && idx >= 0) {
    const a = Math.min(lastSelIndex, idx), b = Math.max(lastSelIndex, idx);
    for (let i = a; i <= b; i++) {
      const cid = state.clips[i] && state.clips[i].id;
      if (cid) { state.selection.add(cid); paintCardSelection(cid); }
    }
    updateSelectionBar();
  } else {
    toggleSelection(id);
    lastSelIndex = idx;
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

// ---------- SUPPRESSION MANUELLE DE DOUBLONS (+ liste noire d'empreintes) ----------
const DELETE_R2_URL = 'https://zrdlvoovrnglxcgoyyeb.supabase.co/functions/v1/delete-from-r2';
const DELETE_R2_TOKEN = 'somatica-r2-2026';

async function deleteClipFull(c) {
  // 1. Mémoriser l'empreinte pour bloquer un futur ré-import (si elle existe)
  if (c.content_hash) {
    const { error: be } = await sb.from('video_blocklist')
      .upsert({ content_hash: c.content_hash, file_name: c.file_name || null, reason: 'doublon' }, { onConflict: 'content_hash' });
    if (be) console.warn('blocklist', be);
  }
  // 2. Supprimer le fichier R2 (+ miniature) via l'Edge Function
  const keys = [];
  if (c.r2_key) keys.push(c.r2_key);
  if (c.thumbnail_url) { try { const p = new URL(c.thumbnail_url).pathname.replace(/^\/+/, ''); if (p && !keys.includes(p)) keys.push(p); } catch (e) {} }
  if (keys.length) {
    try {
      await fetch(DELETE_R2_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DELETE_R2_TOKEN}` }, body: JSON.stringify({ keys }) });
    } catch (e) { console.warn('R2 delete', e); }
  }
  // 3. Supprimer la ligne en base
  const { error } = await sb.from(mediaTable()).delete().eq('id', c.id);
  if (error) throw error;
}

async function deleteSelectionAsDuplicates() {
  const ids = [...state.selection];
  if (!ids.length) { toast('Aucune sélection'); return; }
  const noHash = ids.filter(id => { const c = state.clips.find(x => x.id === id); return c && !c.content_hash; }).length;
  let msg = `Supprimer définitivement ${ids.length} vidéo(s) ?\nBase + fichier R2. L'empreinte est mémorisée pour bloquer un ré-import.`;
  if (noHash) msg += `\n\n${noHash} n'ont pas encore d'empreinte (fais "Hash all" dans l'onglet Doublons avant, sinon elles pourront revenir).`;
  if (!confirm(msg)) return;
  let done = 0, fail = 0;
  for (const id of ids) {
    const c = state.clips.find(x => x.id === id);
    if (!c) continue;
    try {
      await deleteClipFull(c);
      const card = cardEl(id); if (card) card.remove();
      const i = state.clips.findIndex(x => x.id === id); if (i >= 0) state.clips.splice(i, 1);
      done++;
    } catch (e) { console.error('delete clip', e); fail++; }
  }
  state.selection.clear(); lastSelIndex = null;
  if (state.filteredCount != null) state.filteredCount = Math.max(0, state.filteredCount - done);
  updateSelectionBar(); updateCounts(); renderGallery();
  toast(`${done} supprimée(s)${fail ? ` · ${fail} échec(s)` : ''}`, fail ? 'error' : 'info');
}

const deleteDupesBtn = $('delete-dupes');
deleteDupesBtn && deleteDupesBtn.addEventListener('click', deleteSelectionAsDuplicates);

// ---------- ACTIONS GROUPÉES (mode tri) ----------
function buildBatchTriBar() {
  const host = document.getElementById('batch-tri');
  if (!host) return;
  host.innerHTML = '';
  const ok = document.createElement('button');
  ok.className = 'batch-btn ok'; ok.textContent = 'OK';
  ok.addEventListener('click', () => applyBatchStatus('ok'));
  const no = document.createElement('button');
  no.className = 'batch-btn refuse'; no.textContent = 'Refusé';
  no.addEventListener('click', () => applyBatchStatus('refuse'));
  const bug = document.createElement('button');
  bug.className = 'batch-btn bug'; bug.textContent = 'Bug';
  bug.addEventListener('click', () => applyBatchStatus('bug'));
  host.appendChild(ok);
  host.appendChild(no);
  host.appendChild(bug);
  // Tags groupés selon le média : vidéo = jeu complet, photo = facilitateur + pratiques, images IA = aucun
  const batchTags = state.mediaType === 'photo'
    ? [...TRI_FACILITATEUR, ...TRI_CTX1, ...TRI_PRACTICES]
    : (state.mediaType === 'image' ? [] : [...TRI_TAGS, ...TRI_CASES, ...TRI_PRACTICES]);
  if (batchTags.length) {
    const sep = document.createElement('span');
    sep.className = 'batch-sep'; sep.textContent = 'tags';
    host.appendChild(sep);
    for (const [val, label] of batchTags) {
      const b = document.createElement('button');
      b.className = 'batch-btn tag' + (val.startsWith('facil_') ? ' facil' : '');
      b.textContent = label;
      b.addEventListener('click', () => applyBatchTag(val));
      host.appendChild(b);
    }
  }
  // Participante commune (photos) : nomme toute la sélection d'un coup
  if (MEDIA[state.mediaType] && MEDIA[state.mediaType].participante) {
    const psep = document.createElement('span');
    psep.className = 'batch-sep'; psep.textContent = 'participante';
    host.appendChild(psep);
    const pin = document.createElement('input');
    pin.className = 'batch-part';
    pin.type = 'text'; pin.placeholder = 'nom pour la sélection…';
    pin.setAttribute('list', 'participantes-list');
    pin.addEventListener('change', () => applyBatchParticipante(pin.value.trim()));
    host.appendChild(pin);
  }
  // Salle commune (photos)
  if (state.mediaType === 'photo') {
    const ssep = document.createElement('span');
    ssep.className = 'batch-sep'; ssep.textContent = 'salle';
    host.appendChild(ssep);
    const sin = document.createElement('input');
    sin.className = 'batch-part';
    sin.type = 'text'; sin.placeholder = 'salle pour la sélection…';
    sin.setAttribute('list', 'salles-list');
    sin.addEventListener('change', () => applyBatchSalle(sin.value.trim()));
    host.appendChild(sin);
  }
}

async function applyBatchSalle(v) {
  const ids = [...state.selection];
  if (!ids.length) { toast('Aucune sélection'); return; }
  for (const id of ids) { const c = state.clips.find(x => x.id === id); if (c) c.tri_salle = v || null; }
  const { error } = await sb.from(mediaTable()).update({ tri_salle: v || null }).in('id', ids);
  if (error) { console.error('applyBatchSalle', error); toast('Échec', 'error'); return; }
  harvestSalles(v);
  toast(`${ids.length} → ${v || 'sans salle'}`);
}

async function applyBatchParticipante(v) {
  const ids = [...state.selection];
  if (!ids.length) { toast('Aucune sélection'); return; }
  for (const id of ids) { const c = state.clips.find(x => x.id === id); if (c) c.tri_participante = v || null; }
  const { error } = await sb.from(mediaTable()).update({ tri_participante: v || null }).in('id', ids);
  if (error) { console.error('applyBatchParticipante', error); toast('Échec', 'error'); return; }
  harvestParticipantes(v);
  toast(`${ids.length} → ${v || 'sans participante'}`);
}

// Sélectionne toutes les vignettes actuellement chargées (pour taguer en lot)
function selectAllVisible() {
  if (!state.triMode) { toast('Active le mode tri'); return; }
  for (const c of state.clips) state.selection.add(c.id);
  document.querySelectorAll('.gallery .card').forEach(el => {
    el.classList.add('selected');
    const cb = el.querySelector('.select-checkbox');
    if (cb) cb.textContent = '✓';
  });
  lastSelIndex = null;
  updateSelectionBar();
  toast(`${state.selection.size} sélectionné(s)`);
}

async function applyBatchStatus(status) {
  const ids = [...state.selection];
  if (!ids.length) { toast('Aucune sélection'); return; }
  for (const id of ids) { const c = state.clips.find(x => x.id === id); if (c) { c.tri_status = status; recomputeUsable(c); } }
  const { error } = await sb.from(mediaTable()).update({ tri_status: status }).in('id', ids);
  if (error) { console.error('applyBatchStatus', error); toast('Échec de la mise à jour', 'error'); return; }
  toast(`${ids.length} clip(s) → ${triStatusLabel(status)}`);
  updateTriProgressDebounced();
  if (state.filters.triHide && !state.filters.triRefused && !state.filters.triBug) {
    const remove = new Set(ids.filter(id => { const c = state.clips.find(x => x.id === id); return c && isTriaged(c); }));
    if (remove.size) {
      state.clips = state.clips.filter(c => !remove.has(c.id));
      if (state.filteredCount != null) state.filteredCount = Math.max(0, state.filteredCount - remove.size);
    }
  }
  state.selection.clear();
  lastSelIndex = null;
  updateSelectionBar();
  renderGallery();
}

async function applyBatchTag(tag) {
  const ids = [...state.selection];
  if (!ids.length) { toast('Aucune sélection'); return; }
  const clips = ids.map(id => state.clips.find(x => x.id === id)).filter(Boolean);
  const allHave = clips.length > 0 && clips.every(c => triHas(c, tag));
  const add = !allHave; // si tous l'ont déjà, on retire ; sinon on ajoute
  await Promise.all(clips.map(c => {
    const tags = Array.isArray(c.tri_tags) ? [...c.tri_tags] : [];
    const i = tags.indexOf(tag);
    if (add && i < 0) tags.push(tag);
    if (!add && i >= 0) tags.splice(i, 1);
    c.tri_tags = tags; recomputeUsable(c);
    return sb.from(mediaTable()).update({ tri_tags: tags }).eq('id', c.id).then(({ error }) => { if (error) console.error('applyBatchTag', error); });
  }));
  toast(`${clips.length} clip(s) : ${add ? 'tag ajouté' : 'tag retiré'}`);
  renderGallery();
}

// ---------- MODAL ----------
function setModalHevcNotice(c) {
  const container = modalVideo.parentElement;
  if (!container) return;
  let notice = container.querySelector('.modal-hevc-notice');
  if (!c) { if (notice) notice.remove(); return; }
  if (!notice) { notice = document.createElement('div'); notice.className = 'modal-hevc-notice'; container.appendChild(notice); }
  const img = c.thumbnail_url ? `<img src="${escapeAttr(c.thumbnail_url)}" alt="">` : '';
  notice.innerHTML = `${img}<div class="mhn-msg">Vidéo en HEVC, non lisible dans ce navigateur.<br>Elle sera visible après ré-encodage en H.264.</div>`;
}

function openModal(id) {
  const c = state.clips.find(x => x.id === id);
  if (!c) return;
  if (activePreview) activePreview.stop(); // couper les aperçus de la galerie derrière la modale
  document.body.classList.add('modal-open'); // masque la galerie (évite que les vidéos percent par-dessus)
  const _mi0 = modalVideo.parentElement.querySelector('.modal-img'); if (_mi0) _mi0.style.display = 'none';
  state.currentModalId = id;
  modalTitle.textContent = c.ambiance ? c.ambiance : (c.file_name || 'Clip');
  if (clipPreviewable(c)) {
    modalVideo.style.display = '';
    modalVideo.src = c.r2_url;
    modalVideo.currentTime = 0;
    setModalHevcNotice(null);
  } else {
    modalVideo.pause();
    modalVideo.removeAttribute('src');
    try { modalVideo.load(); } catch (e) {}
    modalVideo.style.display = 'none';
    setModalHevcNotice(c);
  }

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
  document.body.classList.remove('modal-open');
  modalVideo.pause();
  modalVideo.src = '';
  modalVideo.style.display = '';
  setModalHevcNotice(null);
  const _mi = modalVideo.parentElement.querySelector('.modal-img');
  if (_mi) { _mi.src = ''; _mi.style.display = 'none'; }
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

// ---------- ZOOM / LARGEUR DE GRILLE (molette 1–16) ----------
const colsRange = document.getElementById('cols-range');
const colsValEl = document.getElementById('cols-val');
// Max de colonnes selon le média : vidéo 4, photos / images IA 16
const COLS_MAX_BY_MODE = { video: 4, photo: 16, image: 16 };
function colsMax() { return COLS_MAX_BY_MODE[state.mediaType] || 4; }
function colsStorageKey() { return state.mediaType === 'video' ? 'library_cols' : 'library_cols_img'; }
function defaultColsForMode() {
  if (state.mediaType === 'video') return window.innerWidth < 768 ? 2 : 3;
  return window.innerWidth < 768 ? 4 : 6;
}

function applyCols(cols) {
  cols = Math.max(1, Math.min(colsMax(), parseInt(cols) || defaultColsForMode()));
  document.documentElement.style.setProperty('--cols', cols);
  gallery.dataset.dense = cols >= 5 ? '2' : (cols >= 3 ? '1' : '0');
  // Au-delà de 4 colonnes : vignettes nues + tag/nom communs dans la barre du bas
  document.body.classList.toggle('tri-dense', cols > 4);
  if (colsRange) { colsRange.max = String(colsMax()); colsRange.value = String(cols); }
  if (colsValEl) colsValEl.textContent = String(cols);
  try { localStorage.setItem(colsStorageKey(), String(cols)); } catch (e) {}
  state.cols = cols;
  return cols;
}

// Recharge la largeur mémorisée pour le média courant (appelé au changement de média)
function reloadColsForMode() {
  if (colsRange) colsRange.max = String(colsMax());
  applyCols(parseInt(localStorage.getItem(colsStorageKey())) || defaultColsForMode());
}

state.cols = applyCols(parseInt(localStorage.getItem(colsStorageKey())) || defaultColsForMode());

if (colsRange) colsRange.addEventListener('input', () => applyCols(colsRange.value));

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
