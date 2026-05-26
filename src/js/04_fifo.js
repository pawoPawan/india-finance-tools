function detectSegmentGaps(files) {
  if (files.length < 2) return { gaps: [], overlaps: 0 };
  const sorted = [...files].sort((a, b) => a.dateMin.localeCompare(b.dateMin));
  const gaps = [];
  let overlaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev     = sorted[i - 1];
    const curr     = sorted[i];
    const prevMax  = new Date(prev.dateMax + 'T00:00:00');
    const currMin  = new Date(curr.dateMin + 'T00:00:00');
    const daysDiff = Math.round((currMin - prevMax) / 86400000);
    if (daysDiff > 1) {
      gaps.push({ from: prev.dateMax, to: curr.dateMin, days: daysDiff - 1 });
    } else if (daysDiff < 0) {
      overlaps++;
    }
  }
  return { gaps, overlaps };
}

function extractIntraday(eqTrades) {
  // Group EQ trades by symbol + date
  const groups = {};
  for (const t of eqTrades) {
    const key = t.symbol + '|' + t.date;
    if (!groups[key]) groups[key] = { symbol: t.symbol, date: t.date, isin: t.isin, fileType: t.fileType, buys: [], sells: [] };
    if (t.type === 'buy') groups[key].buys.push({ ...t });
    else                  groups[key].sells.push({ ...t });
  }

  const intradayPnl   = [];
  const deliveryTrades = [];

  for (const g of Object.values(groups)) {
    const totalBuy  = g.buys.reduce((s, t) => s + t.qty, 0);
    const totalSell = g.sells.reduce((s, t) => s + t.qty, 0);
    const intradayQty = Math.min(totalBuy, totalSell);

    if (intradayQty > 0) {
      const avgBuy  = g.buys.reduce((s, t)  => s + t.qty * t.price, 0) / totalBuy;
      const avgSell = g.sells.reduce((s, t) => s + t.qty * t.price, 0) / totalSell;
      intradayPnl.push({
        symbol:    g.symbol,
        date:      g.date,
        qty:       intradayQty,
        buyPrice:  avgBuy,
        sellPrice: avgSell,
        buyAmt:    avgBuy  * intradayQty,
        sellAmt:   avgSell * intradayQty,
        pnl:       (avgSell - avgBuy) * intradayQty,
      });
    }

    // Remaining delivery: consume intraday qty from front of each side
    let remB = intradayQty;
    for (const t of g.buys) {
      const intra = Math.min(t.qty, remB); remB -= intra;
      const dQty  = t.qty - intra;
      if (dQty > 0) deliveryTrades.push({ ...t, qty: dQty });
    }
    let remS = intradayQty;
    for (const t of g.sells) {
      const intra = Math.min(t.qty, remS); remS -= intra;
      const dQty  = t.qty - intra;
      if (dQty > 0) deliveryTrades.push({ ...t, qty: dQty });
    }
  }

  return { intradayPnl, deliveryTrades };
}

function runFIFO(trades) {
  // Sort ascending by date
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));

  const buyLots   = {}; // symbol → [{date, qty, price}]
  const realized  = [];
  const open      = {}; // symbol → [{date, qty, price}]

  for (const t of sorted) {
    const sym = t.symbol;
    if (t.type === 'buy') {
      if (!buyLots[sym]) buyLots[sym] = [];
      buyLots[sym].push({ date: t.date, qty: t.qty, price: t.price });
    } else if (t.type === 'sell') {
      let remainSell = t.qty;
      if (!buyLots[sym]) buyLots[sym] = [];

      while (remainSell > 0 && buyLots[sym].length > 0) {
        const lot = buyLots[sym][0];
        const matchQty = Math.min(remainSell, lot.qty);
        const holdDays = Math.round((new Date(t.date) - new Date(lot.date)) / 86400000);
        const gain     = (t.price - lot.price) * matchQty;
        const category = holdDays > 365 ? 'LTCG' : 'STCG';

        realized.push({
          symbol:    sym,
          isin:      t.isin,
          fileType:  t.fileType,
          buyDate:   lot.date,
          sellDate:  t.date,
          qty:       matchQty,
          buyPrice:  lot.price,
          sellPrice: t.price,
          gain,
          holdDays,
          category,
        });

        lot.qty      -= matchQty;
        remainSell   -= matchQty;
        if (lot.qty <= 0) buyLots[sym].shift();
      }

      // If more sells than buys (short selling or missing data), skip extra
    }
  }

  // Remaining open lots
  for (const [sym, lots] of Object.entries(buyLots)) {
    const remaining = lots.filter(l => l.qty > 0);
    if (remaining.length) open[sym] = remaining;
  }

  return { realized, open };
}

// ═══════════════════════════════════════════════════════════════════
// F&O P&L (per contract)
// ═══════════════════════════════════════════════════════════════════
function computeFoPnl(foTrades) {
  const contracts = {};
  for (const t of foTrades) {
    if (!contracts[t.symbol]) contracts[t.symbol] = { buyAmt:0, sellAmt:0, buyQty:0, sellQty:0, trades:[] };
    const amt = t.qty * t.price;
    if (t.type === 'buy') { contracts[t.symbol].buyAmt += amt; contracts[t.symbol].buyQty += t.qty; }
    else                  { contracts[t.symbol].sellAmt += amt; contracts[t.symbol].sellQty += t.qty; }
    contracts[t.symbol].trades.push(t);
  }
  return Object.entries(contracts).map(([sym, v]) => ({
    symbol: sym, buyAmt: v.buyAmt, sellAmt: v.sellAmt,
    buyQty: v.buyQty, sellQty: v.sellQty,
    pnl: v.sellAmt - v.buyAmt, trades: v.trades,
  }));
}
