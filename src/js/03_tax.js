function slabTax(incomeINR, slabs) {
  let tax = 0, prev = 0;
  for (const slab of slabs) {
    if (incomeINR <= prev) break;
    const taxable = Math.min(incomeINR, slab.max) - prev;
    tax += taxable * slab.rate;
    prev = slab.max;
  }
  return tax;
}

function computeSTCGRate() {
  const otherL = parseFloat(document.getElementById('otherIncome').value) || 0;
  const otherINR = otherL * 100000;
  const ltcgRatePct = parseFloat(document.getElementById('ltcgRate').value) || 12.5;

  // Compute total STCG gains in INR for all STCG lots
  const currentPrice = parseFloat(document.getElementById('currentPrice').value) || 0;
  const todayINR = parseFloat(document.getElementById('todayINR').value) || 84.5;

  let totalSTCGinINR = 0;
  allLots.filter(l => l.taxCategory === 'STCG').forEach(lot => {
    const gainUSD = (currentPrice - lot.acquisitionPrice) * lot.sharesHeld;
    if (gainUSD > 0) {
      const purchaseRate = ratesMap[lot.dateAcquired]?.rate || todayINR;
      const gainINR = currentPrice * lot.sharesHeld * todayINR - lot.acquisitionPrice * lot.sharesHeld * purchaseRate;
      totalSTCGinINR += Math.max(gainINR, 0);
    }
  });

  const slabs = taxRegime === 'new' ? NEW_SLABS : OLD_SLABS;
  const taxOnOther = slabTax(otherINR, slabs);
  const taxOnTotal = slabTax(otherINR + totalSTCGinINR, slabs);
  const stcgTax = taxOnTotal - taxOnOther;
  const effectiveRate = totalSTCGinINR > 0 ? stcgTax / totalSTCGinINR : (taxRegime === 'new' ? 0.30 : 0.30);

  // Marginal slab rate at income level
  const slabRate = getMarginalRate(otherINR + Math.max(totalSTCGinINR / 2, 1), slabs);

  document.getElementById('stcgRateDisplay').textContent =
    `STCG: ${(slabRate * 100).toFixed(0)}% (eff. ${(effectiveRate * 100).toFixed(1)}%)`;

  return slabRate;
}

function getMarginalRate(incomeINR, slabs) {
  let prev = 0;
  for (const slab of slabs) {
    if (incomeINR <= slab.max) return slab.rate;
    prev = slab.max;
  }
  return 0.30;
}

function setRegime(r) {
  taxRegime = r;
  document.getElementById('regimeNew').classList.toggle('active', r === 'new');
  document.getElementById('regimeOld').classList.toggle('active', r === 'old');
  rerender();
}
