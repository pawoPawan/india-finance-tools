/**
 * MF Analyzer — Morningstar API Fetcher (browser port of api_fetcher.py + server.py)
 * Handles JWT extraction, fund list fetch, and holdings fetch via Cloudflare proxy.
 * Works in both Service Worker (importScripts) and page (<script src>) contexts.
 * Depends on: idb.js
 */
var MFfetcher = (function () {
  'use strict';

  const SCREENER_PAGE = 'https://www.morningstar.in/tools/ECFundscreener.aspx';
  const APAC_API      = 'https://www.apac-api.morningstar.com/ecint/v1/screener';
  const SAL_BASE      = 'https://www.us-api.morningstar.com/sal/sal-service/fund';
  const UNIVERSE      = 'FOIND$$ALL|FCIND$$ALL';
  const DATA_POINTS   = [
    'secId','name','legalName','closePrice','closePriceDate','yield_M12',
    'ongoingCharge','purchasemode','categoryName','Medalist_RatingNumber',
    'starRatingM255','returnD1','returnW1','returnM1','returnM3','returnM6',
    'returnM0','returnM12','returnM36','returnM60','returnM120',
    'maxFrontEndLoad','maxDeferredLoad','expenseRatio','initialPurchase',
    'fundTnav','equityStyleBox','bondStyleBox','averageMarketCapital',
    'averageCreditQualityCode','effectiveDuration','morningstarRiskM255',
    'alphaM36','betaM36','r2M36','standardDeviationM36','sharpeM36',
    'trackRecordExtension','managerTenure','BrandingCompanyName',
  ].join(',');

  const SAL_PARAMS = { locale:'en', clientId:'RSIN_SAL', benchmarkId:'morningstar', version:'4.86.0' };
  const BASE_HDRS  = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':     'application/json, text/plain, */*',
    'Referer':    'https://www.morningstar.in/',
    'Origin':     'https://www.morningstar.in',
  };

  const JWT_TTL     = 60 * 60 * 1000;        // 1 hour
  const SAL_HDR_TTL = 4  * 60 * 60 * 1000;   // 4 hours

  let _proxyUrl   = '';
  let _jwt        = '';   let _jwtTs  = 0;
  let _salHeaders = null; let _salTs  = 0;

  // ── Proxy ─────────────────────────────────────────────────────────────────

  function setProxy(url) { _proxyUrl = (url || '').replace(/\/$/, ''); }
  function getProxy()    { return _proxyUrl; }

  function _proxied(url) {
    if (!_proxyUrl) throw new Error('Proxy URL not configured. Set it in Setup.');
    return `${_proxyUrl}?url=${encodeURIComponent(url)}`;
  }

  async function _fetchP(url, opts = {}) {
    const headers = { ...BASE_HDRS, ...(opts.headers || {}) };
    const resp = await fetch(_proxied(url), { ...opts, headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return resp;
  }

  // ── JWT (screener token) ──────────────────────────────────────────────────

  async function getJWT(force = false) {
    if (!force && _jwt && Date.now() - _jwtTs < JWT_TTL) return _jwt;

    // 1. Check IDB cache
    const cached = await MFidb.getConfig('jwt');
    if (!force && cached && (Date.now() - cached.ts) < JWT_TTL) {
      _jwt = cached.token; _jwtTs = cached.ts; return _jwt;
    }

    // 2. Fetch from proxy /api/jwt endpoint (KV-cached, fast, refreshed hourly by cron)
    try {
      if (_proxyUrl) {
        const r = await fetch(`${_proxyUrl}/api/jwt`);
        if (r.ok) {
          const d = await r.json();
          if (d.token) {
            _jwt = d.token; _jwtTs = d.ts || Date.now();
            await MFidb.setConfig('jwt', { token: _jwt, ts: _jwtTs });
            return _jwt;
          }
        }
      }
    } catch (_) {}

    // 3. Fallback: scrape screener page HTML via proxy
    const html = await (await fetch(_proxied(SCREENER_PAGE), { headers: BASE_HDRS })).text();
    const m = html.match(/id="hfApiToken"[^>]+value="([^"]+)"/);
    if (!m || !m[1]) throw new Error('Could not extract JWT from Morningstar screener page. Check proxy.');
    _jwt = m[1]; _jwtTs = Date.now();
    await MFidb.setConfig('jwt', { token: _jwt, ts: _jwtTs });
    return _jwt;
  }

  // ── SAL headers ───────────────────────────────────────────────────────────
  // SAL token comes from <meta name="accessToken"> on the Morningstar India fund
  // overview page — an anonymous service-account token with SAL.Service data role.
  // Cached hourly in Cloudflare KV by the cron worker; served via /api/sal-token.

  const SAL_CONTENT_TYPE = 'nNsGdN3REOnPMlKDShOYjlk6VYiEVLSdpfpXAm7o2Tk=';

  async function getSALHeaders(force = false) {
    if (!force && _salHeaders && Date.now() - _salTs < SAL_HDR_TTL) return _salHeaders;

    // IDB cache — use if fresh
    const cached = await MFidb.getConfig('sal_headers');
    if (!force && cached && cached.headers && (Date.now() - (cached.ts||0)) < SAL_HDR_TTL) {
      _salHeaders = cached.headers; _salTs = cached.ts || 0; return _salHeaders;
    }

    // Fetch SAL token from proxy /api/sal-token (KV-cached, refreshed hourly by cron)
    try {
      if (_proxyUrl) {
        const r = await fetch(`${_proxyUrl}/api/sal-token`);
        if (r.ok) {
          const d = await r.json();
          if (d.token) {
            const hdrs = {
              ...BASE_HDRS,
              'Authorization':    `Bearer ${d.token}`,
              'x-sal-clientid':   'RSIN_SAL',
              'x-sal-contenttype': d.contentType || SAL_CONTENT_TYPE,
              ...(d.realtime ? { 'x-api-realtime-e': d.realtime } : {}),
            };
            _salHeaders = hdrs; _salTs = d.ts || Date.now();
            await MFidb.setConfig('sal_headers', { headers: _salHeaders, ts: _salTs });
            return _salHeaders;
          }
        }
      }
    } catch (_) {}

    // Fall back to stale IDB cache
    if (cached && cached.headers) {
      _salHeaders = cached.headers; _salTs = cached.ts || 0; return _salHeaders;
    }
    return null;
  }

  /** Called when user pastes raw headers from DevTools. */
  async function setSALHeadersManual(headersObj) {
    _salHeaders = headersObj; _salTs = Date.now();
    await MFidb.setConfig('sal_headers', { headers: headersObj, ts: _salTs });
  }

  // ── SAL URL builder ───────────────────────────────────────────────────────
  function _salUrl(path, extra = {}) {
    const p = new URLSearchParams({ ...SAL_PARAMS, ...extra });
    return `${SAL_BASE}/${path}?${p}`;
  }

  async function _salGet(path, extra = {}, hdrs) {
    const headers = hdrs || await getSALHeaders();
    if (!headers) throw new Error('SAL headers unavailable. Paste them from DevTools in Setup.');
    const url = _salUrl(path, extra);
    // Route through proxy — proxy injects Origin/Referer headers that browsers can't set manually
    let resp = await fetch(_proxied(url), { headers });
    if (resp.status === 401) {
      // Try refreshing SAL headers once
      const fresh = await getSALHeaders(true);
      if (fresh) resp = await fetch(_proxied(url), { headers: fresh });
    }
    if (!resp.ok) throw new Error(`SAL ${resp.status} for ${path}`);
    return resp.json();
  }

  // ── Fund list fetch ───────────────────────────────────────────────────────

  async function _fetchFundPage(jwt, page, pageSize) {
    const params = new URLSearchParams({
      languageId:'en-IN', currencyId:'INR', universeIds:UNIVERSE,
      outputType:'json', version:'1', page:String(page),
      pageSize:String(pageSize), sortOrder:'name asc',
      securityDataPoints:DATA_POINTS, term:'',
    });
    const url  = `${APAC_API}?${params}`;
    // Call screener API directly — it has Access-Control-Allow-Origin: * so no proxy needed.
    // The proxy is blocked by Morningstar's CloudFront WAF for datacenter IPs.
    const resp = await fetch(url, {
      headers: { ...BASE_HDRS, Authorization: `Bearer ${jwt}` }
    });
    if (!resp.ok) throw new Error(`Screener API ${resp.status}`);
    return resp.json();
  }

  /**
   * Fetch the full fund list from Morningstar screener.
   * @param {Function} [onProgress] Called as (fetched, total) after each page.
   * @returns {Promise<Array>} Array of raw fund objects.
   */
  async function fetchAllFunds(onProgress) {
    const jwt      = await getJWT();
    const pageSize = 100;
    const first    = await _fetchFundPage(jwt, 1, pageSize);
    const total    = first.total || 0;
    let rows       = first.rows  || [];
    if (onProgress) onProgress(rows.length, total);
    const totalPages = Math.ceil(total / pageSize);
    for (let p = 2; p <= totalPages; p++) {
      await new Promise(r => setTimeout(r, 250));  // polite delay
      const data = await _fetchFundPage(jwt, p, pageSize);
      rows = rows.concat(data.rows || []);
      if (onProgress) onProgress(rows.length, total);
    }
    return rows;
  }

  // ── Holdings fetch ────────────────────────────────────────────────────────

  function _cleanHolding(x) {
    if (!x) return {};
    return {
      securityName:     x.securityName  || '',
      ticker:           x.ticker        || '',
      isin:             x.isin          || '',
      weighting:        x.weighting,
      numberOfShare:    x.numberOfShare,
      marketValue:      x.marketValue,
      shareChange:      x.shareChange,
      currency:         x.currency || x.localCurrencyCode || 'INR',
      sector:           x.sector   || '',
      country:          x.country  || '',
      firstBoughtDate:  x.firstBoughtDate ? String(x.firstBoughtDate).slice(0,10) : null,
      totalReturn1Year: x.totalReturn1Year,
      forwardPERatio:   x.forwardPERatio,
      stockRating:      x.stockRating,
      assessment:       x.assessment    || '',
      economicMoat:     x.economicMoat  || '',
      susEsgRiskScore:  x.susEsgRiskScore  ?? null,
      susEsgRiskCategory: x.susEsgRiskCategory || '',
      susEsgRiskGlobes: x.susEsgRiskGlobes    ?? null,
      holdingTrend:     (x.holdingTrend || {}).trend || [],
      holdingType:      x.holdingType  || '',
      coupon:           x.coupon        ?? null,
      maturityDate:     x.maturityDate ? String(x.maturityDate).slice(0,10) : null,
      creditRating:     x.creditQuality || '',
    };
  }

  /**
   * Fetch minimal holdings for bulk analytics (equity + bond lists only).
   * Returns null if the fund has no data or the request fails.
   */
  async function fetchHoldingsMini(secId, fundName, category, hdrs) {
    try {
      const raw = await _salGet(
        `portfolio/holding/v2/${secId}/data`,
        { premiumNum:'500', freeNum:'50', hideesg:'false', secId },
        hdrs
      );
      if (!raw) return null;
      const ph = key => ((raw[key] || {}).holdingList || []).filter(Boolean).map(_cleanHolding);
      return {
        secId, _ts: Date.now() / 1000,
        name:     fundName  || secId,
        category: category  || '',
        equityHoldings: ph('equityHoldingPage'),
        bondHoldings:   ph('boldHoldingPage'),   // Morningstar typo "bold" not "bond"
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch full holdings + all supplemental data for a single fund page.
   * Mirrors server.py fetch_all_holding_data + _parse_holding_data.
   */
  async function fetchFullHoldings(secId, fundName, hdrs) {
    const h = hdrs || await getSALHeaders();
    if (!h) throw new Error('SAL headers not available');

    const tasks = [
      ['holdings',   `portfolio/holding/v2/${secId}/data`,        { premiumNum:'500',freeNum:'50',hideesg:'false',secId }],
      ['asset',      `process/asset/v3/${secId}/data`,            { secId }],
      ['sector',     `portfolio/v2/sector/${secId}/data`,         { secId }],
      ['stockStyle', `process/stockStyle/v2/${secId}/data`,       { secId }],
      ['marketCap',  `process/marketCap/${secId}/data`,           { secId }],
      ['financial',  `process/financialMetrics/${secId}/data`,    { secId }],
      ['perf',       `performance/table/${secId}`,                { secExchangeList:'',limitAge:'',hideYTD:'false',secId }],
      ['creditQual', `portfolio/creditQuality/${secId}/data`,     { secId }],
      ['people',     `people/${secId}/data`,                      { locale:'en',secId }],
      ['fixedStyle', `process/fixedIncomeStyle/${secId}/data`,    { secId }],
    ];

    const settled = await Promise.allSettled(
      tasks.map(([name, path, extra]) =>
        _salGet(path, extra, h).then(r => [name, r]).catch(() => [name, null])
      )
    );
    const raw = {};
    settled.forEach(s => { if (s.status === 'fulfilled') raw[s.value[0]] = s.value[1]; });
    return _parseFullHoldings(secId, fundName, raw);
  }

  function _cleanDate(d) { return d ? String(d).slice(0, 10) : null; }
  function _safe(d, k) {
    const v = (d || {})[k];
    if (v == null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  function _netF(alloc, key) {
    const v = (alloc || {})[key];
    const raw = (v && typeof v === 'object') ? (v.netAllocation ?? v.longAllocation) : v;
    if (raw == null) return null;
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  }

  function _parseFullHoldings(secId, fundName, raw) {
    const out = { secId, _ts: Date.now() / 1000, name: fundName || secId };

    // Holdings
    const h = raw.holdings || {};
    out.portfolioDate          = _cleanDate((h.holdingSummary || {}).portfolioDate);
    out.numberOfHolding        = h.numberOfHolding;
    out.numberOfEquityHolding  = h.numberOfEquityHolding;
    out.numberOfBondHolding    = h.numberOfBondHolding;
    const ph = key => ((h[key] || {}).holdingList || []).filter(Boolean).map(_cleanHolding);
    out.equityHoldings = ph('equityHoldingPage');
    out.bondHoldings   = ph('boldHoldingPage');
    out.otherHoldings  = ph('otherHoldingPage');

    // Asset allocation
    const a     = raw.asset || {};
    const alloc = a.allocationMap || {};
    out.assetAllocation = {
      stock: _netF(alloc,'INDAssetAllocStock'), bond:  _netF(alloc,'INDAssetAllocBond'),
      cash:  _netF(alloc,'INDAssetAllocCash'),  other: _netF(alloc,'INDAssetAllocOther'),
      convertible: _netF(alloc,'INDAssetAllocConvertible'),
      preferred:   _netF(alloc,'INDAssetAllocPreferred'),
      asOfDate:    _cleanDate(a.portfolioDate),
    };

    // Sectors
    const SECTOR_NAMES = {
      basicMaterials:'Basic Materials', consumerCyclical:'Consumer Cyclical',
      financialServices:'Financial Services', realEstate:'Real Estate',
      communicationServices:'Communication', energy:'Energy',
      industrials:'Industrials', technology:'Technology',
      consumerDefensive:'Consumer Defensive', healthcare:'Healthcare', utilities:'Utilities',
    };
    const parseSec = (port, cat) => Object.entries(SECTOR_NAMES)
      .filter(([k]) => (port||{})[k] != null)
      .map(([k,name]) => ({name, fund: parseFloat((port||{})[k])||0,
                           category: (cat||{})[k] != null ? parseFloat((cat||{})[k]) : null}))
      .sort((a,b) => b.fund - a.fund);
    const eq = (raw.sector || {}).EQUITY       || {};
    const fi = (raw.sector || {}).FIXEDINCOME  || {};
    out.equitySectors      = parseSec(eq.fundPortfolio, eq.categoryPortfolio);
    out.fixedIncomeSectors = parseSec(fi.fundPortfolio, fi.categoryPortfolio);

    // Style box
    const ss = raw.stockStyle || {};
    out.styleBox = (ss.fund && typeof ss.fund === 'object') ? ss.fund.styleBox : null;
    out.stockStylePortfolioDate = _cleanDate(ss.portfolioDate);

    // Market cap
    const mc = ((raw.marketCap || {}).fund) || {};
    out.marketCap = { giant:_safe(mc,'giant'),large:_safe(mc,'large'),medium:_safe(mc,'medium'),
                      small:_safe(mc,'small'),micro:_safe(mc,'micro'),avgMarketCap:_safe(mc,'avgMarketCap') };

    // Financial metrics
    const fm = ((raw.financial || {}).fund) || {};
    out.financialMetrics = {
      priceToEarnings:_safe(fm,'priceToEarnings'), priceToBook:_safe(fm,'priceToBook'),
      priceToSales:_safe(fm,'priceToSales'),        priceToCashFlow:_safe(fm,'priceToCashFlow'),
      returnOnEquity:_safe(fm,'returnOnEquity'),    debtToCapital:_safe(fm,'debtToCapital'),
      netMargin:_safe(fm,'netMargin'),               revenueGrowth:_safe(fm,'revenueGrowth'),
      earningsGrowth:_safe(fm,'earningsGrowth'),    dividendYield:_safe(fm,'dividendYield'),
      yieldToMaturity:_safe(fm,'yieldToMaturity'),  modifiedDuration:_safe(fm,'modifiedDuration'),
      effectiveDuration:_safe(fm,'effectiveDuration'),
      averageCreditQuality: fm.averageCreditQuality || null,
      averageCoupon:_safe(fm,'averageCoupon'),
    };

    // Performance history
    const pf  = (raw.perf || {}).table || {};
    const perfRows = {};
    for (const row of (pf.growth10KReturnData || [])) {
      if (['fund','category','percentileRank'].includes(row.label)) {
        perfRows[row.label] = (row.datum||[]).map(v => {
          try { return (v!=null&&v!=='') ? Math.round(parseFloat(v)*100)/100 : null; } catch { return null; }
        });
      }
    }
    out.performanceHistory = { columns: pf.columnDefs||[], rows: perfRows };

    // Credit quality
    const cqRaw = ((raw.creditQual||{}).fund) || {};
    const CQ_MAP = { creditQualityAAA:'AAA',creditQualityAA:'AA',creditQualityA:'A',
                     creditQualityBBB:'BBB',creditQualityBB:'BB',creditQualityB:'B',
                     creditQualityBelowB:'Below B',creditQualityNotRated:'Not Rated' };
    out.creditQuality = Object.entries(CQ_MAP)
      .filter(([k]) => cqRaw[k] != null)
      .map(([k,label]) => ({ rating:label, value:Math.round(parseFloat(cqRaw[k])*100)/100 }))
      .filter(x => x.value > 0)
      .sort((a,b) => b.value - a.value);
    out.creditQualityDate = _cleanDate(cqRaw.creditQualityDate);

    // Managers
    const ppl = raw.people || {};
    let mgrs = ppl.managedBy || ppl.managerList || [];
    if (!mgrs.length) for (const v of Object.values(ppl))
      if (Array.isArray(v) && v[0]?.displayName) { mgrs = v; break; }
    out.managers = mgrs
      .filter(m => m.displayName || m.name)
      .map(m => ({ name:m.displayName||m.name||'', startDate:_cleanDate(m.startDate), tenure:m.tenure }));
    out.inceptionDate         = _cleanDate(ppl.inceptionDate);
    out.averageManagerTenure  = ppl.averageManagerTenure;

    // Fixed income style
    const fs = ((raw.fixedStyle||{}).fund) || {};
    out.fixedIncomeStyleBox = (typeof fs === 'object') ? (fs.styleBox || null) : null;

    return out;
  }

  return {
    setProxy, getProxy, getJWT, getSALHeaders, setSALHeadersManual,
    fetchAllFunds, fetchHoldingsMini, fetchFullHoldings, _cleanHolding,
  };
})();
