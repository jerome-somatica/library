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
      faces: $('#view-faces'),
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
        if (target === 'faces') renderFaces();
        if (target === 'maintenance') onMaintenanceOpen();
      });
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
    setupMaintenanceHandlers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
