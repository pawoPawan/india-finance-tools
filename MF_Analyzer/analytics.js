/**
 * MF Analyzer — Analytics & Scoring Engine (browser port of analyzer.py + server.py)
 * Works in both Service Worker (importScripts) and page (<script src>) contexts.
 * Depends on: idb.js (MFidb must be loaded first)
 */
var MFAnalytics = (function () {
  'use strict';

  // ── Field aliases (mirrors server.py FIELD_MAP) ──────────────────────────
  const FIELD_MAP = {
    starRating:   ['starRatingM255'],
    return_1y:    ['returnM12'],
    return_3y:    ['returnM36'],
    return_5y:    ['returnM60'],
    expenseRatio: ['expenseRatio', 'ongoingCharge'],
    riskRating:   ['morningstarRiskM255'],
    sharpe:       ['sharpeM36'],
    alpha:        ['alphaM36'],
    beta:         ['betaM36'],
    category:     ['categoryName'],
    name:         ['name', 'legalName'],
    amc:          ['BrandingCompanyName'],
    aum:          ['fundTnav'],
    nav:          ['closePrice'],
  };

  function _get(f, field, def = null) {
    for (const alias of (FIELD_MAP[field] || [field])) {
      const v = f[alias];
      if (v !== null && v !== undefined && v !== '') {
        const n = parseFloat(v);
        return isNaN(n) ? v : n;
      }
    }
    return def;
  }

  function _getStr(f, field, def = '') {
    for (const alias of (FIELD_MAP[field] || [field])) {
      if (f[alias]) return String(f[alias]);
    }
    return def;
  }

  // ── Composite score (mirrors server.py score_fund) ────────────────────────
  function scoreFunc(f, mx1, mx3, mx5) {
    const star  = (_get(f, 'starRating') || 0) / 5;
    const r1    = Math.max(_get(f, 'return_1y') || 0, 0) / Math.max(mx1, 1);
    const r3    = Math.max(_get(f, 'return_3y') || 0, 0) / Math.max(mx3, 1);
    const r5    = Math.max(_get(f, 'return_5y') || 0, 0) / Math.max(mx5, 1);
    const exp   = _get(f, 'expenseRatio');
    const expSc = exp != null ? Math.max(0, 1 - exp / 2.5) : 0.5;
    let risk    = _get(f, 'riskRating') || 3;
    if (typeof risk === 'string')
      risk = ({ Low:1, 'Below Average':2, Average:3, 'Above Average':4, High:5 }[risk] || 3);
    const riskSc = 1 - (parseFloat(risk) - 1) / 4;
    return Math.round(
      (0.30 * star + 0.25 * r3 + 0.15 * r1 + 0.15 * r5 + 0.10 * expSc + 0.05 * riskSc) * 10000
    ) / 100;
  }

  function makeFundRow(f, mx1, mx3, mx5) {
    const aum = _get(f, 'aum');
    return {
      secId:           f.secId || '',
      name:            _getStr(f, 'name'),
      legalName:       f.legalName || '',
      category:        _getStr(f, 'category'),
      amc:             _getStr(f, 'amc'),
      stars:           Math.round(_get(f, 'starRating') || 0),
      score:           scoreFunc(f, mx1, mx3, mx5),
      ret1m:           _get(f, 'returnM1'),
      ret6m:           _get(f, 'returnM6'),
      ret1y:           _get(f, 'returnM12'),
      ret3y:           _get(f, 'returnM36'),
      ret5y:           _get(f, 'returnM60'),
      ret10y:          _get(f, 'returnM120'),
      expense:         _get(f, 'expenseRatio'),
      risk:            _get(f, 'riskRating'),
      sharpe:          _get(f, 'sharpeM36'),
      alpha:           _get(f, 'alphaM36'),
      beta:            _get(f, 'betaM36'),
      aum:             aum != null ? Math.round(aum / 1e7 * 100) / 100 : null,
      nav:             _get(f, 'nav'),
      navDate:         f.closePriceDate || '',
      styleBox:        f.equityStyleBox,
      medalist:        f.Medalist_RatingNumber,
      managerTenure:   f.managerTenure,
      initialPurchase: f.initialPurchase,
      purchaseMode:    f.purchasemode,
    };
  }

  // ── Fund type → category keyword map (mirrors server.py FUND_TYPE_KEYWORDS) ─
  const FUND_TYPE_KW = {
    equity: ['large-cap','mid-cap','small-cap','large & mid','multi-cap','flexi cap',
             'focused fund','contra','value','dividend yield','elss','equity savings',
             'sector -','equity -','equity long-short','equity ex-top'],
    index:  ['index funds'],
    hybrid: ['aggressive allocation','balanced allocation','conservative allocation',
             'dynamic asset allocation','multi asset allocation','hybrid long-short',
             'arbitrage','fund of funds','children','retirement'],
    debt:   ['corporate bond','banking & psu','credit risk','dynamic bond',
             'government bond','10 yr government','short duration','medium duration',
             'medium to long duration','long duration','ultra short duration',
             'low duration','floating rate','fixed maturity','other bond'],
    liquid: ['liquid','money market','overnight'],
    global: ['global -','alternative other'],
  };

  function catMatchesType(cat, type) {
    const c = (cat || '').toLowerCase();
    return (FUND_TYPE_KW[type] || []).some(kw => c.includes(kw));
  }

  // ── Meta ──────────────────────────────────────────────────────────────────
  function computeMeta(funds) {
    const cats  = [...new Set(funds.map(f => _getStr(f, 'category')).filter(Boolean))].sort();
    const amcs  = [...new Set(funds.map(f => _getStr(f, 'amc')).filter(Boolean))].sort();
    const stars = {};
    for (let i = 1; i <= 5; i++)
      stars[String(i)] = funds.filter(f => Math.round(_get(f, 'starRating') || 0) === i).length;
    return { total: funds.length, categories: cats, amcs, starCounts: stars,
             lastUpdated: Date.now() / 1000 };
  }

  function computeTypeCounts(funds) {
    const counts = { all: funds.length };
    for (const ft of Object.keys(FUND_TYPE_KW))
      counts[ft] = funds.filter(f => catMatchesType(_getStr(f, 'category'), ft)).length;
    return counts;
  }

  // ── Funds list: filter + sort + paginate ─────────────────────────────────
  function filterAndSort(funds, params) {
    const q        = (params.q || '').toLowerCase();
    const category = params.category || '';
    const fundType = params.fund_type || '';
    const amc      = (params.amc || '').toLowerCase();
    const starsRaw = params.stars || '';
    const starsF   = starsRaw.split(',').map(Number).filter(Boolean);
    const minR1    = params.min_ret1y != null && params.min_ret1y !== '' ? +params.min_ret1y : null;
    const minR3    = params.min_ret3y != null && params.min_ret3y !== '' ? +params.min_ret3y : null;
    const minR5    = params.min_ret5y != null && params.min_ret5y !== '' ? +params.min_ret5y : null;
    const maxExp   = params.max_exp   != null && params.max_exp   !== '' ? +params.max_exp   : null;
    const minAum   = params.min_aum   != null && params.min_aum   !== '' ? +params.min_aum   : null;
    const sort     = params.sort     || 'score';
    const dir      = params.dir      || 'desc';
    const page     = Math.max(1, parseInt(params.page      || '1',  10));
    const pageSize = Math.min(200, parseInt(params.page_size || '50', 10));

    const r1s = funds.map(f => _get(f,'return_1y')).filter(x => x != null);
    const r3s = funds.map(f => _get(f,'return_3y')).filter(x => x != null);
    const r5s = funds.map(f => _get(f,'return_5y')).filter(x => x != null);
    const mx1 = r1s.length ? Math.max(...r1s) : 1;
    const mx3 = r3s.length ? Math.max(...r3s) : 1;
    const mx5 = r5s.length ? Math.max(...r5s) : 1;

    let result = [];
    for (const f of funds) {
      const nameStr = (_getStr(f,'name') + ' ' + (f.legalName||'')).toLowerCase();
      const catStr  = _getStr(f, 'category');
      const amcStr  = _getStr(f, 'amc').toLowerCase();
      const secId   = (f.secId || '').toUpperCase();
      if (q && !nameStr.includes(q) && !amcStr.includes(q) &&
          !catStr.toLowerCase().includes(q) && !secId.includes(q.toUpperCase())) continue;
      if (fundType && !catMatchesType(catStr, fundType)) continue;
      if (category && !catStr.toLowerCase().includes(category.toLowerCase())) continue;
      if (amc && !amcStr.includes(amc)) continue;
      const star = Math.round(_get(f,'starRating') || 0);
      if (starsF.length && !starsF.includes(star)) continue;
      const r1 = _get(f,'return_1y'), r3 = _get(f,'return_3y'), r5 = _get(f,'return_5y');
      if (minR1 != null && (r1 == null || r1 < minR1)) continue;
      if (minR3 != null && (r3 == null || r3 < minR3)) continue;
      if (minR5 != null && (r5 == null || r5 < minR5)) continue;
      const exp = _get(f,'expenseRatio');
      if (maxExp != null && exp != null && exp > maxExp) continue;
      const rawAum = _get(f,'aum');
      const aumCr  = rawAum != null ? rawAum / 1e7 : null;
      if (minAum != null && (aumCr == null || aumCr < minAum)) continue;
      result.push(makeFundRow(f, mx1, mx3, mx5));
    }

    const sortFns = {
      score:   x => x.score,
      name:    x => x.name.toLowerCase(),
      stars:   x => x.stars,
      ret1y:   x => x.ret1y   ?? -999,
      ret3y:   x => x.ret3y   ?? -999,
      ret5y:   x => x.ret5y   ?? -999,
      expense: x => x.expense ?? 99,
      aum:     x => x.aum     ?? 0,
      sharpe:  x => x.sharpe  ?? -999,
    };
    const keyFn = sortFns[sort] || sortFns.score;
    result.sort((a, b) => {
      const av = keyFn(a), bv = keyFn(b);
      if (dir === 'asc') return av < bv ? -1 : av > bv ? 1 : 0;
      return bv < av ? -1 : bv > av ? 1 : 0;
    });

    const total = result.length;
    const start = (page - 1) * pageSize;
    return { total, page, page_size: pageSize, funds: result.slice(start, start + pageSize) };
  }

  // ── Analytics aggregation — streams IDB cursor, never loads 418MB into RAM ─
  async function computeAnalytics() {
    const eqMap = {}, bdMap = {}, secMap = {};
    let fundAnalyzed = 0;

    await MFidb.iterateHoldings(data => {
      if (!data._ts) return;
      fundAnalyzed++;
      const fname = data.name || data.secId || '';
      const secId = data.secId || '';

      for (const h of (data.equityHoldings || [])) {
        const nm = (h.securityName || '').trim();
        const wt = h.weighting || 0;
        if (!nm) continue;
        if (!eqMap[nm]) eqMap[nm] = { funds:[], totalWeight:0,
          ticker: h.ticker||'', sector: h.sector||'',
          moat: h.economicMoat||'', esg: h.susEsgRiskScore ?? null };
        eqMap[nm].funds.push({ name: fname, secId, weight: Math.round(wt*100)/100 });
        eqMap[nm].totalWeight += wt;
        const sec = h.sector || 'Other';
        if (!secMap[sec]) secMap[sec] = { fundCount: 0, totalWeight: 0 };
        secMap[sec].fundCount++;
        secMap[sec].totalWeight += wt;
      }

      for (const h of (data.bondHoldings || [])) {
        const nm = (h.securityName || '').trim();
        const wt = h.weighting || 0;
        if (!nm) continue;
        if (!bdMap[nm]) bdMap[nm] = { funds:[], totalWeight:0,
          ticker: h.ticker||'', coupon: h.coupon ?? null,
          creditRating: h.creditRating||'' };
        bdMap[nm].funds.push({ name: fname, secId, weight: Math.round(wt*100)/100 });
        bdMap[nm].totalWeight += wt;
      }
    });

    const fmtEq = (nm, d) => {
      const fc = d.funds.length;
      return { name: nm, ticker: d.ticker, sector: d.sector, moat: d.moat, esg: d.esg,
               fundCount: fc, totalWeight: Math.round(d.totalWeight*100)/100,
               avgWeight: fc ? Math.round(d.totalWeight/fc*100)/100 : 0,
               topFunds: [...d.funds].sort((a,b)=>b.weight-a.weight).slice(0,5) };
    };
    const fmtBd = (nm, d) => {
      const fc = d.funds.length;
      return { name: nm, ticker: d.ticker, coupon: d.coupon, creditRating: d.creditRating,
               fundCount: fc, totalWeight: Math.round(d.totalWeight*100)/100,
               avgWeight: fc ? Math.round(d.totalWeight/fc*100)/100 : 0,
               topFunds: [...d.funds].sort((a,b)=>b.weight-a.weight).slice(0,5) };
    };

    const equities = Object.entries(eqMap).map(([nm,d])=>fmtEq(nm,d)).sort((a,b)=>b.fundCount-a.fundCount);
    const bonds    = Object.entries(bdMap).map(([nm,d])=>fmtBd(nm,d)).sort((a,b)=>b.fundCount-a.fundCount);
    const sectors  = Object.entries(secMap).map(([nm,v])=>({
      name: nm, fundCount: v.fundCount,
      totalWeight: Math.round(v.totalWeight*100)/100,
      avgWeight: v.fundCount ? Math.round(v.totalWeight/v.fundCount*100)/100 : 0,
    })).sort((a,b)=>b.fundCount-a.fundCount);

    return { fundsAnalyzed: fundAnalyzed, totalEquities: equities.length,
             totalBonds: bonds.length, equities, bonds, sectors };
  }

  // ── Entity detail ─────────────────────────────────────────────────────────
  async function computeEntityDetail(name, type) {
    const results = [];
    await MFidb.iterateHoldings(data => {
      if (!data._ts) return;
      const list = type === 'bond' ? (data.bondHoldings||[]) : (data.equityHoldings||[]);
      const match = list.find(h => (h.securityName||'').trim() === name);
      if (!match) return;
      results.push({
        secId:          data.secId,
        name:           data.name || data.secId,
        category:       data.category || '',
        weight:         Math.round((match.weighting||0)*100)/100,
        firstBoughtDate:match.firstBoughtDate || null,
        shareChange:    match.shareChange,
        numberOfShare:  match.numberOfShare,
      });
    });
    results.sort((a,b) => b.weight - a.weight);
    return results;
  }

  // ── Security autocomplete index ───────────────────────────────────────────
  async function buildSecIndex() {
    const eqMap = {}, bdMap = {};
    await MFidb.iterateHoldings(data => {
      const seenEq = new Set(), seenBd = new Set();
      for (const h of (data.equityHoldings||[])) {
        const nm = (h.securityName||'').trim();
        if (nm && !seenEq.has(nm)) { eqMap[nm] = (eqMap[nm]||0)+1; seenEq.add(nm); }
      }
      for (const h of (data.bondHoldings||[])) {
        const nm = (h.securityName||'').trim();
        if (nm && !seenBd.has(nm)) { bdMap[nm] = (bdMap[nm]||0)+1; seenBd.add(nm); }
      }
    });
    return { equity: eqMap, bond: bdMap };
  }

  // ── Fund Finder ───────────────────────────────────────────────────────────
  async function findFunds(equities, bonds, fundsData) {
    const r1s = fundsData.map(f=>_get(f,'return_1y')).filter(x=>x!=null);
    const r3s = fundsData.map(f=>_get(f,'return_3y')).filter(x=>x!=null);
    const r5s = fundsData.map(f=>_get(f,'return_5y')).filter(x=>x!=null);
    const mx1 = r1s.length ? Math.max(...r1s) : 1;
    const mx3 = r3s.length ? Math.max(...r3s) : 1;
    const mx5 = r5s.length ? Math.max(...r5s) : 1;

    const fundIdx = {};
    fundsData.forEach(f => { if (f.secId) fundIdx[f.secId] = f; });

    const results = [];
    await MFidb.iterateHoldings(data => {
      if (!data._ts) return;
      const fd      = fundIdx[data.secId] || {};
      const eqHold  = data.equityHoldings || [];
      const bdHold  = data.bondHoldings   || [];
      const matchEq = equities.filter(nm => eqHold.some(h=>(h.securityName||'').trim()===nm));
      const matchBd = bonds.filter(nm    => bdHold.some(h=>(h.securityName||'').trim()===nm));
      const total   = equities.length + bonds.length;
      if (!total || (!matchEq.length && !matchBd.length)) return;
      const coverage = (matchEq.length + matchBd.length) / total;
      const stars    = Math.round(_get(fd,'starRating')||0);
      const score    = scoreFunc(fd, mx1, mx3, mx5);
      results.push({
        secId:           data.secId,
        name:            data.name || data.secId,
        category:        data.category || _getStr(fd,'category'),
        amc:             _getStr(fd,'amc'),
        stars, score,
        finderScore:     Math.round((coverage*0.5 + (stars/5)*0.3 + (score/100)*0.2)*1000)/1000,
        coverage:        Math.round(coverage*100),
        matchedEquities: matchEq,
        matchedBonds:    matchBd,
      });
    });
    results.sort((a,b) => b.finderScore - a.finderScore);
    return results.slice(0, 50);
  }

  return {
    _get, _getStr, scoreFunc, makeFundRow,
    computeMeta, computeTypeCounts, filterAndSort,
    computeAnalytics, computeEntityDetail,
    buildSecIndex, findFunds,
    FUND_TYPE_KW, catMatchesType,
  };
})();
