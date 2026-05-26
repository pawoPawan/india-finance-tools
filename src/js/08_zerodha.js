// ═══════════════════════════════════════════════════════════════════
// ZERODHA STATE
// ═══════════════════════════════════════════════════════════════════
// Each segment: { trades: [{...}], files: [{name, dateMin, dateMax, count, dupeCount}] }
let zRawFiles     = { eq: { trades:[], files:[] }, fo: { trades:[], files:[] }, mf: { trades:[], files:[] } };
let zRealized     = [];   // FIFO-matched realized trades
let zOpen         = {};   // open lots by symbol
let zIntradayPnl  = [];   // auto-detected speculative intraday trades
let zFoPnl     = [];   // F&O per-contract P&L
let zMfOpen    = {};   // MF open positions
let zTaxRegime = 'new';
let zFilter    = 'all';


// ═══════════════════════════════════════════════════════════════════
// ZERODHA UI HELPERS
// ═══════════════════════════════════════════════════════════════════
function renderZSegmentCard(type) {
  const seg    = zRawFiles[type];
  const cardId = { eq: 'zEqCard', fo: 'zFoCard', mf: 'zMfCard' }[type];
  const infoId = { eq: 'zEqFilesInfo', fo: 'zFoFilesInfo', mf: 'zMfFilesInfo' }[type];
  const card   = document.getElementById(cardId);
  const info   = document.getElementById(infoId);

  if (!seg.files.length) {
    card.classList.remove('ready');
    info.innerHTML = '';
    return;
  }

  card.classList.add('ready');

  const sorted = [...seg.files].sort((a, b) => a.dateMin.localeCompare(b.dateMin));
  const { gaps, overlaps } = detectSegmentGaps(sorted);
  const overallMin = sorted[0].dateMin;
  const overallMax = sorted[sorted.length - 1].dateMax;

  const fileItems = sorted.map(f => `
    <div class="z-file-item">
      <span class="z-file-name" title="${f.name}">${f.name}</span>
      <span class="z-file-range">${fDate(f.dateMin)} → ${fDate(f.dateMax)}</span>
      <span class="z-file-count">${f.count} trades</span>
      ${f.dupeCount ? `<span class="z-file-dupes">(${f.dupeCount} dupes skipped)</span>` : ''}
    </div>`).join('');

  const gapWarnings = gaps.map(g => `
    <div class="z-gap-warning">
      ⚠ Gap: ${fDate(g.from)} → ${fDate(g.to)} — <strong>${g.days} day${g.days !== 1 ? 's' : ''} missing</strong>. Upload another file to fill.
    </div>`).join('');

  const overlapNote = overlaps > 0 ? `
    <div class="z-overlap-note">✓ Overlapping files detected — duplicate trades auto-removed</div>` : '';

  info.innerHTML = `
    <div class="z-coverage-total">
      Coverage: <strong>${fDate(overallMin)} → ${fDate(overallMax)}</strong> · ${seg.trades.length} unique trades
    </div>
    ${fileItems}
    ${gapWarnings}
    ${overlapNote}`;
}

function updateZAnalyzeBtn() {
  updateAnalyzeAllBtn();
}

// ═══════════════════════════════════════════════════════════════════
async function handleZerodhaFile(type, e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  for (const file of files) {
    try {
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array', cellDates: true });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      const parsed = parseZerodhaTradebook(rows, type);
      if (!parsed.length) {
        alert(`No trades found in "${file.name}". Please check the format.`);
        continue;
      }

      // Dedup against already-loaded trades for this segment
      const existingKeys = new Set(zRawFiles[type].trades.map(t => t.dedupKey));
      const newTrades  = parsed.filter(t => !existingKeys.has(t.dedupKey));
      const dupeCount  = parsed.length - newTrades.length;

      if (!newTrades.length) {
        alert(`"${file.name}" — all ${parsed.length} trades already loaded (duplicates skipped).`);
        continue;
      }

      // Date range for this file
      const dates   = newTrades.map(t => t.date).sort();
      const dateMin = dates[0];
      const dateMax = dates[dates.length - 1];

      zRawFiles[type].trades.push(...newTrades);
      zRawFiles[type].files.push({ name: file.name, dateMin, dateMax, count: newTrades.length, dupeCount });

    } catch (err) {
      console.error('Zerodha parse error', err);
      alert(`Error reading "${file.name}": ` + err.message);
    }
  }

  renderZSegmentCard(type);
  updateZAnalyzeBtn();
}

// ─── Detect date gaps between file ranges ───────────────────────────

// ═══════════════════════════════════════════════════════════════════
// ZERODHA XLSX PARSER
// ═══════════════════════════════════════════════════════════════════
function parseZerodhaTradebook(rows, fileType) {
  // Find header row: contains 'Symbol' AND 'Trade Date'
  let hdrIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].map(c => String(c).trim());
    if (row.includes('Symbol') && row.includes('Trade Date')) {
      hdrIdx = i;
      break;
    }
  }
  if (hdrIdx < 0) return [];

  const headers = rows[hdrIdx].map(c => String(c).trim());
  const col = name => headers.indexOf(name);

  const iSymbol   = col('Symbol');
  const iISIN     = col('ISIN');
  const iDate     = col('Trade Date');
  const iType     = col('Trade Type');
  const iQty      = col('Quantity');
  const iPrice    = col('Price');
  const iTradeId  = col('Trade ID');   // for deduplication
  const iExpiry   = col('Expiry Date'); // F&O only, may be -1

  const trades = [];
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[iSymbol]) continue;
    const sym = String(row[iSymbol]).trim();
    if (!sym) continue;

    // Date: may be a JS Date object (cellDates:true) or a string
    let rawDate = row[iDate];
    let dateStr = '';
    if (rawDate instanceof Date) {
      dateStr = rawDate.toISOString().split('T')[0];
    } else {
      dateStr = String(rawDate).trim().split(' ')[0]; // YYYY-MM-DD
    }

    const tradeType = String(row[iType] || '').trim().toLowerCase(); // 'buy' / 'sell'
    const qty       = parseFloat(String(row[iQty]  || '0').replace(/,/g,'')) || 0;
    const price     = parseFloat(String(row[iPrice] || '0').replace(/,/g,'')) || 0;
    const isin      = iISIN >= 0 ? String(row[iISIN] || '').trim() : '';
    const expiry    = iExpiry >= 0 ? String(row[iExpiry] || '').trim() : '';
    const tradeId   = iTradeId >= 0 ? String(row[iTradeId] || '').trim() : '';
    // Fallback dedup key if no Trade ID
    const dedupKey  = tradeId || `${sym}|${dateStr}|${tradeType}|${qty}|${price}`;

    if (!dateStr || !tradeType || qty <= 0) continue;

    trades.push({ symbol: sym, isin, date: dateStr, type: tradeType, qty, price, expiry, fileType, dedupKey });
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// INTRADAY AUTO-DETECTION (equity only, same-day buy+sell netting)
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// ZERODHA TAX CALCULATION
// ═══════════════════════════════════════════════════════════════════
function computeZerodhaTax(realized, foPnl) {
  const ltcgRatePct  = parseFloat(document.getElementById('zLtcgRate').value) || 12.5;
  const stcgRatePct  = parseFloat(document.getElementById('zStcgRate').value) || 20;
  const ltcgRate     = ltcgRatePct / 100;
  const stcgRate     = stcgRatePct / 100;
  const LTCG_EXEMPT  = 125000; // ₹1,25,000

  let totalSTCG = 0, totalLTCG = 0, totalFoPnl = 0;

  realized.forEach(r => {
    if (r.gain > 0) {
      if (r.category === 'LTCG') totalLTCG += r.gain;
      else totalSTCG += r.gain;
    }
  });

  foPnl.forEach(f => { totalFoPnl += f.pnl; });

  const ltcgTaxable = Math.max(totalLTCG - LTCG_EXEMPT, 0);
  const stcgTax     = Math.max(totalSTCG, 0) * stcgRate;
  const ltcgTax     = ltcgTaxable * ltcgRate;

  // F&O + Intraday: slab rate (business / speculative income)
  // Use incremental slab tax: tax on (other + business income) minus tax on other income alone
  const otherL     = parseFloat(document.getElementById('zOtherIncome').value) || 0;
  const otherINR   = otherL * 100000;
  const slabs      = zTaxRegime === 'new' ? NEW_SLABS : OLD_SLABS;
  const foTaxable  = Math.max(totalFoPnl, 0);
  const foTax      = slabTax(otherINR + foTaxable, slabs) - slabTax(otherINR, slabs);
  const foMarginal = foTaxable > 0 ? foTax / foTaxable : getMarginalRate(otherINR + 1, slabs);

  // Intraday equity: Speculative Business Income u/s 43(5) — taxed at slab rate, stacked on other income
  const totalIntradayPnl  = zIntradayPnl.reduce((s, t) => s + t.pnl, 0);
  const intradayTaxable   = Math.max(totalIntradayPnl, 0);
  const intradayTax       = slabTax(otherINR + intradayTaxable, slabs) - slabTax(otherINR, slabs);
  const intradayMarginal  = intradayTaxable > 0 ? intradayTax / intradayTaxable : getMarginalRate(otherINR + 1, slabs);

  const totalTax = stcgTax + ltcgTax + foTax + intradayTax;

  return { totalSTCG, totalLTCG, totalFoPnl, totalIntradayPnl, stcgTax, ltcgTax, foTax, intradayTax, totalTax, ltcgTaxable, LTCG_EXEMPT, stcgRate, ltcgRate, foMarginal, intradayMarginal };
}


// ═══════════════════════════════════════════════════════════════════
// ZERODHA MAIN ANALYSIS RUNNER
// ═══════════════════════════════════════════════════════════════════
function runZerodhaAnalysis() {
  // Gather all equity + MF trades for FIFO
  const eqTrades = zRawFiles.eq.trades;
  const foTrades = zRawFiles.fo.trades;
  const mfTrades = zRawFiles.mf.trades;

  // Extract intraday from equity (MF cannot be intraday)
  const { intradayPnl, deliveryTrades } = extractIntraday(eqTrades);
  zIntradayPnl = intradayPnl;

  // FIFO only on delivery equity + MF
  const eqMfTrades = [...deliveryTrades, ...mfTrades];
  const { realized, open } = runFIFO(eqMfTrades);

  zRealized = realized;
  zOpen     = open;
  zFoPnl    = computeFoPnl(foTrades);

  // MF open: filter from open positions where fileType is 'mf'
  // We'll tag them via realized/open structure
  zMfOpen = {};
  for (const [sym, lots] of Object.entries(open)) {
    // Check if any trade for this symbol came from mf file
    const isMf = mfTrades.some(t => t.symbol === sym);
    if (isMf) zMfOpen[sym] = lots;
  }

  showZerodhaResultsUI();
  rerenderZerodha();
}

function showZerodhaResultsUI() {
  // accordion shown by runAnalysisAll() or directly
  document.getElementById('pra_zerodha').style.display = 'block';
  if (document.getElementById('combinedResultsPanel').style.display === 'none') {
    document.getElementById('landingPanel').style.display = 'none';
    document.getElementById('combinedResultsPanel').style.display = 'block';
  }
}

function resetZerodhaResults() {
  resetZerodhaToLanding();
}

function resetZerodha() {
  zRawFiles = { eq: { trades:[], files:[] }, fo: { trades:[], files:[] }, mf: { trades:[], files:[] } };
  ['eq','fo','mf'].forEach(t => renderZSegmentCard(t));
  resetZerodhaResults();
}

function setZRegime(r) {
  zTaxRegime = r;
  document.getElementById('zRegimeNew').classList.toggle('active', r === 'new');
  document.getElementById('zRegimeOld').classList.toggle('active', r === 'old');
  rerenderZerodha();
}

function setZFilter(f, el) {
  zFilter = f;
  document.querySelectorAll('#zFilterBar .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  rerenderZerodha();
}


// ═══════════════════════════════════════════════════════════════════
// ZERODHA RENDER
// ═══════════════════════════════════════════════════════════════════
function rerenderZerodha() {
  if (!zRealized.length && !Object.keys(zOpen).length && !zFoPnl.length) return;

  const ltcgRate  = (parseFloat(document.getElementById('zLtcgRate').value) || 12.5) / 100;
  const stcgRate  = (parseFloat(document.getElementById('zStcgRate').value) || 20)   / 100;
  const EXEMPT    = 125000;
  const tax       = computeZerodhaTax(zRealized, zFoPnl);

  // ── Per-category stats ────────────────────────────────────────────
  const stats = { eq:{stcg:0,ltcg:0,stcgTax:0,ltcgTax:0}, mf:{stcg:0,ltcg:0,stcgTax:0,ltcgTax:0} };
  zRealized.forEach(r => {
    const cat = r.fileType === 'mf' ? 'mf' : 'eq';
    if (r.category === 'LTCG') stats[cat].ltcg += r.gain;
    else stats[cat].stcg += r.gain;
  });
  stats.eq.stcgTax = Math.max(stats.eq.stcg,0)*stcgRate;
  stats.eq.ltcgTax = Math.max(stats.eq.ltcg-EXEMPT,0)*ltcgRate;
  stats.mf.stcgTax = Math.max(stats.mf.stcg,0)*stcgRate;
  stats.mf.ltcgTax = Math.max(stats.mf.ltcg-EXEMPT,0)*ltcgRate;
  const eqTax  = stats.eq.stcgTax + stats.eq.ltcgTax;
  const mfTax  = stats.mf.stcgTax + stats.mf.ltcgTax;
  const foTax  = tax.foTax;
  const foSign = tax.totalFoPnl >= 0;

  function gainCell(v) {
    const s = v >= 0 ? 'pos' : 'neg';
    return `<td class="${s}">${v>=0?'+':'−'}${fINR(Math.abs(v),true)}</td>`;
  }
  function taxCell(v) { return `<td class="tax-col">${fINR(v,true)}</td>`; }
  function dashCell() { return `<td style="color:#ccc">—</td>`; }

  // ── Consolidated P&L table ────────────────────────────────────────
  const hasEq       = zRawFiles.eq.trades.length > 0;
  const hasMf       = zRawFiles.mf.trades.length > 0;
  const hasFo       = zFoPnl.length > 0;
  const hasIntraday = zIntradayPnl.length > 0;
  const intradayTotal = zIntradayPnl.reduce((s, t) => s + t.pnl, 0);
  const intSign = intradayTotal >= 0;
  document.getElementById('zConsolidated').innerHTML = `
    <table class="z-con-table">
      <thead><tr>
        <th>Category</th><th>STCG Gain</th><th>LTCG Gain</th><th>Spec. P&amp;L</th><th>Est. Tax</th>
      </tr></thead>
      <tbody>
        ${hasEq ? `<tr>
          <td>📈 Equity (Delivery)</td>
          ${gainCell(stats.eq.stcg)}${gainCell(stats.eq.ltcg)}${dashCell()}
          ${taxCell(eqTax)}
        </tr>` : ''}
        ${hasIntraday ? `<tr>
          <td>⚡ Intraday (Speculative)</td>
          ${dashCell()}${dashCell()}
          <td class="${intSign?'pos':'neg'}">${intSign?'+':'−'}${fINR(Math.abs(intradayTotal),true)}</td>
          ${taxCell(tax.intradayTax)}
        </tr>` : ''}
        ${hasMf ? `<tr>
          <td>🏛 Mutual Funds</td>
          ${gainCell(stats.mf.stcg)}${gainCell(stats.mf.ltcg)}${dashCell()}
          ${taxCell(mfTax)}
        </tr>` : ''}
        ${hasFo ? `<tr>
          <td>📊 F&amp;O</td>
          ${dashCell()}${dashCell()}
          <td class="${foSign?'pos':'neg'}">${foSign?'+':'−'}${fINR(Math.abs(tax.totalFoPnl),true)}</td>
          ${taxCell(foTax)}
        </tr>` : ''}
        <tr class="z-con-total">
          <td>Total</td>
          ${gainCell(stats.eq.stcg+stats.mf.stcg)}
          ${gainCell(stats.eq.ltcg+stats.mf.ltcg)}
          <td class="${(intradayTotal+tax.totalFoPnl)>=0?'pos':'neg'}">${(hasIntraday||hasFo)?((intradayTotal+tax.totalFoPnl)>=0?'+':'−')+fINR(Math.abs(intradayTotal+tax.totalFoPnl),true):'—'}</td>
          ${taxCell(tax.totalTax)}
        </tr>
      </tbody>
    </table>`;

  // ── Coverage period helpers ───────────────────────────────────────
  function segCoverage(type) {
    const files = zRawFiles[type].files;
    if (!files.length) return '';
    const sorted = [...files].sort((a,b)=>a.dateMin.localeCompare(b.dateMin));
    return ` · ${fDateShort(sorted[0].dateMin)} – ${fDateShort(sorted[sorted.length-1].dateMax)}`;
  }
  function tradeCoverage(tradesArr) {
    if (!tradesArr.length) return '';
    const dates = tradesArr.map(t => t.date||t.sellDate||t.buyDate).filter(Boolean).sort();
    return ` · ${fDateShort(dates[0])} – ${fDateShort(dates[dates.length-1])}`;
  }

  // ── Equity Realized ───────────────────────────────────────────────
  const showEqRealized = zFilter==='all' || zFilter==='equity';
  document.getElementById('zRealizedSection').style.display = showEqRealized ? 'block' : 'none';
  if (showEqRealized) {
    const eqRealized = zRealized.filter(r => r.fileType !== 'mf');
    const bySymbol   = groupBy(eqRealized, 'symbol');
    document.getElementById('zRealizedMeta').textContent =
      `${Object.keys(bySymbol).length} stock${Object.keys(bySymbol).length!==1?'s':''} · ${fINR(stats.eq.stcg+stats.eq.ltcg,true)} gain${segCoverage('eq')}`;
    document.getElementById('zRealizedCards').innerHTML =
      Object.entries(bySymbol).map(([sym,trades]) => buildRealizedCard(sym,trades,ltcgRate,stcgRate,EXEMPT)).join('')
      || emptyMsg('No realized equity trades');
  }

  // ── Open Equity Positions ─────────────────────────────────────────
  const showOpen = zFilter==='all' || zFilter==='equity';
  document.getElementById('zOpenSection').style.display = showOpen ? 'block' : 'none';
  if (showOpen) {
    const eqOpen = Object.entries(zOpen).filter(([sym]) => !zMfOpen[sym]);
    document.getElementById('zOpenMeta').textContent =
      `${eqOpen.length} stock${eqOpen.length!==1?'s':''} · ${fINR(eqOpen.reduce((s,[,l])=>s+l.reduce((a,x)=>a+x.qty*x.price,0),0),true)} cost${segCoverage('eq')}`;
    document.getElementById('zOpenCards').innerHTML =
      eqOpen.map(([sym,lots]) => buildOpenCard(sym,lots,false)).join('')
      || emptyMsg('No open equity positions');
  }

  // ── F&O ──────────────────────────────────────────────────────────
  const showFo = (zFilter==='all' || zFilter==='fo') && zFoPnl.length;
  document.getElementById('zFoSection').style.display = showFo ? 'block' : 'none';
  if (showFo) {
    const foTotal = zFoPnl.reduce((s,f)=>s+f.pnl,0);
    document.getElementById('zFoMeta').textContent =
      `${zFoPnl.length} contract${zFoPnl.length!==1?'s':''} · ${foTotal>=0?'+':''}${fINR(foTotal,true)}${segCoverage('fo')}`;
    document.getElementById('zFoContent').innerHTML =
      zFoPnl.map(f => buildFoCard(f, tax.foMarginal)).join('');
  }

  // ── Intraday ──────────────────────────────────────────────────────
  const showIntraday = (zFilter==='all' || zFilter==='equity') && zIntradayPnl.length;
  document.getElementById('zIntradaySection').style.display = showIntraday ? 'block' : 'none';
  if (showIntraday) {
    const intTotal = zIntradayPnl.reduce((s,t) => s+t.pnl, 0);
    const intSign  = intTotal >= 0;
    document.getElementById('zIntradayMeta').textContent =
      `${zIntradayPnl.length} session${zIntradayPnl.length!==1?'s':''} · ${intSign?'+':''}${fINR(intTotal,true)}${segCoverage('eq')}`;
    document.getElementById('zIntradayContent').innerHTML = buildIntradaySection(zIntradayPnl, tax.intradayMarginal);
  }

  // ── MF ───────────────────────────────────────────────────────────
  const showMf = zFilter==='all' || zFilter==='mf';
  const mfRealized = zRealized.filter(r => r.fileType==='mf');
  const mfHoldings = Object.entries(zMfOpen);
  document.getElementById('zMfSection').style.display =
    (showMf && (mfRealized.length || mfHoldings.length)) ? 'block' : 'none';
  if (showMf) {
    const mfSymGroups = groupBy(mfRealized, 'symbol');
    document.getElementById('zMfMeta').textContent =
      `${mfHoldings.length} holding${mfHoldings.length!==1?'s':''} · ${Object.keys(mfSymGroups).length} realized${segCoverage('mf')}`;
    let mfHTML = '';
    if (mfHoldings.length) {
      mfHTML += `<div style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;margin:8px 2px 6px">Holdings</div>`;
      mfHTML += mfHoldings.map(([sym,lots]) => buildOpenCard(sym,lots,true)).join('');
    }
    if (Object.keys(mfSymGroups).length) {
      mfHTML += `<div style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;margin:12px 2px 6px">Realized</div>`;
      mfHTML += Object.entries(mfSymGroups).map(([sym,trades]) =>
        buildRealizedCard(sym,trades,ltcgRate,stcgRate,EXEMPT)).join('');
    }
    document.getElementById('zMfContent').innerHTML = mfHTML || emptyMsg('No mutual fund data');
  }
}