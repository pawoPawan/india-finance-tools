/**
 * MF Analyzer — IndexedDB Storage Layer
 * Works in both Service Worker context (importScripts) and page context (<script src>).
 * Replaces: mf_data.json (funds store) + anl_cache.json (holdings store)
 *
 * Stores:
 *   funds    — 13K fund records (~12MB). keyPath: secId
 *   holdings — Per-fund holdings data (~418MB total). keyPath: secId
 *   config   — Key-value settings (proxy URL, tokens, bulk state). keyPath: key
 */
var MFidb = (function () {
  'use strict';

  const DB_NAME = 'MFAnalyzer';
  const DB_VER  = 1;
  let _db = null;

  // Open (or reuse) the IDB connection
  async function open() {
    if (_db) return _db;
    _db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('funds'))
          db.createObjectStore('funds', { keyPath: 'secId' });
        if (!db.objectStoreNames.contains('holdings'))
          db.createObjectStore('holdings', { keyPath: 'secId' });
        if (!db.objectStoreNames.contains('config'))
          db.createObjectStore('config', { keyPath: 'key' });
      };
      req.onsuccess  = e => resolve(e.target.result);
      req.onerror    = e => reject(e.target.error);
      req.onblocked  = () => reject(new Error('IDB blocked'));
    });
    return _db;
  }

  // Generic single-request helper
  async function _req(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const s  = tx.objectStore(store);
      const r  = fn(s);
      if (r) {
        r.onsuccess = () => resolve(r.result);
        r.onerror   = () => reject(r.error);
      } else {
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      }
    });
  }

  // ── Config store (key/value) ───────────────────────────────────────────────

  async function getConfig(key) {
    const row = await _req('config', 'readonly', s => s.get(key));
    return row ? row.value : undefined;
  }

  async function setConfig(key, value) {
    return _req('config', 'readwrite', s => s.put({ key, value }));
  }

  // ── Funds store ───────────────────────────────────────────────────────────

  /** Bulk-upsert an array of fund objects (each must have .secId). */
  async function saveFunds(funds) {
    if (!funds || !funds.length) return 0;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('funds', 'readwrite');
      const s  = tx.objectStore('funds');
      funds.forEach(f => s.put(f));
      tx.oncomplete = () => resolve(funds.length);
      tx.onerror    = () => reject(tx.error);
    });
  }

  /** Return all funds as an array (loaded fully into memory, ~12MB). */
  async function getFunds() {
    return _req('funds', 'readonly', s => s.getAll());
  }

  async function getFundCount() {
    return _req('funds', 'readonly', s => s.count());
  }

  async function clearFunds() {
    return _req('funds', 'readwrite', s => { s.clear(); return null; });
  }

  // ── Holdings store ────────────────────────────────────────────────────────

  /** Save a single fund's holdings record. */
  async function saveHolding(data) {
    return _req('holdings', 'readwrite', s => s.put(data));
  }

  /** Bulk-save multiple holdings records in one transaction. */
  async function saveHoldingsBatch(batch) {
    if (!batch || !batch.length) return;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('holdings', 'readwrite');
      const s  = tx.objectStore('holdings');
      batch.forEach(h => s.put(h));
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  async function getHolding(secId) {
    return _req('holdings', 'readonly', s => s.get(secId));
  }

  async function getHoldingCount() {
    return _req('holdings', 'readonly', s => s.count());
  }

  async function getAllHoldingKeys() {
    return _req('holdings', 'readonly', s => s.getAllKeys());
  }

  /**
   * Stream every holding via an IDB cursor.
   * Calls callback(record) for each — NEVER loads the whole 418MB into memory.
   * Safe to use for analytics aggregation.
   */
  async function iterateHoldings(callback) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('holdings', 'readonly');
      const req = tx.objectStore('holdings').openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { callback(cursor.value); cursor.continue(); }
        else resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function clearHoldings() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('holdings', 'readwrite');
      tx.objectStore('holdings').clear();
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  // ── Bulk state (persisted so page reload can resume) ──────────────────────

  const DEFAULT_BULK = {
    running: false, done: 0, total: 0, errors: 0,
    stop: false, stopped: false, savedAt: 0,
  };

  async function getBulkState() {
    return (await getConfig('bulk_state')) || { ...DEFAULT_BULK };
  }

  async function setBulkState(state) {
    return setConfig('bulk_state', state);
  }

  // ── Export helpers ────────────────────────────────────────────────────────

  /**
   * Export holdings as a plain object { secId: data } — same shape as
   * the server's anl_cache.json, so it can be used for import/export.
   * Streams to avoid OOM on large caches.
   */
  async function exportHoldings() {
    const out = {};
    await iterateHoldings(h => { out[h.secId] = h; });
    return out;
  }

  return {
    open,
    // Config
    getConfig, setConfig,
    // Funds
    saveFunds, getFunds, getFundCount, clearFunds,
    // Holdings
    saveHolding, saveHoldingsBatch, getHolding,
    getHoldingCount, getAllHoldingKeys,
    iterateHoldings, clearHoldings, exportHoldings,
    // Bulk state
    getBulkState, setBulkState,
  };
})();
