function toggleZSection(bodyId, btnId, metaId) {
  const body = document.getElementById(bodyId);
  const btn  = document.getElementById(btnId);
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  btn.textContent    = open ? '▶' : '▼';
}

function toggleZTrades(tradesId, btnId, count) {
  const el  = document.getElementById(tradesId);
  const btn = document.getElementById(btnId);
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  btn.textContent  = open ? `▶ ${count} lot${count!==1?'s':''}` : `▼ hide lots`;
}

function toggleRealCard(cid, icoId) {
  const body = document.getElementById(cid);
  const ico  = document.getElementById(icoId);
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  ico.textContent    = open ? '▶' : '▼';
}

function buildOpenCard(sym, lots, isMf) {
  const totalQty  = lots.reduce((s,l) => s+l.qty, 0);
  const costBasis = lots.reduce((s,l) => s+l.qty*l.price, 0);
  const avgCost   = costBasis / totalQty;
  const symId     = sym.replace(/[^a-zA-Z0-9]/g,'_');

  const lotRows = lots.map((lot,i) => {
    const holdDays  = Math.floor((new Date(TODAY) - new Date(lot.date+'T00:00:00')) / 86400000);
    const isLTCG    = holdDays >= 365;
    const daysLeft  = 365 - holdDays;
    const ltcgOn    = new Date(lot.date+'T00:00:00');
    ltcgOn.setDate(ltcgOn.getDate() + 365);
    const ltcgOnStr = ltcgOn.toISOString().split('T')[0];
    return `<div class="z-open-lot">
      <div class="z-lot-row">
        <span class="badge ${isLTCG?'ltcg':'stcg'}">${isLTCG?'LTCG':'STCG'}</span>
        <span>${lot.qty.toLocaleString('en-IN')} qty @ ₹${lot.price.toFixed(2)}</span>
        <span class="z-lot-meta">· bought ${fDate(lot.date)} · held ${holdDays}d</span>
      </div>
      ${isLTCG
        ? `<div class="z-ltcg-ready">✅ Qualifies for LTCG (12.5%)</div>`
        : `<div class="z-ltcg-hint">⏳ ${daysLeft} day${daysLeft!==1?'s':''} to LTCG — converts on ${fDate(ltcgOnStr)}</div>`}
    </div>`;
  }).join('');

  return `<div class="z-open-card">
    <div class="z-open-header">
      <div>
        <div class="z-open-symbol">${sym}${isMf?' <span style="font-size:11px;color:#6a1b9a;font-weight:600">MF</span>':''}</div>
        <div class="z-open-meta">${totalQty.toLocaleString('en-IN')} units · ${lots.length} lot${lots.length!==1?'s':''} · avg cost ₹${avgCost.toFixed(2)}</div>
      </div>
      <div style="text-align:right">
        <div class="z-open-value">${fINR(costBasis,true)}</div>
        <div style="font-size:11px;color:#aaa">total cost basis</div>
      </div>
    </div>
    <div class="z-lots-detail">${lotRows}</div>
    <div class="z-sell-sim">
      <label>Sell at (₹)</label>
      <input type="number" step="0.01" class="z-sell-input" placeholder="Enter current price"
        oninput="updateOpenCalc('${symId}','${sym}',this.value)">
      <span style="font-size:12px;color:#aaa">→ shows tax, fees &amp; net proceeds</span>
    </div>
    <div id="openCalc_${symId}"></div>
  </div>`;
}

function updateOpenCalc(symId, sym, priceStr) {
  const el = document.getElementById('openCalc_' + symId);
  if (!el) return;
  const price = parseFloat(priceStr);
  if (!price || price <= 0) { el.innerHTML = ''; return; }

  const lots      = zOpen[sym];
  if (!lots) return;
  const ltcgRate  = (parseFloat(document.getElementById('zLtcgRate').value) || 12.5) / 100;
  const stcgRate  = (parseFloat(document.getElementById('zStcgRate').value) || 20)   / 100;
  const EXEMPT    = 125000;

  let stcgGain = 0, ltcgGain = 0;
  const stcgLots = [];
  lots.forEach(lot => {
    const holdDays = Math.floor((new Date(TODAY) - new Date(lot.date+'T00:00:00')) / 86400000);
    const gain     = (price - lot.price) * lot.qty;
    if (holdDays >= 365) { ltcgGain += gain; }
    else {
      stcgGain += gain;
      const daysLeft = 365 - holdDays;
      const ltcgOn = new Date(lot.date+'T00:00:00');
      ltcgOn.setDate(ltcgOn.getDate() + 365);
      stcgLots.push({ lot, gain, daysLeft, ltcgOnStr: ltcgOn.toISOString().split('T')[0] });
    }
  });

  const totalQty   = lots.reduce((s,l)=>s+l.qty,0);
  const totalCost  = lots.reduce((s,l)=>s+l.qty*l.price,0);
  const saleValue  = price * totalQty;
  const totalGain  = stcgGain + ltcgGain;

  // Tax if sold now
  const stcgTaxNow = Math.max(stcgGain, 0) * stcgRate;
  const ltcgTaxNow = Math.max(ltcgGain - EXEMPT, 0) * ltcgRate;
  const totalTaxNow = stcgTaxNow + ltcgTaxNow;

  // Tax if all STCG waits to become LTCG
  const taxIfWait   = Math.max(totalGain - EXEMPT, 0) * ltcgRate;
  const taxSaving   = totalTaxNow - taxIfWait;
  const hasSTCG     = stcgLots.length > 0 && stcgGain > 0;

  // Zerodha delivery sell fees
  const stt        = saleValue * 0.001;          // 0.1% STT on sell
  const exchCharge = saleValue * 0.0000297;       // NSE 0.00297%
  const gst        = exchCharge * 0.18;           // 18% on exchange charges
  const sebi       = saleValue * 0.000001;        // ₹10/crore
  const dp         = 15.93;                       // CDSL DP per scrip
  const totalFees  = stt + exchCharge + gst + sebi + dp;

  const netProceeds = saleValue - totalTaxNow - totalFees;
  const gainSign    = totalGain >= 0;

  el.innerHTML = `<div class="z-open-calc">
    <div class="z-calc-row"><span>Sale Value (${totalQty} × ₹${price.toFixed(2)})</span><span>${fINR(saleValue,true)}</span></div>
    <div class="z-calc-row"><span>Cost Basis</span><span>${fINR(totalCost,true)}</span></div>
    <div class="z-calc-row ${gainSign?'pos':'neg'}"><span>Net Gain / Loss</span><span>${gainSign?'+':''}${fINR(Math.abs(totalGain),true)}</span></div>
    <hr class="z-calc-divider">
    ${stcgGain!==0?`<div class="z-calc-row"><span style="color:#e65100">STCG ${(stcgRate*100).toFixed(0)}% on ${fINR(Math.max(stcgGain,0),true)}</span><span style="color:#e65100">${fINR(stcgTaxNow,true)}</span></div>`:''}
    ${ltcgGain!==0?`<div class="z-calc-row"><span style="color:#1565c0">LTCG ${(ltcgRate*100).toFixed(1)}% on ${fINR(Math.max(ltcgGain-EXEMPT,0),true)} (₹1.25L exempt)</span><span style="color:#1565c0">${fINR(ltcgTaxNow,true)}</span></div>`:''}
    <div class="z-calc-row" style="font-weight:700"><span>Tax if sold today</span><span style="color:#c62828">${fINR(totalTaxNow,true)}</span></div>
    ${hasSTCG && taxSaving > 0 ? (() => {
      const lotLines = stcgLots
        .slice().sort((a,b) => a.daysLeft - b.daysLeft)
        .map(({lot, gain, daysLeft, ltcgOnStr}) => {
          const lotStcgTax = Math.max(gain, 0) * stcgRate;
          const lotLtcgTax = Math.max(gain, 0) * ltcgRate;
          const lotSave    = lotStcgTax - lotLtcgTax;
          return `<div class="z-calc-lot-hint">• ${lot.qty.toLocaleString('en-IN')} qty (bought ${fDate(lot.date)}): <strong>${daysLeft} day${daysLeft!==1?'s':''}</strong> → LTCG on ${fDate(ltcgOnStr)}${lotSave > 0 ? ` · saves ~${fINR(lotSave,true)}` : ''}</div>`;
        }).join('');
      return `<div class="z-calc-saving">⏳ <strong>STCG → LTCG schedule</strong> — total saving: <strong>${fINR(taxSaving,true)}</strong> (pay ${fINR(taxIfWait,true)} instead of ${fINR(totalTaxNow,true)}):${lotLines}</div>`;
    })() : ''}
    <hr class="z-calc-divider">
    <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Zerodha Platform Fees</div>
    <div class="z-calc-row z-fee-row"><span>STT — 0.1% on sell</span><span>${fINR(stt)}</span></div>
    <div class="z-calc-row z-fee-row"><span>Exchange charges — NSE 0.00297%</span><span>${fINR(exchCharge)}</span></div>
    <div class="z-calc-row z-fee-row"><span>GST — 18% on exchange charges</span><span>${fINR(gst)}</span></div>
    <div class="z-calc-row z-fee-row"><span>SEBI charges — ₹10/crore</span><span>${fINR(sebi)}</span></div>
    <div class="z-calc-row z-fee-row"><span>DP charges — CDSL debit</span><span>₹15.93</span></div>
    <div class="z-calc-row" style="font-weight:700"><span>Total Platform Fees</span><span>${fINR(totalFees)}</span></div>
    <hr class="z-calc-divider">
    <div class="z-calc-net"><span>Net in Hand</span><span style="color:${netProceeds>=0?'#2e7d32':'#c62828'}">${fINR(netProceeds,true)}</span></div>
  </div>`;
}

function buildRealizedCard(sym, trades, ltcgRate, stcgRate, EXEMPT) {
  const totalGain = trades.reduce((s,t)=>s+t.gain,0);
  const totalQty  = trades.reduce((s,t)=>s+t.qty,0);
  const avgBuy    = trades.reduce((s,t)=>s+t.buyPrice*t.qty,0) / totalQty;
  const avgSell   = trades.reduce((s,t)=>s+t.sellPrice*t.qty,0) / totalQty;
  const ltcgGain  = trades.filter(t=>t.category==='LTCG').reduce((s,t)=>s+t.gain,0);
  const stcgGain  = trades.filter(t=>t.category==='STCG').reduce((s,t)=>s+t.gain,0);
  const estTax    = Math.max(stcgGain,0)*stcgRate + Math.max(ltcgGain-EXEMPT,0)*ltcgRate;
  const gPos      = totalGain >= 0;
  const domCat    = Math.abs(ltcgGain)>=Math.abs(stcgGain) ? 'LTCG' : 'STCG';
  const tid       = 'rt_'+sym.replace(/[^a-zA-Z0-9]/g,'_');
  const cid       = 'rc_'+sym.replace(/[^a-zA-Z0-9]/g,'_');

  const tradeRows = trades.map(t => `<tr>
    <td>${fDate(t.buyDate)}</td>
    <td>${fDate(t.sellDate)}</td>
    <td style="text-align:right">${t.qty.toLocaleString('en-IN')}</td>
    <td style="text-align:right">${fINR(t.buyPrice)}</td>
    <td style="text-align:right">${fINR(t.sellPrice)}</td>
    <td style="text-align:right;font-weight:700" class="${t.gain>=0?'pos':'neg'}">${t.gain>=0?'+':'−'}${fINR(Math.abs(t.gain),true)}</td>
    <td style="text-align:center"><span class="badge ${t.category.toLowerCase()}">${t.category}</span></td>
    <td style="text-align:right;color:#aaa">${t.holdDays}d</td>
  </tr>`).join('');

  return `<div class="z-trade-card">
    <div class="z-trade-top" onclick="toggleRealCard('${cid}','${cid}_ico')" style="cursor:pointer">
      <div>
        <div class="z-trade-symbol">${sym}</div>
        <div class="z-trade-meta">${totalQty.toLocaleString('en-IN')} qty · avg buy ${fINR(avgBuy)} · avg sell ${fINR(avgSell)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <span class="badge ${domCat.toLowerCase()}">${domCat}</span>
          <span style="font-size:11px;color:#e65100">Tax: ${fINR(estTax,true)}</span>
        </div>
        <span id="${cid}_ico" style="font-size:13px;color:#aaa;line-height:1">▼</span>
      </div>
    </div>
    <div id="${cid}">
      <div class="z-trade-footer">
        <div style="display:flex;gap:16px">
          ${stcgGain!==0?`<div><div style="font-size:10px;color:#aaa">STCG</div><div style="font-size:13px;font-weight:700;color:${stcgGain>=0?'#e65100':'#2e7d32'}">${stcgGain>=0?'+':''}${fINR(stcgGain,true)}</div></div>`:''}
          ${ltcgGain!==0?`<div><div style="font-size:10px;color:#aaa">LTCG</div><div style="font-size:13px;font-weight:700;color:${ltcgGain>=0?'#1565c0':'#2e7d32'}">${ltcgGain>=0?'+':''}${fINR(ltcgGain,true)}</div></div>`:''}
        </div>
        <div class="gain-line ${gPos?'pos':'neg'}" style="font-size:16px">${gPos?'+':'−'}${fINR(Math.abs(totalGain),true)}</div>
      </div>
      <div class="z-trades-toggle" id="btn_${tid}" onclick="event.stopPropagation();toggleZTrades('${tid}','btn_${tid}',${trades.length})">
        ▶ ${trades.length} lot${trades.length!==1?'s':''}
      </div>
      <div id="${tid}" class="z-trades-body">
        <table class="z-trades-table">
          <thead><tr>
            <th style="text-align:left">Buy Date</th><th style="text-align:left">Sell Date</th>
            <th>Qty</th><th>Buy ₹</th><th>Sell ₹</th><th>Gain</th><th>Cat.</th><th>Held</th>
          </tr></thead>
          <tbody>${tradeRows}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function buildIntradaySection(intradayPnl, effectiveRate) {
  // Group by symbol
  const bySymbol = groupBy(intradayPnl, 'symbol');
  const rateNote = effectiveRate > 0
    ? `Based on income entered in Settings, estimated effective rate: <strong>~${(effectiveRate*100).toFixed(1)}%</strong>.`
    : `Enter your <strong>Other Income</strong> in Settings above for an accurate tax estimate.`;
  const caveat   = `<div class="z-gap-warning" style="margin-bottom:10px;background:#fff8e1;border-color:#ffe082;color:#795548">
    ⚠ <strong>Auto-detected:</strong> Same-day buy+sell pairs are classified as <strong>Intraday — Speculative Business Income u/s 43(5)</strong>.
    This is taxed at your income slab rate (5%–30%) added on top of your other income — <em>not</em> at a flat rate.
    ${rateNote}
    Same-day delivery trades may be mis-classified — verify against your broker's Tax P&amp;L report.
  </div>`;

  const cards = Object.entries(bySymbol).map(([sym, trades]) => {
    const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
    const totalQty  = trades.reduce((s, t) => s + t.qty, 0);
    const estTax    = Math.max(totalPnl, 0) * effectiveRate;
    const pPos      = totalPnl >= 0;
    const tid       = 'intra_' + sym.replace(/[^a-zA-Z0-9]/g,'_');

    const rows = trades.map(t => `<tr>
      <td>${fDate(t.date)}</td>
      <td style="text-align:right">${t.qty.toLocaleString('en-IN')}</td>
      <td style="text-align:right">₹${t.buyPrice.toFixed(2)}</td>
      <td style="text-align:right">₹${t.sellPrice.toFixed(2)}</td>
      <td style="text-align:right;font-weight:700" class="${t.pnl>=0?'pos':'neg'}">${t.pnl>=0?'+':'−'}${fINR(Math.abs(t.pnl),true)}</td>
    </tr>`).join('');

    return `<div class="z-trade-card" style="margin-bottom:10px">
      <div class="z-trade-top">
        <div>
          <div class="z-trade-symbol">${sym}</div>
          <div class="z-trade-meta">${trades.length} session${trades.length!==1?'s':''} · ${totalQty.toLocaleString('en-IN')} total qty</div>
        </div>
        <div style="text-align:right">
          <div class="gain-line ${pPos?'pos':'neg'}" style="font-size:15px;font-weight:800">${pPos?'+':'−'}${fINR(Math.abs(totalPnl),true)}</div>
          <div style="font-size:11px;color:#e65100">${effectiveRate > 0 ? `Tax ~${fINR(estTax,true)} @ ${(effectiveRate*100).toFixed(1)}% slab` : `Tax @ slab rate (enter income in Settings)`}</div>
        </div>
      </div>
      <div class="z-trades-toggle" id="btn_${tid}" onclick="toggleZTrades('${tid}','btn_${tid}',${trades.length})">
        ▶ ${trades.length} session${trades.length!==1?'s':''}
      </div>
      <div id="${tid}" class="z-trades-body">
        <table class="z-trades-table">
          <thead><tr>
            <th style="text-align:left">Date</th><th>Qty</th><th>Avg Buy ₹</th><th>Avg Sell ₹</th><th>P&amp;L</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  return caveat + cards;
}

function buildFoCard(f, foRate) {
  const pnlPos = f.pnl >= 0;
  const tax    = Math.max(f.pnl,0) * foRate;
  const tid    = 'fo_'+f.symbol.replace(/[^a-zA-Z0-9]/g,'_');

  const tradeRows = (f.trades||[]).map(t => {
    const amt = t.qty * t.price;
    return `<tr>
      <td>${fDate(t.date)}</td>
      <td><span class="badge ${t.type==='buy'?'stcg':'ltcg'}" style="font-size:10px">${t.type.toUpperCase()}</span></td>
      <td style="text-align:right">${t.qty.toLocaleString('en-IN')}</td>
      <td style="text-align:right">₹${t.price.toFixed(2)}</td>
      <td style="text-align:right">${fINR(amt,true)}</td>
    </tr>`;
  }).join('');

  return `<div class="z-trade-card" style="margin-bottom:10px">
    <div class="z-trade-top">
      <div>
        <div class="z-trade-symbol" style="font-size:13px">${f.symbol}</div>
        <div class="z-trade-meta">Buy: ${fINR(f.buyAmt,true)} · Sell: ${fINR(f.sellAmt,true)}</div>
      </div>
      <div style="text-align:right">
        <div class="gain-line ${pnlPos?'pos':'neg'}" style="font-size:15px;font-weight:800">${pnlPos?'+':'−'}${fINR(Math.abs(f.pnl),true)}</div>
        <div style="font-size:11px;color:#e65100">Tax ~${fINR(tax,true)}</div>
      </div>
    </div>
    <div class="z-trades-toggle" id="btn_${tid}" onclick="toggleZTrades('${tid}','btn_${tid}',${(f.trades||[]).length})">
      ▶ ${(f.trades||[]).length} transaction${(f.trades||[]).length!==1?'s':''}
    </div>
    <div id="${tid}" class="z-trades-body">
      <table class="z-trades-table">
        <thead><tr>
          <th style="text-align:left">Date</th><th style="text-align:left">Type</th>
          <th>Qty</th><th>Price</th><th>Amount</th>
        </tr></thead>
        <tbody>${tradeRows}</tbody>
      </table>
    </div>
  </div>`;
}