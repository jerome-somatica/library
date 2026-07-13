/**
 * admin.js — Onglets Visages + Maintenance de Somatica Library.
 *
 * Dépend de :
 *   - app.js déjà chargé (il gère l'auth, la galerie, etc.)
 *   - fetch vers le worker local exposé par library_worker.py (Flask),
 *     accessible via Cloudflare Tunnel ou directement localhost:8787.
 *
 * Les paramètres de connexion (URL + token) sont stockés en localStorage
 * sous les clés WORKER_URL et WORKER_TOKEN et éditables depuis l'onglet
 * Maintenance.
 */

(() => {
  const LS_URL = 'WORKER_URL';
  const LS_TOKEN = 'WORKER_TOKEN';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ------------------------------------------------------------
  // Tabs switching
  // ------------------------------------------------------------
  function setupTabs() {
    const tabs = $$('#view-tabs .view-tab');
    const views = {
      gallery: $('#view-gallery'),
      montees: $('#view-montees'),
      recordings: $('#view-recordings'),
      faces: $('#view-faces'),
      ai: $('#view-ai'),
      dupes: $('#view-dupes'),
      maintenance: $('#view-maintenance'),
    };

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.view;
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        Object.entries(views).forEach(([name, el]) => {
          if (!el) return;
          el.classList.toggle('active', name === target);
        });

        // Chargements paresseux à la 1re ouverture
        if (target === 'recordings') renderRecordings();
        if (target === 'montees') renderMontees();
        if (target === 'faces') renderFaces();
        if (target === 'dupes') renderDupes();
        if (target === 'maintenance') onMaintenanceOpen();
        if (target === 'ai') {
          onGeminiOpen();
        } else {
          if (typeof stopGeminiPolling === 'function') stopGeminiPolling();
        }
      });
    });
  }

  // ------------------------------------------------------------
  // Onglet Enregistrements (replays des lives ISIS)
  // ------------------------------------------------------------
  const REPLAY_BASE = 'https://isis.somatica.fr/replay/';
  const ISIS_BASE = 'https://isis.somatica.fr';

  function recEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function recResolveCover(url) {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    return ISIS_BASE + (url.charAt(0) === '/' ? url : '/' + url);
  }
  function recFmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
    catch (e) { return ''; }
  }

  async function recFetchList() {
    // Le compte Library n'est pas forcement le facilitateur ISIS : on passe par l'Edge de
    // listing (service role, cote serveur). Repli sur la requete directe si les comptes s'alignent.
    try {
      const { data, error } = await window.sb.functions.invoke('live-recordings-list', { body: {} });
      if (!error && data && Array.isArray(data.recordings)) return data.recordings;
    } catch (e) {}
    try {
      const { data } = await window.sb
        .from('live_sessions')
        .select('code, title, seance_id, created_at, recording_filepath')
        .not('recording_filepath', 'is', null)
        .is('recording_egress_id', null)
        .order('created_at', { ascending: false });
      if (!data || !data.length) return [];
      const ids = [...new Set(data.map((r) => r.seance_id).filter(Boolean))];
      const seances = {};
      if (ids.length) {
        const { data: sd } = await window.sb
          .from('lecteur_seances')
          .select('id, display_title, title, cover_url')
          .in('id', ids);
        (sd || []).forEach((s) => { seances[s.id] = s; });
      }
      return data.map((r) => {
        const s = seances[r.seance_id] || {};
        return {
          code: r.code,
          created_at: r.created_at,
          title: r.title || s.display_title || s.title || 'Séance',
          cover_url: s.cover_url || null,
        };
      });
    } catch (e) { return []; }
  }

  function recCardHtml(r) {
    const cover = recResolveCover(r.cover_url);
    const replay = REPLAY_BASE + encodeURIComponent(r.code);
    const thumb = cover
      ? `<div class="rec-thumb" style="background-image:url('${cover.replace(/['"\\]/g, '')}')"><span class="rec-play">▶</span></div>`
      : `<div class="rec-thumb"><span class="rec-thumb-empty">🎥</span></div>`;
    return `<div class="rec-card" data-code="${recEsc(r.code)}">
      <a href="${replay}" target="_blank" rel="noopener" class="rec-thumb-link">${thumb}</a>
      <div class="rec-body">
        <div class="rec-title">${recEsc(r.title)}</div>
        <div class="rec-date">${recFmtDate(r.created_at)}</div>
        <div class="rec-actions">
          <a class="rec-btn primary" href="${replay}" target="_blank" rel="noopener">Regarder</a>
          <button class="rec-btn" data-act="copy" data-code="${recEsc(r.code)}">Copier le lien</button>
          <button class="rec-btn" data-act="dl" data-code="${recEsc(r.code)}">Télécharger</button>
        </div>
      </div>
    </div>`;
  }

  let recLoading = false;
  async function renderRecordings() {
    const grid = $('#rec-grid');
    if (!grid || recLoading) return;
    recLoading = true;
    grid.innerHTML = '<div class="rec-loading">Chargement...</div>';
    let rows = [];
    try { rows = await recFetchList(); } catch (e) { rows = []; }
    recLoading = false;
    const cnt = $('#rec-count');
    if (!rows.length) {
      if (cnt) cnt.textContent = '';
      grid.innerHTML = '<div class="rec-empty">Aucun enregistrement disponible pour le moment.<small>Les lives que tu enregistres apparaîtront ici.</small></div>';
      return;
    }
    if (cnt) cnt.textContent = rows.length + (rows.length > 1 ? ' enregistrements' : ' enregistrement');
    grid.innerHTML = rows.map(recCardHtml).join('');
  }

  function setupRecordings() {
    const refresh = $('#rec-refresh');
    if (refresh) refresh.addEventListener('click', () => { recLoading = false; renderRecordings(); });
    // Actions copier / telecharger (delegation, une seule fois)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('#view-recordings .rec-btn[data-act]');
      if (!btn) return;
      const code = btn.dataset.code;
      if (btn.dataset.act === 'copy') {
        const link = REPLAY_BASE + code;
        try { await navigator.clipboard.writeText(link); btn.textContent = 'Lien copié !'; }
        catch (err) { btn.textContent = 'Copie impossible'; }
        setTimeout(() => { btn.textContent = 'Copier le lien'; }, 1600);
        return;
      }
      if (btn.dataset.act === 'dl') {
        const old = btn.textContent;
        btn.textContent = 'Préparation...'; btn.disabled = true;
        try {
          const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/live-replay`, {
            method: 'POST',
            headers: { apikey: window.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          });
          const j = await resp.json();
          if (j && j.ready && j.url) {
            const a = document.createElement('a');
            a.href = j.url;
            a.download = (j.title || 'enregistrement') + '.mp4';
            a.target = '_blank'; a.rel = 'noopener';
            document.body.appendChild(a); a.click(); a.remove();
            btn.textContent = old;
          } else if (j && j.recording) {
            btn.textContent = 'Encore en cours'; setTimeout(() => { btn.textContent = old; }, 1800);
          } else {
            btn.textContent = 'Indisponible'; setTimeout(() => { btn.textContent = old; }, 1800);
          }
        } catch (err) {
          btn.textContent = 'Erreur'; setTimeout(() => { btn.textContent = old; }, 1800);
        }
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------
  // Worker client
  // ------------------------------------------------------------
  function getWorker() {
    const url = (localStorage.getItem(LS_URL) || '').replace(/\/+$/, '');
    const token = localStorage.getItem(LS_TOKEN) || '';
    return { url, token };
  }

  function setWorker(url, token) {
    localStorage.setItem(LS_URL, url.replace(/\/+$/, ''));
    localStorage.setItem(LS_TOKEN, token);
  }

  async function workerFetch(path, opts = {}) {
    const { url, token } = getWorker();
    if (!url) throw new Error('Worker non configuré');
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      opts.headers || {},
    );
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(url + path, { ...opts, headers });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Worker ${resp.status}: ${text.slice(0, 200)}`);
    }
    const ct = resp.headers.get('content-type') || '';
    return ct.includes('application/json') ? resp.json() : resp.text();
  }

  // ------------------------------------------------------------
  // Journal
  // ------------------------------------------------------------
  function logLine(msg, tone = 'info') {
    const el = $('#maint-log');
    if (!el) return;
    const line = document.createElement('div');
    const ts = new Date().toLocaleTimeString('fr-FR');
    line.textContent = `[${ts}] ${msg}`;
    if (tone === 'error') line.style.color = '#ff9a9a';
    else if (tone === 'ok') line.style.color = '#a8e6a8';
    else if (tone === 'warn') line.style.color = '#ffc878';
    el.prepend(line);
    // Garder les 200 dernières
    while (el.childNodes.length > 200) el.removeChild(el.lastChild);
  }

  // ------------------------------------------------------------
  // Montées (vidéos assemblées = feed_images.video_url non null)
  // ------------------------------------------------------------
  let monteesState = { loaded: false, loading: false, items: [], feeds: {} };

  function fmtDateShort(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' })
        + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    } catch (_) { return iso; }
  }

  async function fetchMontees() {
    const sb = window.sb;
    if (!sb) throw new Error('Supabase client non disponible');

    // Récupérer d'abord la liste des feeds pour le mapping réseau
    const { data: feeds, error: errFeeds } = await sb
      .from('feeds')
      .select('id, name');
    if (errFeeds) throw errFeeds;
    monteesState.feeds = {};
    (feeds || []).forEach((f) => { monteesState.feeds[f.id] = f; });

    // Peupler le select réseau
    const selFeed = $('#montees-filter-feed');
    if (selFeed && selFeed.options.length <= 1) {
      (feeds || []).forEach((f) => {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = f.name || 'Feed';
        selFeed.appendChild(opt);
      });
    }

    // Récupérer les vidéos montées (video_url non null)
    const { data, error } = await sb
      .from('feed_images')
      .select('id, feed_id, prefix_code, subject, notion_page_id, video_url, cover_url, image_url, edit_project_id, review_status, scheduled_date, updated_at, content_type')
      .not('video_url', 'is', null)
      .order('scheduled_date', { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) throw error;

    monteesState.items = data || [];
    monteesState.loaded = true;
  }

  function filterMontees() {
    const q = ($('#montees-search')?.value || '').trim().toLowerCase();
    const feedId = $('#montees-filter-feed')?.value || '';
    const status = $('#montees-filter-status')?.value || '';
    return monteesState.items.filter((it) => {
      if (feedId && it.feed_id !== feedId) return false;
      if (status && it.review_status !== status) return false;
      if (q) {
        const hay = `${it.prefix_code || ''} ${it.subject || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderMonteesGrid() {
    const grid = $('#montees-grid');
    const countEl = $('#montees-count');
    if (!grid) return;
    const list = filterMontees();
    countEl.textContent = `${list.length} / ${monteesState.items.length}`;

    if (!list.length) {
      grid.innerHTML = '<div class="maint-status">Aucune vidéo montée pour ces filtres.</div>';
      return;
    }

    const statusLabels = {
      approved: 'Programmé',
      published: 'Publié',
      pending: 'Review',
      rejected: 'Refusé',
      none: '—',
    };

    grid.innerHTML = list.map((it) => {
      const feed = monteesState.feeds[it.feed_id];
      const feedName = feed ? (feed.name || 'Feed') : '—';
      const thumb = it.cover_url || it.image_url || '';
      const prefix = it.prefix_code || '—';
      const title = (it.subject || '').replace(/"/g, '&quot;');
      const statusKey = it.review_status || 'none';
      const statusLabel = statusLabels[statusKey] || statusKey;
      const date = fmtDateShort(it.scheduled_date);
      const notionUrl = it.notion_page_id
        ? `https://www.notion.so/${it.notion_page_id.replace(/-/g, '')}`
        : '';
      const editUrl = it.edit_project_id
        ? `https://somatica-edit.netlify.app/?project=${encodeURIComponent(it.edit_project_id)}`
        : '';

      return `
        <div class="montee-card" data-id="${it.id}">
          <div class="montee-thumb">
            ${thumb
              ? `<img src="${thumb}" alt="" loading="lazy">`
              : `<video src="${it.video_url}" preload="metadata" muted></video>`}
            <div class="montee-badge">${prefix}</div>
            <div class="montee-badge-status ${statusKey}">${statusLabel}</div>
          </div>
          <div class="montee-info">
            <div class="montee-title" title="${title}">${title || prefix}</div>
            <div class="montee-meta">
              <span>${feedName}</span>
              <span>${date}</span>
            </div>
          </div>
          <div class="montee-actions">
            <a href="${it.video_url}" target="_blank" rel="noopener">MP4</a>
            ${notionUrl ? `<a href="${notionUrl}" target="_blank" rel="noopener">Notion</a>` : ''}
            ${editUrl ? `<a href="${editUrl}" target="_blank" rel="noopener">Edit</a>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  async function renderMontees(force = false) {
    const grid = $('#montees-grid');
    if (!grid) return;
    if (monteesState.loading) return;
    if (monteesState.loaded && !force) {
      renderMonteesGrid();
      return;
    }
    monteesState.loading = true;
    grid.innerHTML = '<div class="loading">Chargement des vidéos montées...</div>';
    try {
      await fetchMontees();
      renderMonteesGrid();
    } catch (e) {
      console.error('[montees]', e);
      grid.innerHTML = `<div class="error-msg">Erreur : ${e.message || e}</div>`;
    } finally {
      monteesState.loading = false;
    }
  }

  function setupMonteesFilters() {
    const s = $('#montees-search');
    const ff = $('#montees-filter-feed');
    const fs = $('#montees-filter-status');
    const btn = $('#montees-refresh');
    if (s) s.addEventListener('input', () => renderMonteesGrid());
    if (ff) ff.addEventListener('change', () => renderMonteesGrid());
    if (fs) fs.addEventListener('change', () => renderMonteesGrid());
    if (btn) btn.addEventListener('click', () => renderMontees(true));
  }

  // ------------------------------------------------------------
  // Visages
  // ------------------------------------------------------------
  let facesState = { loaded: false, loading: false };

  async function renderFaces(force = false) {
    if (facesState.loading) return;
    if (facesState.loaded && !force) return;

    const grid = $('#faces-grid');
    const status = $('#faces-status');
    grid.innerHTML = '<div class="maint-status">Chargement des clusters...</div>';
    status.textContent = '';
    facesState.loading = true;

    try {
      const data = await workerFetch('/faces/clusters');
      const raw = Array.isArray(data) ? data : data.clusters || [];
      // Normaliser : le worker renvoie cluster_name/is_named/sample_count
      const clusters = raw.map((c) => ({
        name: c.cluster_name || c.name || '',
        count: c.sample_count != null ? c.sample_count : (c.count || 0),
        is_named: c.is_named != null ? c.is_named : isNamed(c.cluster_name || c.name || ''),
        samples: c.sample_count,
        last_seen: c.updated_at,
        thumbnails: (c.thumbnails || [])
          .map((t) => (typeof t === 'string' ? t : t.thumbnail_url))
          .filter(Boolean),
      }));

      if (!clusters.length) {
        grid.innerHTML = '<div class="maint-status">Aucun cluster pour le moment. Lance un build puis un match depuis l\'onglet Maintenance.</div>';
      } else {
        // Tri : nommés d'abord, puis clusters numérotés
        clusters.sort((a, b) => {
          if (a.is_named !== b.is_named) return a.is_named ? -1 : 1;
          return (b.count || 0) - (a.count || 0);
        });
        grid.innerHTML = '';
        clusters.forEach((c) => grid.appendChild(renderFaceCard(c)));
      }

      const named = clusters.filter((c) => c.is_named).length;
      status.textContent = `${clusters.length} groupes · ${named} nommés · ${clusters.length - named} à identifier`;
      facesState.loaded = true;
    } catch (err) {
      grid.innerHTML = `<div class="maint-status" style="color:#ff9a9a">Erreur : ${escapeHtml(err.message)}</div>`;
    } finally {
      facesState.loading = false;
    }
  }

  function isNamed(name) {
    if (!name) return false;
    return !/^cluster_\d+$/i.test(name) && name !== '_UNKNOWN_';
  }

  function renderFaceCard(cluster) {
    const named = cluster.is_named;
    const card = document.createElement('div');
    card.className = 'face-card ' + (named ? 'named' : 'cluster');

    const thumbs = (cluster.thumbnails || []).slice(0, 6);
    const count = cluster.count || 0;

    card.innerHTML = `
      <div class="face-card-header">
        <div class="face-card-name">${escapeHtml(cluster.name || '')}</div>
        <div class="face-card-badge">${count} occ.</div>
      </div>
      <div class="face-thumbs">
        ${thumbs.map((url) => `<div class="face-thumb" style="background-image:url('${escapeAttr(url)}')"></div>`).join('')}
        ${Array.from({ length: Math.max(0, 3 - thumbs.length) }, () => '<div class="face-thumb"></div>').join('')}
      </div>
      <div class="face-card-meta">
        ${cluster.samples ? cluster.samples + ' samples' : ''}${cluster.last_seen ? ' · vu ' + new Date(cluster.last_seen).toLocaleDateString('fr-FR') : ''}
      </div>
      <div class="face-card-rename">
        <input type="text" placeholder="${named ? 'Renommer' : 'Donner un nom'}" value="${named ? escapeAttr(cluster.name) : ''}">
        <button class="maint-btn primary">${named ? 'Renommer' : 'Identifier'}</button>
      </div>
    `;

    const input = card.querySelector('input');
    const btn = card.querySelector('button');
    btn.addEventListener('click', async () => {
      const newName = (input.value || '').trim();
      if (!newName) {
        input.focus();
        return;
      }
      if (newName === cluster.name) return;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await workerFetch('/faces/rename', {
          method: 'POST',
          body: JSON.stringify({ old_name: cluster.name, new_name: newName }),
        });
        logLine(`Cluster "${cluster.name}" → "${newName}"`, 'ok');
        renderFaces(true);
      } catch (err) {
        logLine(`Erreur rename : ${err.message}`, 'error');
        btn.disabled = false;
        btn.textContent = named ? 'Renommer' : 'Identifier';
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn.click();
    });

    return card;
  }

  // ------------------------------------------------------------
  // Doublons
  // ------------------------------------------------------------
  // sb est déclaré dans app.js (top-level const), accessible ici.
  let dupesState = { loaded: false, loading: false, groups: [] };

  async function renderDupes(force = false) {
    if (dupesState.loading) return;
    if (dupesState.loaded && !force) return;

    const list = $('#dupes-list');
    const status = $('#dupes-status');
    list.innerHTML = '<div class="maint-status">Chargement des candidats...</div>';
    status.textContent = '';
    dupesState.loading = true;

    try {
      // Récupère TOUT ce qui a size_bytes non null. On regroupe côté client
      // par (size_bytes, duration_seconds arrondi, created_at_source).
      let rows = [];
      let page = 0;
      const PAGE = 1000;
      while (true) {
        const { data, error } = await sb
          .from('video_library')
          .select('id,r2_url,r2_key,thumbnail_url,file_name,size_bytes,duration_seconds,created_at_source,created_at,content_hash')
          .not('size_bytes', 'is', null)
          .range(page * PAGE, page * PAGE + PAGE - 1);
        if (error) throw error;
        if (!data || !data.length) break;
        rows = rows.concat(data);
        if (data.length < PAGE) break;
        page++;
        if (page > 50) break; // garde-fou
      }

      const groups = new Map();
      for (const r of rows) {
        if (r.duration_seconds == null || r.created_at_source == null) continue;
        const key = `${r.size_bytes}|${Math.round(r.duration_seconds * 10) / 10}|${r.created_at_source}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }

      const candidateGroups = [];
      for (const [key, items] of groups) {
        if (items.length > 1) {
          // Classer par état
          const allHashed = items.every((i) => i.content_hash);
          let state = 'pending'; // par défaut : candidats non vérifiés
          if (allHashed) {
            const hashes = new Set(items.map((i) => i.content_hash));
            state = hashes.size === 1 ? 'confirmed' : 'rejected';
          }
          candidateGroups.push({ key, items, state });
        }
      }

      // Tri : confirmés d'abord, puis pending, puis rejetés
      const order = { confirmed: 0, pending: 1, rejected: 2 };
      candidateGroups.sort((a, b) => {
        if (a.state !== b.state) return order[a.state] - order[b.state];
        return (b.items[0].size_bytes || 0) - (a.items[0].size_bytes || 0);
      });

      dupesState.groups = candidateGroups;

      if (!candidateGroups.length) {
        list.innerHTML = '<div class="maint-status">Aucun candidat doublon trouvé. La bibliothèque est propre.</div>';
      } else {
        list.innerHTML = '';
        candidateGroups.forEach((g) => list.appendChild(renderDupeGroup(g)));
      }

      const confirmed = candidateGroups.filter((g) => g.state === 'confirmed').length;
      const pending = candidateGroups.filter((g) => g.state === 'pending').length;
      const rejected = candidateGroups.filter((g) => g.state === 'rejected').length;
      const toDelete = candidateGroups
        .filter((g) => g.state === 'confirmed')
        .reduce((sum, g) => sum + g.items.length - 1, 0);
      status.textContent = `${candidateGroups.length} groupes · ${confirmed} confirmés (${toDelete} à supprimer) · ${pending} à hasher · ${rejected} faux positifs`;
      dupesState.loaded = true;
    } catch (err) {
      list.innerHTML = `<div class="maint-status" style="color:#ff9a9a">Erreur : ${escapeHtml(err.message)}</div>`;
    } finally {
      dupesState.loading = false;
    }
  }

  function renderDupeGroup(group) {
    const wrap = document.createElement('div');
    wrap.className = 'dupe-group ' + group.state;
    wrap.dataset.key = group.key;

    const item0 = group.items[0];
    const sizeMb = (item0.size_bytes / 1024 / 1024).toFixed(1);
    const dur = item0.duration_seconds != null ? item0.duration_seconds.toFixed(1) + 's' : '?';
    const date = item0.created_at_source ? new Date(item0.created_at_source).toLocaleDateString('fr-FR') : '?';

    const badgeLabel = group.state === 'confirmed' ? 'Doublons confirmés'
      : group.state === 'rejected' ? 'Faux positifs'
      : 'À hasher';

    // Trouver l'item à garder = celui avec r2_key le plus court OU created_at le plus ancien
    // Par défaut : garder le premier trié par created_at asc
    const sorted = [...group.items].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : Infinity;
      const tb = b.created_at ? new Date(b.created_at).getTime() : Infinity;
      return ta - tb;
    });
    const keepId = sorted[0].id;

    wrap.innerHTML = `
      <div class="dupe-group-header">
        <div class="dupe-group-title">
          ${sizeMb} Mo · ${dur} · ${date} · ${group.items.length} copies
        </div>
        <div class="dupe-group-badge ${group.state}">${escapeHtml(badgeLabel)}</div>
        <div class="dupe-group-actions">
          ${group.state === 'pending' ? '<button class="maint-btn" data-action="hash">Hasher ce groupe</button>' : ''}
          ${group.state === 'confirmed' ? '<button class="maint-btn danger" data-action="delete-extras">Supprimer les extras</button>' : ''}
        </div>
      </div>
      <div class="dupe-items"></div>
    `;

    const itemsWrap = wrap.querySelector('.dupe-items');
    group.items.forEach((it) => itemsWrap.appendChild(renderDupeItem(it, group, keepId)));

    // Actions groupe
    const hashBtn = wrap.querySelector('[data-action="hash"]');
    if (hashBtn) {
      hashBtn.addEventListener('click', async () => {
        hashBtn.disabled = true;
        hashBtn.textContent = 'Hash en cours...';
        try {
          await hashGroup(group);
          renderDupes(true);
        } catch (err) {
          alert('Erreur hash : ' + err.message);
          hashBtn.disabled = false;
          hashBtn.textContent = 'Hasher ce groupe';
        }
      });
    }

    const delBtn = wrap.querySelector('[data-action="delete-extras"]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const toDelete = group.items.filter((i) => i.id !== keepId);
        if (!confirm(`Supprimer définitivement ${toDelete.length} doublon(s) ? (DB + R2)\n\nGardé : ${sorted[0].file_name}`)) return;
        delBtn.disabled = true;
        delBtn.textContent = 'Suppression...';
        try {
          for (const victim of toDelete) {
            await deleteVideo(victim);
          }
          renderDupes(true);
        } catch (err) {
          alert('Erreur suppression : ' + err.message);
          delBtn.disabled = false;
          delBtn.textContent = 'Supprimer les extras';
        }
      });
    }

    return wrap;
  }

  function renderDupeItem(item, group, keepId) {
    const card = document.createElement('div');
    card.className = 'dupe-item';
    if (group.state === 'confirmed') {
      card.classList.add(item.id === keepId ? 'to-keep' : 'to-delete');
    }

    const thumb = item.thumbnail_url || '';
    const hashShort = item.content_hash ? item.content_hash.slice(0, 12) + '...' : 'non hashé';
    const created = item.created_at ? new Date(item.created_at).toLocaleDateString('fr-FR') : '?';

    card.innerHTML = `
      <div class="dupe-thumb" style="${thumb ? `background-image:url('${escapeAttr(thumb)}')` : ''}"></div>
      <div class="dupe-filename">${escapeHtml(item.file_name || item.r2_key || item.id)}</div>
      <div class="dupe-meta">upload ${created}</div>
      <div class="dupe-hash">${escapeHtml(hashShort)}</div>
      <div class="dupe-item-actions">
        <button data-action="preview">Voir</button>
        <button class="danger" data-action="delete">Supprimer</button>
      </div>
    `;

    const previewBtn = card.querySelector('[data-action="preview"]');
    previewBtn.addEventListener('click', () => {
      if (item.r2_url) window.open(item.r2_url, '_blank');
    });

    const deleteBtn = card.querySelector('[data-action="delete"]');
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Supprimer définitivement ?\n\n${item.file_name || item.r2_key}`)) return;
      deleteBtn.disabled = true;
      deleteBtn.textContent = '...';
      try {
        await deleteVideo(item);
        renderDupes(true);
      } catch (err) {
        alert('Erreur : ' + err.message);
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Supprimer';
      }
    });

    return card;
  }

  // Hash SHA256 côté navigateur d'une vidéo R2, en streaming (ReadableStream).
  async function hashVideoStreaming(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    // crypto.subtle.digest ne streame pas, mais on peut accumuler les chunks
    // et hasher à la fin. Pour des fichiers < 500 Mo c'est OK.
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    // Concatène puis digest
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return { hash: hex, size: total };
  }

  async function hashGroup(group) {
    for (const item of group.items) {
      if (item.content_hash) continue;
      if (!item.r2_url) continue;
      const { hash } = await hashVideoStreaming(item.r2_url);
      const { error } = await sb
        .from('video_library')
        .update({ content_hash: hash })
        .eq('id', item.id);
      if (error) throw error;
      item.content_hash = hash;
    }
  }

  // Suppression : utilise l'Edge Function delete-from-r2 pour R2, puis
  // DELETE sur video_library via le client Supabase directement.
  const DELETE_R2_URL = 'https://zrdlvoovrnglxcgoyyeb.supabase.co/functions/v1/delete-from-r2';
  const DELETE_R2_TOKEN = 'somatica-r2-2026';

  async function deleteVideo(item) {
    // 1. Collecter les keys R2 à supprimer (fichier + miniature si présente)
    const keys = [];
    if (item.r2_key) keys.push(item.r2_key);
    // Dériver la clé miniature depuis thumbnail_url si présente :
    // https://.../thumbnails/xxx.jpg -> thumbnails/xxx.jpg
    if (item.thumbnail_url) {
      try {
        const u = new URL(item.thumbnail_url);
        // path commence par /<bucket-publique>/<key> — sur R2 public le domaine
        // custom renvoie directement <key>. On prend le pathname sans slash initial.
        const path = u.pathname.replace(/^\/+/, '');
        if (path && !keys.includes(path)) keys.push(path);
      } catch (_) { /* ignore */ }
    }

    // 2. Appel delete-from-r2
    if (keys.length) {
      const resp = await fetch(DELETE_R2_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DELETE_R2_TOKEN}`,
        },
        body: JSON.stringify({ keys }),
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`R2 delete HTTP ${resp.status} ${txt}`);
      }
      const result = await resp.json();
      if (result.errors && result.errors.length) {
        // On log mais on ne bloque pas : mieux vaut finir le cleanup DB
        console.warn('R2 delete errors:', result.errors);
      }
    }

    // 3. DELETE ligne DB (cascade : face_sightings, etc. selon les FK)
    const { error } = await sb
      .from('video_library')
      .delete()
      .eq('id', item.id);
    if (error) throw error;

    return { id: item.id, r2_keys: keys };
  }

  // ------------------------------------------------------------
  // Maintenance
  // ------------------------------------------------------------
  let maintLoadedOnce = false;

  function onMaintenanceOpen() {
    // Remplir les inputs avec la config courante
    const { url, token } = getWorker();
    $('#worker-url-input').value = url;
    $('#worker-token-input').value = token;
    if (!maintLoadedOnce) {
      // Ping auto une fois
      pingWorker(true);
      if (url && token) loadAlbums();
      maintLoadedOnce = true;
    }
  }

  async function pingWorker(silent = false) {
    const statusEl = $('#worker-status');
    const offlineBanner = $('#worker-offline');
    try {
      const data = await workerFetch('/health');
      statusEl.textContent = `OK · ${data.version || 'ready'}`;
      statusEl.style.color = '#a8e6a8';
      offlineBanner.style.display = 'none';
      if (!silent) logLine('Worker en ligne', 'ok');
    } catch (err) {
      statusEl.textContent = `Hors ligne (${err.message.split(':')[0]})`;
      statusEl.style.color = '#ff9a9a';
      offlineBanner.style.display = 'block';
      if (!silent) logLine(`Worker injoignable : ${err.message}`, 'error');
    }
  }

  async function loadAlbums() {
    const sel = $('#album-select');
    sel.innerHTML = '<option value="">Chargement...</option>';
    try {
      const data = await workerFetch('/icloud/albums');
      const albums = Array.isArray(data) ? data : data.albums || [];
      const current = data.current_album || data.current || localStorage.getItem('ICLOUD_ALBUM') || '';
      sel.innerHTML = '';
      albums.forEach((a) => {
        const opt = document.createElement('option');
        const name = typeof a === 'string' ? a : a.name;
        const count = typeof a === 'object' ? (a.video_count != null ? a.video_count : a.count) : null;
        opt.value = name;
        opt.textContent = count != null ? `${name} (${count})` : name;
        if (name === current) opt.selected = true;
        sel.appendChild(opt);
      });
      if (current) localStorage.setItem('ICLOUD_ALBUM', current);
    } catch (err) {
      sel.innerHTML = `<option value="">Erreur : ${escapeAttr(err.message)}</option>`;
    }
  }

  async function saveAlbumSetting(name) {
    try {
      await workerFetch('/settings/icloud_sync_album', {
        method: 'PUT',
        body: JSON.stringify({ value: name }),
      });
      localStorage.setItem('ICLOUD_ALBUM', name);
      logLine(`Album iCloud par défaut → "${name}"`, 'ok');
    } catch (err) {
      logLine(`Erreur config album : ${err.message}`, 'error');
    }
  }

  // Lancer un job async et suivre son statut
  async function runJob(path, btn, statusEl, opts = {}) {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '...';
    statusEl.textContent = 'Démarrage...';
    try {
      const data = await workerFetch(path, { method: 'POST', body: JSON.stringify(opts.body || {}) });
      if (data.job_id) {
        await followJob(data.job_id, statusEl);
      } else {
        statusEl.textContent = data.message || 'Terminé';
        logLine(`${path} OK`, 'ok');
      }
    } catch (err) {
      statusEl.textContent = `Erreur : ${err.message}`;
      logLine(`${path} : ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  async function followJob(jobId, statusEl) {
    let done = false;
    while (!done) {
      await sleep(1500);
      try {
        const j = await workerFetch(`/jobs/${jobId}`);
        const state = j.status || j.state || 'running';
        const msg = summarizeJob(j);
        statusEl.textContent = `${state} · ${msg}`;
        if (state === 'success' || state === 'done' || state === 'error' || state === 'cancelled') {
          done = true;
          const tone = (state === 'success' || state === 'done') ? 'ok' : state === 'error' ? 'error' : 'warn';
          logLine(`Job ${jobId} → ${state} · ${msg}`, tone);
        }
      } catch (err) {
        statusEl.textContent = `Perdu contact : ${err.message}`;
        break;
      }
    }
  }

  function summarizeJob(j) {
    const bits = [];
    if (j.added != null) bits.push(`+${j.added}`);
    if (j.updated != null) bits.push(`~${j.updated}`);
    if (j.skipped != null) bits.push(`=${j.skipped}`);
    if (j.failed != null) bits.push(`!${j.failed}`);
    if (j.matched != null) bits.push(`matched ${j.matched}`);
    if (j.created_clusters != null) bits.push(`nouveaux ${j.created_clusters}`);
    if (j.error) bits.push(j.error.slice(0, 120));
    if (j.output_tail) {
      const tail = j.output_tail.split('\n').filter(Boolean).slice(-1)[0] || '';
      if (tail) bits.push(tail.slice(0, 100));
    }
    return bits.join(' · ');
  }

  function setupMaintenanceHandlers() {
    $('#worker-save').addEventListener('click', () => {
      const url = $('#worker-url-input').value.trim();
      const token = $('#worker-token-input').value.trim();
      setWorker(url, token);
      logLine('Config worker enregistrée', 'ok');
      pingWorker();
    });
    $('#worker-ping').addEventListener('click', () => pingWorker());

    $('#albums-refresh').addEventListener('click', loadAlbums);
    $('#album-select').addEventListener('change', (e) => {
      const name = e.target.value;
      if (!name) return;
      saveAlbumSetting(name);
    });

    $('#run-sync').addEventListener('click', () => {
      const album = $('#album-select').value;
      runJob('/icloud/sync', $('#run-sync'), $('#sync-status'), { body: { album } });
    });

    $('#thumbs-check').addEventListener('click', async () => {
      const status = $('#thumbs-status');
      status.textContent = 'Vérification...';
      try {
        const data = await workerFetch('/thumbnails/check');
        const missing = data.missing_count != null ? data.missing_count : (data.missing || 0);
        status.textContent = `${missing} miniatures manquantes`;
        logLine(`Check miniatures : ${missing} manquantes`, 'ok');
      } catch (err) {
        status.textContent = `Erreur : ${err.message}`;
      }
    });
    $('#thumbs-run').addEventListener('click', () => {
      runJob('/thumbnails/backfill', $('#thumbs-run'), $('#thumbs-status'));
    });
    $('#thumbs-redo').addEventListener('click', () => {
      if (!confirm('Regénérer TOUTES les miniatures ? Ça peut durer un long moment.')) return;
      runJob('/thumbnails/backfill', $('#thumbs-redo'), $('#thumbs-status'), { body: { redo: true } });
    });

    $('#faces-build').addEventListener('click', () => {
      runJob('/faces/build', $('#faces-build'), $('#facejob-status'));
    });
    $('#faces-match').addEventListener('click', () => {
      runJob('/faces/match', $('#faces-match'), $('#facejob-status'));
    });

    // Onglet Visages
    $('#faces-refresh').addEventListener('click', () => renderFaces(true));
    $('#faces-run-match').addEventListener('click', async () => {
      const btn = $('#faces-run-match');
      const status = $('#faces-status');
      await runJob('/faces/match', btn, status);
      renderFaces(true);
    });

    // Section Gemini
    setupGeminiHandlers();

    // Onglet Doublons
    const dupesRefreshBtn = $('#dupes-refresh');
    if (dupesRefreshBtn) dupesRefreshBtn.addEventListener('click', () => renderDupes(true));
    const dupesHashAllBtn = $('#dupes-hash-all');
    if (dupesHashAllBtn) {
      dupesHashAllBtn.addEventListener('click', async () => {
        const pendingGroups = dupesState.groups.filter((g) => g.state === 'pending');
        if (!pendingGroups.length) {
          alert('Aucun groupe à hasher.');
          return;
        }
        const totalItems = pendingGroups.reduce((s, g) => s + g.items.filter((i) => !i.content_hash).length, 0);
        if (!confirm(`Hasher ${totalItems} fichiers (${pendingGroups.length} groupes) ? Cela peut prendre plusieurs minutes.`)) return;
        dupesHashAllBtn.disabled = true;
        const status = $('#dupes-status');
        let done = 0;
        try {
          for (const g of pendingGroups) {
            status.textContent = `Hash ${done + 1} / ${pendingGroups.length} groupes...`;
            await hashGroup(g);
            done++;
          }
          renderDupes(true);
        } catch (err) {
          alert('Erreur : ' + err.message);
        } finally {
          dupesHashAllBtn.disabled = false;
          dupesHashAllBtn.textContent = 'Hasher tout';
        }
      });
    }
  }

  // ------------------------------------------------------------
  // Gemini analysis monitoring
  // ------------------------------------------------------------
  let geminiPollTimer = null;

  function setupGeminiHandlers() {
    const slider = $('#gem-batch-slider');
    const valEl = $('#gem-batch-val');
    if (slider && valEl) {
      slider.addEventListener('input', () => { valEl.textContent = slider.value; });
    }
    const refreshBtn = $('#gem-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshGeminiStats);
    const unblockBtn = $('#gem-unblock');
    if (unblockBtn) unblockBtn.addEventListener('click', unblockGhosts);
    const retryBtn = $('#gem-retry-errors');
    if (retryBtn) retryBtn.addEventListener('click', retryErrors);
    const forceBtn = $('#gem-force-run');
    if (forceBtn) forceBtn.addEventListener('click', forceRunCron);
    const cronBtn = $('#gem-apply-cron');
    if (cronBtn) cronBtn.addEventListener('click', applyCronBatch);
    setupSuppHandlers();
  }

  function onGeminiOpen() {
    refreshGeminiStats();
    renderSuppBatch();
    if (geminiPollTimer) clearInterval(geminiPollTimer);
    geminiPollTimer = setInterval(refreshGeminiStats, 15000);
  }

  function stopGeminiPolling() {
    if (geminiPollTimer) { clearInterval(geminiPollTimer); geminiPollTimer = null; }
  }

  async function refreshGeminiStats() {
    if (typeof sb === 'undefined') return;
    try {
      const { data: stats, error: e1 } = await sb.rpc('gemini_status_counts');
      if (e1 || !stats) {
        await fallbackStats();
      } else {
        renderGeminiStats(stats);
      }
    } catch (err) {
      await fallbackStats();
    }

    // Erreurs récentes
    try {
      const { data: errors } = await sb
        .from('video_library')
        .select('id,file_name,analysis_error,updated_at')
        .eq('analysis_status', 'error')
        .order('updated_at', { ascending: false })
        .limit(10);
      renderGeminiErrors(errors || []);
    } catch (e) {}

    // Throughput 24h — on compte done + analyzed (les deux = Gemini terminé)
    try {
      const since = new Date(Date.now() - 24*3600*1000).toISOString();
      const { data: done } = await sb
        .from('video_library')
        .select('analyzed_at')
        .in('analysis_status', ['done', 'analyzed'])
        .gte('analyzed_at', since);
      renderThroughput(done || []);
    } catch (e) {}
  }

  async function fallbackStats() {
    const statuses = ['done', 'analyzed', 'processing', 'pending', 'error', 'skipped'];
    const stats = [];
    for (const s of statuses) {
      const { count } = await sb
        .from('video_library')
        .select('id', { count: 'exact', head: true })
        .eq('analysis_status', s);
      stats.push({ status: s, n: count || 0 });
    }
    renderGeminiStats(stats);
  }

  function renderGeminiStats(rows) {
    const map = {};
    for (const r of rows || []) {
      const k = r.status || r.analysis_status;
      const v = r.n ?? r.count ?? 0;
      map[k] = typeof v === 'string' ? parseInt(v, 10) : v;
    }
    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set('#gem-done', map.done || 0);
    set('#gem-analyzed', map.analyzed || 0);
    set('#gem-processing', map.processing || 0);
    set('#gem-pending', map.pending || 0);
    set('#gem-error', map.error || 0);
    set('#gem-skipped', map.skipped || 0);
  }

  function renderGeminiErrors(errors) {
    const wrap = $('#gemini-errors');
    if (!errors.length) {
      wrap.innerHTML = '<em>Aucune erreur récente</em>';
      return;
    }
    wrap.innerHTML = errors.map(e => `
      <div class="gemini-error-row">
        <span class="file" title="${escapeAttr(e.file_name || e.id)}">${escapeHtml(e.file_name || e.id)}</span>
        <span class="msg" title="${escapeAttr(e.analysis_error || '')}">${escapeHtml((e.analysis_error || 'Sans message').slice(0, 80))}</span>
        <button data-id="${e.id}">Réessayer</button>
      </div>
    `).join('');
    wrap.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = '...';
        const { error } = await sb
          .from('video_library')
          .update({ analysis_status: 'pending', analysis_error: null })
          .eq('id', id);
        if (error) { btn.textContent = 'Err'; logLine(`Retry ${id} : ${error.message}`, 'error'); return; }
        logLine(`Retry ${id} → pending`, 'ok');
        refreshGeminiStats();
      });
    });
  }

  function renderThroughput(rows) {
    // 24 buckets d'1h
    const buckets = new Array(24).fill(0);
    const now = Date.now();
    for (const r of rows) {
      const t = new Date(r.analyzed_at).getTime();
      const hAgo = Math.floor((now - t) / 3600000);
      if (hAgo >= 0 && hAgo < 24) buckets[23 - hAgo]++;
    }
    const max = Math.max(1, ...buckets);
    const wrap = $('#gemini-throughput');
    wrap.innerHTML = buckets.map((n, i) => {
      const h = Math.max(2, Math.round(n / max * 100));
      const hour = (24 - i);
      return `<div class="bar" style="height:${h}%"><span class="tip">${n} il y a ${hour}h</span></div>`;
    }).join('');
  }

  async function unblockGhosts() {
    const status = $('#gem-status');
    status.textContent = 'Déblocage...';
    const cutoff = new Date(Date.now() - 15*60*1000).toISOString();
    const { error, count } = await sb
      .from('video_library')
      .update({ analysis_status: 'pending' }, { count: 'exact' })
      .eq('analysis_status', 'processing')
      .lt('updated_at', cutoff);
    if (error) { status.textContent = `Erreur : ${error.message}`; return; }
    status.textContent = `${count || 0} fantômes débloqués`;
    logLine(`Gemini : ${count || 0} fantômes → pending`, 'ok');
    refreshGeminiStats();
  }

  async function retryErrors() {
    const status = $('#gem-status');
    status.textContent = 'Reset des erreurs...';
    const { error, count } = await sb
      .from('video_library')
      .update({ analysis_status: 'pending', analysis_error: null }, { count: 'exact' })
      .eq('analysis_status', 'error');
    if (error) { status.textContent = `Erreur : ${error.message}`; return; }
    status.textContent = `${count || 0} erreurs → pending`;
    logLine(`Gemini : ${count || 0} erreurs réessayées`, 'ok');
    refreshGeminiStats();
  }

  async function forceRunCron() {
    const status = $('#gem-status');
    const batch = parseInt($('#gem-batch-slider').value || '30', 10);
    status.textContent = `Envoi ${batch} clips à Gemini...`;
    const { data, error } = await sb.rpc('analyze_pending_clips', { batch_size: batch });
    if (error) { status.textContent = `Erreur : ${error.message}`; return; }
    status.textContent = `${data} clips envoyés`;
    logLine(`Gemini : ${data} clips lancés (batch ${batch})`, 'ok');
    setTimeout(refreshGeminiStats, 1500);
  }

  async function applyCronBatch() {
    const status = $('#gem-status');
    const batch = parseInt($('#gem-batch-slider').value || '30', 10);
    status.textContent = 'Mise à jour cron...';
    const { error } = await sb.rpc('set_gemini_cron_batch', { new_batch: batch });
    if (error) {
      status.textContent = `RPC manquante : crée set_gemini_cron_batch ou modifie le cron via SQL`;
      logLine(`set_gemini_cron_batch : ${error.message}`, 'error');
      return;
    }
    status.textContent = `Cron mis à jour → batch ${batch}`;
    logLine(`Cron Gemini → batch ${batch}`, 'ok');
  }

  // ------------------------------------------------------------
  // Analyses Gemini complémentaires (on-demand par clip)
  // ------------------------------------------------------------
  const SUPP_KINDS = [
    { key: 'reel_pitch', label: '🎯 Pitchs Reel', desc: '3 angles narratifs' },
    { key: 'cut_points', label: '✂︎ Points de coupe', desc: 'Segments exploitables' },
    { key: 'captions',   label: '📝 Captions overlay', desc: '3 stratégies de texte' },
  ];

  async function renderSuppBatch() {
    const grid = $('#supp-kinds-grid');
    if (!grid || typeof sb === 'undefined') return;
    const status = $('#supp-status');
    if (status) status.textContent = 'Chargement...';

    // On récupère tous les statuts pour tous les kinds en une passe.
    // Volume raisonnable : quelques centaines de lignes max à ce stade.
    const { data, error } = await sb
      .from('clip_supplementary_analyses')
      .select('kind,status')
      .limit(5000);

    if (error) {
      grid.innerHTML = `<div class="maint-status" style="color:#ff9a9a">Erreur : ${escapeHtml(error.message)}</div>`;
      if (status) status.textContent = '';
      return;
    }

    // Regrouper par kind
    const buckets = {};
    for (const k of SUPP_KINDS) buckets[k.key] = { done: 0, processing: 0, error: 0, total: 0 };
    for (const row of data || []) {
      const b = buckets[row.kind];
      if (!b) continue;
      b.total++;
      if (row.status === 'done') b.done++;
      else if (row.status === 'processing') b.processing++;
      else if (row.status === 'error') b.error++;
    }

    grid.innerHTML = SUPP_KINDS.map(k => {
      const b = buckets[k.key];
      return `
        <div class="supp-kind-card" data-kind="${escapeAttr(k.key)}">
          <div class="kind-name">${escapeHtml(k.label)}</div>
          <div style="font-size:11px;opacity:0.65;margin-bottom:8px">${escapeHtml(k.desc)}</div>
          <div class="counts">
            <span class="c-done">${b.done} done</span>
            <span class="c-processing">${b.processing} en cours</span>
            <span class="c-error">${b.error} err</span>
          </div>
          <div style="font-size:11px;opacity:0.55;margin-top:6px">Total : ${b.total}</div>
          <div class="batch-controls">
            <select class="supp-batch-filter" data-kind="${escapeAttr(k.key)}">
              <option value="missing">Manquants</option>
              <option value="error">Erreurs</option>
              <option value="all">Tout (re-run)</option>
            </select>
            <button class="supp-batch-btn" data-kind="${escapeAttr(k.key)}">Lancer batch</button>
          </div>
          <div class="batch-progress" data-kind="${escapeAttr(k.key)}"></div>
        </div>
      `;
    }).join('');

    // Wiring des boutons batch (nouvellement injectés)
    grid.querySelectorAll('.supp-batch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind;
        const sel = grid.querySelector(`.supp-batch-filter[data-kind="${kind}"]`);
        const filter = sel ? sel.value : 'missing';
        runSuppBatchForKind(kind, filter, btn);
      });
    });

    if (status) status.textContent = `Actualisé ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }

  function setupSuppHandlers() {
    const btn = $('#supp-refresh');
    if (btn && !btn.dataset.bound) {
      btn.addEventListener('click', renderSuppBatch);
      btn.dataset.bound = '1';
    }
    const vbaseBtn = $('#vbase-batch-run');
    if (vbaseBtn && !vbaseBtn.dataset.bound) {
      vbaseBtn.addEventListener('click', runVBaseBatch);
      vbaseBtn.dataset.bound = '1';
    }
  }

  // Rate limit : 2s entre appels Gemini pour rester en dessous des limites Tier 1.
  const SUPP_BATCH_DELAY_MS = 2000;
  // Plafond de sécurité pour éviter de lancer 1000 clips par erreur.
  const SUPP_BATCH_MAX = 200;
  const SUPP_EDGE_URL = 'https://zrdlvoovrnglxcgoyyeb.supabase.co/functions/v1/analyze-clip-supplementary';
  // Clé publique (anon) Supabase, identique à celle utilisée dans app.js.
  const SUPP_ANON_KEY = 'sb_publishable_ukrn7WQHygY5FUtNiMxxfA_E-esyAUs';

  async function collectClipIdsForSuppBatch(kind, filter) {
    // Récupère la liste d'IDs de clips à traiter selon le filtre.
    if (filter === 'error') {
      // Clips qui ont une ligne en error pour ce kind.
      const { data, error } = await sb
        .from('clip_supplementary_analyses')
        .select('clip_id')
        .eq('kind', kind)
        .eq('status', 'error');
      if (error) throw error;
      return Array.from(new Set((data || []).map(r => r.clip_id)));
    }
    if (filter === 'missing') {
      // Clips sans ligne done pour ce kind.
      // 1. Tous les clips analysés par v-base (done/analyzed)
      const { data: allClips, error: e1 } = await sb
        .from('video_library')
        .select('id')
        .in('analysis_status', ['done', 'analyzed']);
      if (e1) throw e1;
      // 2. Clips qui ont déjà une ligne done pour ce kind
      const { data: existing, error: e2 } = await sb
        .from('clip_supplementary_analyses')
        .select('clip_id')
        .eq('kind', kind)
        .eq('status', 'done');
      if (e2) throw e2;
      const doneSet = new Set((existing || []).map(r => r.clip_id));
      return (allClips || []).map(r => r.id).filter(id => !doneSet.has(id));
    }
    if (filter === 'all') {
      // Re-run sur tout ce qui a été analysé par v-base.
      const { data, error } = await sb
        .from('video_library')
        .select('id')
        .in('analysis_status', ['done', 'analyzed']);
      if (error) throw error;
      return (data || []).map(r => r.id);
    }
    return [];
  }

  async function runSuppBatchForKind(kind, filter, btnEl) {
    const card = btnEl.closest('.supp-kind-card');
    const progressEl = card ? card.querySelector('.batch-progress') : null;
    const setProgress = (txt) => { if (progressEl) progressEl.textContent = txt; };

    setProgress('Recherche des clips...');
    btnEl.disabled = true;

    let ids;
    try {
      ids = await collectClipIdsForSuppBatch(kind, filter);
    } catch (err) {
      setProgress(`Erreur : ${err.message}`);
      btnEl.disabled = false;
      return;
    }

    if (!ids.length) {
      setProgress('Aucun clip à traiter.');
      btnEl.disabled = false;
      return;
    }

    let toProcess = ids;
    let capped = false;
    if (toProcess.length > SUPP_BATCH_MAX) {
      toProcess = toProcess.slice(0, SUPP_BATCH_MAX);
      capped = true;
    }

    const confirmMsg = `Lancer ${kind} sur ${toProcess.length} clip${toProcess.length > 1 ? 's' : ''}${capped ? ` (plafonné à ${SUPP_BATCH_MAX} sur ${ids.length})` : ''} ?\nDélai ${SUPP_BATCH_DELAY_MS/1000}s entre chaque, temps estimé : ${Math.round(toProcess.length * SUPP_BATCH_DELAY_MS / 1000 / 60 * 10) / 10} min.`;
    if (!confirm(confirmMsg)) {
      setProgress('Annulé.');
      btnEl.disabled = false;
      return;
    }

    let ok = 0, fail = 0, skipped = 0;
    for (let i = 0; i < toProcess.length; i++) {
      const clipId = toProcess[i];
      setProgress(`${i + 1}/${toProcess.length} — ok:${ok} skip:${skipped} err:${fail}`);
      try {
        const resp = await fetch(SUPP_EDGE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPP_ANON_KEY}`,
          },
          body: JSON.stringify({ clip_id: clipId, kind, force: filter === 'all' }),
        });
        if (!resp.ok) {
          fail++;
        } else {
          const r = await resp.json();
          if (r.skipped) skipped++;
          else ok++;
        }
      } catch (_) {
        fail++;
      }
      if (i < toProcess.length - 1) await sleep(SUPP_BATCH_DELAY_MS);
    }

    setProgress(`Terminé. ok:${ok} skip:${skipped} err:${fail} (sur ${toProcess.length})`);
    logLine(`Supp ${kind} (${filter}) : ${ok} ok / ${skipped} skip / ${fail} err`, fail ? 'error' : 'ok');
    btnEl.disabled = false;
    renderSuppBatch();
  }

  async function runVBaseBatch() {
    const filter = $('#vbase-filter').value;
    const btn = $('#vbase-batch-run');
    const status = $('#vbase-batch-status');
    if (!filter || !btn) return;

    const labels = {
      error: 'les clips en erreur',
      missing: 'les clips jamais analysés',
      done: 'tous les clips déjà done (re-run)',
      all: 'TOUS les clips (sauf processing)',
    };
    if (!confirm(`Marquer en pending : ${labels[filter] || filter} ?\nLe cron Gemini les reprendra sous 2 min.`)) {
      status.textContent = 'Annulé.';
      return;
    }

    btn.disabled = true;
    status.textContent = 'Mise à jour...';

    let q = sb.from('video_library').update({ analysis_status: 'pending', analysis_error: null }, { count: 'exact' });
    if (filter === 'error') {
      q = q.eq('analysis_status', 'error');
    } else if (filter === 'missing') {
      q = q.is('analysis_status', null);
    } else if (filter === 'done') {
      q = q.in('analysis_status', ['done', 'analyzed']);
    } else if (filter === 'all') {
      q = q.neq('analysis_status', 'processing');
    }

    const { error, count } = await q;
    btn.disabled = false;
    if (error) {
      status.textContent = `Erreur : ${error.message}`;
      logLine(`V-base batch ${filter} : ${error.message}`, 'error');
      return;
    }
    status.textContent = `${count || 0} clips → pending`;
    logLine(`V-base batch ${filter} : ${count || 0} clips remis en pending`, 'ok');
    setTimeout(refreshGeminiStats, 1500);
  }

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ------------------------------------------------------------
  // Boot — on attend que l'app principale ait démarré (l'app auth bascule
  // sur #app ; on se contente d'accrocher les handlers DOM, le reste est
  // chargé à la 1re ouverture de l'onglet)
  // ------------------------------------------------------------
  function init() {
    if (!$('#view-tabs')) return; // Pas la bonne page
    setupTabs();
    setupRecordings();
    setupMaintenanceHandlers();
    setupMonteesFilters();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
