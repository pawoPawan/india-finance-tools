// ═══════════════════════════════════════════════════════════════════
// INDMONEY STATE
// ═══════════════════════════════════════════════════════════════════
let imRawFiles    = { us: { cg: null, fa: null }, in: { cg: null, fa: null } };
let imUsParsed    = { stcg: [], ltcg: [], dividends: [], interest: [] };
let imUsHoldings  = [];
let imInParsed    = { stcg: [], ltcg: [], dividends: [], interest: [] };
let imInHoldings  = [];
let imSubMode     = 'us';     // 'us' | 'in'
let imCurrency    = 'USD';    // 'USD' | 'INR'
let imTaxRegime   = 'new';
let imActiveMarket = null;    // 'us' | 'in' | null

// ─── Sub-mode switcher ────────────────────────────────────────────
function setImSubMode(mode) {
  imSubMode = mode;
  document.getElementById('imTabUs').classList.toggle('active', mode === 'us');
  document.getElementById('imTabIn').classList.toggle('active', mode === 'in');
  document.getElementById('imUsUploadCards').style.display = mode === 'us' ? 'flex' : 'none';
  document.getElementById('imInUploadCards').style.display = mode === 'in' ? 'flex' : 'none';
}

function syncImSubTabs() {
  const hasUs = selectedMarkets.has('us');
  const hasIn = selectedMarkets.has('india');
  const showBoth = hasUs && hasIn;
  document.getElementById('imSubTabs').style.display = showBoth ? '' : 'none';
  if (showBoth) {
    // Both markets — restore tab-driven visibility
    setImSubMode(imSubMode);
  } else {
    // Single market — show relevant cards directly, no tabs needed
    document.getElementById('imUsUploadCards').style.display = hasUs ? 'flex' : 'none';
    document.getElementById('imInUploadCards').style.display = hasIn ? 'flex' : 'none';
    if (hasUs)  imSubMode = 'us';
    if (hasIn)  imSubMode = 'in';
  }
}

// ─── Tax regime ───────────────────────────────────────────────────
function setImRegime(r) {
  imTaxRegime = r;
  document.getElementById('imRegimeNew').classList.toggle('active', r === 'new');
  document.getElementById('imRegimeOld').classList.toggle('active', r === 'old');
  if (imActiveMarket) rerenderIndMoney(imActiveMarket);
}

// ─── Currency toggle (IndMoney) ───────────────────────────────────
function setImCurrency(c) {
  imCurrency = c;
  document.getElementById('imCurrUSD').classList.toggle('active', c === 'USD');
  document.getElementById('imCurrINR').classList.toggle('active', c === 'INR');
  // mirror button colors
  const activeStyle = 'background:#4a9eff;color:#fff';
  document.getElementById('imCurrUSD').style.cssText = c === 'USD' ? activeStyle : '';
  document.getElementById('imCurrINR').style.cssText = c === 'INR' ? activeStyle : '';
  if (imActiveMarket) rerenderIndMoney(imActiveMarket);
}

// ─── Helper: format amount in chosen currency ─────────────────────
function imAmt(usd, inr) {
  if (imCurrency === 'USD') return '$' + Math.abs(usd).toFixed(2);
  return fINR(Math.abs(inr), true);
}
function imAmtSigned(usd, inr) {
  const val = imCurrency === 'USD' ? usd : inr;
  const fmt = imCurrency === 'USD' ? ('$' + Math.abs(usd).toFixed(2)) : fINR(Math.abs(inr), true);
  return (val < 0 ? '−' : '+') + fmt;
}

// ─── IndMoney slab rate helper ────────────────────────────────────
function imGetMarginalRate() {
  const otherL   = parseFloat(document.getElementById('imOtherIncome').value) || 0;
  const otherINR = otherL * 100000;
  const slabs    = imTaxRegime === 'new' ? NEW_SLABS : OLD_SLABS;
  return getMarginalRate(otherINR + 1, slabs);
}

// ═══════════════════════════════════════════════════════════════════
// INDMONEY PARSERS
// ═══════════════════════════════════════════════════════════════════
function parseIndMoneyCG(rows, market) {
  let section = null;
  const stcg = [], ltcg = [], dividends = [], interest = [];

  for (const row of rows) {
    const first = String(row[0] || '').trim();
    if (first.startsWith('Short Term Capital Gains'))  { section = 'stcg'; continue; }
    if (first.startsWith('Long Term Capital Gains'))   { section = 'ltcg'; continue; }
    if (first === 'Dividend Income')                    { section = 'div';  continue; }
    if (first === 'Interest Income')                    { section = 'int';  continue; }
    if (first.startsWith('Disclaimer') || first.startsWith('*')) break;

    if ((section === 'stcg' || section === 'ltcg') && first === 'Security') continue;
    if ((section === 'stcg' || section === 'ltcg') && first && first !== 'Security') {
      const sym          = String(row[0]).trim();
      const saleDate     = String(row[1]).trim();
      const soldUnits    = parseFloat(row[2]) || 0;
      const sellValueUSD = parseFloat(row[3]) || 0;
      const buyValueUSD  = parseFloat(row[4]) || 0;
      const brokerage    = parseFloat(row[5]) || 0;
      const gainUSD      = parseFloat(row[6]) || 0;
      const gainINR      = parseFloat(row[7]) || 0;
      const buyDate      = String(row[8] || '').trim();
      if (sym && saleDate && soldUnits > 0) {
        const trade = { symbol: sym, saleDate, soldUnits, sellValueUSD, buyValueUSD, brokerage, gainUSD, gainINR, buyDate };
        if (section === 'stcg') stcg.push(trade); else ltcg.push(trade);
      }
    }

    if (section === 'div' && first === 'Security') continue;
    if (section === 'div' && first && first !== 'Security') {
      const sym    = String(row[0]).trim();
      const date   = String(row[1]).trim();
      const amtUSD = parseFloat(row[2]) || 0;
      const amtINR = parseFloat(row[3]) || 0;
      const desc   = String(row[4] || '').trim();
      if (sym && date) {
        dividends.push({ symbol: sym, date, amtUSD, amtINR, desc,
          isWithholding: desc.toLowerCase().includes('tax recovered') });
      }
    }

    if (section === 'int' && first === 'Date') continue;
    if (section === 'int' && first && first !== 'Date') {
      const date   = String(row[0]).trim();
      const amtUSD = parseFloat(row[1]) || 0;
      const amtINR = parseFloat(row[2]) || 0;
      if (date) interest.push({ date, amtUSD, amtINR });
    }
  }

  return { stcg, ltcg, dividends, interest };
}

function parseIndMoneyFA(rows) {
  if (!rows || !rows.length) return [];
  const holdings = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const nameWithTicker = String(row[2] || '').trim();
    if (!nameWithTicker) continue;
    const tickerMatch  = nameWithTicker.match(/\(([A-Z0-9.]+)\)$/);
    const ticker       = tickerMatch ? tickerMatch[1] : nameWithTicker;
    const name         = nameWithTicker.replace(/\([A-Z0-9.]+\)$/, '').trim();
    const country      = String(row[0] || '').trim();
    const nature       = String(row[5] || '').trim();  // "Company" or "ETF"
    const acquireDate  = String(row[6] || '').trim();
    const initialValue = parseFloat(row[7]) || 0;      // INR cost at purchase (xe.com rate)
    const peakValue    = parseFloat(String(row[8]).replace(/-/g,'')) || 0; // INR peak during FY
    const closingRaw   = String(row[9] || '').trim();
    const closingValue = closingRaw === '-' ? 0 : (parseFloat(closingRaw) || 0); // INR at FY-end
    const isSold       = closingRaw === '-';
    // col 10: dividends/income received from this lot during FY (INR, or "-")
    const divRaw       = String(row[10] || '').trim();
    const dividendINR  = (divRaw === '-' || divRaw === '') ? 0 : (parseFloat(divRaw) || 0);
    // col 11: sale proceeds if sold (INR, or "-")
    const procRaw      = String(row[11] || '').trim();
    const proceedsINR  = (procRaw === '-' || procRaw === '') ? 0 : (parseFloat(procRaw) || 0);
    if (ticker && acquireDate) {
      holdings.push({ ticker, name, country, nature, acquireDate,
        initialValue, peakValue, closingValue, isSold, dividendINR, proceedsINR });
    }
  }
  return holdings;
}

// ═══════════════════════════════════════════════════════════════════
// INDMONEY FILE HANDLERS
// ═══════════════════════════════════════════════════════════════════
async function handleImFile(market, type, e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const buf  = await file.arrayBuffer();
    const wb   = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    imRawFiles[market][type] = rows;

    const mCap  = market.charAt(0).toUpperCase() + market.slice(1);
    const tCap  = type.charAt(0).toUpperCase() + type.slice(1);
    const cardId = 'im' + mCap + tCap + 'Card';
    const infoId = 'im' + mCap + tCap + 'Info';

    const cardEl = document.getElementById(cardId);
    const infoEl = document.getElementById(infoId);
    if (cardEl) cardEl.classList.add('ready');
    if (infoEl) infoEl.innerHTML = '<div class="z-coverage-total">✓ ' + file.name + '</div>';

    // Enable analyze button if CG file is loaded
    if (imRawFiles[market].cg) {
      updateAnalyzeAllBtn();
    }
  } catch(err) {
    alert('Error reading file: ' + err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// INDMONEY ANALYSIS RUNNER
// ═══════════════════════════════════════════════════════════════════
function runIndMoneyAnalysis(market) {
  const cgRows = imRawFiles[market].cg;
  const faRows = imRawFiles[market].fa;
  if (!cgRows) { alert('Please upload a Capital Gains Statement first.'); return; }

  if (market === 'us') {
    imUsParsed   = parseIndMoneyCG(cgRows, 'us');
    imUsHoldings = faRows ? parseIndMoneyFA(faRows) : [];
  } else {
    imInParsed   = parseIndMoneyCG(cgRows, 'in');
    imInHoldings = faRows ? parseIndMoneyFA(faRows) : [];
  }

  imActiveMarket = market;
  showImResultsUI(market);
  rerenderIndMoney(market);
}

function showImResultsUI(market) {
  document.querySelector('#imSettingsPanel .settings-title').textContent =
    'IndMoney Tax Settings (' + (market === 'us' ? 'US Stocks' : 'India Stocks') + ')';
}

function resetIndMoneyResults() {
  imActiveMarket = null;
  resetImToLanding();
}

function resetIndMoney(market) {
  imRawFiles[market] = { cg: null, fa: null };
  const mCap = market.charAt(0).toUpperCase() + market.slice(1);
  ['Cg','Fa'].forEach(t => {
    const cardId = 'im' + mCap + t + 'Card';
    const infoId = 'im' + mCap + t + 'Info';
    const cardEl = document.getElementById(cardId);
    const infoEl = document.getElementById(infoId);
    if (cardEl) cardEl.classList.remove('ready');
    if (infoEl) infoEl.innerHTML = '';
  });
  updateAnalyzeAllBtn();
  resetIndMoneyResults();
}

// ═══════════════════════════════════════════════════════════════════
// INDMONEY SECTION TOGGLE
// ═══════════════════════════════════════════════════════════════════
function toggleImSection(bodyId, toggleId, metaId) {
  const body   = document.getElementById(bodyId);
  const toggle = document.getElementById(toggleId);
  const isOpen = body.style.display !== 'none';
  body.style.display   = isOpen ? 'none' : '';
  toggle.textContent   = isOpen ? '▶' : '▼';
}

// ═══════════════════════════════════════════════════════════════════
// INDMONEY RENDERER
// ═══════════════════════════════════════════════════════════════════
function rerenderIndMoney(market) {
  if (!market) return;
  const parsed   = market === 'us' ? imUsParsed   : imInParsed;
  const holdings = market === 'us' ? imUsHoldings : imInHoldings;

  const stcgRate = (parseFloat(document.getElementById('imStcgRate').value) || 30)   / 100;
  const ltcgRate = (parseFloat(document.getElementById('imLtcgRate').value) || 12.5) / 100;

  // ─── Compute totals ────────────────────────────────────────────
  const totalStcgUSD = parsed.stcg.reduce((s,t) => s + t.gainUSD, 0);
  const totalStcgINR = parsed.stcg.reduce((s,t) => s + t.gainINR, 0);
  const totalLtcgUSD = parsed.ltcg.reduce((s,t) => s + t.gainUSD, 0);
  const totalLtcgINR = parsed.ltcg.reduce((s,t) => s + t.gainINR, 0);

  // Dividends: separate gross from withholding
  const grossDivs  = parsed.dividends.filter(d => !d.isWithholding);
  const withholding = parsed.dividends.filter(d => d.isWithholding);
  const totalDivUSD = grossDivs.reduce((s,d) => s + d.amtUSD, 0);
  const totalDivINR = grossDivs.reduce((s,d) => s + d.amtINR, 0);
  const totalWhtUSD = withholding.reduce((s,d) => s + Math.abs(d.amtUSD), 0);
  const totalWhtINR = withholding.reduce((s,d) => s + Math.abs(d.amtINR), 0);

  // Tax estimates
  const stcgTaxINR  = Math.max(totalStcgINR, 0) * stcgRate;
  const ltcgTaxINR  = Math.max(totalLtcgINR, 0) * ltcgRate;
  const divTaxINR   = Math.max(totalDivINR, 0) * stcgRate;  // dividends taxed at slab
  const totalTaxINR = stcgTaxINR + ltcgTaxINR + divTaxINR;

  // ─── Consolidated table ────────────────────────────────────────
  const conEl = document.getElementById('imConsolidated');
  conEl.innerHTML = `
    <table class="im-con-table">
      <thead><tr>
        <th>Category</th>
        <th>Gain / Income (${imCurrency})</th>
        <th>Est. Tax (₹)</th>
      </tr></thead>
      <tbody>
        <tr>
          <td>Short-Term Capital Gains <span style="font-size:10px;color:#888">(${stcgRate*100}% slab)</span></td>
          <td class="${totalStcgINR>=0?'pos':'neg'}">${imAmtSigned(totalStcgUSD, totalStcgINR)}</td>
          <td class="tax-col">${totalStcgINR>0?fINR(stcgTaxINR,true):'—'}</td>
        </tr>
        <tr>
          <td>Long-Term Capital Gains <span style="font-size:10px;color:#888">(${ltcgRate*100}%)</span></td>
          <td class="${totalLtcgINR>=0?'pos':'neg'}">${imAmtSigned(totalLtcgUSD, totalLtcgINR)}</td>
          <td class="tax-col">${totalLtcgINR>0?fINR(ltcgTaxINR,true):'—'}</td>
        </tr>
        <tr>
          <td>Dividend Income <span style="font-size:10px;color:#888">(gross; US WHT credit available)</span></td>
          <td class="${totalDivINR>=0?'pos':'neg'}">${imAmtSigned(totalDivUSD, totalDivINR)}</td>
          <td class="tax-col">${totalDivINR>0?fINR(divTaxINR,true):'—'}</td>
        </tr>
        <tr class="im-con-total">
          <td>Total</td>
          <td></td>
          <td class="tax-col">${fINR(totalTaxINR,true)}</td>
        </tr>
      </tbody>
    </table>`;

  // ─── STCG cards ───────────────────────────────────────────────
  document.getElementById('imStcgMeta').textContent =
    parsed.stcg.length + ' trade' + (parsed.stcg.length !== 1 ? 's' : '') +
    ' · ' + (totalStcgINR >= 0 ? '+' : '') + (imCurrency==='USD' ? '$'+Math.abs(totalStcgUSD).toFixed(2) : fINR(Math.abs(totalStcgINR),true));

  const stcgBySymbol = groupImTrades(parsed.stcg);
  document.getElementById('imStcgCards').innerHTML =
    stcgBySymbol.map(g => renderImTradeGroup(g, stcgRate, 'STCG')).join('') ||
    '<div class="empty-state">No short-term capital gains</div>';

  // ─── LTCG cards ───────────────────────────────────────────────
  document.getElementById('imLtcgMeta').textContent =
    parsed.ltcg.length + ' trade' + (parsed.ltcg.length !== 1 ? 's' : '') +
    ' · ' + (totalLtcgINR >= 0 ? '+' : '') + (imCurrency==='USD' ? '$'+Math.abs(totalLtcgUSD).toFixed(2) : fINR(Math.abs(totalLtcgINR),true));

  const ltcgBySymbol = groupImTrades(parsed.ltcg);
  document.getElementById('imLtcgCards').innerHTML =
    ltcgBySymbol.map(g => renderImTradeGroup(g, ltcgRate, 'LTCG')).join('') ||
    '<div class="empty-state">No long-term capital gains</div>';

  // ─── Dividend cards ───────────────────────────────────────────
  document.getElementById('imDivMeta').textContent =
    grossDivs.length + ' payment' + (grossDivs.length !== 1 ? 's' : '') +
    ' · gross ' + (imCurrency==='USD' ? '$'+totalDivUSD.toFixed(2) : fINR(totalDivINR,true)) +
    ' · WHT ' + (imCurrency==='USD' ? '$'+totalWhtUSD.toFixed(2) : fINR(totalWhtINR,true));

  document.getElementById('imDivCards').innerHTML = renderImDividends(grossDivs, withholding, stcgRate);

  // ─── Holdings/open positions ───────────────────────────────────
  const openHoldings = holdings.filter(h => !h.isSold);
  const soldHoldings = holdings.filter(h => h.isSold);
  const uniqueTickers = new Set(openHoldings.map(h => h.ticker)).size;
  const totalOpenCost    = openHoldings.reduce((s, h) => s + h.initialValue, 0);
  const totalOpenCurrent = openHoldings.reduce((s, h) => s + h.closingValue, 0);
  const totalOpenGain    = totalOpenCurrent - totalOpenCost;
  const gainSign = totalOpenGain >= 0;
  document.getElementById('imHoldingsMeta').textContent =
    uniqueTickers + ' ticker' + (uniqueTickers !== 1 ? 's' : '') + ' · ' +
    openHoldings.length + ' lot' + (openHoldings.length !== 1 ? 's' : '') +
    (openHoldings.length ? ' · ' + (gainSign ? '+' : '−') + '₹' + Math.abs(totalOpenGain).toFixed(0) + ' unrealized (FY-end)' : '');
  document.getElementById('imHoldingsCards').innerHTML =
    openHoldings.length ? renderImHoldings(openHoldings) :
    (holdings.length ? '<div class="empty-state">All positions closed (loaded ' + holdings.length + ' from FA Schedule)</div>' :
    '<div class="empty-state">No FA Schedule uploaded — open positions not available</div>');

  // ─── Sold this FY (from FA Schedule col 11) ────────────────────
  const imSoldSection = document.getElementById('imSoldSection');
  const imSoldCards   = document.getElementById('imSoldCards');
  const imSoldMeta    = document.getElementById('imSoldMeta');
  if (imSoldSection) {
    if (soldHoldings.length) {
      const soldTickers = new Set(soldHoldings.map(h => h.ticker)).size;
      const totalSoldCost  = soldHoldings.reduce((s, h) => s + h.initialValue, 0);
      const totalSoldProc  = soldHoldings.reduce((s, h) => s + h.proceedsINR, 0);
      const totalSoldGain  = totalSoldProc - totalSoldCost;
      imSoldMeta.textContent = soldTickers + ' ticker' + (soldTickers !== 1 ? 's' : '') +
        ' · ' + soldHoldings.length + ' lot' + (soldHoldings.length !== 1 ? 's' : '') +
        ' · ' + (totalSoldGain >= 0 ? '+' : '−') + '₹' + Math.abs(totalSoldGain).toFixed(0) + ' gross gain';
      imSoldCards.innerHTML = renderImSoldHoldings(soldHoldings);
      imSoldSection.style.display = '';
    } else {
      imSoldSection.style.display = 'none';
    }
  }

  // ─── Schedule FA Summary (for ITR filing reference) ────────────
  const imFaSummaryEl = document.getElementById('imFaSummary');
  if (imFaSummaryEl && holdings.length) {
    imFaSummaryEl.style.display = '';
    imFaSummaryEl.innerHTML = renderFaSummary(holdings);
  } else if (imFaSummaryEl) {
    imFaSummaryEl.style.display = 'none';
  }
}

// ─── Group trades by symbol ────────────────────────────────────────
function groupImTrades(trades) {
  const map = {};
  for (const t of trades) {
    if (!map[t.symbol]) map[t.symbol] = { symbol: t.symbol, trades: [] };
    map[t.symbol].trades.push(t);
  }
  return Object.values(map).sort((a,b) => {
    const gA = a.trades.reduce((s,t) => s + t.gainINR, 0);
    const gB = b.trades.reduce((s,t) => s + t.gainINR, 0);
    return gB - gA;
  });
}

// ─── Render a symbol group of CG trades ───────────────────────────
function renderImTradeGroup(g, taxRate, type) {
  const totalGainUSD = g.trades.reduce((s,t) => s + t.gainUSD, 0);
  const totalGainINR = g.trades.reduce((s,t) => s + t.gainINR, 0);
  const taxINR       = Math.max(totalGainINR, 0) * taxRate;
  const isPos        = totalGainINR >= 0;
  const tid          = 'im_' + type.toLowerCase() + '_' + g.symbol.replace(/[^a-zA-Z0-9]/g,'_');

  const tradeRows = g.trades.map(t => `
    <tr>
      <td>${t.saleDate}</td>
      <td>${t.buyDate}</td>
      <td style="text-align:right">${t.soldUnits}</td>
      <td style="text-align:right">$${t.sellValueUSD.toFixed(2)}</td>
      <td style="text-align:right">$${t.buyValueUSD.toFixed(2)}</td>
      <td style="text-align:right" class="${t.gainUSD>=0?'pos':'neg'}">$${t.gainUSD.toFixed(2)}</td>
      <td style="text-align:right" class="${t.gainINR>=0?'pos':'neg'}">${fINR(t.gainINR,true)}</td>
    </tr>`).join('');

  return `<div class="im-trade-card">
    <div class="im-trade-top">
      <div>
        <div class="im-trade-symbol">${g.symbol}</div>
        <div class="im-trade-meta">${g.trades.length} trade${g.trades.length!==1?'s':''} · <span class="badge ${type.toLowerCase()}">${type}</span></div>
      </div>
      <div style="text-align:right">
        <div class="gain-line ${isPos?'pos':'neg'}" style="font-size:15px;font-weight:800">${isPos?'+':'−'}${imAmt(totalGainUSD,totalGainINR)}</div>
        ${totalGainINR>0?'<div style="font-size:11px;color:#e65100">Tax ~'+fINR(taxINR,true)+'</div>':''}
      </div>
    </div>
    <div class="im-trade-footer">
      <span style="font-size:12px;color:#888">Sell: ${imAmt(g.trades.reduce((s,t)=>s+t.sellValueUSD,0), 0)} · Buy: ${imAmt(g.trades.reduce((s,t)=>s+t.buyValueUSD,0), 0)}</span>
      ${totalGainINR>0?'<span style="font-size:12px;color:#e65100">Tax ~'+fINR(taxINR,true)+'</span>':''}
    </div>
    <div class="im-trades-toggle" id="btn_${tid}" onclick="toggleImTrades('${tid}','btn_${tid}')">
      ▶ Show ${g.trades.length} trade${g.trades.length!==1?'s':''}
    </div>
    <div id="${tid}" class="im-trades-body">
      <table class="im-trades-table">
        <thead><tr>
          <th style="text-align:left">Sale Date</th>
          <th style="text-align:left">Buy Date</th>
          <th>Units</th><th>Sell $</th><th>Buy $</th><th>Gain $</th><th>Gain ₹</th>
        </tr></thead>
        <tbody>${tradeRows}</tbody>
      </table>
    </div>
  </div>`;
}

// ─── Render dividend section ───────────────────────────────────────
function renderImDividends(grossDivs, withholding, taxRate) {
  if (!grossDivs.length && !withholding.length) return '<div class="empty-state">No dividend income</div>';

  // Group gross dividends by symbol
  const map = {};
  for (const d of grossDivs) {
    if (!map[d.symbol]) map[d.symbol] = { symbol: d.symbol, payments: [], totalUSD:0, totalINR:0 };
    map[d.symbol].payments.push(d);
    map[d.symbol].totalUSD += d.amtUSD;
    map[d.symbol].totalINR += d.amtINR;
  }

  // withholding total
  const whtUSD = withholding.reduce((s,d) => s + Math.abs(d.amtUSD), 0);
  const whtINR = withholding.reduce((s,d) => s + Math.abs(d.amtINR), 0);

  let html = Object.values(map).map(g => {
    const taxINR  = Math.max(g.totalINR, 0) * taxRate;
    const tid     = 'im_div_' + g.symbol.replace(/[^a-zA-Z0-9]/g,'_');
    const rows    = g.payments.map(p => `
      <tr>
        <td>${p.date}</td>
        <td style="text-align:right">$${p.amtUSD.toFixed(2)}</td>
        <td style="text-align:right">${fINR(p.amtINR,true)}</td>
        <td style="font-size:11px;color:#888">${p.desc}</td>
      </tr>`).join('');
    return `<div class="im-div-card">
      <div class="im-div-top">
        <div>
          <div class="im-div-symbol">${g.symbol}</div>
          <div class="im-trade-meta">${g.payments.length} payment${g.payments.length!==1?'s':''}</div>
        </div>
        <div style="text-align:right">
          <div class="gain-line pos" style="font-size:15px;font-weight:800">+${imAmt(g.totalUSD,g.totalINR)}</div>
          <div style="font-size:11px;color:#e65100">Tax ~${fINR(taxINR,true)}</div>
        </div>
      </div>
      <div class="im-trades-toggle" id="btn_${tid}" onclick="toggleImTrades('${tid}','btn_${tid}')">▶ Show payments</div>
      <div id="${tid}" class="im-trades-body">
        <table class="im-trades-table">
          <thead><tr>
            <th style="text-align:left">Date</th><th>Amount $</th><th>Amount ₹</th><th style="text-align:left">Description</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="im-div-footer">Gross dividend — taxable as Other Income at slab rate. US withholding tax (DTAA 25%) is available as credit.</div>
    </div>`;
  }).join('');

  if (whtUSD > 0) {
    html += `<div style="margin:0 0 10px;padding:10px 16px;background:#fff3e0;border-radius:10px;font-size:13px;color:#bf360c;font-weight:600">
      US Withholding Tax (already deducted): $${whtUSD.toFixed(2)} / ${fINR(whtINR,true)}
      <span style="font-size:11px;color:#888;font-weight:400;display:block;margin-top:3px">
        This tax is creditable under India-US DTAA — claim as Foreign Tax Credit in ITR Schedule FSI.
      </span>
    </div>`;
  }
  return html;
}

// ─── Render sold positions this FY (FA Schedule col 11) ───────────
function renderImSoldHoldings(soldHoldings) {
  const usdRate  = parseFloat(document.getElementById('imUsdRate')?.value) || 84.5;
  const showINR  = !((typeof imCurrency !== 'undefined') && imCurrency === 'USD');

  function fAmt(inrVal) {
    if (showINR) return fINR(inrVal, true);
    return '$' + (inrVal / usdRate).toFixed(0);
  }

  // group by ticker
  const byTicker = {};
  for (const h of soldHoldings) {
    if (!byTicker[h.ticker]) byTicker[h.ticker] = { name: h.name, lots: [] };
    byTicker[h.ticker].lots.push(h);
  }

  return Object.entries(byTicker).map(([ticker, group]) => {
    const lots      = group.lots;
    const totalCost = lots.reduce((s, h) => s + h.initialValue, 0);
    const totalProc = lots.reduce((s, h) => s + h.proceedsINR, 0);
    const totalGain = totalProc - totalCost;
    const gainSign  = totalGain >= 0;

    const lotRows = lots.map(h => {
      const gain = h.proceedsINR - h.initialValue;
      const gSign = gain >= 0;
      return `<div class="im-sold-lot">
        <span class="im-lot-date">${h.acquireDate}</span>
        <span style="color:#888;font-size:11px">${h.nature}</span>
        <span style="margin-left:auto;color:#888;font-size:11px">Cost ${fAmt(h.initialValue)}</span>
        <span style="color:#888;font-size:11px">→</span>
        <span style="font-weight:700;color:#1a1a2e;font-size:12px">Proceeds ${fAmt(h.proceedsINR)}</span>
        <span style="font-size:11px;color:${gSign?'#2e7d32':'#c62828'};font-weight:600">${gSign?'+':'−'}${fAmt(Math.abs(gain))}</span>
      </div>`;
    }).join('');

    return `<div class="im-sold-card">
      <div class="im-sold-top">
        <div>
          <div class="im-holding-symbol">${ticker}</div>
          <div class="im-holding-meta">${group.name} · ${lots.length} sold lot${lots.length !== 1 ? 's' : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:13px;font-weight:700;color:#888">Proceeds ${fAmt(totalProc)}</div>
          <div style="font-size:11px;color:${gainSign?'#2e7d32':'#c62828'};font-weight:600">
            ${gainSign?'+':'−'}${fAmt(Math.abs(totalGain))} gross gain (pre-brokerage)
          </div>
        </div>
      </div>
      <div class="im-lots-inner">${lotRows}</div>
    </div>`;
  }).join('');
}

// ─── Schedule FA Summary — ITR filing reference ────────────────────
// All values from IndMoney FA Schedule, in INR (using xe.com rates).
// For Indian ITR Schedule FA (Part B: Foreign Equity & Debt Interest)
function renderFaSummary(holdings) {
  const usdRate = parseFloat(document.getElementById('imUsdRate')?.value) || 84.5;
  const showINR = !((typeof imCurrency !== 'undefined') && imCurrency === 'USD');
  function fAmt(inrVal) {
    return showINR ? fINR(inrVal, true) : '$' + (inrVal / usdRate).toFixed(0);
  }

  const allTickers   = new Set(holdings.map(h => h.ticker)).size;
  const allLots      = holdings.length;
  const totalCostINR = holdings.reduce((s, h) => s + h.initialValue, 0);
  const openH        = holdings.filter(h => !h.isSold);
  const soldH        = holdings.filter(h => h.isSold);
  const totalCloseINR   = openH.reduce((s, h) => s + h.closingValue, 0);
  const totalProcINR    = soldH.reduce((s, h) => s + h.proceedsINR, 0);
  const totalDivINR     = holdings.reduce((s, h) => s + h.dividendINR, 0);
  const unrealizedINR   = totalCloseINR - openH.reduce((s, h) => s + h.initialValue, 0);
  const realizedGrossINR = totalProcINR - soldH.reduce((s, h) => s + h.initialValue, 0);
  const gainSign = unrealizedINR >= 0;
  const rgSign   = realizedGrossINR >= 0;

  return `<div class="im-fa-summary">
    <div class="im-fa-summary-title">Schedule FA — Foreign Asset Summary (ITR Filing Reference, FY 2025-26)</div>
    <div class="im-fa-summary-grid">
      <div class="im-fa-stat">
        <div class="im-fa-stat-label">Assets Reported</div>
        <div class="im-fa-stat-val">${allTickers} tickers</div>
        <div class="im-fa-stat-sub">${allLots} lots · ${openH.length} open · ${soldH.length} sold</div>
      </div>
      <div class="im-fa-stat">
        <div class="im-fa-stat-label">Initial Value of Investment</div>
        <div class="im-fa-stat-val">${fAmt(totalCostINR)}</div>
        <div class="im-fa-stat-sub">Initial value at purchase (INR)</div>
      </div>
      <div class="im-fa-stat">
        <div class="im-fa-stat-label">Closing Balance</div>
        <div class="im-fa-stat-val">${fAmt(totalCloseINR)}</div>
        <div class="im-fa-stat-sub">${openH.length} open lots at FY-end · <span style="color:${gainSign?'#2e7d32':'#c62828'};font-weight:700">${gainSign?'+':'−'}${fAmt(Math.abs(unrealizedINR))}</span></div>
      </div>
      <div class="im-fa-stat">
        <div class="im-fa-stat-label">Total Proceeds from Sale</div>
        <div class="im-fa-stat-val">${fAmt(totalProcINR)}</div>
        <div class="im-fa-stat-sub">${soldH.length} sold lots · <span style="color:${rgSign?'#2e7d32':'#c62828'};font-weight:700">${rgSign?'+':'−'}${fAmt(Math.abs(realizedGrossINR))}</span> gross</div>
      </div>
      <div class="im-fa-stat">
        <div class="im-fa-stat-label">Gross Amount Paid/Credited</div>
        <div class="im-fa-stat-val">${fAmt(totalDivINR)}</div>
        <div class="im-fa-stat-sub">Gross; from FA Schedule</div>
      </div>
    </div>
    <div class="im-fa-note">
      <strong>For ITR:</strong> Report each lot in <strong>Schedule FA → Part B</strong> (equity interest in foreign entity).
      Use <em>Initial Value</em> as cost (Col 8), <em>Closing Balance</em> for open lots (Col 10), <em>Proceeds</em> for sold lots (Col 12).
      For capital gains tax, use the <strong>CG Statement</strong> data above (accounts for brokerage &amp; exact sale dates).
      FA Schedule dividends (₹${totalDivINR.toFixed(0)}) may differ from CG Statement dividends — CG Statement is more complete.
    </div>
  </div>`;
}

// ─── Render open positions (FA Schedule) — grouped by ticker ───────
// NOTE: IndMoney FA Schedule stores values in INR (using xe.com rates at purchase/closing date).
// Each lot is typically a fractional share investment (e.g. ₹465 = ~0.07 PLTR shares at ₹6,500/share).
function renderImHoldings(holdings) {
  const usdRate  = parseFloat(document.getElementById('imUsdRate')?.value) || 84.5;
  const ltcgRate = parseFloat(document.getElementById('imLtcgRate')?.value) / 100 || 0.125;
  const stcgRate = parseFloat(document.getElementById('imStcgRate')?.value) / 100 || 0.30;
  const showINR  = !((typeof imCurrency !== 'undefined') && imCurrency === 'USD');
  // FA Schedule values are always in INR — convert to USD only when USD mode selected
  const TODAY_MS = new Date().getTime();
  const LTCG_DAYS = 730; // US stocks: 24 months (u/s 48, Explanation 1)

  // group lots by ticker
  const byTicker = {};
  for (const h of holdings) {
    if (!byTicker[h.ticker]) byTicker[h.ticker] = { name: h.name, lots: [] };
    byTicker[h.ticker].lots.push(h);
  }

  // FA Schedule values are in INR; USD display divides by today's rate
  function fAmt(inrVal) {
    if (showINR) return fINR(inrVal, true);
    return '$' + (inrVal / usdRate).toFixed(0);
  }
  function fAmtDetail(inrVal) {
    if (showINR) return fINR(inrVal, true);
    return '$' + (inrVal / usdRate).toFixed(2);
  }

  function holdingDays(acquireDate) {
    if (!acquireDate) return 0;
    let d;
    if (/^\d{4}-\d{2}-\d{2}/.test(acquireDate)) {
      d = new Date(acquireDate + 'T00:00:00');
    } else {
      const parts = acquireDate.split(/[\/\-]/);
      d = new Date(`${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}T00:00:00`);
    }
    return Math.floor((TODAY_MS - d.getTime()) / 86400000);
  }

  return Object.entries(byTicker).map(([ticker, group]) => {
    const lots = group.lots;
    const totalCostINR    = lots.reduce((s, h) => s + h.initialValue, 0);
    const totalCurrentINR = lots.reduce((s, h) => s + h.closingValue, 0);
    const totalGainINR    = totalCurrentINR - totalCostINR;
    const gainSign        = totalGainINR >= 0;

    // estimated tax — gain is in INR; tax is in INR
    let estTaxINR = 0;
    for (const h of lots) {
      const days   = holdingDays(h.acquireDate);
      const gainINR = h.closingValue - h.initialValue;
      if (gainINR > 0) {
        estTaxINR += gainINR * (days >= LTCG_DAYS ? ltcgRate : stcgRate);
      }
    }

    const lotRows = lots.map(h => {
      const days      = holdingDays(h.acquireDate);
      const isLTCG    = days >= LTCG_DAYS;
      const daysToLTCG = LTCG_DAYS - days;
      const gainINR   = h.closingValue - h.initialValue;
      const gainPos   = gainINR >= 0;
      let badge, countdown = '';
      if (isLTCG) {
        badge = `<span class="im-lot-badge ltcg">LTCG</span>`;
      } else if (daysToLTCG <= 90) {
        badge = `<span class="im-lot-badge near">STCG</span>`;
        countdown = `<span class="im-lot-countdown">${daysToLTCG}d to LTCG</span>`;
      } else {
        badge = `<span class="im-lot-badge stcg">STCG</span>`;
        countdown = `<span class="im-lot-countdown">${daysToLTCG}d to LTCG</span>`;
      }
      const lotTaxINR = gainINR > 0 ? gainINR * (isLTCG ? ltcgRate : stcgRate) : 0;
      const taxStr    = gainINR > 0 ? ` · est. ${fAmt(lotTaxINR)} tax` : '';
      const divStr = h.dividendINR > 0 ? `<span style="font-size:10px;background:#e8f5e9;color:#2e7d32;font-weight:700;padding:1px 5px;border-radius:4px">div ${fAmt(h.dividendINR)}</span>` : '';
      return `<div class="im-lot-row">
        <span class="im-lot-date">${h.acquireDate}</span>
        ${badge}${countdown ? ' ' + countdown : ''}
        <span style="color:#888;font-size:11px">${days}d held</span>
        ${divStr}
        <span style="margin-left:auto;font-size:12px;font-weight:700;color:#1a1a2e">${fAmt(h.closingValue)}</span>
        <span style="font-size:11px;color:${gainPos?'#2e7d32':'#c62828'};font-weight:600">${gainPos?'+':'−'}${fAmtDetail(Math.abs(gainINR))}${taxStr}</span>
      </div>`;
    }).join('');

    return `<div class="im-holding-card">
      <div class="im-holding-top">
        <div>
          <div class="im-holding-symbol">${ticker}</div>
          <div class="im-holding-meta">${group.name} · ${lots.length} lot${lots.length !== 1 ? 's' : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:15px;font-weight:800;color:#1565c0">${fAmt(totalCurrentINR)}</div>
          <div style="font-size:11px;color:${gainSign?'#2e7d32':'#c62828'};font-weight:600">${gainSign?'+':'−'}${fAmt(Math.abs(totalGainINR))} unrealized</div>
        </div>
      </div>
      <div class="im-ticker-summary">
        <div class="im-ticker-stat"><div class="im-ticker-stat-label">Cost Basis</div><div class="im-ticker-stat-val">${fAmt(totalCostINR)}</div></div>
        <div class="im-ticker-stat"><div class="im-ticker-stat-label">FY-end Value</div><div class="im-ticker-stat-val">${fAmt(totalCurrentINR)}</div></div>
        <div class="im-ticker-stat"><div class="im-ticker-stat-label">Unrealized Gain</div><div class="im-ticker-stat-val" style="color:${gainSign?'#2e7d32':'#c62828'}">${gainSign?'+':'−'}${fAmt(Math.abs(totalGainINR))}</div></div>
        <div class="im-ticker-stat"><div class="im-ticker-stat-label">Est. Tax on Gain</div><div class="im-ticker-stat-val" style="color:#e65100">${fAmt(estTaxINR)}</div></div>
        ${lots.reduce((s,h)=>s+h.dividendINR,0) > 0 ? `<div class="im-ticker-stat"><div class="im-ticker-stat-label">Dividends (FA)</div><div class="im-ticker-stat-val" style="color:#2e7d32">${fAmt(lots.reduce((s,h)=>s+h.dividendINR,0))}</div></div>` : ''}
      </div>
      <div class="im-lots-inner">${lotRows}</div>
    </div>`;
  }).join('');
}

// ─── Toggle IndMoney trade row visibility ─────────────────────────
function toggleImTrades(bodyId, btnId) {
  const body  = document.getElementById(bodyId);
  const btn   = document.getElementById(btnId);
  // .im-trades-body is hidden via CSS (display:none), not inline style,
  // so we must check for explicit 'block' to know if it's open
  const isOpen = body.style.display === 'block';
  body.style.display = isOpen ? '' : 'block';
  if (btn) btn.textContent = (isOpen ? '▶' : '▼') + btn.textContent.slice(1);
}

// ═══════════════════════════════════════════════════════════════════
// INDMONEY — INDIA MARKET (Zerodha-equivalent features, different format)
// ═══════════════════════════════════════════════════════════════════
let imInRawFiles = { eq: { trades:[], files:[] }, fo: { trades:[], files:[] }, mf: { trades:[], files:[] } };
let imInRealized = [];
let imInOpen     = {};
let imInFoPnl    = [];
let imInMfOpen   = {};
let imInIntraday = [];
let imInFilter   = 'all';

// ─── Flexible parser — handles IndMoney India tradebook format ─────
// Detects columns by name (case-insensitive partial match) so it works
// regardless of minor column name differences across IndMoney versions.
function parseIndMoneyIndiaTradebook(rows, fileType) {
  // Find header row
  let hdrIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(c => String(c).trim().toLowerCase());
    const hasSymbol = cells.some(h => ['symbol','stock','scrip','ticker','instrument'].includes(h));
    const hasDate   = cells.some(h => h.includes('date'));
    const hasQty    = cells.some(h => ['quantity','qty','units'].includes(h));
    if (hasSymbol && hasDate && hasQty) { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) return [];

  const headers = rows[hdrIdx].map(c => String(c).trim().toLowerCase());
  // Find column by any matching keyword
  const col = (...names) => {
    for (const n of names) {
      const idx = headers.findIndex(h => h.includes(n));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const iSymbol  = col('symbol','stock','scrip','ticker','instrument');
  const iDate    = col('trade date','order date','transaction date','date');
  const iType    = col('trade type','transaction type','order type','buy/sell','type');
  const iQty     = col('quantity','qty','units');
  const iPrice   = col('trade price','price','rate','avg price');
  const iISIN    = col('isin');
  const iTradeId = col('trade id','order id','transaction id','ref');

  if (iSymbol < 0 || iDate < 0 || iQty < 0 || iPrice < 0) return [];

  const trades = [];
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => String(c).trim() === '')) continue;
    const sym = String(row[iSymbol] || '').trim();
    if (!sym) continue;

    // Parse date — supports YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY
    let rawDate = row[iDate];
    let dateStr = '';
    if (rawDate instanceof Date) {
      dateStr = rawDate.toISOString().split('T')[0];
    } else {
      const s = String(rawDate).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s))           dateStr = s.slice(0, 10);
      else if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(s)) {
        const p = s.split(/[\/\-]/);
        dateStr = `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
      } else dateStr = s.slice(0, 10);
    }

    const rawType = String(row[iType] || '').trim().toLowerCase();
    const type    = rawType.includes('buy') ? 'buy' : rawType.includes('sell') ? 'sell' : '';
    const qty     = parseFloat(String(row[iQty]   || '0').replace(/,/g,'')) || 0;
    const price   = parseFloat(String(row[iPrice] || '0').replace(/,/g,'')) || 0;
    const isin    = iISIN    >= 0 ? String(row[iISIN]    || '').trim() : '';
    const tId     = iTradeId >= 0 ? String(row[iTradeId] || '').trim() : '';
    const dedupKey = tId || `${sym}|${dateStr}|${type}|${qty}|${price}`;

    if (!dateStr || !type || qty <= 0) continue;
    trades.push({ symbol: sym, isin, date: dateStr, type, qty, price, fileType, dedupKey });
  }
  return trades;
}

// ─── File handler ─────────────────────────────────────────────────
async function handleImInFile(type, e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  for (const file of files) {
    try {
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array', cellDates: true });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      const parsed = parseIndMoneyIndiaTradebook(rows, type);
      if (!parsed.length) {
        alert(`No trades found in "${file.name}".\nExpected columns: Symbol, Date, Trade Type, Quantity, Price.\nCheck file format.`);
        continue;
      }

      const existingKeys = new Set(imInRawFiles[type].trades.map(t => t.dedupKey));
      const newTrades    = parsed.filter(t => !existingKeys.has(t.dedupKey));
      const dupeCount    = parsed.length - newTrades.length;

      if (!newTrades.length) {
        alert(`"${file.name}" — all ${parsed.length} trades already loaded (duplicates skipped).`);
        continue;
      }

      const dates   = newTrades.map(t => t.date).sort();
      imInRawFiles[type].trades.push(...newTrades);
      imInRawFiles[type].files.push({ name: file.name, dateMin: dates[0], dateMax: dates[dates.length-1], count: newTrades.length, dupeCount });

    } catch (err) {
      console.error('ImIn parse error', err);
      alert(`Error reading "${file.name}": ` + err.message);
    }
  }

  renderImInSegmentCard(type);
  updateImInAnalyzeBtn();
}

function renderImInSegmentCard(type) {
  const seg    = imInRawFiles[type];
  const cardId = { eq:'imInEqCard', fo:'imInFoCard', mf:'imInMfCard' }[type];
  const infoId = { eq:'imInEqFilesInfo', fo:'imInFoFilesInfo', mf:'imInMfFilesInfo' }[type];
  const card   = document.getElementById(cardId);
  const info   = document.getElementById(infoId);
  if (!seg.files.length) { card.classList.remove('ready'); info.innerHTML = ''; return; }

  card.classList.add('ready');
  const sorted = [...seg.files].sort((a,b) => a.dateMin.localeCompare(b.dateMin));
  const { gaps, overlaps } = detectSegmentGaps(sorted);

  const fileItems = sorted.map(f => `
    <div class="z-file-item">
      <span class="z-file-name" title="${f.name}">${f.name}</span>
      <span class="z-file-range">${fDate(f.dateMin)} → ${fDate(f.dateMax)}</span>
      <span class="z-file-count">${f.count} trades</span>
      ${f.dupeCount ? `<span class="z-file-dupes">(${f.dupeCount} dupes skipped)</span>` : ''}
    </div>`).join('');

  const gapWarnings  = gaps.map(g => `<div class="z-gap-warning">⚠ Gap: ${fDate(g.from)} → ${fDate(g.to)} — <strong>${g.days} days missing</strong></div>`).join('');
  const overlapNote  = overlaps > 0 ? `<div class="z-overlap-note">✓ Overlaps detected — duplicates auto-removed</div>` : '';

  info.innerHTML = `
    <div class="z-coverage-total">Coverage: <strong>${fDate(sorted[0].dateMin)} → ${fDate(sorted[sorted.length-1].dateMax)}</strong> · ${seg.trades.length} unique trades</div>
    ${fileItems}${gapWarnings}${overlapNote}`;
}

function updateImInAnalyzeBtn() {
  updateAnalyzeAllBtn();
}

// ─── Analysis runner ───────────────────────────────────────────────
function runIndMoneyIndiaAnalysis() {
  const eqTrades = imInRawFiles.eq.trades;
  const foTrades = imInRawFiles.fo.trades;
  const mfTrades = imInRawFiles.mf.trades;

  const { intradayPnl, deliveryTrades } = extractIntraday(eqTrades);
  imInIntraday = intradayPnl;

  const { realized, open } = runFIFO([...deliveryTrades, ...mfTrades]);
  imInRealized = realized;
  imInOpen     = open;
  imInFoPnl    = computeFoPnl(foTrades);

  imInMfOpen = {};
  for (const [sym, lots] of Object.entries(open)) {
    if (mfTrades.some(t => t.symbol === sym)) imInMfOpen[sym] = lots;
  }

  // Show India results, hide US results
  document.getElementById('imUsResults').style.display      = 'none';
  document.getElementById('imInResults').style.display      = 'block';
  document.querySelector('#imSettingsPanel .settings-title').textContent = 'IndMoney Tax Settings (India Stocks)';
  imActiveMarket = 'in';

  rerenderImIndia();
}

// ─── Filter ────────────────────────────────────────────────────────
function setImInFilter(f, el) {
  imInFilter = f;
  document.querySelectorAll('#imInFilterBar .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  rerenderImIndia();
}

// ─── Reset ────────────────────────────────────────────────────────
function resetImIndia() {
  imInRawFiles = { eq: { trades:[], files:[] }, fo: { trades:[], files:[] }, mf: { trades:[], files:[] } };
  ['eq','fo','mf'].forEach(t => renderImInSegmentCard(t));
  updateAnalyzeAllBtn();
  imInRealized = []; imInOpen = {}; imInFoPnl = []; imInMfOpen = {}; imInIntraday = [];
  document.getElementById('imUsResults').style.display = 'block';
  document.getElementById('imInResults').style.display = 'none';
  imActiveMarket = null;
  // Reset back to India sub-tab
  setImSubMode('in');
}

// ─── Renderer — reuses all Zerodha card builders ──────────────────
function rerenderImIndia() {
  if (!imInRealized.length && !Object.keys(imInOpen).length && !imInFoPnl.length && !imInIntraday.length) return;

  const ltcgRate = (parseFloat(document.getElementById('imLtcgRate').value) || 12.5) / 100;
  const stcgRate = (parseFloat(document.getElementById('imStcgRate').value) || 20)   / 100;
  const EXEMPT   = 125000;
  const otherL   = parseFloat(document.getElementById('imOtherIncome').value) || 0;
  const otherINR = otherL * 100000;
  const slabs    = imTaxRegime === 'new' ? NEW_SLABS : OLD_SLABS;

  // Per-category stats
  const stats = { eq:{stcg:0,ltcg:0}, mf:{stcg:0,ltcg:0} };
  imInRealized.forEach(r => {
    const cat = r.fileType === 'mf' ? 'mf' : 'eq';
    if (r.category === 'LTCG') stats[cat].ltcg += r.gain;
    else                        stats[cat].stcg += r.gain;
  });
  const eqTax  = Math.max(stats.eq.stcg,0)*stcgRate + Math.max(stats.eq.ltcg-EXEMPT,0)*ltcgRate;
  const mfTax  = Math.max(stats.mf.stcg,0)*stcgRate + Math.max(stats.mf.ltcg-EXEMPT,0)*ltcgRate;
  const foTotal   = imInFoPnl.reduce((s,f) => s+f.pnl, 0);
  const foTaxable2 = Math.max(foTotal, 0);
  const foTax  = slabTax(otherINR + foTaxable2, slabs) - slabTax(otherINR, slabs);
  const foMarginal = foTaxable2 > 0 ? foTax / foTaxable2 : getMarginalRate(otherINR + 1, slabs);
  const intTotal  = imInIntraday.reduce((s,t) => s+t.pnl, 0);
  const intTaxable = Math.max(intTotal, 0);
  const intTax = slabTax(otherINR + intTaxable, slabs) - slabTax(otherINR, slabs);
  const intMarginal = intTaxable > 0 ? intTax / intTaxable : getMarginalRate(otherINR + 1, slabs);
  const totalTax = eqTax + mfTax + foTax + intTax;

  // ── Consolidated table ────────────────────────────────────────────
  const hasEq  = imInRawFiles.eq.trades.length > 0;
  const hasMf  = imInRawFiles.mf.trades.length > 0;
  const hasFo  = imInFoPnl.length > 0;
  const hasInt = imInIntraday.length > 0;
  function gCell(v) { return `<td class="${v>=0?'pos':'neg'}">${v>=0?'+':'−'}${fINR(Math.abs(v),true)}</td>`; }
  function tCell(v) { return `<td class="tax-col">${fINR(v,true)}</td>`; }
  function dash()   { return `<td style="color:#ccc">—</td>`; }
  const foSign  = foTotal >= 0;
  const intSign = intTotal >= 0;

  document.getElementById('imInConsolidated').innerHTML = `
    <table class="z-con-table">
      <thead><tr><th>Category</th><th>STCG Gain</th><th>LTCG Gain</th><th>Spec. P&amp;L</th><th>Est. Tax</th></tr></thead>
      <tbody>
        ${hasEq  ? `<tr><td>📈 Equity (Delivery)</td>${gCell(stats.eq.stcg)}${gCell(stats.eq.ltcg)}${dash()}${tCell(eqTax)}</tr>` : ''}
        ${hasInt ? `<tr><td>⚡ Intraday (Speculative)</td>${dash()}${dash()}<td class="${intSign?'pos':'neg'}">${intSign?'+':'−'}${fINR(Math.abs(intTotal),true)}</td>${tCell(intTax)}</tr>` : ''}
        ${hasMf  ? `<tr><td>🏛 Mutual Funds</td>${gCell(stats.mf.stcg)}${gCell(stats.mf.ltcg)}${dash()}${tCell(mfTax)}</tr>` : ''}
        ${hasFo  ? `<tr><td>📊 F&amp;O</td>${dash()}${dash()}<td class="${foSign?'pos':'neg'}">${foSign?'+':'−'}${fINR(Math.abs(foTotal),true)}</td>${tCell(foTax)}</tr>` : ''}
        <tr class="z-con-total"><td>Total</td>
          ${gCell(stats.eq.stcg+stats.mf.stcg)}${gCell(stats.eq.ltcg+stats.mf.ltcg)}
          <td class="${(intTotal+foTotal)>=0?'pos':'neg'}">${(hasInt||hasFo)?((intTotal+foTotal)>=0?'+':'−')+fINR(Math.abs(intTotal+foTotal),true):'—'}</td>
          ${tCell(totalTax)}
        </tr>
      </tbody>
    </table>`;

  // ── Coverage helper ────────────────────────────────────────────────
  function segCov(type) {
    const files = imInRawFiles[type].files;
    if (!files.length) return '';
    const s = [...files].sort((a,b)=>a.dateMin.localeCompare(b.dateMin));
    return ` · ${fDateShort(s[0].dateMin)} – ${fDateShort(s[s.length-1].dateMax)}`;
  }

  // ── Equity Realized ────────────────────────────────────────────────
  const showEq = imInFilter === 'all' || imInFilter === 'equity';
  document.getElementById('imInRealizedSection').style.display = showEq ? 'block' : 'none';
  if (showEq) {
    const eqReal   = imInRealized.filter(r => r.fileType !== 'mf');
    const bySymbol = groupBy(eqReal, 'symbol');
    document.getElementById('imInRealizedMeta').textContent =
      `${Object.keys(bySymbol).length} stocks · ${fINR(stats.eq.stcg+stats.eq.ltcg,true)} gain${segCov('eq')}`;
    document.getElementById('imInRealizedCards').innerHTML =
      Object.entries(bySymbol).map(([sym,trades]) => buildRealizedCard(sym,trades,ltcgRate,stcgRate,EXEMPT)).join('') || emptyMsg('No realized equity trades');
  }

  // ── Open Equity Positions ──────────────────────────────────────────
  document.getElementById('imInOpenSection').style.display = showEq ? 'block' : 'none';
  if (showEq) {
    const eqOpen = Object.entries(imInOpen).filter(([sym]) => !imInMfOpen[sym]);
    document.getElementById('imInOpenMeta').textContent =
      `${eqOpen.length} stocks · ${fINR(eqOpen.reduce((s,[,l])=>s+l.reduce((a,x)=>a+x.qty*x.price,0),0),true)} cost${segCov('eq')}`;
    document.getElementById('imInOpenCards').innerHTML =
      eqOpen.map(([sym,lots]) => buildOpenCard(sym,lots,false)).join('') || emptyMsg('No open equity positions');
  }

  // ── Intraday ───────────────────────────────────────────────────────
  const showInt = (imInFilter === 'all' || imInFilter === 'equity') && imInIntraday.length;
  document.getElementById('imInIntradaySection').style.display = showInt ? 'block' : 'none';
  if (showInt) {
    document.getElementById('imInIntradayMeta').textContent =
      `${imInIntraday.length} sessions · ${intSign?'+':''}${fINR(intTotal,true)}${segCov('eq')}`;
    document.getElementById('imInIntradayContent').innerHTML = buildIntradaySection(imInIntraday, intMarginal);
  }

  // ── F&O ───────────────────────────────────────────────────────────
  const showFo = (imInFilter === 'all' || imInFilter === 'fo') && imInFoPnl.length;
  document.getElementById('imInFoSection').style.display = showFo ? 'block' : 'none';
  if (showFo) {
    document.getElementById('imInFoMeta').textContent =
      `${imInFoPnl.length} contracts · ${foSign?'+':''}${fINR(foTotal,true)}${segCov('fo')}`;
    document.getElementById('imInFoContent').innerHTML = imInFoPnl.map(f => buildFoCard(f, foMarginal)).join('');
  }

  // ── MF ────────────────────────────────────────────────────────────
  const showMf  = imInFilter === 'all' || imInFilter === 'mf';
  const mfReal  = imInRealized.filter(r => r.fileType === 'mf');
  const mfHold  = Object.entries(imInMfOpen);
  document.getElementById('imInMfSection').style.display = (showMf && (mfReal.length || mfHold.length)) ? 'block' : 'none';
  if (showMf) {
    const mfGroups = groupBy(mfReal, 'symbol');
    document.getElementById('imInMfMeta').textContent =
      `${mfHold.length} holdings · ${Object.keys(mfGroups).length} realized${segCov('mf')}`;
    let html = '';
    if (mfHold.length) {
      html += `<div style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;margin:8px 2px 6px">Holdings</div>`;
      html += mfHold.map(([sym,lots]) => buildOpenCard(sym,lots,true)).join('');
    }
    if (Object.keys(mfGroups).length) {
      html += `<div style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;margin:12px 2px 6px">Realized</div>`;
      html += Object.entries(mfGroups).map(([sym,trades]) => buildRealizedCard(sym,trades,ltcgRate,stcgRate,EXEMPT)).join('');
    }
    document.getElementById('imInMfContent').innerHTML = html || emptyMsg('No mutual fund data');
  }
}