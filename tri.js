/* Library · Tri — espace de tri dédié. 23/09/2026.
 *
 * Jérôme : « les filtres, la mise en page et l'utilisation de Library sont super pas
 * ergonomiques… fais quelque chose d'exploitable, pour retaguer facilement en lot ou
 * par unité, des filtres et des recherches efficaces, rejeter ou valider ».
 *
 * Trois principes, qui expliquent presque tout le code :
 *
 *  1. TOUTE la banque (vidéos + photos, ~4 400 lignes, colonnes légères) est chargée
 *     en mémoire au démarrage. Filtres, recherche et compteurs deviennent instantanés :
 *     aucun aller-retour serveur quand on coche un filtre.
 *
 *  2. Le panneau de droite édite LA SÉLECTION, qu'elle compte 1 ou 300 médias. Il n'y a
 *     pas de « mode tri » à activer ni de barre de lot séparée : le même geste sert à
 *     l'unité et au lot.
 *
 *  3. Une écriture groupe les médias par valeur RÉSULTANTE : poser « Lucie » sur 200
 *     médias = une seule requête, pas 200. Et chaque action peut être annulée.
 *
 * Ce que l'ancienne vue garde seule : le retour vers SomaticaEdit (?mode=picker), les
 * enregistrements live, l'accès élèves, les images et vidéos IA.
 */
'use strict';

const SUPABASE_URL = 'https://zrdlvoovrnglxcgoyyeb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ukrn7WQHygY5FUtNiMxxfA_E-esyAUs';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sansAccents = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/Æ/g, 'AE');
const cle = s => sansAccents(s).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const VIDE = '∅';                       // valeur « sans … » d'une facette
const JEROME = 'jerome lepilliet';      // jamais proposé comme participante : c'est lui qui anime

// ───────────────────────────── Taxonomie ─────────────────────────────
// Mêmes slugs que l'ancienne vue et que la vue banque_pour_montage : ce sont eux que
// lisent les moteurs de production. Ne pas en inventer.
const GROUPES = [
  { cle: 'contexte', titre: 'Contexte', sans: true, valeurs: [['formation', 'Formation'], ['seance', 'Séance'], ['individuel', 'Individuel']] },
  { cle: 'pratique', titre: 'Pratique', sans: true, valeurs: [['innerdance', 'Innerdance'], ['breathwork', 'Breathwork'], ['qi_cleansing', 'Qi cleansing'], ['cacao', 'Cacao']] },
  { cle: 'facilitateur', titre: 'Animé par', sans: true, exclusif: true, valeurs: [['facil_jerome', 'Jérôme'], ['facil_nath', 'Nath'], ['facil_duo', 'Les deux']] },
  { cle: 'cohorte', titre: 'Cohorte', sans: true, exclusif: true, valeurs: [['cohorte_1', 'Cohorte 1'], ['cohorte_2', 'Cohorte 2'], ['cohorte_3', 'Cohorte 3']] },
  { cle: 'role', titre: 'Ce que ça montre', sans: true, valeurs: [['temoignage_eleve', 'Témoignage élève'], ['temoignage_seance', 'Témoignage séance'], ['explication', 'Explication'], ['cours', 'Cours'], ['pov', 'POV'], ['demo', 'Démo'], ['visite_salle', 'Visite de salle'], ['objets', 'Objets'], ['groupe', 'Groupe']] },
  { cle: 'montage', titre: 'Montage / son', valeurs: [['deja_monte', 'Déjà monté'], ['texte_incruste', 'Texte incrusté'], ['son_origine', "Son d'origine ++"], ['a_transcrire', 'À transcrire']] },
  { cle: 'nathalie', titre: 'Nathalie', valeurs: [['nathalie_facilite', 'Nath. facilite'], ['nathalie_sol', 'Nath. au sol'], ['duo_jerome_nathalie', 'Duo Jérôme & Nath']] },
  { cle: 'controle', titre: 'Contrôle', valeurs: [['a_controler', 'À contrôler']] },
  // Vidéos finies pour un usage précis, rangées à part (onglet « Couvertures FB ») :
  // les couvertures d'événements Facebook, au format bannière 1,91:1 (1920×1006).
  { cle: 'reserve', titre: 'Usage réservé', valeurs: [['couverture_fb', 'Couverture événement FB']] },
];
const COUVERTURE = 'couverture_fb';
// Tout / Vidéos / Photos montrent la banque de travail ; les couvertures ont leur onglet.
const typeDe = it => it.tags.includes(COUVERTURE) ? 'couverture' : it.kind;

// Format d'après les dimensions : sert à trouver du vertical pour les stories et reels,
// et repère les bannières (les couvertures d'événements sont les seules aujourd'hui).
function formatDe(w, h) {
  w = Number(w) || 0; h = Number(h) || 0;
  if (!w || !h) return VIDE;
  const r = w / h;
  return r < 0.9 ? 'vertical' : r <= 1.1 ? 'carre' : r < 1.85 ? 'horizontal' : 'banniere';
}
const LIBELLE_TAG = Object.fromEntries(GROUPES.flatMap(g => g.valeurs));
const STATUTS = { a_trier: 'À trier', ok: 'Validé', refuse: 'Refusé', bug: 'Bug' };

// ───────────────────────────── État ─────────────────────────────
const S = {
  items: [], byId: new Map(),
  filtres: { type: '', statut: '', facettes: {}, recherche: '' },
  trier: 'date_desc', grouper: '', taille: 150, son: true,
  ouvertes: new Set(['personne', 'salle', 'cohorte', 'exploitable', 'contexte']),
  vue: [], indexVue: new Map(), groupes: [],
  plat: [], rendus: 0, grilleCourante: null, cartes: new Map(),
  sel: new Set(), ancre: null, courant: null,
  sortants: new Set(),        // modifiés et ne correspondant plus aux filtres, gardés à l'écran
  compteurs: null, libelles: {},
  vocab: { salles: [], univers: [] },
  pile: [],                   // annulations
  lance: false,
  gen: 0,                     // numéro de chargement : un complément en retard s'arrête seul
};

const PREFS = 'library_tri_v1';
function chargerPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}');
    if (p.filtres) {
      S.filtres.type = p.filtres.type || '';
      S.filtres.statut = p.filtres.statut ?? '';
      for (const [k, v] of Object.entries(p.filtres.facettes || {})) if (v?.length) S.filtres.facettes[k] = new Set(v);
    }
    if (p.trier) S.trier = p.trier;
    if (p.grouper !== undefined) S.grouper = p.grouper;
    if (p.taille) S.taille = p.taille;
    if (p.son !== undefined) S.son = p.son;
    if (p.ouvertes) S.ouvertes = new Set(p.ouvertes);
  } catch (e) { /* préférences illisibles : on repart des défauts */ }
}
function sauverPrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({
      filtres: { type: S.filtres.type, statut: S.filtres.statut,
        facettes: Object.fromEntries(Object.entries(S.filtres.facettes).map(([k, v]) => [k, [...v]])) },
      trier: S.trier, grouper: S.grouper, taille: S.taille, son: S.son, ouvertes: [...S.ouvertes],
    }));
  } catch (e) { /* stockage bloqué : sans conséquence */ }
}

// ───────────────────────────── Normalisation ─────────────────────────────
function splitPersonnes(v) {
  if (!v) return [];
  return String(v).split(/\s*[,;/]\s*|\s+et\s+/i).map(s => s.trim()).filter(Boolean);
}
function joinPersonnes(liste) { return liste.length ? liste.join(', ') : null; }

function jourIso(v) { return v ? String(v).slice(0, 10) : ''; }
function dateDepuisNom(nom) {
  const m = /^(?:rush-)?(\d{4}-\d{2}-\d{2})/i.exec(nom || '');
  return m ? m[1] : '';
}

function universDe(tags) {
  if (!tags.includes('hors_somatica')) return 'somatica';
  return tags.find(t => t.startsWith('u_')) || (tags.includes('chantier') ? 'chantier' : 'hors');
}

// La vue banque_pour_montage, réécrite ici à l'identique : « utilisable » est ce que les
// moteurs prennent vraiment. Si cette règle change côté base, la changer ici aussi.
function utilisableParLesMoteurs(it) {
  const r = it.raw;
  if (!r.r2_url) return false;
  if (['rejected', 'refuse', 'bug'].includes(r.tri_status)) return false;
  if (it.tags.includes('a_controler') || it.tags.includes('hors_somatica')) return false;
  if (it.kind === 'photo') return !r.is_private && !!r.usable_com;
  return !!r.usable_for_reel;
}

function deriver(it) {
  const r = it.raw;
  it.nom = r.file_name || r.filename || '';
  it.url = r.r2_url || '';
  it.thumb = it.kind === 'video' ? (r.thumbnail_url || '') : it.url;
  it.duree = Number(r.duration_seconds) || 0;
  it.tags = Array.isArray(r.tri_tags) ? r.tri_tags.filter(Boolean) : [];
  it.personnes = splitPersonnes(r.tri_participante);
  it.salle = (r.tri_salle || '').trim();
  it.gps = (r.location_name || '').trim();
  it.statut = ['ok', 'refuse', 'bug'].includes(r.tri_status) ? r.tri_status : 'a_trier';
  it.note = Number(r.tri_rating) || 0;
  it.commentaire = r.tri_note || '';
  it.usage = it.kind === 'video' ? (r.used_in_reels?.length || 0) : (r.used_in_projects?.length || 0);
  it.ajout = r.created_at || '';
  if (!it.parent) it.date = jourIso(r.created_at_source) || dateDepuisNom(it.nom) || jourIso(r.created_at);
  it.univers = universDe(it.tags);
  it.exploitable = utilisableParLesMoteurs(it);
  it.detectees = (r.persons_detected || []).filter(n => n && n !== '_UNKNOWN_' && cle(n) !== JEROME);
  it.lieu = it.salle || it.gps;

  // valeurs par facette, calculées une fois
  const fv = {
    personne: it.personnes.length ? [...new Set(it.personnes.map(cle))] : [VIDE],
    salle: [it.salle ? cle(it.salle) : VIDE],
    univers: [it.univers],
    exploitable: [it.exploitable ? 'oui' : 'non'],
    usage: [it.usage > 0 ? 'oui' : 'non'],
    note: [it.note ? (it.note >= 8 ? '8' : it.note >= 5 ? '5' : '1') : VIDE],
    mois: [it.date ? it.date.slice(0, 7) : VIDE],
    gps: it.kind === 'video' ? [it.gps ? cle(it.gps) : VIDE] : [],
    ia: it.detectees.length ? ['oui'] : ['non'],
    exclu: it.kind === 'video' ? [it.raw.exclu_du_tirage ? 'oui' : 'non'] : [],
    format: [formatDe(r.width, r.height)],
  };
  for (const g of GROUPES) {
    const presents = g.valeurs.map(v => v[0]).filter(v => it.tags.includes(v));
    fv[g.cle] = presents.length ? presents : (g.sans ? [VIDE] : []);
  }
  it.fv = fv;
  it.recherche = cle([it.nom, it.personnes.join(' '), it.salle, it.gps, r.description_short || '', r.subject || '',
    r.description || '', it.commentaire, it.tags.map(t => LIBELLE_TAG[t] || t).join(' '), it.date].join(' '));
}

// ───────────────────────────── Chargement ─────────────────────────────
// La base est une NANO partagée avec ISS : jamais de rafale. Une requête à la fois,
// colonnes légères d'abord. Le bloc d'analyse IA des photos (description, clip d'origine)
// arrive ensuite, en arrière-plan, par petits paquets — l'écran n'attend pas après lui.
// Le 23/09, six requêtes en parallèle ont suffi à déclencher un « statement timeout ».
const COLS = {
  video_library: 'id,file_name,r2_url,thumbnail_url,duration_seconds,width,height,created_at,created_at_source,' +
    'tri_status,tri_rating,tri_note,tri_tags,tri_participante,tri_salle,location_name,usable_for_reel,' +
    'description_short,persons_detected,status,flagged,used_in_reels,exclu_du_tirage',
  image_library: 'id,filename,r2_url,width,height,created_at,tri_status,tri_rating,tri_note,tri_tags,' +
    'tri_participante,tri_salle,usable_com,is_private,subject,status,flagged,used_in_projects',
};
const pause = ms => new Promise(r => setTimeout(r, ms));

async function lirePage(table, cols, depuis, taille, essai = 0) {
  const { data, error } = await sb.from(table).select(cols).order('id').range(depuis, depuis + taille - 1);
  if (!error) return data;
  // trop long : on recoupe la page en deux plutôt que d'insister
  if (essai < 3 && taille > 125 && /timeout|canceling statement/i.test(error.message)) {
    await pause(400 * (essai + 1));
    const moitie = Math.ceil(taille / 2);
    const a = await lirePage(table, cols, depuis, moitie, essai + 1);
    const b = a.length < moitie ? [] : await lirePage(table, cols, depuis + moitie, taille - moitie, essai + 1);
    return a.concat(b);
  }
  throw new Error(`${table} : ${error.message}`);
}

async function chargerTable(table, progres) {
  const lignes = [];
  for (let depuis = 0; ; depuis += 1000) {        // par tranches de 1000 : au-delà, la base s'arrête SANS RIEN DIRE
    const page = await lirePage(table, COLS[table], depuis, 1000);
    lignes.push(...page);
    progres(page.length);
    if (page.length < 1000) break;
  }
  return lignes;
}

async function chargerBanque() {
  const txt = $('chargement-txt');
  let lus = 0;
  const progres = k => { lus += k; txt.textContent = `Chargement de la banque… ${lus} médias`; };
  const videos = await chargerTable('video_library', progres);
  const photos = await chargerTable('image_library', progres);
  S.items = []; S.byId.clear();
  for (const r of videos) { const it = { id: r.id, table: 'video_library', kind: 'video', raw: r }; deriver(it); S.items.push(it); S.byId.set(it.id, it); }
  for (const r of photos) { const it = { id: r.id, table: 'image_library', kind: 'photo', raw: r }; deriver(it); S.items.push(it); S.byId.set(it.id, it); }
}

// Complément IA des photos : clip d'origine (date de tournage exacte, lien vers le clip)
// et description (pour la recherche). Pas indispensable : si la base traîne, on s'arrête.
async function completerPhotos(gen) {
  const cols = 'id,video_id:gemini_raw->>video_id,description:gemini_raw->>description_short';
  let change = false;
  for (let depuis = 0; ; depuis += 400) {
    let page;
    try { page = await lirePage('image_library', cols, depuis, 400); }
    catch (e) { console.warn('complément photos interrompu', e.message); break; }
    if (gen !== S.gen) return;             // la banque a été rechargée entre-temps
    for (const r of page) {
      const it = S.byId.get(r.id); if (!it) continue;
      it.raw.video_id = r.video_id; it.raw.description = r.description;
      const parent = r.video_id && S.byId.get(r.video_id);
      if (parent) { it.parent = parent; if (parent.date && parent.date !== it.date) { it.date = parent.date; change = true; } }
      deriver(it);
    }
    if (page.length < 400) break;
    await pause(250);
  }
  // Des photos ont pu changer de date (celle du clip dont elles sont tirées). On ne
  // rebâtit la grille que si Jérôme n'a encore rien touché : sinon elle bougerait sous
  // ses doigts. Le prochain filtre ou « actualiser » les rangera à leur place.
  const tranquille = !S.sel.size && !S.pile.length && $('grille-zone').scrollTop < 40 && $('visionneuse').hidden;
  if (change && tranquille) actualiser();
  else { calculer(); rendreFacettes(); rendreCompteurs(); }
}

async function chargerVocabulaire() {
  const { data } = await sb.from('somatica_vocabulaire').select('famille,valeur,parent,ordre').eq('actif', true).order('ordre');
  const par = f => (data || []).filter(x => x.famille === f);
  S.vocab.salles = [...par('salle').map(x => x.parent ? `${x.parent} · ${x.valeur}` : x.valeur), ...par('ville').map(x => x.valeur)];
  S.vocab.univers = par('univers').map(x => ['u_' + cle(x.valeur).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), x.valeur]);
}

// ───────────────────────────── Facettes ─────────────────────────────
const FACETTES = [
  { cle: 'personne', titre: 'Participantes', libre: true, cherche: true, editable: true, sansLib: 'sans participante' },
  { cle: 'salle', titre: 'Salle', libre: true, cherche: true, editable: true, sansLib: 'sans salle' },
  { cle: 'exploitable', titre: 'Utilisable par les moteurs', fixe: [['oui', 'Oui'], ['non', 'Non']] },
  { cle: 'exclu', titre: 'Exclu du tirage (vidéos)', fixe: [['oui', 'Exclu (déjà monté, couverture…)'], ['non', 'Non']] },
  { cle: 'univers', titre: 'Univers', fixe: () => [['somatica', 'Somatica'], ...S.vocab.univers, ['chantier', 'Chantier'], ['hors', 'Hors Somatica (autre)']] },
  ...GROUPES.map(g => ({ cle: g.cle, titre: g.titre, fixe: g.valeurs, sansLib: g.sans ? 'sans ' + g.titre.toLowerCase() : null })),
  { cle: 'format', titre: 'Format', fixe: [['vertical', 'Vertical (stories, reels)'], ['horizontal', 'Horizontal'], ['carre', 'Carré'], ['banniere', 'Bannière large (événement FB)']], sansLib: 'format inconnu' },
  { cle: 'ia', titre: 'Reconnu par Photos', fixe: [['oui', 'Un nom proposé'], ['non', 'Rien de reconnu']] },
  { cle: 'usage', titre: 'Déjà utilisé en post', fixe: [['oui', 'Oui'], ['non', 'Jamais']] },
  { cle: 'note', titre: 'Note', fixe: [['8', '8 à 10'], ['5', '5 à 7'], ['1', '1 à 4']], sansLib: 'sans note' },
  { cle: 'mois', titre: 'Période', libre: true, tri: 'desc', sansLib: 'date inconnue' },
  { cle: 'gps', titre: 'Lieu GPS (vidéos)', libre: true, cherche: true, sansLib: 'sans lieu GPS' },
];

function jetons(q) { return cle(q).split(' ').filter(Boolean); }

// Un seul passage sur la banque : la vue ET tous les compteurs. Un compteur de facette
// compte les médias qui passent TOUS les autres filtres (recherche à facettes classique).
function calculer() {
  const f = S.filtres;
  const actives = FACETTES.filter(F => f.facettes[F.cle]?.size);
  const tj = jetons(f.recherche);
  const cpt = { type: { video: 0, photo: 0, couverture: 0, '': 0 }, statut: { a_trier: 0, ok: 0, refuse: 0, bug: 0, '': 0 } };
  for (const F of FACETTES) cpt[F.cle] = new Map();
  const variantes = { personne: new Map(), salle: new Map(), gps: new Map() };
  const vue = [];

  for (const it of S.items) {
    for (const k of ['personne', 'salle', 'gps']) {
      const src = k === 'personne' ? it.personnes : k === 'salle' ? (it.salle ? [it.salle] : []) : (it.gps && it.kind === 'video' ? [it.gps] : []);
      for (const v of src) {
        const c = cle(v); let m = variantes[k].get(c); if (!m) variantes[k].set(c, m = new Map());
        m.set(v, (m.get(v) || 0) + 1);
      }
    }
    if (tj.length && !tj.every(t => it.recherche.includes(t))) continue;   // la recherche ne se compte pas
    let echec = null, nb = 0;
    const ty = typeDe(it);
    if (f.type ? ty !== f.type : ty === 'couverture') { echec = 'type'; nb++; }
    if (f.statut && it.statut !== f.statut) { echec = 'statut'; nb++; }
    for (const F of actives) {
      if (nb > 1) break;
      const sel = f.facettes[F.cle];
      if (!it.fv[F.cle].some(v => sel.has(v))) { echec = F.cle; nb++; }
    }
    if (nb > 1) continue;
    const compter = d => {
      if (d === 'type') { const t = typeDe(it); cpt.type[t]++; if (t !== 'couverture') cpt.type['']++; return; }
      if (d === 'statut') { cpt.statut[it.statut]++; cpt.statut['']++; return; }
      const m = cpt[d]; for (const v of it.fv[d]) m.set(v, (m.get(v) || 0) + 1);
    };
    if (nb === 0) {
      vue.push(it);
      compter('type'); compter('statut'); for (const F of FACETTES) compter(F.cle);
    } else compter(echec);
  }
  // libellé affiché = l'orthographe la plus fréquente
  for (const k of Object.keys(variantes)) {
    const lib = new Map();
    for (const [c, m] of variantes[k]) lib.set(c, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    S.libelles[k] = lib;
  }
  S.compteurs = cpt;
  return vue;
}

function comparateur() {
  const par = {
    date_desc: (a, b) => (b.date || '').localeCompare(a.date || '') || (b.ajout || '').localeCompare(a.ajout || '') || (a.nom || '').localeCompare(b.nom || ''),
    date_asc: (a, b) => (a.date || '9').localeCompare(b.date || '9') || (a.ajout || '').localeCompare(b.ajout || '') || (a.nom || '').localeCompare(b.nom || ''),
    ajout_desc: (a, b) => (b.ajout || '').localeCompare(a.ajout || ''),
    nom: (a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr', { numeric: true }),
    duree_desc: (a, b) => (b.duree || 0) - (a.duree || 0),
    note_desc: (a, b) => (b.note || 0) - (a.note || 0) || (b.date || '').localeCompare(a.date || ''),
  };
  return par[S.trier] || par.date_desc;
}

const FMT_JOUR = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
const FMT_MOIS = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
function jourLisible(d) { if (!d) return 'date inconnue'; try { return FMT_JOUR.format(new Date(d + 'T12:00:00')); } catch (e) { return d; } }
function moisLisible(m) { if (!m || m === VIDE) return 'date inconnue'; try { const s = FMT_MOIS.format(new Date(m + '-15T12:00:00')); return s[0].toUpperCase() + s.slice(1); } catch (e) { return m; } }
function duree(s) { s = Math.round(s || 0); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} s`; }

function grouper(vue) {
  if (!S.grouper) return [];
  const par = new Map();
  for (const it of vue) {
    let k, titre;
    switch (S.grouper) {
      case 'seance': k = (it.date || '?') + '|' + (it.lieu ? cle(it.lieu) : '?');
        titre = `${jourLisible(it.date)} · ${it.lieu || 'lieu inconnu'}`; break;
      case 'jour': k = it.date || '?'; titre = jourLisible(it.date); break;
      case 'mois': k = it.date ? it.date.slice(0, 7) : '?'; titre = moisLisible(k); break;
      case 'participante': k = it.personnes.length ? it.personnes.map(cle).sort().join(' + ') : VIDE;
        titre = it.personnes.length ? it.personnes.join(' + ') : 'Sans participante'; break;
      case 'salle': k = it.salle ? cle(it.salle) : VIDE; titre = it.salle || 'Sans salle'; break;
      default: k = ''; titre = '';
    }
    let g = par.get(k); if (!g) par.set(k, g = { cle: k, titre, items: [] });
    g.items.push(it);
  }
  const groupes = [...par.values()];
  if (S.grouper === 'participante' || S.grouper === 'salle') {
    groupes.sort((a, b) => (a.cle === VIDE) - (b.cle === VIDE) || b.items.length - a.items.length);
  }
  return groupes;   // sinon : ordre d'apparition dans la vue triée
}

function metaGroupe(g) {
  const pers = new Map(), coh = new Set(); let v = 0, p = 0, sansNom = 0;
  for (const it of g.items) {
    it.kind === 'video' ? v++ : p++;
    if (!it.personnes.length && !it.tags.includes(COUVERTURE)) sansNom++;
    for (const n of it.personnes) pers.set(cle(n), n);
    for (const t of it.tags) if (t.startsWith('cohorte_')) coh.add(LIBELLE_TAG[t] || t);
  }
  const bits = [];
  if (v) bits.push(`${v} vidéo${v > 1 ? 's' : ''}`);
  if (p) bits.push(`${p} photo${p > 1 ? 's' : ''}`);
  if (S.grouper !== 'participante' && pers.size) bits.push([...pers.values()].slice(0, 4).join(', ') + (pers.size > 4 ? ` +${pers.size - 4}` : ''));
  if (sansNom && S.grouper !== 'participante') bits.push(`<span style="color:var(--orange)">${sansNom} sans nom</span>`);
  if (coh.size) bits.push([...coh].join(', '));
  return bits.join(' · ');
}

// ───────────────────────────── Rendu : vue complète ─────────────────────────────
function actualiser({ garderDefilement = false } = {}) {
  S.vue = calculer().sort(comparateur());
  S.indexVue = new Map(S.vue.map((it, i) => [it.id, i]));
  S.groupes = grouper(S.vue);
  S.sallesParJour = null;
  S.sortants.clear();
  // la sélection ne garde que ce qui est encore visible
  for (const id of [...S.sel]) if (!S.indexVue.has(id)) S.sel.delete(id);
  if (S.courant && !S.indexVue.has(S.courant)) S.courant = null;
  if (S.ancre && !S.indexVue.has(S.ancre)) S.ancre = null;
  const zone = $('grille-zone'), y = zone.scrollTop;
  rendreGrille();
  if (garderDefilement) zone.scrollTop = y; else zone.scrollTop = 0;
  rendreFacettes(); rendreCompteurs(); rendreActifs(); rendreBarreSelection(); rendreInspecteur();
  sauverPrefs();
}

// Après une écriture : on ne reconstruit PAS la grille. Les médias qui ne correspondent
// plus restent à l'écran, grisés, pour qu'on puisse continuer à éditer la même sélection
// (poser un nom PUIS une cohorte sur le même lot). « Actualiser » les fait sortir.
function apresModification(items) {
  calculer();   // recompte seulement
  const sortaient = S.sortants.size;
  for (const it of items) {
    if (correspond(it)) S.sortants.delete(it.id); else S.sortants.add(it.id);
    const c = S.cartes.get(it.id); if (c) peindreCarte(c, it);
  }
  rendreFacettes(); rendreCompteurs(); rendreBarreSelection(); rendreInspecteur();
  if (sortaient !== S.sortants.size) rendreBarreSelection();
}

function correspond(it) {
  const f = S.filtres, tj = jetons(f.recherche);
  if (tj.length && !tj.every(t => it.recherche.includes(t))) return false;
  if (f.type ? typeDe(it) !== f.type : typeDe(it) === 'couverture') return false;
  if (f.statut && it.statut !== f.statut) return false;
  for (const F of FACETTES) {
    const sel = f.facettes[F.cle];
    if (sel?.size && !it.fv[F.cle].some(v => sel.has(v))) return false;
  }
  return true;
}

function rendreGrille() {
  const grille = $('grille');
  arreterSurvol();
  grille.innerHTML = '';
  S.cartes.clear();
  S.plat = [];
  if (S.grouper) for (const g of S.groupes) { S.plat.push({ g }); for (const it of g.items) S.plat.push({ it }); }
  else { S.plat.push({ g: null }); for (const it of S.vue) S.plat.push({ it }); }
  S.rendus = 0; S.grilleCourante = null;
  $('vide').hidden = S.vue.length > 0;
  $('chargement').hidden = true;
  document.documentElement.style.setProperty('--taille', S.taille + 'px');
  rendreSuite(260);
}

function rendreSuite(n = 200) {
  const fin = Math.min(S.plat.length, S.rendus + n);
  for (let k = S.rendus; k < fin; k++) {
    const e = S.plat[k];
    if ('g' in e) {
      const sec = document.createElement('section');
      sec.className = 'groupe';
      if (e.g) {
        const sugg = suggestionsSalle(e.g).map(x =>
          `<button class="lien sugg" data-groupe-salle="${esc(e.g.cle)}" data-salle="${esc(x.l)}"
            title="Le même jour, ${x.n} média${x.n > 1 ? 's sont notés' : ' est noté'} dans cette salle. Un clic la pose sur les ${e.g.items.length} (annulable).">📍 salle : ${esc(x.l)} ?</button>`).join('');
        sec.innerHTML = `<div class="groupe-tete"><span class="titre">${esc(e.g.titre)}</span>
          <span class="meta">${metaGroupe(e.g)}</span>${sugg}
          <button class="lien" data-groupe="${esc(e.g.cle)}">sélectionner les ${e.g.items.length}</button></div>`;
      }
      const g = document.createElement('div'); g.className = 'grille-g';
      sec.appendChild(g);
      $('grille').appendChild(sec);
      S.grilleCourante = g;
    } else {
      S.grilleCourante.appendChild(creerCarte(e.it));
    }
  }
  S.rendus = fin;
}

// Séance sans lieu : les salles notées le même jour sur d'autres médias sont de bonnes
// candidates. On les propose, on ne les pose jamais tout seul.
function suggestionsSalle(g) {
  if (S.grouper !== 'seance' || !g.cle.endsWith('|?')) return [];
  const jour = g.items[0]?.date; if (!jour) return [];
  if (!S.sallesParJour) {
    S.sallesParJour = new Map();
    for (const it of S.items) {
      if (!it.salle || !it.date) continue;
      let m = S.sallesParJour.get(it.date); if (!m) S.sallesParJour.set(it.date, m = new Map());
      const k = cle(it.salle), x = m.get(k) || { l: S.libelles.salle?.get(k) || it.salle, n: 0 };
      x.n++; m.set(k, x);
    }
  }
  return [...(S.sallesParJour.get(jour)?.values() || [])].sort((a, b) => b.n - a.n).slice(0, 3);
}

function assurerRendu(id) {
  // pour la navigation clavier : rendre jusqu'au média visé s'il ne l'est pas encore
  let garde = 0;
  while (!S.cartes.has(id) && S.rendus < S.plat.length && garde++ < 100) rendreSuite(400);
  return S.cartes.get(id);
}

// ───────────────────────────── Cartes ─────────────────────────────
const fileVignettes = [];
let vignettesEnCours = 0;
// Image capturée d'un clip, gardée en cache (les plus récentes d'abord). Un <video>
// laissé dans la grille ne tient pas : Chrome met en veille les lecteurs inactifs au bout
// de quelques secondes et la vignette redevient noire. Une toile, elle, reste.
const cadres = new Map();
function cadreEnCache(id) { const c = cadres.get(id); if (c) { cadres.delete(id); cadres.set(id, c); } return c; }
function mettreEnCache(id, cv) { cadres.set(id, cv); if (cadres.size > 700) cadres.delete(cadres.keys().next().value); }

function capturerCadre(url, cote) {
  // Rend une toile carrée (recadrage « cover ») avec une image du clip, ou null.
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    let fini = false;
    const finir = cv => { if (fini) return; fini = true; v.removeAttribute('src'); v.load(); resolve(cv); };
    v.addEventListener('loadedmetadata', () => { try { v.currentTime = Math.min(0.8, (v.duration || 2) / 2); } catch (e) { finir(null); } }, { once: true });
    v.addEventListener('seeked', () => {
      try {
        const vw = v.videoWidth, vh = v.videoHeight;
        if (!vw || !vh) return finir(null);
        const cv = document.createElement('canvas'); cv.width = cote; cv.height = cote;
        const m = Math.min(vw, vh);
        cv.getContext('2d').drawImage(v, (vw - m) / 2, (vh - m) / 2, m, m, 0, 0, cote, cote);
        finir(cv);
      } catch (e) { finir(null); }
    }, { once: true });
    v.addEventListener('error', () => finir(null), { once: true });
    setTimeout(() => finir(null), 12000);   // un fichier qui ne répond pas ne bloque pas la file
    v.src = url;
  });
}

function chargerVignetteVideo(vig) {
  // Pas plus de 6 captures à la fois, sinon le défilement s'étouffe.
  if (vignettesEnCours >= 6) { fileVignettes.push(vig); return; }
  vignettesEnCours++;
  const id = vig.parentElement?.dataset.id;
  capturerCadre(vig.dataset.video, Math.round(Math.min(280, Math.max(160, S.taille * 1.6)))).then(cv => {
    if (cv) { vig.appendChild(cv); if (id) mettreEnCache(id, cv); }
    else vig.classList.add('sans-image');
    vignettesEnCours--;
    const suivant = fileVignettes.shift();
    if (suivant) chargerVignetteVideo(suivant);
  });
}
const observerVignettes = new IntersectionObserver(entrees => {
  for (const e of entrees) {
    if (!e.isIntersecting) continue;
    observerVignettes.unobserve(e.target);
    const vig = e.target.querySelector('.vig');
    if (vig?.dataset.video && !vig.firstChild) chargerVignetteVideo(vig);
  }
}, { root: null, rootMargin: '300px' });

function creerCarte(it) {
  const c = document.createElement('div');
  c.className = 'carte';
  c.dataset.id = it.id;
  c.innerHTML = '<div class="vig"></div><div class="coche" title="Ajouter / retirer de la sélection"></div><div class="haut-d"></div><div class="bas"></div>';
  const vig = c.firstChild;
  if (it.thumb) {
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = ''; img.src = it.thumb;
    vig.appendChild(img);
  } else if (it.kind === 'video' && it.url) {
    const cv = cadreEnCache(it.id);
    if (cv) vig.appendChild(cv);            // déjà capturée : la toile change simplement de carte
    else { vig.dataset.video = it.url; observerVignettes.observe(c); }
  }
  peindreCarte(c, it);
  S.cartes.set(it.id, c);
  return c;
}

function peindreCarte(c, it) {
  c.classList.toggle('sel', S.sel.has(it.id));
  c.classList.toggle('courant', S.courant === it.id);
  c.classList.remove('st-ok', 'st-refuse', 'st-bug');
  if (it.statut !== 'a_trier') c.classList.add('st-' + it.statut);
  c.style.opacity = S.sortants.has(it.id) ? '.35' : '';
  c.classList.toggle('petite', S.taille < 120);
  const hd = [];
  if (it.kind === 'video') hd.push(`<span class="pastille">▶ ${duree(it.duree)}</span>`);
  if (it.note) hd.push(`<span class="pastille note">${it.note}</span>`);
  if (it.usage) hd.push(`<span class="pastille usage" title="Déjà utilisé ${it.usage} fois en post">↻${it.usage}</span>`);
  c.children[2].innerHTML = hd.join('');
  const bas = [];
  if (it.tags.includes(COUVERTURE)) bas.push('<span class="etq fb">Couverture FB</span>');
  if (it.personnes.length) for (const p of it.personnes.slice(0, 3)) bas.push(`<span class="etq">${esc(p)}</span>`);
  else if (!it.tags.includes(COUVERTURE)) bas.push('<span class="etq manque">sans nom</span>');
  if (it.salle) bas.push(`<span class="etq salle">${esc(courte(it.salle))}</span>`);
  if (it.univers !== 'somatica') bas.push(`<span class="etq hors">${esc(libelleUnivers(it.univers))}</span>`);
  c.children[3].innerHTML = bas.join('');
  c.title = `${it.nom}\n${jourLisible(it.date)}${it.lieu ? ' · ' + it.lieu : ''}\n${STATUTS[it.statut]}${it.exploitable ? ' · utilisable par les moteurs' : ''}`;
}
function courte(salle) { const p = salle.split('·'); return (p[p.length - 1] || salle).trim(); }
function libelleUnivers(u) {
  if (u === 'somatica') return 'Somatica';
  const v = S.vocab.univers.find(x => x[0] === u);
  return v ? v[1] : u === 'chantier' ? 'Chantier' : 'Hors Somatica';
}

// ───────────────────────────── Aperçu au survol ─────────────────────────────
// Une seule vidéo décodée à la fois, avec le son si demandé : c'est le comportement
// que Jérôme connaît. Le bas de la vignette sert de réglette pour avancer.
const survol = { minuterie: null, video: null, carte: null };
function arreterSurvol() {
  clearTimeout(survol.minuterie);
  if (survol.video) {
    survol.video.pause(); survol.video.removeAttribute('src'); survol.video.load();
    survol.carte?.querySelector('.survol-video')?.remove();
    survol.carte?.querySelector('.progres')?.remove();
    survol.carte?.querySelector('.bande-scrub')?.remove();
  }
  survol.video = null; survol.carte = null;
}
function demarrerSurvol(c, it) {
  arreterSurvol();
  const v = document.createElement('video');
  v.className = 'survol-video'; v.playsInline = true; v.loop = true; v.preload = 'auto';
  v.muted = !S.son; v.src = it.url;
  const barre = document.createElement('div'); barre.className = 'progres';
  const bande = document.createElement('div'); bande.className = 'bande-scrub';
  bande.addEventListener('mousemove', e => {
    if (!v.duration) return;
    const r = bande.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.duration;
  });
  bande.addEventListener('click', e => e.stopPropagation());
  v.addEventListener('timeupdate', () => { if (v.duration) barre.style.width = (100 * v.currentTime / v.duration) + '%'; });
  c.querySelector('.vig').appendChild(v);
  c.appendChild(barre); c.appendChild(bande);
  survol.video = v; survol.carte = c;
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
}

// ───────────────────────────── Sélection ─────────────────────────────
function selection() { return [...S.sel].map(id => S.byId.get(id)).filter(Boolean); }

function peindreSelection() {
  for (const [id, c] of S.cartes) {
    c.classList.toggle('sel', S.sel.has(id));
    c.classList.toggle('courant', S.courant === id);
  }
  rendreBarreSelection();
  rendreInspecteur();
}

function selectionnerPlage(deId, aId, ajouter) {
  const a = S.indexVue.get(deId), b = S.indexVue.get(aId);
  if (a == null || b == null) return;
  if (!ajouter) S.sel.clear();
  for (let k = Math.min(a, b); k <= Math.max(a, b); k++) S.sel.add(S.vue[k].id);
}

function clicCarte(e, id) {
  const multi = e.metaKey || e.ctrlKey || e.target.closest('.coche');
  if (e.shiftKey && S.ancre) {
    selectionnerPlage(S.ancre, id, multi);
  } else if (multi) {
    S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id);
    S.ancre = id;
  } else {
    S.sel.clear(); S.sel.add(id); S.ancre = id;
  }
  S.courant = id;
  peindreSelection();
}

function allerA(id, etendre) {
  if (!id) return;
  const c = assurerRendu(id);
  if (etendre && S.ancre) selectionnerPlage(S.ancre, id, false);
  else { S.sel.clear(); S.sel.add(id); S.ancre = id; }
  S.courant = id;
  peindreSelection();
  c?.scrollIntoView({ block: 'nearest' });
}

function deplacer(dir, etendre) {
  if (!S.vue.length) return;
  const cur = S.courant ?? S.vue[0].id;
  if (!S.courant) return allerA(cur, false);
  const i = S.indexVue.get(cur);
  if (dir === 'g' || dir === 'd') {
    const j = Math.max(0, Math.min(S.vue.length - 1, i + (dir === 'd' ? 1 : -1)));
    return allerA(S.vue[j].id, etendre);
  }
  // haut / bas : au plus près, géométriquement — marche aussi par-dessus les en-têtes de groupe
  let c = S.cartes.get(cur); if (!c) return;
  const r = c.getBoundingClientRect(), cx = r.left + r.width / 2;
  const chercher = () => {
    let best = null, bd = Infinity;
    for (const [id, el] of S.cartes) {
      const q = el.getBoundingClientRect();
      const ok = dir === 'b' ? q.top > r.top + r.height / 2 : q.bottom < r.bottom - r.height / 2;
      if (!ok) continue;
      const d = Math.abs(q.top - r.top) * 10000 + Math.abs(q.left + q.width / 2 - cx);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };
  let cible = chercher();
  if (!cible && dir === 'b' && S.rendus < S.plat.length) { rendreSuite(300); cible = chercher(); }
  if (cible) allerA(cible, etendre);
}

function avancerApresStatut() {
  // Tri rapide : après V ou X sur UN média, on passe au suivant
  if (S.sel.size !== 1 || !S.courant) return;
  const i = S.indexVue.get(S.courant);
  const suivant = S.vue[i + 1];
  if (suivant) allerA(suivant.id, false);
}

// ───────────────────────────── Écritures ─────────────────────────────
async function parallele(taches, n) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, taches.length) }, async () => { while (i < taches.length) await taches[i++](); }));
}

// Renvoie les ids qui n'ont PAS pu être écrits (base saturée, session expirée…).
async function ecrireGroupes(groupes) {
  const echecs = new Set();
  const taches = [];
  for (const g of groupes.values()) {
    for (let i = 0; i < g.ids.length; i += 150) {
      const ids = g.ids.slice(i, i + 150);
      taches.push(async () => {
        let { error } = await sb.from(g.table).update(g.patch).in('id', ids);
        if (error && /timeout|canceling statement|fetch/i.test(error.message)) {   // une seconde chance
          await pause(800);
          ({ error } = await sb.from(g.table).update(g.patch).in('id', ids));
        }
        if (error) { console.error('écriture', g.table, error); ids.forEach(id => echecs.add(id)); }
      });
    }
  }
  await parallele(taches, 2);   // base partagée : jamais de rafale
  await refermerExclues(groupes);
  return echecs;
}

// Ce qui n'a pas été écrit reprend à l'écran sa valeur d'avant : l'écran ne ment pas.
function remettre(retour, echecs) {
  const ko = retour.filter(r => echecs.has(r.it.id));
  for (const { it, avant } of ko) { Object.assign(it.raw, avant); refleterDeclencheurs(it); deriver(it); }
  if (ko.length) apresModification(ko.map(r => r.it));
  return retour.filter(r => !echecs.has(r.it.id));
}

// Le déclencheur vid_tri_sync recalcule usable_for_reel côté base : on fait pareil ici
// pour que l'écran dise la même chose que la base sans avoir à relire.
function refleterDeclencheurs(it) {
  if (it.kind !== 'video') return;
  const t = it.raw.tri_tags || [];
  it.raw.usable_for_reel = !(it.raw.tri_status === 'refuse' || it.raw.tri_status === 'bug' || t.includes('nathalie_sol')
    || it.raw.exclu_du_tirage);   // voir refermerExclues()
}

// Une vidéo « exclue du tirage » (couverture, déjà montée…) ne doit jamais redevenir
// piochable. Or le déclencheur vid_tri_sync de la base remet usable_for_reel à true
// dès qu'on change tri_status ou tri_tags, sans regarder exclu_du_tirage (vu le 24/09 :
// 46 couvertures rouvertes). On referme donc aussitôt. Sans effet une fois la règle
// corrigée en base — on peut alors retirer cette fonction.
async function refermerExclues(groupes) {
  const ids = [];
  for (const g of groupes.values()) {
    if (g.table !== 'video_library' || !('tri_status' in g.patch || 'tri_tags' in g.patch)) continue;
    for (const id of g.ids) if (S.byId.get(id)?.raw.exclu_du_tirage) ids.push(id);
  }
  for (let i = 0; i < ids.length; i += 150) {
    const { error } = await sb.from('video_library').update({ usable_for_reel: false })
      .in('id', ids.slice(i, i + 150)).eq('exclu_du_tirage', true);
    if (error) console.error('refermer les exclues', error);
  }
}

async function modifier(items, calcul, libelle) {
  const groupes = new Map(), retour = [];
  for (const it of items) {
    const patch = calcul(it);
    if (!patch) continue;
    const avant = {}; let change = false;
    for (const k of Object.keys(patch)) {
      avant[k] = it.raw[k] ?? null;
      if (JSON.stringify(avant[k]) !== JSON.stringify(patch[k] ?? null)) change = true;
    }
    if (!change) continue;
    retour.push({ it, avant, apres: patch });
    const k = it.table + '\u0000' + JSON.stringify(patch);
    let g = groupes.get(k); if (!g) groupes.set(k, g = { table: it.table, patch, ids: [] });
    g.ids.push(it.id);
    Object.assign(it.raw, patch);
    refleterDeclencheurs(it);
    deriver(it);
  }
  if (!retour.length) { toast('Rien à changer : c’était déjà comme ça'); return 0; }
  apresModification(retour.map(r => r.it));
  const echecs = await ecrireGroupes(groupes);
  const reussis = remettre(retour, echecs);
  if (reussis.length) {
    S.pile.push({ libelle, retour: reussis });
    if (S.pile.length > 30) S.pile.shift();
  }
  if (echecs.size) {
    toast(`${echecs.size} média${echecs.size > 1 ? 's' : ''} NON enregistré${echecs.size > 1 ? 's' : ''} (base occupée) — réessaie dans un instant` +
      (reussis.length ? ` · ${reussis.length} enregistré${reussis.length > 1 ? 's' : ''}` : ''), 'erreur', reussis.length > 0);
  } else {
    toast(`${libelle} — ${reussis.length} média${reussis.length > 1 ? 's' : ''}`, 'ok', true);
  }
  return reussis.length;
}

async function annuler() {
  const a = S.pile.pop();
  if (!a) { toast('Rien à annuler'); return; }
  const groupes = new Map();
  for (const { it, avant } of a.retour) {
    Object.assign(it.raw, avant);
    refleterDeclencheurs(it);
    deriver(it);
    const k = it.table + '\u0000' + JSON.stringify(avant);
    let g = groupes.get(k); if (!g) groupes.set(k, g = { table: it.table, patch: avant, ids: [] });
    g.ids.push(it.id);
  }
  apresModification(a.retour.map(r => r.it));
  const echecs = await ecrireGroupes(groupes);
  if (echecs.size) {
    // ceux-là gardent en base la valeur modifiée : l'écran aussi, et ⌘Z pourra réessayer
    const restes = a.retour.filter(r => echecs.has(r.it.id));
    for (const { it, apres } of restes) { Object.assign(it.raw, apres); refleterDeclencheurs(it); deriver(it); }
    apresModification(restes.map(r => r.it));
    S.pile.push({ libelle: a.libelle, retour: restes });
    toast(`Annulation incomplète : ${echecs.size} média(s) non remis — refais ⌘Z dans un instant`, 'erreur');
  } else toast(`Annulé : ${a.libelle}`, 'ok');
}

// ── statut ──
function patchStatut(it, statut, maintenant) {
  const p = { tri_status: statut };
  if (statut === 'refuse') {
    // comme le « Rejeter » de l'ancienne vue — sauf sur les photos, dont `status` porte
    // l'état d'analyse (« analyzed ») : l'écraser perdrait cette information.
    if (it.kind === 'video') { p.status = 'rejected'; p.updated_at = maintenant; }
  } else if (it.kind === 'video' && it.raw.status === 'rejected') {
    p.status = 'available'; p.updated_at = maintenant;
  }
  return p;
}
async function changerStatut(statut) {
  const items = selection();
  if (!items.length) return;
  const maintenant = new Date().toISOString();
  const lib = { ok: 'Validé', refuse: 'Rejeté', a_trier: 'Remis à trier', bug: 'Marqué bug' }[statut];
  const seul = items.length === 1;
  await modifier(items, it => patchStatut(it, statut, maintenant), lib);
  if (seul) avancerApresStatut();
}

// ── étiquettes ──
function etatTag(items, tag) {
  let n = 0; for (const it of items) if (it.tags.includes(tag)) n++;
  return n === 0 ? 'off' : n === items.length ? 'on' : 'mixte';
}
async function basculerTag(groupe, tag) {
  const items = selection(); if (!items.length) return;
  const etat = etatTag(items, tag);
  const retirer = etat === 'on';
  const autres = groupe.exclusif ? groupe.valeurs.map(v => v[0]).filter(v => v !== tag) : [];
  await modifier(items, it => {
    let t = it.tags.filter(x => !autres.includes(x));
    if (retirer) t = t.filter(x => x !== tag); else if (!t.includes(tag)) t = [...t, tag];
    return { tri_tags: t };
  }, `${LIBELLE_TAG[tag]} ${retirer ? 'retiré' : 'posé'}`);
}
async function viderGroupe(groupe) {
  const items = selection(); if (!items.length) return;
  const vals = groupe.valeurs.map(v => v[0]);
  await modifier(items, it => ({ tri_tags: it.tags.filter(x => !vals.includes(x)) }), `${groupe.titre} retiré`);
}
async function poserUnivers(u) {
  const items = selection(); if (!items.length) return;
  await modifier(items, it => {
    let t = it.tags.filter(x => x !== 'hors_somatica' && x !== 'chantier' && !x.startsWith('u_'));
    if (u !== 'somatica') t = [...t, 'hors_somatica', ...(u.startsWith('u_') ? [u] : [])];
    return { tri_tags: t };
  }, `Univers : ${libelleUnivers(u)}`);
}

// ── personnes ──
async function ajouterPersonne(nom) {
  nom = (nom || '').trim(); if (!nom) return;
  const items = selection(); if (!items.length) return;
  // si ce nom existe déjà sous une autre graphie, on reprend la graphie la plus fréquente
  const officiel = S.libelles.personne?.get(cle(nom)) || nom;
  await modifier(items, it => {
    if (it.personnes.some(p => cle(p) === cle(officiel))) return null;
    return { tri_participante: joinPersonnes([...it.personnes, officiel]) };
  }, `« ${officiel} » ajoutée`);
}
async function retirerPersonne(cleNom, libelle) {
  const items = selection(); if (!items.length) return;
  await modifier(items, it => {
    if (!it.personnes.some(p => cle(p) === cleNom)) return null;
    return { tri_participante: joinPersonnes(it.personnes.filter(p => cle(p) !== cleNom)) };
  }, `« ${libelle} » retirée`);
}

// ── salle, note, commentaire ──
async function poserSalle(v) {
  const items = selection(); if (!items.length) return;
  v = (v || '').trim();
  const officiel = v ? (S.libelles.salle?.get(cle(v)) || v) : null;
  await modifier(items, () => ({ tri_salle: officiel }), officiel ? `Salle : ${officiel}` : 'Salle retirée');
}
async function poserNote(n) {
  const items = selection(); if (!items.length) return;
  await modifier(items, () => ({ tri_rating: n || null }), n ? `Note ${n}/10` : 'Note retirée');
}
async function poserCommentaire(txt) {
  const items = selection(); if (!items.length) return;
  txt = (txt || '').trim();
  await modifier(items, () => ({ tri_note: txt || null }), txt ? 'Commentaire enregistré' : 'Commentaire effacé');
}

// ───────────────────────────── Filtres : rendu ─────────────────────────────
function valeursFacette(F) {
  const cpt = S.compteurs[F.cle];
  const sel = S.filtres.facettes[F.cle] || new Set();
  let liste;
  if (F.fixe) {
    const fixe = typeof F.fixe === 'function' ? F.fixe() : F.fixe;
    liste = fixe.map(([v, l]) => ({ v, l, n: cpt.get(v) || 0 }))
      .filter(x => x.n || sel.has(x.v) || !['univers'].includes(F.cle) || x.v === 'somatica');
  } else {
    const lib = S.libelles[F.cle] || new Map();
    liste = [...cpt.entries()].filter(([v]) => v !== VIDE).map(([v, n]) => ({
      v, n, l: F.cle === 'mois' ? moisLisible(v) : (lib.get(v) || v),
    }));
    for (const v of sel) if (v !== VIDE && !cpt.has(v)) liste.push({ v, n: 0, l: F.cle === 'mois' ? moisLisible(v) : (lib.get(v) || v) });
    if (F.tri === 'desc') liste.sort((a, b) => b.v.localeCompare(a.v));
    else liste.sort((a, b) => b.n - a.n || a.l.localeCompare(b.l, 'fr'));
  }
  if (F.sansLib) liste.unshift({ v: VIDE, l: '— ' + F.sansLib + ' —', n: cpt.get(VIDE) || 0, manque: true });
  return liste;
}

function rendreFacettes() {
  const boite = $('facettes');
  const recherches = {};
  boite.querySelectorAll('.facette-cherche').forEach(i => { recherches[i.dataset.f] = i.value; });
  const focus = document.activeElement?.classList.contains('facette-cherche') ? document.activeElement.dataset.f : null;
  const html = [];
  for (const F of FACETTES) {
    const sel = S.filtres.facettes[F.cle] || new Set();
    const ouverte = S.ouvertes.has(F.cle) || sel.size > 0;
    const vals = valeursFacette(F);
    if (!vals.some(x => x.n) && !sel.size && F.cle === 'gps' && S.filtres.type === 'photo') continue;
    const q = cle(recherches[F.cle] || '');
    const lignes = vals.filter(x => !q || cle(x.l).includes(q)).map(x => `
      <div class="valeur${sel.has(x.v) ? ' on' : ''}${x.manque ? ' manque' : ''}${!x.n && !sel.has(x.v) ? ' zero' : ''}" data-f="${F.cle}" data-v="${esc(x.v)}">
        <span class="case"></span><span class="libelle">${esc(x.l)}</span>
        ${F.editable && x.v !== VIDE ? `<button class="editer" data-f="${F.cle}" data-v="${esc(x.v)}" data-l="${esc(x.l)}" data-n="${x.n}" title="Renommer / fusionner">✎</button>` : ''}
        <span class="nb">${x.n}</span></div>`).join('');
    html.push(`<div class="facette${ouverte ? ' ouverte' : ''}" data-f="${F.cle}">
      <button class="facette-tete" data-ouvrir="${F.cle}"><span class="fleche">▸</span>${esc(F.titre)}${sel.size ? `<span class="nb-actifs">${sel.size}</span>` : ''}</button>
      <div class="facette-corps">
        ${F.cherche ? `<input class="facette-cherche" data-f="${F.cle}" placeholder="chercher…" value="${esc(recherches[F.cle] || '')}">` : ''}
        <div class="facette-liste">${lignes || '<div class="aide" style="padding:4px 8px">rien</div>'}</div>
      </div></div>`);
  }
  boite.innerHTML = html.join('');
  if (focus) { const i = boite.querySelector(`.facette-cherche[data-f="${focus}"]`); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  $('effacer-filtres').hidden = !Object.values(S.filtres.facettes).some(s => s.size) && !S.filtres.recherche;
}

function rendreCompteurs() {
  const c = S.compteurs;
  document.querySelectorAll('#seg-type button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === S.filtres.type);
    b.querySelector('i').textContent = c.type[b.dataset.v] ?? '';
  });
  document.querySelectorAll('#onglets-statut > button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === S.filtres.statut);
    b.querySelector('i').textContent = c.statut[b.dataset.v] ?? '';
    if (b.dataset.v === 'bug') b.hidden = !c.statut.bug && S.filtres.statut !== 'bug';
  });
}

function rendreActifs() {
  const puces = [];
  if (S.filtres.recherche) puces.push(`<span class="puce-active"><b>Recherche</b> « ${esc(S.filtres.recherche)} »<button data-retirer="recherche">×</button></span>`);
  for (const F of FACETTES) {
    const sel = S.filtres.facettes[F.cle]; if (!sel?.size) continue;
    const vals = valeursFacette(F);
    for (const v of sel) {
      const x = vals.find(y => y.v === v);
      puces.push(`<span class="puce-active"><b>${esc(F.titre)}</b> ${esc(x ? x.l : v)}<button data-retirer="${F.cle}" data-v="${esc(v)}">×</button></span>`);
    }
  }
  $('actifs').innerHTML = puces.join('');
}

function rendreBarreSelection() {
  const n = S.sel.size, total = S.vue.length;
  const sortants = S.sortants.size;
  $('compte-vue').innerHTML = `<b>${total}</b> média${total > 1 ? 's' : ''}` +
    (n ? ` · <b>${n}</b> sélectionné${n > 1 ? 's' : ''}` : '') +
    (sortants ? ` · <span style="color:var(--orange)">${sortants} ne correspond${sortants > 1 ? 'ent' : ''} plus aux filtres</span> <button class="lien" id="actualiser">actualiser</button>` : '');
  $('deselectionner').hidden = !n;
  $('tout-selectionner').textContent = total ? `tout sélectionner (${total})` : 'tout sélectionner';
}

// ───────────────────────────── Inspecteur ─────────────────────────────
function listeNoms() {
  const lib = S.libelles.personne || new Map(), cpt = new Map();
  for (const it of S.items) for (const p of it.personnes) { const k = cle(p); cpt.set(k, (cpt.get(k) || 0) + 1); }
  return [...cpt.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => lib.get(k) || k);
}
function listeSalles() {
  const lib = S.libelles.salle || new Map(), vus = new Set(), out = [];
  const cpt = new Map(); for (const it of S.items) if (it.salle) { const k = cle(it.salle); cpt.set(k, (cpt.get(k) || 0) + 1); }
  for (const [k] of [...cpt.entries()].sort((a, b) => b[1] - a[1])) { vus.add(k); out.push(lib.get(k) || k); }
  for (const s of S.vocab.salles) if (!vus.has(cle(s))) { vus.add(cle(s)); out.push(s); }
  return out;
}

function rendreInspecteur() {
  const items = selection();
  $('insp-vide').hidden = items.length > 0;
  const boite = $('insp');
  boite.hidden = items.length === 0;
  if (!items.length) { boite.innerHTML = ''; return; }
  const garderFocus = document.activeElement?.id;
  const n = items.length, un = n === 1 ? items[0] : null;

  // ── aperçu ──
  let apercu;
  if (un) {
    apercu = un.kind === 'video'
      ? `<div class="insp-apercu"><video src="${esc(un.url)}" controls playsinline preload="metadata"${un.thumb ? ` poster="${esc(un.thumb)}"` : ''}></video></div>`
      : `<div class="insp-apercu"><img src="${esc(un.url)}" alt=""></div>`;
  } else {
    const vig = items.slice(0, 17).map(it => it.thumb ? `<div><img src="${esc(it.thumb)}" loading="lazy" alt=""></div>`
      : `<div data-cadre="${esc(it.id)}"></div>`);
    if (n > 17) vig.push(`<div class="plus">+${n - 17}</div>`);
    apercu = `<div class="insp-mosaique">${vig.join('')}</div>`;
  }

  // ── infos ──
  let meta = '';
  if (un) {
    const bits = [`<b>${esc(un.nom)}</b>`, `${jourLisible(un.date)}${un.kind === 'video' ? ' · ' + duree(un.duree) : ''}${un.raw.width ? ` · ${un.raw.width}×${un.raw.height}` : ''}`];
    if (un.gps && un.gps !== un.salle) bits.push(`GPS : ${esc(un.gps)}`);
    if (un.parent) bits.push(`Image tirée du clip ${esc(un.parent.nom)}`);
    bits.push(un.exploitable ? '<span style="color:var(--vert)">● utilisable par les moteurs</span>' : '<span style="color:var(--texte-3)">○ pas utilisé par les moteurs</span>');
    if (un.raw.exclu_du_tirage) bits.push(un.exploitable
      ? '<span style="color:var(--orange)">⚠ marqué « exclu du tirage », mais les moteurs peuvent encore le prendre</span>'
      : '<span style="color:var(--texte-3)">⛔ exclu du tirage (déjà monté, couverture…)</span>');
    const desc = un.raw.description_short || un.raw.description || un.raw.subject;
    if (desc) bits.push(`<span class="desc">${esc(desc)}</span>`);
    meta = `<div class="insp-meta">${bits.join('<br>')}</div>`;
  } else {
    const v = items.filter(i => i.kind === 'video').length;
    meta = `<div class="insp-meta">${v} vidéo${v > 1 ? 's' : ''}, ${n - v} photo${n - v > 1 ? 's' : ''} — tout ce que tu règles ci-dessous s'applique aux ${n}.</div>`;
  }

  // ── statut ──
  const statuts = new Set(items.map(i => i.statut));
  const st = statuts.size === 1 ? [...statuts][0] : null;
  const blocStatut = `<div class="insp-statut">
    <button class="btn valider${st === 'ok' ? ' on' : ''}" data-statut="ok">✓ Valider</button>
    <button class="btn rejeter${st === 'refuse' ? ' on' : ''}" data-statut="refuse">✕ Rejeter</button>
    <button class="btn${st === 'a_trier' ? ' on' : ''}" data-statut="a_trier">↺ À trier</button></div>`;

  // ── personnes ──
  const pers = new Map();
  for (const it of items) for (const p of it.personnes) { const k = cle(p); const e = pers.get(k) || { l: p, n: 0 }; e.n++; pers.set(k, e); }
  const chips = [...pers.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, e]) =>
    `<span class="personne${e.n < n ? ' partielle' : ''}">${esc(e.l)}${e.n < n ? ` <small>${e.n}/${n}</small>` : ''}<button data-retirer-personne="${esc(k)}" data-l="${esc(e.l)}" title="Retirer">×</button></span>`).join('');
  const suggest = new Map();
  for (const it of items) for (const d of it.detectees) if (!it.personnes.some(p => cle(p) === cle(d))) suggest.set(cle(d), d);
  const blocSuggest = suggest.size ? `<div class="suggestions">Photos a reconnu : ${[...suggest.values()].slice(0, 5)
    .map(d => `<button class="suggestion" data-ajouter-personne="${esc(d)}">+ ${esc(d)}</button>`).join('')}</div>` : '';
  const blocPersonnes = `<div class="champ"><div class="champ-titre">Participantes${n > 1 && pers.size ? ' <span class="mixte">(le nombre = combien en ont)</span>' : ''}</div>
    <div class="personnes">${chips || '<span class="aide" style="margin:0">personne pour l’instant</span>'}</div>
    ${blocSuggest}
    <div class="ligne-saisie"><input class="saisie" id="insp-personne" list="dl-personnes" placeholder="Ajouter une personne… (P)" autocomplete="off">
    <button class="btn" id="insp-personne-ok">Ajouter</button></div></div>`;

  // ── salle ──
  const salles = new Set(items.map(i => i.salle));
  const salleUnique = salles.size === 1 ? [...salles][0] : null;
  const blocSalle = `<div class="champ"><div class="champ-titre">Salle${salles.size > 1 ? ` <span class="mixte">${salles.size} différentes</span>` : ''}</div>
    <div class="ligne-saisie"><input class="saisie" id="insp-salle" list="dl-salles" placeholder="${salles.size > 1 ? 'remplacer pour toutes…' : 'Ville · salle (S)'}" value="${esc(salleUnique || '')}" autocomplete="off">
    ${salleUnique ? '<button class="btn icone" id="insp-salle-effacer" title="Retirer la salle">×</button>' : ''}</div></div>`;

  // ── univers ──
  const univs = new Map(); for (const it of items) univs.set(it.univers, (univs.get(it.univers) || 0) + 1);
  const choixU = [['somatica', 'Somatica'], ...S.vocab.univers];
  const blocUnivers = `<div class="champ"><div class="champ-titre">Univers${univs.size > 1 ? ' <span class="mixte">mixte</span>' : ''}</div><div class="puces">${
    choixU.map(([u, l]) => { const k = univs.get(u) || 0; return `<button class="puce${u !== 'somatica' ? ' hors' : ''}${k === n ? ' on' : k ? ' mixte' : ''}" data-univers="${esc(u)}">${esc(l)}</button>`; }).join('')}</div></div>`;

  // ── groupes d'étiquettes ──
  const blocsTags = GROUPES.map(g => {
    const etats = g.valeurs.map(([v, l]) => [v, l, etatTag(items, v)]);
    const mixte = etats.some(e => e[2] === 'mixte');
    const aucun = etats.every(e => e[2] === 'off');
    return `<div class="champ"><div class="champ-titre">${esc(g.titre)}${mixte ? ' <span class="mixte">mixte</span>' : ''}</div><div class="puces">
      ${etats.map(([v, l, e]) => `<button class="puce${e === 'on' ? ' on' : e === 'mixte' ? ' mixte' : ''}" data-groupe="${g.cle}" data-tag="${v}">${esc(l)}</button>`).join('')}
      ${g.exclusif && !aucun ? `<button class="puce" data-vider="${g.cle}" title="Retirer ${esc(g.titre.toLowerCase())}">aucun</button>` : ''}</div></div>`;
  }).join('');

  // ── note & commentaire ──
  const notes = new Set(items.map(i => i.note));
  const noteU = notes.size === 1 ? [...notes][0] : null;
  const blocNote = `<div class="champ"><div class="champ-titre">Note${notes.size > 1 ? ' <span class="mixte">mixte</span>' : ''}</div><div class="notes">
    ${Array.from({ length: 10 }, (_, i) => `<button class="${noteU && i < noteU ? 'on' : ''}" data-note="${i + 1}">${i + 1}</button>`).join('')}
    <button data-note="0" title="Retirer la note">×</button></div></div>`;
  const coms = new Set(items.map(i => i.commentaire));
  const comU = coms.size === 1 ? [...coms][0] : '';
  const blocCom = `<div class="champ"><div class="champ-titre">Commentaire${coms.size > 1 ? ' <span class="mixte">différents — écrire remplace pour tous</span>' : ''}</div>
    <textarea class="saisie" id="insp-commentaire" placeholder="note pour toi…">${esc(comU)}</textarea></div>`;

  boite.innerHTML = `
    <div class="insp-tete"><b>${n === 1 ? '1 média' : n + ' médias'}</b><button class="lien mobile-seul" id="insp-reduire">${document.body.classList.contains('insp-reduit') ? '▴ tout voir' : '▾ réduire'}</button><button class="lien" id="insp-desel">désélectionner</button></div>
    ${apercu}${meta}${blocStatut}<hr class="sep">
    ${blocPersonnes}${blocSalle}${blocUnivers}<hr class="sep">
    ${blocsTags}<hr class="sep">${blocNote}${blocCom}
    <datalist id="dl-personnes">${listeNoms().map(x => `<option value="${esc(x)}">`).join('')}</datalist>
    <datalist id="dl-salles">${listeSalles().map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
  // mosaïque : on recopie les images déjà capturées ; sinon on capture (et on garde)
  boite.querySelectorAll('[data-cadre]').forEach(async d => {
    const id = d.dataset.cadre, it = S.byId.get(id); if (!it) return;
    let src = cadreEnCache(id);
    if (!src) { src = await capturerCadre(it.url, 200); if (src) mettreEnCache(id, src); }
    if (!src || !d.isConnected) return;
    const cv = document.createElement('canvas'); cv.width = 80; cv.height = 80;
    cv.getContext('2d').drawImage(src, 0, 0, 80, 80);
    d.appendChild(cv);
  });
  if (garderFocus === 'insp-personne' || garderFocus === 'insp-salle') $(garderFocus)?.focus();
}

// ───────────────────────────── Visionneuse ─────────────────────────────
function ouvrirVisionneuse() {
  const id = S.courant || [...S.sel][0] || S.vue[0]?.id;
  if (!id) return;
  if (!S.sel.has(id)) { S.sel.clear(); S.sel.add(id); S.courant = id; peindreSelection(); }
  arreterSurvol();
  $('visionneuse').hidden = false;
  peindreVisionneuse();
}
function fermerVisionneuse() {
  $('visionneuse').hidden = true;
  $('vis-media').innerHTML = '';
}
function peindreVisionneuse() {
  const it = S.byId.get(S.courant); if (!it) return;
  $('vis-media').innerHTML = it.kind === 'video'
    ? `<video src="${esc(it.url)}" controls autoplay playsinline${S.son ? '' : ' muted'}></video>`
    : `<img src="${esc(it.url)}" alt="">`;
  const i = S.indexVue.get(it.id) ?? 0;
  $('vis-info').innerHTML = `<b>${esc(it.nom)}</b> · ${i + 1}/${S.vue.length}<br>${jourLisible(it.date)}${it.lieu ? ' · ' + esc(it.lieu) : ''}
    · ${it.personnes.length ? esc(it.personnes.join(', ')) : '<span style="color:var(--orange)">sans nom</span>'}
    · <b style="color:${it.statut === 'ok' ? 'var(--vert)' : it.statut === 'refuse' ? 'var(--rouge)' : 'var(--texte-2)'}">${STATUTS[it.statut]}</b>`;
  document.querySelectorAll('#visionneuse [data-statut]').forEach(b => b.classList.toggle('on', b.dataset.statut === it.statut));
}
function visionneuseAller(pas) {
  const i = S.indexVue.get(S.courant); if (i == null) return;
  const j = Math.max(0, Math.min(S.vue.length - 1, i + pas));
  allerA(S.vue[j].id, false);
  peindreVisionneuse();
}

// ───────────────────────────── Renommer / fusionner ─────────────────────────────
let fusionEnCours = null;
function ouvrirFusion(facette, v, libelle, n) {
  fusionEnCours = { facette, v, libelle, n };
  const quoi = facette === 'personne' ? 'la participante' : 'la salle';
  $('fusion-titre').textContent = `Renommer ${quoi} « ${libelle} »`;
  $('fusion-aide').textContent = `${n} média(s) la portent. Tape le bon nom — s'il existe déjà, les deux sont fusionnés.`;
  $('fusion-liste').innerHTML = (facette === 'personne' ? listeNoms() : listeSalles()).filter(x => cle(x) !== v).map(x => `<option value="${esc(x)}">`).join('');
  $('fusion-cible').value = libelle;
  $('fusion-note').textContent = facette === 'personne' ? 'Laisser vide = retirer ce nom de tous les médias.' : 'Laisser vide = retirer cette salle de tous les médias.';
  $('fusion').hidden = false;
  setTimeout(() => { $('fusion-cible').focus(); $('fusion-cible').select(); }, 30);
}
async function appliquerFusion() {
  const f = fusionEnCours; if (!f) return;
  const cible = $('fusion-cible').value.trim();
  if (cible === f.libelle) { $('fusion').hidden = true; fusionEnCours = null; return; }
  // vider le champ retire le nom PARTOUT : on demande avant (c'est annulable, mais autant ne pas se tromper)
  if (!cible && +f.n > 1 && !confirm(`Retirer « ${f.libelle} » de ${f.n} médias ?`)) return;
  $('fusion').hidden = true; fusionEnCours = null;
  // Même nom à l'orthographe près (« anais G » → « Anaïs G ») : c'est une correction,
  // on prend ce qui est tapé. Sinon, si le nom existe déjà, on reprend sa graphie : fusion.
  const graphie = (lib) => !cible ? '' : cle(cible) === f.v ? cible : (lib?.get(cle(cible)) || cible);
  if (f.facette === 'personne') {
    const officiel = graphie(S.libelles.personne);
    const items = S.items.filter(it => it.personnes.some(p => cle(p) === f.v));
    await modifier(items, it => {
      const out = [];
      for (const p of it.personnes) {
        const np = cle(p) === f.v ? officiel : p;
        if (np && !out.some(x => cle(x) === cle(np))) out.push(np);
      }
      return { tri_participante: joinPersonnes(out) };
    }, cible ? `« ${f.libelle} » → « ${officiel} »` : `« ${f.libelle} » retirée partout`);
  } else {
    const officiel = graphie(S.libelles.salle) || null;
    const items = S.items.filter(it => it.salle && cle(it.salle) === f.v);
    await modifier(items, () => ({ tri_salle: officiel }), cible ? `Salle « ${f.libelle} » → « ${officiel} »` : `Salle « ${f.libelle} » retirée partout`);
  }
  actualiser({ garderDefilement: true });
}

// ───────────────────────────── Toast ─────────────────────────────
let minuterieToast = null;
function toast(txt, genre = 'ok', annulable = false) {
  const t = $('toast');
  t.className = 'toast' + (genre === 'erreur' ? ' erreur' : '');
  $('toast-txt').textContent = txt;
  $('toast-annuler').hidden = !annulable;
  t.hidden = false;
  clearTimeout(minuterieToast);
  minuterieToast = setTimeout(() => { t.hidden = true; }, annulable ? 7000 : 3500);
}

// ───────────────────────────── Événements ─────────────────────────────
function brancher() {
  // recherche
  let minRech = null;
  $('recherche').addEventListener('input', e => {
    clearTimeout(minRech);
    minRech = setTimeout(() => { S.filtres.recherche = e.target.value.trim(); actualiser(); }, 140);
  });

  $('seg-type').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.filtres.type = b.dataset.v; actualiser();
  });
  $('onglets-statut').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    S.filtres.statut = b.dataset.v; actualiser();
  });
  $('grouper').addEventListener('change', e => { S.grouper = e.target.value; actualiser(); });
  $('trier').addEventListener('change', e => { S.trier = e.target.value; actualiser(); });
  $('taille').addEventListener('input', e => {
    S.taille = +e.target.value;
    document.documentElement.style.setProperty('--taille', S.taille + 'px');
    for (const c of S.cartes.values()) c.classList.toggle('petite', S.taille < 120);
    sauverPrefs();
  });
  $('btn-son').addEventListener('click', () => {
    S.son = !S.son; $('btn-son').textContent = S.son ? '🔊' : '🔇';
    if (survol.video) survol.video.muted = !S.son;
    sauverPrefs();
  });
  $('btn-aide').addEventListener('click', () => { $('aide-clavier').hidden = false; });
  $('aide-fermer').addEventListener('click', () => { $('aide-clavier').hidden = true; });
  $('btn-plus').addEventListener('click', e => { e.stopPropagation(); $('menu-plus').hidden = !$('menu-plus').hidden; });
  document.addEventListener('click', e => { if (!e.target.closest('.menu-plus')) $('menu-plus').hidden = true; });
  $('btn-recharger').addEventListener('click', async () => { $('menu-plus').hidden = true; await relancer(); });
  $('btn-deconnexion').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

  // facettes
  $('facettes').addEventListener('click', e => {
    const ed = e.target.closest('.editer');
    if (ed) { e.stopPropagation(); ouvrirFusion(ed.dataset.f, ed.dataset.v, ed.dataset.l, ed.dataset.n); return; }
    const o = e.target.closest('[data-ouvrir]');
    if (o) {
      const k = o.dataset.ouvrir;
      S.ouvertes.has(k) ? S.ouvertes.delete(k) : S.ouvertes.add(k);
      o.parentElement.classList.toggle('ouverte'); sauverPrefs(); return;
    }
    const v = e.target.closest('.valeur'); if (!v) return;
    const k = v.dataset.f, val = v.dataset.v;
    const sel = S.filtres.facettes[k] || (S.filtres.facettes[k] = new Set());
    if (e.altKey) { const garde = sel.has(val) && sel.size === 1; sel.clear(); if (!garde) sel.add(val); }   // ⌥ : seulement celle-ci
    else sel.has(val) ? sel.delete(val) : sel.add(val);
    if (!sel.size) delete S.filtres.facettes[k];
    actualiser();
  });
  $('facettes').addEventListener('input', e => {
    if (!e.target.classList.contains('facette-cherche')) return;
    rendreFacettes();
  });
  // téléphone : les filtres s'ouvrent en plein écran
  $('btn-filtres-mobile').addEventListener('click', () => document.body.classList.add('filtres-ouverts'));
  $('fermer-filtres').addEventListener('click', () => document.body.classList.remove('filtres-ouverts'));
  $('effacer-filtres').addEventListener('click', () => {
    S.filtres.facettes = {}; S.filtres.recherche = ''; $('recherche').value = ''; actualiser();
  });
  $('actifs').addEventListener('click', e => {
    const b = e.target.closest('[data-retirer]'); if (!b) return;
    if (b.dataset.retirer === 'recherche') { S.filtres.recherche = ''; $('recherche').value = ''; }
    else { const s = S.filtres.facettes[b.dataset.retirer]; s?.delete(b.dataset.v); if (!s?.size) delete S.filtres.facettes[b.dataset.retirer]; }
    actualiser();
  });

  // grille
  const grille = $('grille');
  grille.addEventListener('click', e => {
    const sg = e.target.closest('[data-groupe-salle]');
    if (sg) {
      const gr = S.groupes.find(x => x.cle === sg.dataset.groupeSalle); if (!gr) return;
      S.sel.clear(); for (const it of gr.items) S.sel.add(it.id);
      S.ancre = S.courant = gr.items[0].id;
      peindreSelection();
      poserSalle(sg.dataset.salle);
      return;
    }
    const g = e.target.closest('[data-groupe]');
    if (g) {
      const gr = S.groupes.find(x => x.cle === g.dataset.groupe); if (!gr) return;
      if (!(e.metaKey || e.ctrlKey)) S.sel.clear();
      for (const it of gr.items) S.sel.add(it.id);
      S.ancre = gr.items[0].id; S.courant = gr.items[0].id;
      peindreSelection(); return;
    }
    const c = e.target.closest('.carte'); if (!c) return;
    clicCarte(e, c.dataset.id);
  });
  grille.addEventListener('dblclick', e => { if (e.target.closest('.carte')) ouvrirVisionneuse(); });
  grille.addEventListener('mouseover', e => {
    const c = e.target.closest('.carte'); if (!c || c === survol.carte) return;
    const it = S.byId.get(c.dataset.id);
    clearTimeout(survol.minuterie);
    if (it?.kind === 'video') survol.minuterie = setTimeout(() => demarrerSurvol(c, it), 170);
    else arreterSurvol();
  });
  grille.addEventListener('mouseleave', arreterSurvol);
  grille.addEventListener('mouseout', e => {
    const c = e.target.closest('.carte'); if (!c) return;
    if (!c.contains(e.relatedTarget)) { if (c === survol.carte) arreterSurvol(); else clearTimeout(survol.minuterie); }
  });
  new IntersectionObserver(e => { if (e[0].isIntersecting && S.rendus < S.plat.length) rendreSuite(); },
    { root: $('grille-zone'), rootMargin: '900px' }).observe($('sentinelle'));

  $('tout-selectionner').addEventListener('click', () => { for (const it of S.vue) S.sel.add(it.id); peindreSelection(); });
  $('deselectionner').addEventListener('click', () => { S.sel.clear(); peindreSelection(); });
  $('barre-selection').addEventListener('click', e => { if (e.target.id === 'actualiser') actualiser({ garderDefilement: true }); });

  // inspecteur
  const insp = $('insp');
  insp.addEventListener('click', e => {
    const t = e.target;
    if (t.id === 'insp-desel') { S.sel.clear(); peindreSelection(); return; }
    if (t.id === 'insp-reduire') {   // téléphone : le volet d'édition se replie sur ses boutons de statut
      t.textContent = document.body.classList.toggle('insp-reduit') ? '▴ tout voir' : '▾ réduire'; return;
    }
    const st = t.closest('[data-statut]'); if (st) return changerStatut(st.dataset.statut);
    const u = t.closest('[data-univers]'); if (u) return poserUnivers(u.dataset.univers);
    const tg = t.closest('[data-tag]'); if (tg) return basculerTag(GROUPES.find(g => g.cle === tg.dataset.groupe), tg.dataset.tag);
    const vd = t.closest('[data-vider]'); if (vd) return viderGroupe(GROUPES.find(g => g.cle === vd.dataset.vider));
    const rp = t.closest('[data-retirer-personne]'); if (rp) return retirerPersonne(rp.dataset.retirerPersonne, rp.dataset.l);
    const ap = t.closest('[data-ajouter-personne]'); if (ap) return ajouterPersonne(ap.dataset.ajouterPersonne);
    const no = t.closest('[data-note]'); if (no) return poserNote(+no.dataset.note);
    if (t.id === 'insp-personne-ok') return ajouterPersonne($('insp-personne').value);
    if (t.id === 'insp-salle-effacer') return poserSalle('');
  });
  insp.addEventListener('keydown', e => {
    if (e.target.id === 'insp-personne' && e.key === 'Enter') { e.preventDefault(); ajouterPersonne(e.target.value).then(() => $('insp-personne')?.focus()); }
    if (e.target.id === 'insp-salle' && e.key === 'Enter') { e.preventDefault(); poserSalle(e.target.value); e.target.blur(); }
    if (e.target.id === 'insp-commentaire' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') e.target.blur();
  });
  insp.addEventListener('change', e => {
    if (e.target.id === 'insp-salle' && e.target.value.trim() && e.target.value.trim() !== (selection()[0]?.salle || '')) poserSalle(e.target.value);
  });
  insp.addEventListener('focusout', e => {
    if (e.target.id !== 'insp-commentaire') return;
    const items = selection(); const coms = new Set(items.map(i => i.commentaire));
    const avant = coms.size === 1 ? [...coms][0] : '';
    if (e.target.value.trim() !== avant.trim() && !(coms.size > 1 && !e.target.value.trim())) poserCommentaire(e.target.value);
  });

  // visionneuse
  $('vis-prec').addEventListener('click', () => visionneuseAller(-1));
  $('vis-suiv').addEventListener('click', () => visionneuseAller(1));
  $('vis-fermer').addEventListener('click', fermerVisionneuse);
  $('visionneuse').addEventListener('click', e => {
    const st = e.target.closest('[data-statut]');
    if (st) { changerStatut(st.dataset.statut).then(peindreVisionneuse); }
  });

  // fusion
  $('fusion-annuler').addEventListener('click', () => { $('fusion').hidden = true; });
  $('fusion-ok').addEventListener('click', appliquerFusion);
  $('fusion-cible').addEventListener('keydown', e => { if (e.key === 'Enter') appliquerFusion(); if (e.key === 'Escape') $('fusion').hidden = true; });

  $('toast-annuler').addEventListener('click', () => { $('toast').hidden = true; annuler(); });

  document.addEventListener('keydown', clavier);
}

function clavier(e) {
  const t = e.target;
  const dansSaisie = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  const vis = !$('visionneuse').hidden;
  const fenetre = !$('fusion').hidden || !$('aide-clavier').hidden;
  const mod = e.metaKey || e.ctrlKey;

  if (e.key === 'Escape') {
    if (fenetre) { $('fusion').hidden = true; $('aide-clavier').hidden = true; return; }
    if (vis) { fermerVisionneuse(); return; }
    if (dansSaisie) { t.blur(); return; }
    if (S.sel.size) { S.sel.clear(); peindreSelection(); }
    return;
  }
  if (fenetre || dansSaisie) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); annuler().then(() => vis && peindreVisionneuse()); return; }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); for (const it of S.vue) S.sel.add(it.id); peindreSelection(); return; }
  if (mod) return;

  const k = e.key;
  if (k === '/') { e.preventDefault(); $('recherche').focus(); $('recherche').select(); return; }
  if (k === '?') { $('aide-clavier').hidden = false; return; }
  if (vis && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); visionneuseAller(k === 'ArrowLeft' ? -1 : 1); return; }
  const fleches = { ArrowLeft: 'g', ArrowRight: 'd', ArrowUp: 'h', ArrowDown: 'b' };
  if (fleches[k] && !vis) { e.preventDefault(); deplacer(fleches[k], e.shiftKey); return; }
  if (k === ' ' || k === 'Enter') { e.preventDefault(); vis ? fermerVisionneuse() : ouvrirVisionneuse(); return; }
  const lk = k.toLowerCase();
  if (lk === 'v') { changerStatut('ok').then(() => vis && peindreVisionneuse()); return; }
  if (lk === 'x') { changerStatut('refuse').then(() => vis && peindreVisionneuse()); return; }
  if (lk === 'u') { changerStatut('a_trier').then(() => vis && peindreVisionneuse()); return; }
  if (/^[0-9]$/.test(k) && S.sel.size) { poserNote(k === '0' ? 10 : +k).then(() => vis && peindreVisionneuse()); return; }
  if (lk === 'p' && S.sel.size) { e.preventDefault(); if (vis) fermerVisionneuse(); $('insp-personne')?.focus(); return; }
  if (lk === 's' && S.sel.size) { e.preventDefault(); if (vis) fermerVisionneuse(); $('insp-salle')?.focus(); $('insp-salle')?.select(); return; }
}

// ───────────────────────────── Démarrage ─────────────────────────────
async function relancer() {
  S.gen++;
  $('chargement').hidden = false; $('grille').innerHTML = ''; S.cartes.clear();
  try {
    await chargerVocabulaire();
    await chargerBanque();
  } catch (e) {
    $('chargement-txt').textContent = 'Impossible de charger la banque : ' + e.message + ' — réessaie dans un instant (menu ⋯ → Recharger).';
    return;
  }
  actualiser();
  completerPhotos(S.gen);
}

async function lancerApp() {
  if (S.lance) return;
  S.lance = true;
  $('connexion').hidden = true;
  $('app').hidden = false;
  chargerPrefs();
  $('grouper').value = S.grouper;
  $('trier').value = S.trier;
  $('taille').value = S.taille;
  $('btn-son').textContent = S.son ? '🔊' : '🔇';
  brancher();
  await relancer();
}

function afficherConnexion() {
  $('connexion').hidden = false;
  let email = '';
  const msg = (t, err) => { $('cx-msg').textContent = t; $('cx-msg').style.color = err ? 'var(--rouge)' : ''; };
  $('cx-envoyer').onclick = async () => {
    email = $('cx-email').value.trim(); if (!email) return msg('Entre ton email', true);
    $('cx-envoyer').disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
    $('cx-envoyer').disabled = false;
    if (error) return msg(error.message, true);
    $('cx-etape-email').hidden = true; $('cx-etape-code').hidden = false; msg(`Code envoyé à ${email}.`);
    $('cx-code').focus();
  };
  $('cx-verifier').onclick = async () => {
    const code = $('cx-code').value.trim(); if (!code) return msg('Saisis le code reçu', true);
    $('cx-verifier').disabled = true;
    const { error } = await sb.auth.verifyOtp({ email, token: code, type: 'email' });
    $('cx-verifier').disabled = false;
    if (error) msg(error.message, true);
  };
  $('cx-email').onkeydown = e => { if (e.key === 'Enter') $('cx-envoyer').click(); };
  $('cx-code').onkeydown = e => { if (e.key === 'Enter') $('cx-verifier').click(); };
  $('cx-changer').onclick = e => { e.preventDefault(); $('cx-etape-code').hidden = true; $('cx-etape-email').hidden = false; };
}

(async function demarrer() {
  const { data: { session } } = await sb.auth.getSession();
  // En local, pas de code par email : c'est la machine de Jérôme. En ligne, même compte
  // que l'ancienne vue (la session est partagée : même domaine).
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  sb.auth.onAuthStateChange((_e, s) => { if (s) lancerApp(); });
  if (session || local) lancerApp(); else afficherConnexion();
})();
