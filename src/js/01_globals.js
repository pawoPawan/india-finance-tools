// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
let allLots = [];
let ratesMap = {};      // isoDate → {rate, source}
let currency = 'USD';
let activeFilter = 'all';
let taxRegime = 'new';
const TODAY = new Date().toISOString().split('T')[0];

// ═══════════════════════════════════════════════════════════════════
// INDIA TAX SLAB CALCULATION
// ═══════════════════════════════════════════════════════════════════
// FY 2025-26 New Regime (Budget 2025)
const NEW_SLABS = [
  {max:400000,  rate:0},
  {max:800000,  rate:0.05},
  {max:1200000, rate:0.10},
  {max:1600000, rate:0.15},
  {max:2000000, rate:0.20},
  {max:2400000, rate:0.25},
  {max:Infinity,rate:0.30},
];
// Old Regime
const OLD_SLABS = [
  {max:250000,  rate:0},
  {max:500000,  rate:0.05},
  {max:1000000, rate:0.20},
  {max:Infinity,rate:0.30},
];