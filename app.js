/* ========================================
   Partner Link Tracker — App Logic
   Short.io API integration, state, rendering
   ======================================== */

(() => {
  'use strict';

  // ─── Configuration ───
  const CONFIG = {
    DOMAIN: 'alcovialife.short.gy',
    DOMAIN_ID: 1667143,
    API_BASE: 'https://api.short.io',
    STATS_BASE: 'https://statistics.short.io',
    LINKS_PER_PAGE: 150,
  };

  // ─── Seed known partners (keyed by Short.io link path/slug) ───
  // These are partners whose links already exist in Short.io.
  // On first load, we match them by path and store in localStorage.
  const SEED_PARTNERS = {
    'bOAwS8': { name: 'Kavya' },
    '0nQRfi': { name: 'Test Partner' },
  };

  // ─── State ───
  const state = {
    apiKey: 'sk_LJK53T8xGgloqR3U',
    links: [],       // raw link objects from Short.io
    stats: {},       // linkId → stats object
    merged: [],      // links + stats merged (filtered to tracked only)
    sortField: null,
    sortAsc: true,
  };

  // ─── DOM References ───
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    addPartnerModal: $('#addPartnerModal'),
    addPartnerForm: $('#addPartnerForm'),
    addPartnerError: $('#addPartnerError'),
    addPartnerBtn: $('#addPartnerBtn'),
    closeAddPartner: $('#closeAddPartner'),
    addPartnerTrigger: $('#addPartnerTrigger'),
    dashboard: $('#dashboard'),
    refreshBtn: $('#refreshBtn'),
    // Summary cards
    totalLinks: $('#totalLinks'),
    totalClicks: $('#totalClicks'),
    humanClicks: $('#humanClicks'),
    botClicks: $('#botClicks'),
    // Filters
    searchPartner: $('#searchPartner'),
    searchPath: $('#searchPath'),
    filterStatus: $('#filterStatus'),
    // Table
    loadingState: $('#loadingState'),
    emptyState: $('#emptyState'),
    partnerTable: $('#partnerTable'),
    tableBody: $('#tableBody'),
    lastUpdated: $('#lastUpdated'),
  };

  // ─── API Layer ───

  function apiHeaders() {
    return {
      'Authorization': state.apiKey,
      'Accept': 'application/json',
    };
  }

  async function fetchAllLinks() {
    const targetUrl = `${CONFIG.API_BASE}/api/links?domain_id=${CONFIG.DOMAIN_ID}&limit=${CONFIG.LINKS_PER_PAGE}&_t=${Date.now()}`;
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;

    const res = await fetch(proxyUrl, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch links: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return data.links || [];
  }

  async function fetchLinkStats(linkId) {
    // Exact same endpoint as the n8n workflow: api-v2.short.io with domain_id param
    const targetUrl = `https://api-v2.short.io/statistics/link/${linkId}?period=total&tzOffset=0&domain_id=${CONFIG.DOMAIN_ID}&_t=${Date.now()}`;
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;

    try {
      const res = await fetch(proxyUrl, {
        headers: {
          'Authorization': state.apiKey,
          'accept': 'application/json',
        },
      });
      if (!res.ok) return null;
      const data = await res.json();

      // Short.io sometimes has lag where totalClicks=0 but clickStatistics shows real data.
      // Sum the clickStatistics dataset as a fallback for more accurate counts.
      let statsTotal = 0;
      if (data.clickStatistics && data.clickStatistics.datasets) {
        data.clickStatistics.datasets.forEach((ds) => {
          if (ds.data) {
            ds.data.forEach((point) => {
              statsTotal += Number(point.y) || 0;
            });
          }
        });
      }

      return {
        totalClicks: Math.max(Number(data.totalClicks) || 0, statsTotal),
        humanClicks: Number(data.humanClicks) || 0,
      };
    } catch (e) {
      console.error(`Stats error for ${linkId}:`, e);
      return null;
    }
  }

  async function createShortLink({ originalURL, slug }) {
    const body = {
      originalURL,
      domain: CONFIG.DOMAIN,
    };
    if (slug) body.path = slug;

    const targetUrl = `${CONFIG.API_BASE}/links`;
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;

    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        ...apiHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Failed to create link: ${res.status}`);
    }
    return await res.json();
  }

  // ─── Partner Metadata (localStorage) ───

  function getPartnerMeta() {
    try {
      return JSON.parse(localStorage.getItem('partnerMeta') || '{}');
    } catch {
      return {};
    }
  }

  function setPartnerMeta(linkId, meta) {
    const all = getPartnerMeta();
    all[linkId] = { ...all[linkId], ...meta };
    localStorage.setItem('partnerMeta', JSON.stringify(all));
  }

  function isTrackedPartner(linkId) {
    const meta = getPartnerMeta();
    return !!meta[linkId];
  }

  // Seed known partners on first run by matching paths
  function seedPartners(links) {
    const meta = getPartnerMeta();
    let changed = false;
    links.forEach((link) => {
      const linkId = link.idString || link.id;
      const path = link.path || '';
      if (SEED_PARTNERS[path] && !meta[linkId]) {
        meta[linkId] = { ...SEED_PARTNERS[path] };
        changed = true;
      }
    });
    if (changed) {
      localStorage.setItem('partnerMeta', JSON.stringify(meta));
    }
  }

  // ─── Data Loading ───

  async function loadDashboard() {
    showLoading(true);
    try {
      const links = await fetchAllLinks();
      state.links = links;

      // Seed known partners on first load
      seedPartners(links);

      // Only fetch stats for tracked partners
      const meta = getPartnerMeta();
      const trackedLinks = links.filter((link) => {
        const linkId = link.idString || link.id;
        return !!meta[linkId];
      });

      const stats = {};

      // Fetch stats individually for tracked links (with cache-busting)
      const batchSize = 5;
      for (let i = 0; i < trackedLinks.length; i += batchSize) {
        const batch = trackedLinks.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map((link) => fetchLinkStats(link.idString || link.id))
        );
        batch.forEach((link, idx) => {
          const linkId = link.idString || link.id;
          if (results[idx]) {
            stats[linkId] = results[idx];
          }
        });
      }

      state.stats = stats;

      // Merge (only tracked partners)
      mergeData();
      renderSummary();
      renderTable();
      updateTimestamp();
    } catch (err) {
      console.error('Load error:', err);
      showError('Failed to load data. Please try again.');
    } finally {
      showLoading(false);
    }
  }

  function mergeData() {
    const meta = getPartnerMeta();
    // Only include links that are tracked (have partner metadata)
    state.merged = state.links
      .filter((link) => {
        const linkId = link.idString || link.id;
        return !!meta[linkId];
      })
      .map((link) => {
        const linkId = link.idString || link.id;
        const stat = state.stats[linkId] || {};
        const partnerInfo = meta[linkId] || {};
        const totalClicks = Number(stat.totalClicks) || 0;
        const humanClicks = Number(stat.humanClicks) || 0;
        const botClicks = Math.max(0, totalClicks - humanClicks);
        return {
          linkId,
          partnerName: partnerInfo.name || link.title || '—',
          partnerEmail: partnerInfo.email || '',
          partnerPhone: partnerInfo.phone || '',
          shortURL: link.secureShortURL || link.shortURL || '',
          path: link.path || '',
          originalURL: link.originalURL || '',
          totalClicks,
          humanClicks,
          botClicks,
          status: link.archived ? 'inactive' : 'active',
          createdAt: link.createdAt,
        };
      });
  }

  // ─── Rendering ───

  function renderSummary() {
    const data = getFilteredData();
    const totals = data.reduce(
      (acc, d) => {
        acc.totalClicks += d.totalClicks;
        acc.humanClicks += d.humanClicks;
        acc.botClicks += d.botClicks;
        return acc;
      },
      { totalClicks: 0, humanClicks: 0, botClicks: 0 }
    );

    dom.totalLinks.textContent = formatNumber(data.length);
    dom.totalClicks.textContent = formatNumber(totals.totalClicks);
    dom.humanClicks.textContent = formatNumber(totals.humanClicks);
    dom.botClicks.textContent = formatNumber(totals.botClicks);
  }

  function renderTable() {
    const data = getFilteredData();

    if (data.length === 0) {
      dom.partnerTable.classList.add('hidden');
      dom.emptyState.classList.remove('hidden');
      return;
    }

    dom.emptyState.classList.add('hidden');
    dom.partnerTable.classList.remove('hidden');

    // Sort
    if (state.sortField) {
      data.sort((a, b) => {
        let va = a[state.sortField];
        let vb = b[state.sortField];
        if (typeof va === 'string') {
          va = va.toLowerCase();
          vb = (vb || '').toLowerCase();
        }
        if (va < vb) return state.sortAsc ? -1 : 1;
        if (va > vb) return state.sortAsc ? 1 : -1;
        return 0;
      });
    }

    dom.tableBody.innerHTML = data.map((d) => `
      <tr>
        <td>
          <div class="partner-name">${escapeHtml(d.partnerName)}</div>
          ${d.partnerEmail ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">${escapeHtml(d.partnerEmail)}</div>` : ''}
        </td>
        <td><a class="short-link" href="${escapeHtml(d.shortURL)}" target="_blank" rel="noopener">${escapeHtml(shortenUrl(d.shortURL))}</a></td>
        <td><span class="path-slug">/${escapeHtml(d.path)}</span></td>
        <td class="metric">${formatNumber(d.totalClicks)}</td>
        <td class="metric">${formatNumber(d.humanClicks)}</td>
        <td class="metric">${formatNumber(d.botClicks)}</td>
        <td><span class="status-badge status-${d.status}">${d.status}</span></td>
      </tr>
    `).join('');
  }

  function getFilteredData() {
    const nameQuery = (dom.searchPartner.value || '').toLowerCase().trim();
    const pathQuery = (dom.searchPath.value || '').toLowerCase().trim();
    const statusFilter = dom.filterStatus.value;

    return state.merged.filter((d) => {
      if (nameQuery && !d.partnerName.toLowerCase().includes(nameQuery) &&
          !d.partnerEmail.toLowerCase().includes(nameQuery)) {
        return false;
      }
      if (pathQuery && !d.path.toLowerCase().includes(pathQuery)) {
        return false;
      }
      if (statusFilter !== 'all' && d.status !== statusFilter) {
        return false;
      }
      return true;
    });
  }

  // ─── Helpers ───

  function formatNumber(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString('en-IN');
  }

  function shortenUrl(url) {
    if (!url) return '';
    return url.replace(/^https?:\/\//, '');
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showLoading(show) {
    dom.loadingState.classList.toggle('hidden', !show);
    if (show) {
      dom.partnerTable.classList.add('hidden');
      dom.emptyState.classList.add('hidden');
    }
  }

  function showError(msg) {
    dom.loadingState.classList.add('hidden');
    dom.emptyState.classList.remove('hidden');
    dom.emptyState.querySelector('h3').textContent = 'Error';
    dom.emptyState.querySelector('p').textContent = msg;
  }

  function updateTimestamp() {
    const now = new Date();
    dom.lastUpdated.textContent = now.toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  // ─── Event Handlers ───

  // Auto-load dashboard on startup
  loadDashboard();

  // Refresh — full re-fetch from API
  dom.refreshBtn.addEventListener('click', async () => {
    dom.refreshBtn.disabled = true;
    dom.refreshBtn.querySelector('.refresh-icon').style.animation = 'spin 0.8s linear infinite';
    // Clear cached stats to force fresh data
    state.stats = {};
    await loadDashboard();
    dom.refreshBtn.disabled = false;
    dom.refreshBtn.querySelector('.refresh-icon').style.animation = '';
  });

  // Filters (debounced)
  let filterTimer;
  function onFilterChange() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      renderSummary();
      renderTable();
    }, 200);
  }

  dom.searchPartner.addEventListener('input', onFilterChange);
  dom.searchPath.addEventListener('input', onFilterChange);
  dom.filterStatus.addEventListener('change', onFilterChange);

  // Sorting
  $$('.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (state.sortField === field) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortField = field;
        state.sortAsc = true;
      }
      // Update active state
      $$('.sortable').forEach((t) => t.classList.remove('active'));
      th.classList.add('active');
      th.textContent = th.textContent.replace(/ [↑↓]$/, '') + (state.sortAsc ? ' ↑' : ' ↓');

      renderTable();
    });
  });

  // Add Partner modal
  dom.addPartnerTrigger.addEventListener('click', () => {
    dom.addPartnerModal.classList.remove('hidden');
    dom.addPartnerError.classList.add('hidden');
    // Reset form but keep default destination URL
    $('#partnerName').value = '';
    $('#partnerEmail').value = '';
    $('#partnerPhone').value = '';
    $('#destinationUrl').value = 'https://alcovia.life/neuromarketing-workshop';
    $('#customSlug').value = '';
  });

  dom.closeAddPartner.addEventListener('click', () => {
    dom.addPartnerModal.classList.add('hidden');
  });

  dom.addPartnerModal.addEventListener('click', (e) => {
    if (e.target === dom.addPartnerModal) {
      dom.addPartnerModal.classList.add('hidden');
    }
  });

  // Add Partner form submit
  dom.addPartnerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    dom.addPartnerError.classList.add('hidden');
    dom.addPartnerBtn.disabled = true;
    dom.addPartnerBtn.querySelector('.btn-text').textContent = 'Creating...';

    const name = $('#partnerName').value.trim();
    const email = $('#partnerEmail').value.trim();
    const phone = $('#partnerPhone').value.trim();
    const destUrl = $('#destinationUrl').value.trim();
    const slug = $('#customSlug').value.trim();

    try {
      const link = await createShortLink({
        originalURL: destUrl,
        slug: slug || undefined,
      });

      // Store partner metadata locally
      const linkId = link.idString || link.id;
      setPartnerMeta(linkId, { name, email, phone });

      // Also try to update the link title via Short.io API
      try {
        const updateUrl = `${CONFIG.API_BASE}/links/${linkId}`;
        const updateProxy = `https://corsproxy.io/?url=${encodeURIComponent(updateUrl)}`;
        await fetch(updateProxy, {
          method: 'POST',
          headers: {
            ...apiHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: name }),
        });
      } catch {
        // Non-critical, metadata is stored locally
      }

      dom.addPartnerModal.classList.add('hidden');
      await loadDashboard();
    } catch (err) {
      dom.addPartnerError.textContent = err.message;
      dom.addPartnerError.classList.remove('hidden');
    } finally {
      dom.addPartnerBtn.disabled = false;
      dom.addPartnerBtn.querySelector('.btn-text').textContent = 'Create Partner Link';
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dom.addPartnerModal.classList.add('hidden');
    }
  });

})();
