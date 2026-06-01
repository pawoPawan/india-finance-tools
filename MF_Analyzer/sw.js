/**
 * MF Analyzer — Service Worker (replaces Flask backend for GitHub Pages)
 * Intercepts all /api/* requests and handles them entirely in-browser.
 *
 * Architecture:
 *  - idb.js   : IndexedDB persistence (funds, holdings, config)
 *  - analytics.js : scoring, filtering, aggregation
 *  - fetcher.js   : Morningstar API calls via Cloudflare proxy
 *
 * Bulk fetch runs in the PAGE context (not here — SW can be suspended).
 * The page posts BULK_UPDATE messages to keep IDB state in sync.
 */

'use strict';
importScripts('./idb.js?v=5', './analytics.js?v=5', './fetcher.js?v=5');

// ── In-memory caches (cleared on SW restart) ─────────────────────────────────
let _fundsCache   = null;   // Array<fund>  — loaded from IDB
let _fundCountKey = -1;     // IDB fund count when _fundsCache was built
let _anlCache     = null;   // computeAnalytics() result
let _anlCountKey  = -1;     // IDB holding count when _anlCache was built
let _secIdx       = null;   // buildSecIndex() result
let _secIdxKey    = -1;     // IDB holding count when _secIdx was built

// ── SW lifecycle ──────────────────────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// ── Page → SW message channel ─────────────────────────────────────────────────
self.addEventListener('message', e => {
  const { type, payload } = e.data || {};
  switch (type) {
    case 'BULK_UPDATE':
      // Page posts state after each fund is fetched/skipped
      MFidb.setBulkState(payload).catch(() => {});
      // Invalidate analytics cache so next GET /api/analytics recomputes
      _anlCache = null;
      break;
    case 'INVALIDATE_FUNDS':
      _fundsCache = null;
      break;
    case 'INVALIDATE_ANALYTICS':
      _anlCache = null;
      _secIdx   = null;
      break;
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
  }
});

// ── Fetch intercept ───────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Support both root-deployed (/api/*) and subdirectory-deployed (.../MF_Analyzer/api/*)
  const apiIdx = url.pathname.indexOf('/api/');
  if (apiIdx === -1) return;   // pass through non-API requests
  // Rewrite pathname to always start with /api/ for the router
  const apiUrl = new URL(url);
  apiUrl.pathname = url.pathname.slice(apiIdx);
  e.respondWith(handleAPI(e.request, apiUrl));
});

// ── JSON response helpers ─────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function apiErr(msg, status = 400) { return json({ error: String(msg) }, status); }

// ── Main router ───────────────────────────────────────────────────────────────
async function handleAPI(req, url) {
  const p  = url.pathname;
  const m  = req.method;
  const sp = url.searchParams;

  try {

    // ── Config ───────────────────────────────────────────────────────────────
    if (p === '/api/config/proxy') {
      if (m === 'GET') {
        const proxy = (await MFidb.getConfig('proxy_url')) || '';
        MFfetcher.setProxy(proxy);
        return json({ proxy });
      }
      if (m === 'POST') {
        const { proxy = '' } = await req.json();
        const trimmed = proxy.trim().replace(/\/$/, '');
        await MFidb.setConfig('proxy_url', trimmed);
        MFfetcher.setProxy(trimmed);
        return json({ ok: true });
      }
    }

    if (p === '/api/config/sal-headers' && m === 'POST') {
      const { headers = {} } = await req.json();
      await MFfetcher.setSALHeadersManual(headers);
      return json({ ok: true });
    }

    if (p === '/api/config/sal-headers' && m === 'DELETE') {
      await MFidb.setConfig('sal_headers', null);
      return json({ ok: true });
    }

    // ── Data import / export ─────────────────────────────────────────────────
    if (p === '/api/data/import' && m === 'POST') {
      const body = await req.json();
      if (body.funds && Array.isArray(body.funds) && body.funds.length) {
        await MFidb.saveFunds(body.funds);
        _fundsCache = null;
      }
      if (body.holdings && typeof body.holdings === 'object') {
        const batch = Object.values(body.holdings).filter(Boolean);
        if (batch.length) {
          await MFidb.saveHoldingsBatch(batch);
          _anlCache = null;
          _secIdx   = null;
        }
      }
      return json({ ok: true,
        fundsImported:    body.funds    ? body.funds.length               : 0,
        holdingsImported: body.holdings ? Object.keys(body.holdings).length : 0,
      });
    }

    if (p === '/api/data/export' && m === 'GET') {
      const funds    = await _getFunds();
      const holdings = await MFidb.exportHoldings();
      return json({ funds, holdings });
    }

    if (p === '/api/data/clear' && m === 'POST') {
      const { what = 'all' } = await req.json().catch(() => ({}));
      if (what === 'funds' || what === 'all') {
        await MFidb.clearFunds();
        _fundsCache = null;
      }
      if (what === 'holdings' || what === 'all') {
        await MFidb.clearHoldings();
        _anlCache = null;
        _secIdx   = null;
      }
      if (what === 'all') {
        await MFidb.setBulkState({ running:false, done:0, total:0, errors:0,
                                   stop:false, stopped:false, savedAt:0 });
      }
      return json({ ok: true });
    }

    // ── Fund list (from IDB) ──────────────────────────────────────────────────
    if (p === '/api/meta' && m === 'GET') {
      const funds = await _getFunds();
      return json(MFAnalytics.computeMeta(funds));
    }

    if (p === '/api/funds' && m === 'GET') {
      const funds  = await _getFunds();
      const params = Object.fromEntries(sp.entries());
      return json(MFAnalytics.filterAndSort(funds, params));
    }

    if (p === '/api/fund-type-counts' && m === 'GET') {
      const funds = await _getFunds();
      return json(MFAnalytics.computeTypeCounts(funds));
    }

    // ── Refresh fund list from Morningstar (runs async, responds immediately) ─
    if (p === '/api/funds/refresh' && m === 'POST') {
      const proxyUrl = (await MFidb.getConfig('proxy_url')) || '';
      MFfetcher.setProxy(proxyUrl);
      await MFidb.setConfig('refresh_state', {
        running: true, fetched: 0, total: 0, startedAt: Date.now(),
      });
      // Fire and forget — progress tracked in IDB 'refresh_state'
      _runFundRefresh().catch(async e => {
        await MFidb.setConfig('refresh_state', {
          running: false, error: e.message, doneAt: Date.now(),
        });
      });
      return json({ ok: true, status: 'started' });
    }

    if (p === '/api/funds/refresh-status' && m === 'GET') {
      const state = (await MFidb.getConfig('refresh_state')) || { running: false };
      return json(state);
    }

    // ── Holdings (individual fund) ────────────────────────────────────────────
    if (p.startsWith('/api/holdings/') && m === 'GET') {
      const secId = decodeURIComponent(p.slice('/api/holdings/'.length));
      if (!secId) return apiErr('Missing secId', 400);
      const data = await MFidb.getHolding(secId);
      if (!data) return apiErr('Not found', 404);
      return json(data);
    }

    // Fetch (or refresh) full holdings for a single fund — called by fund detail drawer
    if (p.startsWith('/api/holdings/fetch/') && m === 'POST') {
      const secId    = decodeURIComponent(p.slice('/api/holdings/fetch/'.length));
      const { name } = await req.json().catch(() => ({}));
      const proxyUrl = (await MFidb.getConfig('proxy_url')) || '';
      MFfetcher.setProxy(proxyUrl);
      const data = await MFfetcher.fetchFullHoldings(secId, name || secId);
      if (!data) return apiErr('Holdings unavailable', 404);
      await MFidb.saveHolding(data);
      _anlCache = null;
      _secIdx   = null;
      return json(data);
    }

    // ── Analytics (aggregated) ────────────────────────────────────────────────
    if (p === '/api/analytics' && m === 'GET') {
      return json(await _getAnalytics());
    }

    if (p === '/api/analytics/entity' && m === 'GET') {
      const name = sp.get('name') || '';
      const type = sp.get('type') || 'equity';
      if (!name) return apiErr('Missing name');
      const raw = await MFAnalytics.computeEntityDetail(name, type);
      // Normalize field names to match the UI: name → fundName
      const funds = raw.map(r => ({ ...r, fundName: r.fundName || r.name, amc: r.amc || '', stars: r.stars || 0, score: r.score || null }));
      return json({ totalFunds: funds.length, funds });
    }

    // ── Bulk fetch control ────────────────────────────────────────────────────
    // The actual fetch loop runs in PAGE context. SW just manages IDB state.

    if (p === '/api/analytics/bulk-status' && m === 'GET') {
      const state = await MFidb.getBulkState();
      const funds = await _getFunds();
      return json({ ...state, total: funds.length });
    }

    if (p === '/api/analytics/bulk-fetch' && m === 'POST') {
      // Page will start/resume the loop after receiving this response
      const state = await MFidb.getBulkState();
      await MFidb.setBulkState({ ...state, stop: false, stopped: false, running: true });
      const funds = await _getFunds();
      return json({ ok: true, status: 'running', total: funds.length });
    }

    if (p === '/api/analytics/bulk-stop' && m === 'POST') {
      const state = await MFidb.getBulkState();
      await MFidb.setBulkState({ ...state, stop: true });
      return json({ ok: true });
    }

    if (p === '/api/analytics/bulk-restart' && m === 'POST') {
      await MFidb.clearHoldings();
      await MFidb.setBulkState({ running:false, done:0, total:0, errors:0,
                                  stop:false, stopped:false, savedAt:0 });
      _anlCache = null;
      _secIdx   = null;
      const funds = await _getFunds();
      return json({ ok: true, total: funds.length });
    }

    // ── Securities autocomplete ───────────────────────────────────────────────
    if (p === '/api/securities' && m === 'GET') {
      const q    = (sp.get('q') || '').toLowerCase();
      const type = sp.get('type') || 'equity';
      const idx  = await _getSecIndex();
      const map  = type === 'bond' ? idx.bond : idx.equity;
      const entries = Object.entries(map);
      const filtered = q
        ? entries.filter(([nm]) => nm.toLowerCase().includes(q))
        : entries;
      const top = filtered
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([name, fundCount]) => ({ name, fundCount }));
      return json(top);
    }

    // ── Fund finder ───────────────────────────────────────────────────────────
    if (p === '/api/find-funds' && m === 'POST') {
      const body     = await req.json();
      const equities = (body.equities || []).filter(Boolean);
      const bonds    = (body.bonds    || []).filter(Boolean);
      if (!equities.length && !bonds.length) return json([]);
      const funds   = await _getFunds();
      const results = await MFAnalytics.findFunds(equities, bonds, funds);
      return json(results);
    }

    // ── Sell simulator helper — holdings for a fund ──────────────────────────
    if (p.startsWith('/api/sell-sim/') && m === 'GET') {
      const secId = decodeURIComponent(p.slice('/api/sell-sim/'.length));
      const data  = await MFidb.getHolding(secId);
      return json(data || { secId, equityHoldings: [], bondHoldings: [] });
    }

    return apiErr('Not found', 404);

  } catch (e) {
    console.error('[SW] API error:', p, e);
    return apiErr(e.message || 'Internal error', 500);
  }
}

// ── Cached helpers ────────────────────────────────────────────────────────────

async function _getFunds() {
  const count = await MFidb.getFundCount();
  if (_fundsCache && count === _fundCountKey) return _fundsCache;
  _fundsCache   = await MFidb.getFunds();
  _fundCountKey = count;
  return _fundsCache;
}

async function _getAnalytics() {
  const count = await MFidb.getHoldingCount();
  if (_anlCache && count === _anlCountKey) return _anlCache;
  _anlCache    = await MFAnalytics.computeAnalytics();
  _anlCountKey = count;
  return _anlCache;
}

async function _getSecIndex() {
  const count = await MFidb.getHoldingCount();
  if (_secIdx && count === _secIdxKey) return _secIdx;
  _secIdx    = await MFAnalytics.buildSecIndex();
  _secIdxKey = count;
  return _secIdx;
}

// ── Fund list refresh (background, async) ─────────────────────────────────────
async function _runFundRefresh() {
  const proxy = (await MFidb.getConfig('proxy_url')) || '';
  MFfetcher.setProxy(proxy);

  const funds = await MFfetcher.fetchAllFunds(async (fetched, total) => {
    await MFidb.setConfig('refresh_state', {
      running: true, fetched, total, startedAt: Date.now(),
    });
  });

  if (funds.length) {
    await MFidb.saveFunds(funds);
    _fundsCache = null;
  }

  await MFidb.setConfig('refresh_state', {
    running: false, fetched: funds.length, total: funds.length, doneAt: Date.now(),
  });
}
