// ═══════════════════════════════════════════════════════════════════
// GROWW STATE
// ═══════════════════════════════════════════════════════════════════
let gRawFiles    = { eq: { trades:[], files:[] }, fo: { trades:[], files:[] }, mf: { trades:[], files:[] } };
let gRealized    = [];
let gOpen        = {};
let gIntradayPnl = [];
let gFoPnl       = [];
let gMfOpen      = {};
let gTaxRegime   = 'new';
let gFilter      = 'all';

// ═══════════════════════════════════════════════════════════════════
// GROWW XLSX PARSER — flexible column detection (no hardcoded headers)
// ═══════════════════════════════════════════════════════════════════
function parseGrowwTradebook(rows, fileType) {
  // Find header row: look for any row containing symbol-like AND date-like columns
  const SYMBOL_KW = ['symbol','trading symbol','scrip','instrument'];
  const DATE_KW   = ['trade date','order date','date'];
  const TYPE_KW   = ['trade type','transaction type','buy/sell','side'];
  const QTY_KW    = ['quantity','qty','shares'];

  let hdrIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(c => String(c).trim().toLowerCase());
    const hasS = cells.some(c => SYMBOL_KW.some(k => c.includes(k)));
    const hasD = cells.some(c => DATE_KW.some(k => c.includes(k)));
    const hasQ = cells.some(c => QTY_KW.some(k => c.includes(k)));
    if (hasS && hasD && hasQ) { hdrIdx = i; break; }
    // Minimum: symbol + date
    if (hasS && hasD) { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) return [];

  const hdrs = rows[hdrIdx].map(c => String(c).trim().toLowerCase());

  function colFlex(keywords) {
    for (const kw of keywords) {
      const idx = hdrs.findIndex(h => h.includes(kw));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  const iSym    = colFlex(SYMBOL_KW);
  const iDate   = colFlex(DATE_KW);
  const iType   = colFlex(TYPE_KW);
  const iQty    = colFlex(QTY_KW);
  const iPrice  = colFlex(['price','trade price','rate','avg']);
  const iISIN   = colFlex(['isin']);
  const iId     = colFlex(['trade id','trade no','order id','order no','exchange order']);
  const iExpiry = colFlex(['expiry']);

  if (iSym < 0 || iDate < 0 || iQty < 0 || iPrice < 0) return [];

  const trades = [];
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => String(c).trim() === '')) continue;

    const sym = String(row[iSym] || '').trim();
    if (!sym || sym.toLowerCase() === 'symbol' || sym.toLowerCase() === 'total') continue;

    // Parse date — handles JS Date, YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, timestamps
    let dateStr = '';
    const rawDate = row[iDate];
    if (rawDate instanceof Date) {
      dateStr = rawDate.toISOString().split('T')[0];
    } else {
      const ds = String(rawDate || '').trim().split(' ')[0].split('T')[0];
      if (/^\d{4}-\d{2}-\d{2}/.test(ds)) {
        dateStr = ds.slice(0, 10);
      } else if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(ds)) {
        const p = ds.split(/[\/\-]/);
        dateStr = `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
      } else {
        dateStr = ds;
      }
    }
    if (!dateStr) continue;

    // Normalize trade type: BUY/B → 'buy', SELL/S → 'sell'
    let tradeType = '';
    if (iType >= 0) {
      const raw = String(row[iType] || '').trim().toUpperCase();
      tradeType = (raw === 'BUY' || raw === 'B') ? 'buy' :
                  (raw === 'SELL' || raw === 'S') ? 'sell' : raw.toLowerCase();
    }
    // If no type column found, skip row
    if (!tradeType) continue;

    const qty    = parseFloat(String(row[iQty]   || '0').replace(/,/g,'')) || 0;
    const price  = parseFloat(String(row[iPrice] || '0').replace(/,/g,'')) || 0;
    const isin   = iISIN   >= 0 ? String(row[iISIN]   || '').trim() : '';
    const expiry = iExpiry >= 0 ? String(row[iExpiry] || '').trim() : '';
    const tradeId = iId    >= 0 ? String(row[iId]     || '').trim() : '';
    const dedupKey = tradeId || `${sym}|${dateStr}|${tradeType}|${qty}|${price}`;

    if (qty <= 0 || price <= 0) continue;

    trades.push({ symbol: sym, isin, date: dateStr, type: tradeType, qty, price, expiry, fileType, dedupKey });
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// GROWW FILE HANDLER
// ═══════════════════════════════════════════════════════════════════
async function handleGrowwFile(type, e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  for (const file of files) {
    try {
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array', cellDates: true });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      const parsed = parseGrowwTradebook(rows, type);
      if (!parsed.length) {
        alert(`No trades found in "${file.name}". Please check the format — Groww XLSX tradebook expected.`);
        continue;
      }

      const existingKeys = new Set(gRawFiles[type].trades.map(t => t.dedupKey));
      const newTrades  = parsed.filter(t => !existingKeys.has(t.dedupKey));
      const dupeCount  = parsed.length - newTrades.length;

      if (!newTrades.length) {
        alert(`"${file.name}" — all ${parsed.length} trades already loaded (duplicates skipped).`);
        continue;
      }

      const dates   = newTrades.map(t => t.date).sort();
      const dateMin = dates[0];
      const dateMax = dates[dates.length - 1];

      gRawFiles[type].trades.push(...newTrades);
      gRawFiles[type].files.push({ name: file.name, dateMin, dateMax, count: newTrades.length, dupeCount });

    } catch (err) {
      console.error('Groww parse error', err);
      alert(`Error reading "${file.name}": ` + err.message);
    }
  }

  renderGSegmentCard(type);
  updateGAnalyzeBtn();
}

function renderGSegmentCard(type) {
  const seg    = gRawFiles[type];
  const cardId = { eq: 'gEqCard', fo: 'gFoCard', mf: 'gMfCard' }[type];
  const infoId = { eq: 'gEqFilesInfo', fo: 'gFoFilesInfo', mf: 'gMfFilesInfo' }[type];
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

function updateGAnalyzeBtn() {
  updateAnalyzeAllBtn();
}

// ═══════════════════════════════════════════════════════════════════
// GROWW TAX CALCULATOR
// ═══════════════════════════════════════════════════════════════════
function computeGrowwTax(realized, foPnl) {
  const ltcgRatePct = parseFloat(document.getElementById('gLtcgRate').value) || 12.5;
  const stcgRatePct = parseFloat(document.getElementById('gStcgRate').value) || 20;
  const ltcgRate    = ltcgRatePct / 100;
  const stcgRate    = stcgRatePct / 100;
  const LTCG_EXEMPT = 125000;

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

  const otherL    = parseFloat(document.getElementById('gOtherIncome').value) || 0;
  const otherINR  = otherL * 100000;
  const slabs     = gTaxRegime === 'new' ? NEW_SLABS : OLD_SLABS;
  const foTaxable = Math.max(totalFoPnl, 0);
  const foTax     = slabTax(otherINR + foTaxable, slabs) - slabTax(otherINR, slabs);
  const foMarginal = foTaxable > 0 ? foTax / foTaxable : getMarginalRate(otherINR + 1, slabs);

  // Intraday: Speculative Business Income u/s 43(5) — incremental slab tax stacked on other income
  const totalIntradayPnl = gIntradayPnl.reduce((s, t) => s + t.pnl, 0);
  const intradayTaxable  = Math.max(totalIntradayPnl, 0);
  const intradayTax      = slabTax(otherINR + intradayTaxable, slabs) - slabTax(otherINR, slabs);
  const intradayMarginal = intradayTaxable > 0 ? intradayTax / intradayTaxable : getMarginalRate(otherINR + 1, slabs);

  const totalTax = stcgTax + ltcgTax + foTax + intradayTax;

  return { totalSTCG, totalLTCG, totalFoPnl, totalIntradayPnl, stcgTax, ltcgTax, foTax, intradayTax, totalTax, ltcgTaxable, LTCG_EXEMPT, stcgRate, ltcgRate, foMarginal, intradayMarginal };
}

// ═══════════════════════════════════════════════════════════════════
// GROWW MAIN ANALYSIS RUNNER
// ═══════════════════════════════════════════════════════════════════
function runGrowwAnalysis() {
  const eqTrades = gRawFiles.eq.trades;
  const foTrades = gRawFiles.fo.trades;
  const mfTrades = gRawFiles.mf.trades;

  const { intradayPnl, deliveryTrades } = extractIntraday(eqTrades);
  gIntradayPnl = intradayPnl;

  const eqMfTrades = [...deliveryTrades, ...mfTrades];
  const { realized, open } = runFIFO(eqMfTrades);

  gRealized = realized;
  gOpen     = open;
  gFoPnl    = computeFoPnl(foTrades);

  gMfOpen = {};
  for (const [sym, lots] of Object.entries(open)) {
    const isMf = mfTrades.some(t => t.symbol === sym);
    if (isMf) gMfOpen[sym] = lots;
  }

  showGrowwResultsUI();
  rerenderGroww();
}

function showGrowwResultsUI() {
  document.getElementById('pra_groww').style.display = 'block';
  if (document.getElementById('combinedResultsPanel').style.display === 'none') {
    document.getElementById('landingPanel').style.display = 'none';
    document.getElementById('combinedResultsPanel').style.display = 'block';
  }
}

function resetGrowwResults() {
  resetGrowwToLanding();
}

function resetGroww() {
  gRawFiles = { eq: { trades:[], files:[] }, fo: { trades:[], files:[] }, mf: { trades:[], files:[] } };
  ['eq','fo','mf'].forEach(t => renderGSegmentCard(t));
  resetGrowwResults();
}

function setGRegime(r) {
  gTaxRegime = r;
  document.getElementById('gRegimeNew').classList.toggle('active', r === 'new');
  document.getElementById('gRegimeOld').classList.toggle('active', r === 'old');
  rerenderGroww();
}

function setGFilter(f, el) {
  gFilter = f;
  document.querySelectorAll('#gFilterBar .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  rerenderGroww();
}

// ═══════════════════════════════════════════════════════════════════
// GROWW RENDER
// ═══════════════════════════════════════════════════════════════════
function rerenderGroww() {
  if (!gRealized.length && !Object.keys(gOpen).length && !gFoPnl.length) return;

  const ltcgRate = (parseFloat(document.getElementById('gLtcgRate').value) || 12.5) / 100;
  const stcgRate = (parseFloat(document.getElementById('gStcgRate').value) || 20)   / 100;
  const EXEMPT   = 125000;
  const tax      = computeGrowwTax(gRealized, gFoPnl);

  const stats = { eq:{stcg:0,ltcg:0,stcgTax:0,ltcgTax:0}, mf:{stcg:0,ltcg:0,stcgTax:0,ltcgTax:0} };
  gRealized.forEach(r => {
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
  const foSign = tax.totalFoPnl >= 0;

  function gainCell(v) {
    const s = v >= 0 ? 'pos' : 'neg';
    return `<td class="${s}">${v>=0?'+':'−'}${fINR(Math.abs(v),true)}</td>`;
  }
  function taxCell(v) { return `<td class="tax-col">${fINR(v,true)}</td>`; }
  function dashCell() { return `<td style="color:#ccc">—</td>`; }

  const hasEq       = gRawFiles.eq.trades.length > 0;
  const hasMf       = gRawFiles.mf.trades.length > 0;
  const hasFo       = gFoPnl.length > 0;
  const hasIntraday = gIntradayPnl.length > 0;
  const intradayTotal = gIntradayPnl.reduce((s, t) => s + t.pnl, 0);
  const intSign = intradayTotal >= 0;

  document.getElementById('gConsolidated').innerHTML = `
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
          ${taxCell(tax.foTax)}
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

  function segCoverage(type) {
    const files = gRawFiles[type].files;
    if (!files.length) return '';
    const sorted = [...files].sort((a,b)=>a.dateMin.localeCompare(b.dateMin));
    return ` · ${fDateShort(sorted[0].dateMin)} – ${fDateShort(sorted[sorted.length-1].dateMax)}`;
  }

  // Equity Realized
  const showEqRealized = gFilter==='all' || gFilter==='equity';
  document.getElementById('gRealizedSection').style.display = showEqRealized ? 'block' : 'none';
  if (showEqRealized) {
    const eqRealized = gRealized.filter(r => r.fileType !== 'mf');
    const bySymbol   = groupBy(eqRealized, 'symbol');
    document.getElementById('gRealizedMeta').textContent =
      `${Object.keys(bySymbol).length} stock${Object.keys(bySymbol).length!==1?'s':''} · ${fINR(stats.eq.stcg+stats.eq.ltcg,true)} gain${segCoverage('eq')}`;
    document.getElementById('gRealizedCards').innerHTML =
      Object.entries(bySymbol).map(([sym,trades]) => buildRealizedCard(sym,trades,ltcgRate,stcgRate,EXEMPT)).join('')
      || emptyMsg('No realized equity trades');
  }

  // Open Equity Positions
  const showOpen = gFilter==='all' || gFilter==='equity';
  document.getElementById('gOpenSection').style.display = showOpen ? 'block' : 'none';
  if (showOpen) {
    const eqOpen = Object.entries(gOpen).filter(([sym]) => !gMfOpen[sym]);
    document.getElementById('gOpenMeta').textContent =
      `${eqOpen.length} stock${eqOpen.length!==1?'s':''} · ${fINR(eqOpen.reduce((s,[,l])=>s+l.reduce((a,x)=>a+x.qty*x.price,0),0),true)} cost${segCoverage('eq')}`;
    document.getElementById('gOpenCards').innerHTML =
      eqOpen.map(([sym,lots]) => buildOpenCard(sym,lots,false)).join('')
      || emptyMsg('No open equity positions');
  }

  // F&O
  const showFo = (gFilter==='all' || gFilter==='fo') && gFoPnl.length;
  document.getElementById('gFoSection').style.display = showFo ? 'block' : 'none';
  if (showFo) {
    const foTotal = gFoPnl.reduce((s,f)=>s+f.pnl,0);
    document.getElementById('gFoMeta').textContent =
      `${gFoPnl.length} contract${gFoPnl.length!==1?'s':''} · ${foTotal>=0?'+':''}${fINR(foTotal,true)}${segCoverage('fo')}`;
    document.getElementById('gFoContent').innerHTML =
      gFoPnl.map(f => buildFoCard(f, tax.foMarginal)).join('');
  }

  // Intraday
  const showIntraday = (gFilter==='all' || gFilter==='equity') && gIntradayPnl.length;
  document.getElementById('gIntradaySection').style.display = showIntraday ? 'block' : 'none';
  if (showIntraday) {
    const intTotal = gIntradayPnl.reduce((s,t) => s+t.pnl, 0);
    const intSign  = intTotal >= 0;
    document.getElementById('gIntradayMeta').textContent =
      `${gIntradayPnl.length} session${gIntradayPnl.length!==1?'s':''} · ${intSign?'+':''}${fINR(intTotal,true)}${segCoverage('eq')}`;
    document.getElementById('gIntradayContent').innerHTML = buildIntradaySection(gIntradayPnl, tax.intradayMarginal);
  }

  // MF
  const showMf = gFilter==='all' || gFilter==='mf';
  const mfRealized = gRealized.filter(r => r.fileType==='mf');
  const mfHoldings = Object.entries(gMfOpen);
  document.getElementById('gMfSection').style.display =
    (showMf && (mfRealized.length || mfHoldings.length)) ? 'block' : 'none';
  if (showMf) {
    const mfSymGroups = groupBy(mfRealized, 'symbol');
    document.getElementById('gMfMeta').textContent =
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
    document.getElementById('gMfContent').innerHTML = mfHTML || emptyMsg('No mutual fund data');
  }
}