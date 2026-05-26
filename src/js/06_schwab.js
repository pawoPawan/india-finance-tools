// ═══════════════════════════════════════════════════════════════════
// CURRENCY / FILTER
// ═══════════════════════════════════════════════════════════════════
function setCurrency(c) {
  currency = c;
  document.querySelectorAll('.currency-btn').forEach((b,i) => b.classList.toggle('active', (i===0&&c==='USD')||(i===1&&c==='INR')));
  rerender();
}

function setFilter(f, el) {
  activateFilter(f);
  rerender();
}


// ═══════════════════════════════════════════════════════════════════
let pendingLots = null;      // CSV parsed, waiting for XLS
let pendingXlsRates = null;  // XLS parsed, waiting for CSV

async function handleCsvUpload(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  const lots = parseSchawbCSV(text);
  if (!lots.length) { alert('No lots found in CSV. Check file format.'); return; }

  // Mark CSV card ready
  document.getElementById('csvCard').classList.add('ready');
  document.getElementById('csvBtnLabel').textContent = '✓ ' + file.name;

  if (pendingXlsRates) {
    initWithBoth(lots, pendingXlsRates);
  } else {
    pendingLots = lots;
  }
}

async function handleXlsUpload(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const rates = parseRBIXls(await file.text());
  if (!Object.keys(rates).length) { alert('No rates found in the XLS. Make sure you downloaded the correct RBI Reference Rate file.'); return; }

  // Mark XLS card ready
  document.getElementById('xlsCard').classList.add('ready');
  document.getElementById('xlsBtnLabel').textContent = '✓ ' + file.name;

  if (pendingLots) {
    initWithBoth(pendingLots, rates);
  } else {
    pendingXlsRates = rates;
  }
}

// Parse the RBI HTML-as-XLS: DD/MM/YYYY → rate
function parseRBIXls(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const rates = {};
  doc.querySelectorAll('tr').forEach(row => {
    const cells = [...row.querySelectorAll('td')];
    if (cells.length < 2) return;
    const parts = cells[0].textContent.trim().split('/');
    if (parts.length !== 3) return;
    const iso = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    const rate = parseFloat(cells[1].textContent.replace(/,/g,''));
    if (!isNaN(rate) && rate > 30 && rate < 200) rates[iso] = rate;
  });
  return rates;
}

// Find the nearest available RBI rate on or before a given date (for holidays/weekends)
function nearestRBIRate(isoDate, xlsRates) {
  if (xlsRates[isoDate]) return { rate: xlsRates[isoDate], exact: true };
  // Look back up to 4 calendar days (covers long weekends + holidays)
  const d = new Date(isoDate + 'T00:00:00');
  for (let i = 1; i <= 4; i++) {
    d.setDate(d.getDate() - 1);
    const key = d.toISOString().split('T')[0];
    if (xlsRates[key]) return { rate: xlsRates[key], exact: false, usedDate: key };
  }
  return null;
}

function initWithBoth(lots, xlsRates) {
  allLots = lots;
  ratesMap = {};

  const lotDates = [...new Set(lots.map(l => l.dateAcquired))];
  lotDates.forEach(date => {
    const found = nearestRBIRate(date, xlsRates);
    if (found) {
      ratesMap[date] = { rate: found.rate, source: 'rbi' };
    }
  });

  // Today's rate: use most recent available from XLS
  const todayFound = nearestRBIRate(TODAY, xlsRates);
  if (todayFound) {
    document.getElementById('todayINR').value = todayFound.rate.toFixed(2);
    // Also sync IndMoney USD→INR rate if it hasn't been manually changed
    const imUsdRateEl = document.getElementById('imUsdRate');
    if (imUsdRateEl && parseFloat(imUsdRateEl.value) === 84.5) {
      imUsdRateEl.value = todayFound.rate.toFixed(2);
    }
    ratesMap[TODAY] = { rate: todayFound.rate, source: 'rbi' };
  }

  showMainUI();
  activateFilter('all');
  renderRateTable();
  rerender();
}

// ── Reset filter chip + activeFilter variable ──────────────────────
function activateFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.chip').forEach(c => {
    const isAll  = c.textContent.trim() === 'All Lots';
    const isThis = (f === 'all' && isAll) || c.textContent.trim() === f;
    c.classList.toggle('active', isThis);
  });
}


function resetUpload() {
  pendingLots = null;
  pendingXlsRates = null;
  allLots = [];
  ratesMap = {};
  document.getElementById('csvCard').classList.remove('ready');
  document.getElementById('xlsCard').classList.remove('ready');
  document.getElementById('csvBtnLabel').textContent = 'Choose File';
  document.getElementById('xlsBtnLabel').textContent = 'Choose File';
  document.getElementById('settingsPanel').style.display = 'none';
  document.getElementById('catSummarySection').style.display = 'none';
  document.getElementById('summarySection').style.display = 'none';
  document.getElementById('disclaimerSection').style.display = 'none';
  document.getElementById('currencyToggle').style.display = 'none';
  activateFilter('all');
  document.getElementById('lotsWrap').innerHTML = '';
  document.getElementById('pra_schwab').style.display = 'none';
  checkAndMaybeGoBack();
}

function showMainUI() {
  document.getElementById('settingsPanel').style.display = 'block';
  document.getElementById('catSummarySection').style.display = 'block';
  document.getElementById('summarySection').style.display = 'block';
  document.getElementById('disclaimerSection').style.display = 'block';
  document.getElementById('currencyToggle').style.display = '';
}

function saveTodayINR() {}

// ── Manual rate override ───────────────────────────────────────────
function overrideRate(date, val) {
  const rate = parseFloat(val);
  if (!isNaN(rate) && rate > 0) {
    ratesMap[date] = { rate, source: 'manual' };
    rerender();
  }
}

// ── Rate table ─────────────────────────────────────────────────────
function renderRateTable() {
  const tbody = document.getElementById('rateTableBody');
  const uniqueDates = [...new Set(allLots.map(l => l.dateAcquired))].sort();
  const hasEst = uniqueDates.some(d => (ratesMap[d]?.source || 'est') === 'est');
  document.getElementById('missingRatesBanner').style.display = hasEst ? '' : 'none';

  tbody.innerHTML = uniqueDates.map(date => {
    const info = ratesMap[date] || {};
    const src = info.source || 'est';
    const isEst = src === 'est';
    const isLocked = src === 'rbi'; // locked once imported from RBI XLS
    const rowStyle = isEst ? 'background:#fff8e1;' : '';
    const manualCell = isLocked
      ? `<span style="font-size:12px;color:#888">— locked (RBI)</span>`
      : `<input type="number" value="${info.rate?.toFixed(2)||''}" step="0.01"
          style="${isEst ? 'border:2px solid #f57c00;background:#fff3e0;font-weight:600;' : ''}width:110px;"
          onchange="overrideRate('${date}',this.value)"
          placeholder="${isEst ? '⚠ Enter rate' : 'Override'}">`;
    return `<tr style="${rowStyle}">
      <td>${fDate(date)}</td>
      <td>${info.rate ? '₹' + info.rate.toFixed(4) : '<span style="color:#c62828">—</span>'}</td>
      <td><span class="source-tag ${src}">${src.toUpperCase()}</span></td>
      <td>${manualCell}</td>
    </tr>`;
  }).join('');
}


// CSV PARSER — Schwab format
// ═══════════════════════════════════════════════════════════════════
function parseSchawbCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const lots = [];

  const esppIdx  = lines.findIndex(l => l.includes('EMPLOYEE STOCK PURCHASE PLAN SHARES'));
  const eqIdx    = lines.findIndex(l => l.includes('EQUITY AWARD SHARES'));

  // ── ESPP lots ─────────────────────────────────────────────────────
  if (esppIdx >= 0) {
    const end = eqIdx > 0 ? eqIdx : lines.length;
    let i = esppIdx + 2;
    while (i < end) {
      const parts = parseCsvLine(lines[i]);
      if (parts.length >= 8 && isMMDDYYYY(parts[0]) && parts[1] === 'NVDA') {
        const dateAcquired  = mmddToISO(parts[0]);
        const purchasePrice = numOf(parts[4]);
        const sharesAvail   = intOf(parts[7]);
        const sharesTotal   = intOf(parts[6]);

        // Schwab CSV structure per ESPP lot:
        //   Line i:   lot summary  (Purchase Date, Symbol, Market Value, ...)
        //   Line i+1: column header ("Date Holding Period Met,Symbol,Plan Id,...")
        //   Line i+2: actual detail  (Qualified/date, Symbol, PlanId, SubDate, PurchDate, SubFMV, PurchFMV, PurchPrice)
        // Detect column-header row by checking if next line contains "Plan Id"
        let detail = [];
        let step   = 2;
        const rawNext = i + 1 < end ? lines[i + 1] : '';
        if (rawNext.includes('Plan Id')) {
          // i+1 is col-header, i+2 is actual data
          detail = i + 2 < end ? parseCsvLine(lines[i + 2]) : [];
          step   = 3;
        } else {
          detail = parseCsvLine(rawNext);
        }

        // detail layout: [HoldingPeriodMet, Symbol, PlanId, SubDate, PurchDate, SubFMV, PurchFMV, PurchPrice]
        // Use Purchase FMV (index 6) as capital-gain cost basis (discount already taxed as perquisite)
        let purchaseFMV = purchasePrice;
        if (detail.length >= 7) {
          const fmv = numOf(detail[6]);
          if (fmv > 0) purchaseFMV = fmv;
        }

        if (sharesAvail > 0 && dateAcquired) {
          lots.push(mkLot('ESPP', 'NVDA', dateAcquired, purchaseFMV, purchasePrice, sharesAvail, sharesTotal));
        }
        i += step;
      } else { i++; }
    }
  }

  // ── RSU lots from EQUITY AWARD SHARES ─────────────────────────────
  if (eqIdx >= 0) {
    const hdrIdx = lines.findIndex((l, idx) => idx > eqIdx && l.startsWith('Award Date,Symbol,Award ID'));
    if (hdrIdx >= 0) {
      for (let i = hdrIdx + 1; i < lines.length; i++) {
        const p = parseCsvLine(lines[i]);
        if (p.length < 11) continue;
        const sym      = p[1];
        const dateAcq  = mmddToISO(p[7]);
        const acqPrice = numOf(p[8]);
        const shares   = intOf(p[9]);
        const avail    = intOf(p[10]);
        if (!dateAcq || avail <= 0 || !sym || sym === 'Symbol') continue;
        lots.push(mkLot('RSU', sym, dateAcq, acqPrice, acqPrice, avail, shares));
      }
    }
  }

  return lots;
}

function mkLot(type, symbol, dateAcquired, acquisitionPrice, purchasePrice, sharesHeld, sharesTotal) {
  return {
    type, symbol, dateAcquired, acquisitionPrice, purchasePrice, sharesHeld, sharesTotal,
    taxCategory: monthsDiff(dateAcquired, TODAY) > 24 ? 'LTCG' : 'STCG',
    holdingMonths: monthsDiff(dateAcquired, TODAY),
  };
}


// ═══════════════════════════════════════════════════════════════════
// RSU / ESPP CATEGORY SUMMARY
// ═══════════════════════════════════════════════════════════════════
function renderCatSummary(currentPrice, todayINR, ltcgRate, stcgRate) {
  const categories = ['RSU', 'ESPP'];
  const grid = document.getElementById('catSummaryGrid');

  grid.innerHTML = categories.map(cat => {
    const lots = allLots.filter(l => l.type === cat);
    if (!lots.length) return '';

    let shares = 0, costUSD = 0, costINR = 0, valueUSD = 0, valueINR = 0, taxEst = 0;
    lots.forEach(lot => {
      const pRate   = ratesMap[lot.dateAcquired]?.rate || todayINR;
      const taxRate = lot.taxCategory === 'LTCG' ? ltcgRate : stcgRate;
      shares   += lot.sharesHeld;
      costUSD  += lot.acquisitionPrice * lot.sharesHeld;
      costINR  += lot.acquisitionPrice * lot.sharesHeld * pRate;
      valueUSD += currentPrice * lot.sharesHeld;
      valueINR += currentPrice * lot.sharesHeld * todayINR;
      const gainBase = currency === 'INR'
        ? Math.max(currentPrice * lot.sharesHeld * todayINR - lot.acquisitionPrice * lot.sharesHeld * pRate, 0)
        : Math.max((currentPrice - lot.acquisitionPrice) * lot.sharesHeld, 0);
      taxEst += gainBase * taxRate;
    });

    const gainUSD    = valueUSD - costUSD;
    const gainINR    = valueINR - costINR;
    const gainPctUSD = costUSD > 0 ? gainUSD / costUSD * 100 : 0;
    const gainPctINR = costINR > 0 ? gainINR / costINR * 100 : 0;
    const gPos       = gainUSD >= 0;

    const showINR = currency === 'INR';

    return `<div class="cat-card">
      <div class="cat-card-header">
        <div class="cat-icon ${cat.toLowerCase()}">${cat}</div>
        <div class="cat-title">${cat === 'RSU' ? 'Restricted Stock Units' : 'Employee Stock Purchase Plan'}</div>
        <div class="cat-shares">${shares} shares · ${lots.length} lots</div>
      </div>
      <div class="cat-rows">
        <div class="cat-row">
          <div class="cr-label">Total Invested</div>
          <div class="cr-val">${showINR ? fINR(costINR,true) : fUSD(costUSD,true)}</div>
          <div class="cr-sub">${showINR ? fUSD(costUSD,true)+' × avg buy rate' : fINR(costINR,true)+' at buy rates'}</div>
        </div>
        <div class="cat-row">
          <div class="cr-label">Current Value</div>
          <div class="cr-val">${showINR ? fINR(valueINR,true) : fUSD(valueUSD,true)}</div>
          <div class="cr-sub">${showINR ? fUSD(valueUSD,true)+' × ₹'+todayINR.toFixed(2) : fINR(valueINR,true)+' at ₹'+todayINR.toFixed(2)}</div>
        </div>
        <div class="cat-row gain-row">
          <div>
            <div class="cr-label">Total Gain</div>
            <div class="cr-val ${gPos?'pos':'neg'}">${signStr(showINR?gainINR:gainUSD)}${showINR?fINR(Math.abs(gainINR),true):fUSD(Math.abs(gainUSD),true)} (${(showINR?gainPctINR:gainPctUSD).toFixed(1)}%)</div>
          </div>
          <div style="text-align:right">
            <div class="cr-label">Est. Tax</div>
            <div class="cr-val" style="color:#e65100">${showINR?fINR(taxEst,true):fUSD(taxEst,true)}</div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════
function rerender() {
  if (!allLots.length) return;

  const currentPrice = parseFloat(document.getElementById('currentPrice').value) || 0;
  const todayINR     = parseFloat(document.getElementById('todayINR').value) || 84.5;
  const ltcgRate     = parseFloat(document.getElementById('ltcgRate').value) / 100;
  const stcgRate     = computeSTCGRate();  // dynamic from slab

  // Filter
  let filtered = allLots;
  if (activeFilter === 'RSU')  filtered = allLots.filter(l => l.type === 'RSU');
  if (activeFilter === 'ESPP') filtered = allLots.filter(l => l.type === 'ESPP');
  if (activeFilter === 'LTCG') filtered = allLots.filter(l => l.taxCategory === 'LTCG');
  if (activeFilter === 'STCG') filtered = allLots.filter(l => l.taxCategory === 'STCG');
  filtered = [...filtered].sort((a,b) => new Date(b.dateAcquired)-new Date(a.dateAcquired));

  // ── Summary ──────────────────────────────────────────────────────
  let totVal=0, totGain=0, totTax=0, totShares=0, totValINR=0, totGainINR=0, totCostINR=0;
  allLots.forEach(lot => {
    const taxRate = lot.taxCategory === 'LTCG' ? ltcgRate : stcgRate;
    const pRate   = ratesMap[lot.dateAcquired]?.rate || todayINR;
    // USD
    const val     = currentPrice * lot.sharesHeld;
    const gain    = (currentPrice - lot.acquisitionPrice) * lot.sharesHeld;
    // INR: cost uses purchase-day rate, value uses today's rate
    const costINR_ = lot.acquisitionPrice * lot.sharesHeld * pRate;
    const valINR_  = currentPrice * lot.sharesHeld * todayINR;
    const gainINR_ = valINR_ - costINR_;
    const taxBase  = currency === 'INR' ? Math.max(gainINR_, 0) : Math.max(gain, 0);
    totVal    += val;
    totGain   += gain;
    totShares += lot.sharesHeld;
    totValINR += valINR_;
    totGainINR+= gainINR_;
    totCostINR+= costINR_;
    totTax    += taxBase * taxRate;
  });

  const totGainPctINR = totCostINR > 0 ? totGainINR / totCostINR * 100 : 0;
  const totGainPctUSD = (totVal - totGain) > 0 ? totGain / (totVal - totGain) * 100 : 0;

  const sg = document.getElementById('summaryGrid');
  if (currency === 'USD') {
    sg.innerHTML = `
      <div class="sum-card"><div class="slabel">Total Shares</div><div class="sval">${totShares.toLocaleString()}</div><div class="ssub">${allLots.length} lots</div></div>
      <div class="sum-card"><div class="slabel">Portfolio Value</div><div class="sval">${fUSD(totVal,true)}</div><div class="ssub">@ $${currentPrice.toFixed(2)}/sh</div></div>
      <div class="sum-card ${totGain>=0?'green':'red'}"><div class="slabel">Total USD Gain</div><div class="sval">${signStr(totGain)}${fUSD(totGain,true)}</div><div class="ssub">${totGainPctUSD.toFixed(1)}% return</div></div>
      <div class="sum-card orange"><div class="slabel">Est. Tax Liability</div><div class="sval">${fUSD(totTax,true)}</div><div class="ssub">LTCG ${(ltcgRate*100).toFixed(1)}% / STCG slab</div></div>`;
  } else {
    sg.innerHTML = `
      <div class="sum-card"><div class="slabel">Total Shares</div><div class="sval">${totShares.toLocaleString()}</div><div class="ssub">₹${todayINR.toFixed(2)}/$ today</div></div>
      <div class="sum-card"><div class="slabel">Portfolio Value (₹)</div><div class="sval">${fINR(totValINR,true)}</div><div class="ssub">shares × $${currentPrice.toFixed(2)} × ₹${todayINR.toFixed(2)}</div></div>
      <div class="sum-card ${totGainINR>=0?'green':'red'}"><div class="slabel">Total INR Gain</div><div class="sval">${signStr(totGainINR)}${fINR(totGainINR,true)}</div><div class="ssub">${totGainPctINR.toFixed(1)}% on ₹ cost basis</div></div>
      <div class="sum-card orange"><div class="slabel">Est. Tax (₹)</div><div class="sval">${fINR(totTax,true)}</div><div class="ssub">LTCG ${(ltcgRate*100).toFixed(1)}% / STCG slab</div></div>`;
  }

  document.getElementById('sectionLabel').textContent =
    `${filtered.length} lot${filtered.length!==1?'s':''} · ${activeFilter==='all'?'All Holdings':activeFilter}`;

  // ── RSU / ESPP category summary ───────────────────────────────────
  renderCatSummary(currentPrice, todayINR, ltcgRate, stcgRate);

  // ── Lot cards ─────────────────────────────────────────────────────
  const wrap = document.getElementById('lotsWrap');
  if (!filtered.length) { wrap.innerHTML = '<div class="empty-state"><h3>No lots match the filter</h3></div>'; return; }

  wrap.innerHTML = filtered.map(lot => { try {
    const taxRate  = lot.taxCategory === 'LTCG' ? ltcgRate : stcgRate;
    const pRate    = ratesMap[lot.dateAcquired]?.rate || todayINR;
    const src      = ratesMap[lot.dateAcquired]?.source || 'est';
    const val      = currentPrice * lot.sharesHeld;
    const gainUSD  = (currentPrice - lot.acquisitionPrice) * lot.sharesHeld;
    const gainPct  = lot.acquisitionPrice > 0 ? gainUSD / (lot.acquisitionPrice * lot.sharesHeld) * 100 : 0;

    // INR calculations
    const costINR       = lot.acquisitionPrice * lot.sharesHeld * pRate;
    const valINR        = val * todayINR;
    const gainINR       = valINR - costINR;
    const gainINR_stock = gainUSD * todayINR;
    const gainINR_forex = lot.acquisitionPrice * lot.sharesHeld * (todayINR - pRate);
    const fxChangePct   = pRate > 0 ? (todayINR - pRate) / pRate * 100 : 0;

    const taxBase = currency === 'INR' ? Math.max(gainINR, 0) : Math.max(gainUSD, 0);
    const taxAmt  = taxBase * taxRate;

    // STCG → LTCG projection
    const isSTCG = lot.taxCategory === 'STCG';
    const ltcgConvert = isSTCG ? ltcgDate(lot.dateAcquired) : null;
    const daysLeft    = isSTCG ? daysUntil(ltcgConvert) : 0;
    const taxAtLTCG   = taxBase * ltcgRate;
    const taxSaving   = taxAmt - taxAtLTCG;

    // Shared: forex rate row (shown in BOTH modes)
    // RBI-sourced rates are locked (read-only); EST/manual rates are editable
    const isLocked = src === 'rbi';
    const rateDisplay = isLocked
      ? `<span style="font-size:15px;font-weight:700">₹${pRate.toFixed(2)}</span>`
      : `<input type="number" step="0.01" value="${pRate.toFixed(2)}"
          style="width:80px;font-size:14px;font-weight:700;border:1px solid ${src==='est'?'#f57c00':'#ddd'};border-radius:5px;padding:2px 5px;color:${src==='est'?'#e65100':'inherit'};background:${src==='est'?'#fff8f0':'#fff'}"
          onchange="overrideRate('${lot.dateAcquired}',this.value)"
          title="Edit to correct the USD/INR rate for this date">`;
    const fxRow = `
      <div class="fx-row">
        <div class="fx-item">
          <div class="fx-label">USD/INR at Purchase</div>
          <div class="fx-val" style="display:flex;align-items:center;gap:4px">
            ${rateDisplay}
            <span class="fx-src ${src}">${src.toUpperCase()}</span>
          </div>
        </div>
        <div class="fx-arrow">→</div>
        <div class="fx-item">
          <div class="fx-label">USD/INR Today</div>
          <div class="fx-val">₹${todayINR.toFixed(2)}</div>
        </div>
        <div class="fx-item">
          <div class="fx-label">Forex Gain (₹)</div>
          <div class="fx-val ${gainINR_forex>=0?'pos':'neg'}">${signStr(gainINR_forex)}${fINR(Math.abs(gainINR_forex),true)} (${signStr(fxChangePct)}${Math.abs(fxChangePct).toFixed(1)}%)</div>
        </div>
        <div class="fx-item">
          <div class="fx-label">Stock Gain (₹)</div>
          <div class="fx-val ${gainINR_stock>=0?'pos':'neg'}">${signStr(gainINR_stock)}${fINR(Math.abs(gainINR_stock),true)}</div>
        </div>
      </div>`;

    // STCG → LTCG banner
    const ltcgBanner = isSTCG && daysLeft > 0 ? `
      <div class="ltcg-banner">
        <div class="ltcg-banner-top">
          <span class="clock">⏳</span>
          <span>Converts to LTCG on <strong>${fDate(ltcgConvert)}</strong></span>
          <span class="days-badge">${daysLeft} day${daysLeft!==1?'s':''} away</span>
        </div>
        <div class="ltcg-tax-compare">
          <div class="tc-box">
            <div class="tc-label">STCG Tax Now</div>
            <div class="tc-val stcg-col">${currency==='INR'?fINR(taxAmt,true):fUSD(taxAmt,true)}</div>
            <div style="font-size:10px;color:#aaa">${(taxRate*100).toFixed(0)}% slab</div>
          </div>
          <div class="tc-arrow">→</div>
          <div class="tc-box">
            <div class="tc-label">LTCG Tax After</div>
            <div class="tc-val ltcg-col">${currency==='INR'?fINR(taxAtLTCG,true):fUSD(taxAtLTCG,true)}</div>
            <div style="font-size:10px;color:#aaa">${(ltcgRate*100).toFixed(1)}%</div>
          </div>
          <div class="tc-saving">
            <div class="tc-label">Tax Saved by Waiting</div>
            <div class="tc-val">${currency==='INR'?fINR(taxSaving,true):fUSD(taxSaving,true)}</div>
          </div>
        </div>
      </div>` : (isSTCG && daysLeft <= 0 ? `
      <div class="ltcg-banner" style="background:#e8f5e9;border-color:#c8e6c9">
        <div class="ltcg-banner-top">
          <span>✅ This lot <strong>qualifies for LTCG</strong> today — consider selling to get ${(ltcgRate*100).toFixed(1)}% rate</span>
        </div>
      </div>` : '');

    const gPos      = gainUSD >= 0;
    const gINRPos   = gainINR >= 0;
    // INR gain % uses INR cost as base (not USD cost)
    const gainPctINR = costINR > 0 ? gainINR / costINR * 100 : 0;

    // Per-share INR values
    const vestPriceINR    = lot.acquisitionPrice * pRate;   // $X.XX × ₹Y.YY
    const currentPriceINR = currentPrice * todayINR;        // $X.XX × ₹Y.YY
    // Total value formula: shares × currentPrice($) × todayINR
    // valINR = lot.sharesHeld × currentPrice × todayINR  (already computed above)

    if (currency === 'USD') {
      return `<div class="lot-card">
        <div class="lot-top">
          <div class="lot-top-left">
            <span class="lot-date">${fDate(lot.dateAcquired)}</span>
            <span class="badge ${lot.taxCategory.toLowerCase()}">${lot.taxCategory} · ${fHolding(lot.holdingMonths)}</span>
            <span class="badge ${lot.type.toLowerCase()}">${lot.type}</span>
          </div>
          <div class="schwab-pill"><div class="schwab-dot">CS</div><div class="schwab-name">CHARLES<br>SCHWAB</div></div>
        </div>
        <div class="lot-grid">
          <div><div class="lf-label">Shares</div><div class="lf-val">${lot.sharesHeld}</div></div>
          <div><div class="lf-label">Vest Price</div><div class="lf-val">$${lot.acquisitionPrice.toFixed(2)}</div><div class="lf-sub">₹${vestPriceINR.toFixed(0)} at buy rate</div></div>
          <div><div class="lf-label">Current Price</div><div class="lf-val">$${currentPrice.toFixed(2)}</div><div class="lf-sub">₹${currentPriceINR.toFixed(0)} at today rate</div></div>
          <div><div class="lf-label">Value</div><div class="lf-val">${fUSD(val,true)}</div><div class="lf-sub">${fINR(valINR,true)}</div></div>
        </div>
        <div class="lot-footer">
          <div class="gain-line ${gPos?'pos':'neg'}">${signStr(gainUSD)}${fUSD(Math.abs(gainUSD))} (${signStr(gainPct)}${Math.abs(gainPct).toFixed(1)}%)</div>
          <div class="tax-line">Tax: ${fUSD(taxAmt)} <span style="color:#aaa;font-size:11px">(${(taxRate*100).toFixed(1)}%)</span></div>
        </div>
        ${fxRow}
        ${ltcgBanner}
      </div>`;
    } else {
      return `<div class="lot-card">
        <div class="lot-top">
          <div class="lot-top-left">
            <span class="lot-date">${fDate(lot.dateAcquired)}</span>
            <span class="badge ${lot.taxCategory.toLowerCase()}">${lot.taxCategory} · ${fHolding(lot.holdingMonths)}</span>
            <span class="badge ${lot.type.toLowerCase()}">${lot.type}</span>
          </div>
          <div class="schwab-pill"><div class="schwab-dot">CS</div><div class="schwab-name">CHARLES<br>SCHWAB</div></div>
        </div>
        <div class="lot-grid">
          <div><div class="lf-label">Shares</div><div class="lf-val">${lot.sharesHeld}</div></div>
          <div>
            <div class="lf-label">Vest Price (₹)</div>
            <div class="lf-val">${fINR(vestPriceINR,true)}</div>
            <div class="lf-sub">$${lot.acquisitionPrice.toFixed(2)} × ₹${pRate.toFixed(2)}</div>
          </div>
          <div>
            <div class="lf-label">Current Price (₹)</div>
            <div class="lf-val">${fINR(currentPriceINR,true)}</div>
            <div class="lf-sub">$${currentPrice.toFixed(2)} × ₹${todayINR.toFixed(2)}</div>
          </div>
          <div>
            <div class="lf-label">Total Value (₹)</div>
            <div class="lf-val">${fINR(valINR,true)}</div>
            <div class="lf-sub">${lot.sharesHeld} × ₹${currentPriceINR.toFixed(0)}</div>
          </div>
        </div>
        <div class="lot-footer">
          <div class="gain-line ${gINRPos?'pos':'neg'}">${signStr(gainINR)}${fINR(Math.abs(gainINR),true)} (${signStr(gainPctINR)}${Math.abs(gainPctINR).toFixed(1)}%)</div>
          <div class="tax-line">Tax: ${fINR(taxAmt)} <span style="color:#aaa;font-size:11px">(${(taxRate*100).toFixed(1)}%)</span></div>
        </div>
        ${fxRow}
        ${ltcgBanner}
      </div>`;
    }
  } catch(e) { console.error('Lot render error', lot, e); return ''; } }).join('');
}

window.addEventListener('DOMContentLoaded', () => {
  // Initialize landing panel with default US market selection
  renderPlatformCards();
  updateUploads();
});