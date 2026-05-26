# Equity Analyzer — Complete Reference Document

> **Purpose:** Full technical and feature reference for future enhancements.
> **Last updated:** 2026-05-27
> **Live URL:** https://pawopawan.github.io/equity_analyzer/
> **Repo:** https://github.com/pawoPawan/equity_analyzer

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Build System](#3-build-system)
4. [Source File Map](#4-source-file-map)
5. [User Flow — Wizard UI](#5-user-flow--wizard-ui)
6. [Platform: Charles Schwab — Equity Awards](#6-platform-charles-schwab--equity-awards)
7. [Platform: Charles Schwab — Retail Brokerage](#7-platform-charles-schwab--retail-brokerage)
8. [Platform: IndMoney — US Stocks](#8-platform-indmoney--us-stocks)
9. [Platform: IndMoney — India Stocks](#9-platform-indmoney--india-stocks)
10. [Platform: Zerodha](#10-platform-zerodha)
11. [Platform: Groww](#11-platform-groww)
12. [Core Engine — FIFO, Intraday, F&O](#12-core-engine--fifo-intraday-fo)
13. [Tax Logic](#13-tax-logic)
14. [Open Position Sell Simulator](#14-open-position-sell-simulator)
15. [Shared Card Builders](#15-shared-card-builders)
16. [Utility Functions](#16-utility-functions)
17. [Global State Variables](#17-global-state-variables)
18. [Key HTML Element IDs](#18-key-html-element-ids)
19. [Tax Settings Per Platform](#19-tax-settings-per-platform)
20. [Known Limitations & Caveats](#20-known-limitations--caveats)
21. [Bug History](#21-bug-history)
22. [Enhancement Ideas / Future Work](#22-enhancement-ideas--future-work)

---

## 1. Project Overview

Single-file, zero-backend HTML application that estimates Indian capital gains tax from brokerage export files. All parsing and computation runs entirely in the user's browser — no data is sent to any server.

**Supported markets:** United States (US), India

**Supported platforms:**

| Platform | Markets | What it handles |
|---|---|---|
| Charles Schwab | US | RSU & ESPP equity awards (any company); retail brokerage Buy/Sell transactions |
| IndMoney | US + India | US CG statements + FA Schedule; India EQ / F&O / MF tradebooks |
| Zerodha | India | EQ / F&O / MF tradebooks (XLSX) |
| Groww | India | EQ / F&O / MF tradebooks (XLSX/CSV, flexible headers) |

**Tax framework:** India ITR — LTCG, STCG, intraday speculative income, F&O business income. FY 2025-26, Budget 2025 tax slabs.

---

## 2. Architecture

```
src/
  css/main.css              — all styles (one file)
  html/
    header.html             — top nav bar
    landing.html            — 4-step wizard UI (markets → platforms → uploads → analyze)
    inputs.html             — hidden <input type="file"> elements
    results.html            — combined results panel (all platform result sections)
  js/
    01_globals.js           — global state, India tax slabs
    02_utils.js             — formatters, date helpers, CSV parser, FIFO utils
    03_tax.js               — STCG slab rate calculator, regime switcher
    04_fifo.js              — FIFO matching, intraday extraction, F&O P&L
    05_card_builders.js     — shared HTML card builders (open positions, realized, F&O, intraday)
    06_schwab.js            — Schwab upload handlers, RBI XLS parser, awards parser, retail parser
    07_indmoney.js          — IndMoney file handlers, CG/FA parsers, renderer
    08_zerodha.js           — Zerodha file handler, tradebook parser, renderer
    09_groww.js             — Groww file handler, tradebook parser (flexible), renderer
    10_landing.js           — wizard navigation, market/platform selection, runAnalysisAll
  template.html             — shell with {{CSS}}, {{JS}}, {{LANDING}}, {{RESULTS}} placeholders

build.js                    — Node.js build script → equity-analyzer.html + index.html
equity-analyzer.html        — built output (identical to index.html)
index.html                  — GitHub Pages entry point (identical to equity-analyzer.html)
```

**External dependency (CDN, loaded at runtime):**
- `SheetJS (XLSX)` — for parsing `.xlsx` / `.xls` files (IndMoney, Zerodha, Groww, RBI XLS).
  Loaded in `template.html` via `<script>` tag.

---

## 3. Build System

```bash
node build.js
```

Reads all `src/` files, injects them into `src/template.html` using `safeReplace()` (avoids `$`-substitution issues with regex replace), writes `equity-analyzer.html` and `index.html`.

**No minification, no transpilation, no bundler.** Raw source is injected as-is.

To verify the build:
```bash
node -e "new Function(require('fs').readFileSync('equity-analyzer.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1]); console.log('JS OK')"
```

**Deploy to GitHub Pages:** push `index.html` to `main` branch — GitHub Pages serves it automatically.

---

## 4. Source File Map

| File | Lines | Responsibility |
|---|---|---|
| `01_globals.js` | ~30 | `allLots`, `ratesMap`, `currency`, `activeFilter`, `taxRegime`, `TODAY`, India tax slab constants (`NEW_SLABS`, `OLD_SLABS`) |
| `02_utils.js` | ~72 | `fUSD`, `fINR`, `fDate`, `fHolding`, `isMMDDYYYY`, `mmddToISO`, `numOf`, `intOf`, `monthsDiff`, `ltcgDate`, `daysUntil`, `parseCsvLine`, `groupBy`, `emptyMsg` |
| `03_tax.js` | ~61 | `slabTax`, `computeSTCGRate`, `getMarginalRate`, `setRegime` (Schwab awards regime only) |
| `04_fifo.js` | ~146 | `detectSegmentGaps`, `extractIntraday`, `runFIFO`, `computeFoPnl` |
| `05_card_builders.js` | ~325 | `buildOpenCard` (with `_openCalcMeta` registry), `updateOpenCalc`, `buildRealizedCard`, `buildIntradaySection`, `buildFoCard`, `toggleZSection`, `toggleZTrades`, `toggleRealCard` |
| `06_schwab.js` | ~860 | All Schwab logic: upload handlers, RBI XLS parser, `nearestRBIRate`, equity awards init & renderer, retail init & renderer, rate table, `rerender` |
| `07_indmoney.js` | ~1100 | IndMoney state, file handlers, `parseIndMoneyCG`, `parseIndMoneyFA`, India tradebook parsers, renderers for US and India markets |
| `08_zerodha.js` | ~480 | Zerodha state, file handler, `parseZerodhaTradebook`, `runZerodhaAnalysis`, `rerenderZerodha` |
| `09_groww.js` | ~480 | Groww state, file handler, `parseGrowwTradebook` (flexible header detection), `runGrowwAnalysis`, `rerenderGroww` |
| `10_landing.js` | ~285 | Wizard navigation (`advanceWizard`, `switchToStep`), market/platform toggles, `updateUploads`, `runAnalysisAll`, `backToSetup`, platform result toggles, platform reset functions |

---

## 5. User Flow — Wizard UI

The landing panel is a 4-step wizard. Each step validates before advancing forward; going backward is always free.

```
Step 1: Markets
  → Select "United States" and/or "India"
  → At least one must be selected (can't deselect the last one)

Step 2: Platforms
  → Schwab card visible only if US market selected
  → Zerodha/Groww cards visible only if India market selected
  → IndMoney always visible (covers both markets)
  → Validation: if US selected, at least one US platform (Schwab or IndMoney) must be chosen
  → Validation: if India selected, at least one India platform (Zerodha, Groww, IndMoney) must be chosen

Step 3: Uploads
  → Shows collapsible upload accordion per selected platform
  → Each platform has its own upload sub-section (see platform sections below)
  → Switching back to step 1/2 and changing markets/platforms re-evaluates visibility

Step 4: Analyze
  → Analyze button enabled only when at least one platform has data uploaded
  → Calls runAnalysisAll() which runs each selected platform's analysis and shows results panel
```

**Navigation state after going back and changing selections:** `switchToStep(n)` always recomputes derived state before advancing — platform card visibility is refreshed, `updateUploads()` is called, `updateAnalyzeAllBtn()` is called. Changes on earlier steps are always reflected.

**Error display:** `#wizardError` div shown inline below the wizard nav. `hideWizardError()` is called every time `advanceWizard` runs, so it clears automatically on step change.

---

## 6. Platform: Charles Schwab — Equity Awards

### What it does
Handles RSU (Restricted Stock Units) and ESPP (Employee Stock Purchase Plan) lots from the Schwab Equity Award Center. Works for **any company**, not just Nvidia.

### Files required
1. **Equity Awards CSV** — `EquityAwardsCenter_EquityDetails_*.csv` — exported from Schwab Equity Award Center → View Equity Details → Download CSV
2. **RBI Reference Rate XLS** — `USD/INR` rate archive from `rbi.org.in/scripts/referenceratearchive.aspx` (HTML-as-XLS format)

### Auto-detection
On CSV upload, `handleCsvUpload` reads the first line. If it contains `"transactions"` + `"for account"` (case-insensitive), it's treated as **retail**. Otherwise it's **equity awards**. Files can be uploaded in either order — pending state held in `pendingLots` / `pendingXlsRates`.

### CSV parser: `parseSchawbCSV(text)`
Scans for two section markers:
- `EMPLOYEE STOCK PURCHASE PLAN SHARES` → ESPP lots
- `EQUITY AWARD SHARES` → RSU lots

Lot fields extracted:
- `type`: `'RSU'` or `'ESPP'`
- `symbol`: ticker (any symbol, not hardcoded)
- `dateAcquired`: ISO date (LTCG threshold = 24 months from this date)
- `acquisitionPrice`: FMV at vest (RSU) or Purchase FMV (ESPP)
- `purchasePrice`: original purchase price (ESPP only, lower than FMV due to discount — not used as cost basis)
- `sharesHeld`: shares still available
- `taxCategory`: `'LTCG'` if held > 24 months, else `'STCG'`

**Cost basis note:** For RSU: FMV at vest = cost basis (perquisite was taxed as salary income). For ESPP: Purchase FMV (not discounted price) = cost basis.

### RBI XLS parser: `parseRBIXls(text)`
Parses the HTML-table-as-XLS format. Rows: `DD/MM/YYYY | rate`. Filters out non-numeric and out-of-range values (rate must be between 30 and 200).

### Rate lookup: `nearestRBIRate(isoDate, xlsRates)`
For weekends/holidays: looks back up to 4 calendar days. Returns `{ rate, exact }`.

### Result UI: `rerender()`
Settings panel inputs:
- `#currentPrice` — current stock price in USD (typed by user)
- `#todayINR` — today's USD/INR rate (auto-filled from RBI XLS, editable)
- `#ltcgRate` — LTCG rate % (default 12.5)
- `#otherIncome` — other annual income in ₹ lakhs (drives STCG slab)
- `#regimeNew` / `#regimeOld` — tax regime toggle

Summary grid: 4 cards — Total Shares, Portfolio Value, Total Gain, Est. Tax. Switchable between USD and INR views.

Category summary: `renderCatSummary()` — one card per type (RSU, ESPP) with invested cost, current value, gain, tax estimate.

Lot cards: one per lot, sortable by LTCG/STCG/RSU/ESPP filter chips. Each lot shows:
- Vest date, holding category badge, type badge
- Shares, vest price, current price, value
- Total gain (USD or INR)
- Forex breakdown row (purchase rate → today rate → forex gain + stock gain separately)
- LTCG countdown banner: shows days until LTCG, STCG tax now vs LTCG tax later, saving amount

Rate table: `renderRateTable()` — shows each unique vest date's rate. RBI-sourced rates are locked (display only). Missing/estimated rates show an editable input with orange border. Inline `overrideRate(date, val)` writes to `ratesMap`.

---

## 7. Platform: Charles Schwab — Retail Brokerage

### What it does
Handles personal Schwab brokerage account Buy/Sell transactions. Converts USD prices to INR using per-trade-date RBI rates, then runs the same FIFO + intraday pipeline used by Zerodha/Groww.

### Files required
1. **Transactions CSV** — exported from Schwab: Accounts → History → select date range → Export
2. **RBI Reference Rate XLS** — same as equity awards

### CSV format
```
"Transactions  for account XXXXXXXX",
(blank line),
"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
...(data rows)...
"Transactions Total,..."
```

### Parser: `parseSchawbRetailCSV(text)`
- Finds header row by looking for a row containing `action`, `symbol`, and starting with `"date"` or `date,`
- **Buy actions:** `buy`, `buy to open`, `buy to close`, `reinvest shares`
- **Sell actions:** `sell`, `sell to open`, `sell to close`
- Dates may have `"as of"` suffix: `"12/16/2020 as of 12/15/2020"` — only the part before `" as of "` is used
- Date format: `MM/DD/YYYY` (slashes) — handled by `mmddToISO` with `/` or `-` separator regex
- Deduplication: exact same `symbol|date|type|qty|price` is skipped
- Skips rows where symbol is `--` or `symbol`

### INR conversion: `initWithBothRetail(trades, xlsRates)`
Each trade's USD price is multiplied by the RBI rate for **that specific trade date** (or nearest available). This means:
- Buy INR cost = `buyPrice_USD × buy_date_rate`
- Sell INR proceeds = `sellPrice_USD × sell_date_rate`
- FIFO gain in INR = proceeds − cost (captures both stock appreciation and forex movement)

### LTCG threshold
**730 days (24 months)** — US equity. FIFO `category` is re-mapped after: `holdDays > 730 ? 'LTCG' : 'STCG'`.

### State variables
- `schwabMode`: `'awards'` or `'retail'` or `null`
- `schwabRDataReady`: boolean
- `schwabRRealized`: realized trades array
- `schwabROpen`: open lots by symbol `{ sym: [{date, qty, price}] }`
- `schwabRIntradayPnl`: same-day buy+sell pairs
- `schwabRTaxRegime`: `'new'` or `'old'`

### Result UI: `rerenderSchwabRetail()`
Settings inputs:
- `#schwabROtherIncome`, `#schwabRStcgRate` (default 30%), `#schwabRLtcgRate` (default 12.5%)
- `#schwabRRegimeNew` / `#schwabRRegimeOld`

Sections:
- Consolidated summary grid (STCG, LTCG, Intraday P&L, Total Tax)
- Realized Gains — per-symbol `buildRealizedCard` cards
- Open Positions — `buildOpenCard` with `{ ltcgDays: 730, ltcgRateId: 'schwabRLtcgRate', stcgRateId: 'schwabRStcgRate' }`
- Intraday — `buildIntradaySection`

---

## 8. Platform: IndMoney — US Stocks

### What it does
Parses IndMoney's pre-computed Capital Gains Statement for US stocks and optionally the FA (Foreign Assets) Schedule.

### Files required
1. **Capital Gains Statement (CG)** — `IND-CG-STMT*.xls` — IndMoney → US Stocks → Reports → Capital Gains. **Required.**
2. **FA Schedule** — `IND-FA-SCHEDULE*.xls` — IndMoney → US Stocks → Reports → FA Schedule. **Optional.**

### CG parser: `parseIndMoneyCG(rows, market='us')`
Reads sections based on row headers:
- `Short Term Capital Gains` → STCG trades
- `Long Term Capital Gains` → LTCG trades
- `Dividend Income` → dividends (separates gross from withholding by checking `desc.includes('tax recovered')`)
- `Interest Income` → interest

Each STCG/LTCG trade: `{ symbol, saleDate, soldUnits, sellValueUSD, buyValueUSD, brokerage, gainUSD, gainINR, buyDate }`.

The `gainINR` from IndMoney is used directly — IndMoney pre-computes the INR gain using xe.com rates.

### FA parser: `parseIndMoneyFA(rows)`
Reads holdings from the FA schedule. Each row: `{ ticker, name, country, nature, acquireDate, initialValue (INR cost), peakValue, closingValue, isSold, dividendINR, proceedsINR }`.

### Result sections (US market)
- Consolidated table: STCG, LTCG, Dividends, Interest, Total Tax
- STCG section — trade cards
- LTCG section — trade cards
- Dividend Income section (separates gross from withholding tax recoveries)
- Open Positions / FA Schedule — holdings from FA file
- Sold This FY — positions where `closingValue === '-'` in FA

**Currency toggle:** `imCurrUSD` / `imCurrINR` — switches display between USD and INR. Uses `imAmt(usd, inr)` / `imAmtSigned(usd, inr)` helpers.

**USD/INR rate input:** `#imUsdRate` (default 84.50) — auto-synced from Schwab's RBI XLS if uploaded. Used for INR view calculations.

---

## 9. Platform: IndMoney — India Stocks

### What it does
Handles IndMoney's India-market tradebooks (same FIFO pipeline as Zerodha/Groww).

### Files required
All optional, multiple files per segment accepted:
- Equity tradebook (XLSX/CSV)
- F&O tradebook (XLSX/CSV)
- Mutual Fund tradebook (XLSX/CSV)

### Sub-tabs
When both US and India markets are selected, IndMoney shows `US market` / `India market` tabs in the upload section. When only one market is selected, the relevant upload cards are shown directly without tabs.

### Processing
Same pipeline as Zerodha: `extractIntraday` → `runFIFO` → `computeFoPnl`. Uses `imLtcgRate` / `imStcgRate` input IDs.

### Result sections (India market)
Identical structure to Zerodha: Realized Gains, Open Positions, Intraday, F&O, Mutual Funds. Filter chips: All / Equity / F&O / Mutual Funds.

---

## 10. Platform: Zerodha

### Files required
All optional, **multiple files per segment accepted** (accumulated, deduplicated):
- Equity Tradebook `.xlsx` — Zerodha → Reports → Tradebook → Equity → Export
- F&O Tradebook `.xlsx`
- Mutual Fund Tradebook `.xlsx`

### Parser: `parseZerodhaTradebook(rows, type)`
Looks for header row with known column names. Handles:
- Date formats: ISO, DD/MM/YYYY, JS Date objects
- Duplicate detection by trade ID

### Multi-file handling
`zRawFiles.eq.trades` accumulates trades across multiple uploaded files. `detectSegmentGaps` warns about date coverage gaps. Overlapping files: duplicates removed.

### State variables
`zRawFiles`, `zRealized`, `zOpen`, `zIntradayPnl`, `zFoPnl`, `zMfOpen`, `zTaxRegime`, `zFilter`

### Tax settings inputs
- `#zOtherIncome`, `#zStcgRate` (default 20%), `#zLtcgRate` (default 12.5%), `#zRegimeNew/Old`

### Result sections
Consolidated grid → filter chips (All / Equity / F&O / Mutual Funds) → Realized / Open Positions / F&O / Intraday / Mutual Funds sections.

---

## 11. Platform: Groww

### Files required
Same as Zerodha: EQ / F&O / MF tradebooks (XLSX or CSV, multiple files OK).

### Parser: `parseGrowwTradebook(rows, fileType)` — flexible header detection
Does **not** use hardcoded column indices. Instead:
- Scans first 15 rows for a header row that contains symbol-like AND date-like column keywords
- Uses `colFlex(keywords)` which tries multiple keyword variants per column
- Handles JS Date objects, YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY date formats
- Handles `BUY` / `SELL` or `B` / `S` type values, with `B2B` / `B2S` mapping

This makes Groww parsing resilient to column reordering across export versions.

### State variables
`gRawFiles`, `gRealized`, `gOpen`, `gIntradayPnl`, `gFoPnl`, `gMfOpen`, `gTaxRegime`, `gFilter`

### Tax settings inputs
- `#gOtherIncome`, `#gStcgRate` (default 20%), `#gLtcgRate` (default 12.5%), `#gRegimeNew/Old`

### Result sections
Identical structure to Zerodha.

---

## 12. Core Engine — FIFO, Intraday, F&O

All four platforms (Schwab retail, IndMoney India, Zerodha, Groww) share the same three-function pipeline in `04_fifo.js`.

### `extractIntraday(eqTrades) → { intradayPnl, deliveryTrades }`
Groups EQ trades by `symbol + date`. For any symbol+date where both buys and sells exist:
- `intradayQty = min(totalBuy, totalSell)` → intraday session
- Remaining qty after netting = delivery trades
- Intraday P&L = `(avgSell − avgBuy) × intradayQty`

Intraday is classified as **speculative business income u/s 43(5)**, taxed at income slab rate.

### `runFIFO(trades) → { realized, open }`
- Sorts all trades by date ascending
- Maintains `buyLots[sym]` queue
- For each sell: dequeues from oldest buy lots, records `{ symbol, buyDate, sellDate, qty, buyPrice, sellPrice, gain, holdDays, category }`
- `category`: `holdDays > 365 ? 'LTCG' : 'STCG'` (for India equity; Schwab retail overrides this to 730 days post-FIFO)
- Remaining unsold buy lots → `open[sym]`

### `computeFoPnl(foTrades) → [{ symbol, buyAmt, sellAmt, pnl, trades }]`
Aggregates all F&O trades per contract symbol. P&L = total sell amount − total buy amount.

### `detectSegmentGaps(files)`
For multi-file uploads: detects date gaps (> 1 day) between file coverage ranges. Warns in the upload UI.

---

## 13. Tax Logic

### India tax rates (FY 2025-26)

| Category | Rate | Notes |
|---|---|---|
| LTCG — India equity | 12.5% | Held > 12 months (365 days). ₹1.25L annual exemption. |
| LTCG — US equity | 12.5% | Held > 24 months (730 days). ₹1.25L annual exemption. |
| STCG — India equity | 20% (from Jul 2024) | Flat rate on equity. |
| STCG — US equity / foreign | Slab rate | Treated as ordinary income, added on top of other income. |
| Intraday speculative | Slab rate | u/s 43(5), speculative business income. |
| F&O | Slab rate | Business income. |
| Dividends (US) | Slab rate | Treated as income from other sources. |

### Slab calculation: `slabTax(incomeINR, slabs)`
Marginal slab tax on income. Used to compute effective STCG rate:
```
effectiveSTCGRate = (slabTax(otherIncome + stcgGain) − slabTax(otherIncome)) / stcgGain
```

### Tax regime slabs (FY 2025-26)

**New Regime:**
0% up to ₹4L → 5% ₹4-8L → 10% ₹8-12L → 15% ₹12-16L → 20% ₹16-20L → 25% ₹20-24L → 30% above ₹24L

**Old Regime:**
0% up to ₹2.5L → 5% ₹2.5-5L → 20% ₹5-10L → 30% above ₹10L

### LTCG exemption: ₹1,25,000 (₹1.25 lakh)
Only the gain above ₹1.25L is taxable at 12.5%.

---

## 14. Open Position Sell Simulator

Built into every open position card via `buildOpenCard` + `updateOpenCalc`.

### `_openCalcMeta` registry
Module-level object in `05_card_builders.js`:
```javascript
const _openCalcMeta = {}; // symId → { lots, ltcgDays, ltcgRateId, stcgRateId }
```
Populated by `buildOpenCard` when a card is rendered. `updateOpenCalc` reads from it.

### `buildOpenCard(sym, lots, isMf, opts)`
`opts` parameter (optional):
```javascript
{
  ltcgDays:   730,              // LTCG threshold in days. Default: 365 (India). Schwab retail: 730.
  ltcgRateId: 'schwabRLtcgRate', // ID of LTCG rate <input>. Default: 'zLtcgRate'
  stcgRateId: 'schwabRStcgRate', // ID of STCG rate <input>. Default: 'zStcgRate'
}
```

Each lot in the card shows:
- LTCG / STCG badge (based on `holdDays >= ltcgDays`)
- Days remaining to LTCG threshold

### `updateOpenCalc(symId, sym, priceStr)`
Called by `oninput` on the sell price input. Reads `_openCalcMeta[symId]` for lots and rate IDs. Computes:
- Sale value, cost basis, net gain
- STCG tax (at `stcgRate`) + LTCG tax (at `ltcgRate`, above ₹1.25L exemption)
- STCG→LTCG schedule: for each STCG lot, shows days until LTCG and tax saving
- Platform fees (STT 0.1%, NSE exchange charges 0.00297%, GST 18% on exchange, SEBI ₹10/crore, CDSL DP ₹15.93)
- Net in hand = sale value − tax − fees

### Platform-specific rate IDs

| Platform | ltcgRateId | stcgRateId | ltcgDays |
|---|---|---|---|
| Zerodha (default) | `zLtcgRate` | `zStcgRate` | 365 |
| Groww | `gLtcgRate` | `gStcgRate` | 365 |
| IndMoney India | `imLtcgRate` | `imStcgRate` | 365 |
| Schwab Retail | `schwabRLtcgRate` | `schwabRStcgRate` | 730 |

---

## 15. Shared Card Builders

All in `05_card_builders.js`. Used by multiple platforms.

### `buildRealizedCard(sym, trades, ltcgRate, stcgRate, EXEMPT)`
Shows per-symbol realized gain summary with expandable trade table. Columns: Buy Date, Sell Date, Qty, Buy ₹, Sell ₹, Gain, Category, Days Held.

### `buildIntradaySection(intradayPnl, effectiveRate)`
Groups by symbol. Warns that intraday = speculative income taxed at slab. Shows rate estimate if `otherIncome` entered.

### `buildFoCard(f, foRate)`
Per-contract F&O card with total buy/sell amount and P&L. Expandable trade list.

### `toggleZSection(bodyId, btnId, metaId)` / `toggleZTrades(...)` / `toggleRealCard(...)`
Collapse/expand helpers for all section accordions.

---

## 16. Utility Functions

In `02_utils.js`:

| Function | Description |
|---|---|
| `fUSD(v, compact)` | Format as `$1,234.56` or `$1.23K` |
| `fINR(v, compact)` | Format as `₹1,23,456` or `₹1.25L` / `₹1.25Cr` |
| `fDate(isoDate)` | `"Jan 5, 2023"` |
| `fDateShort(isoDate)` | `"Jan 2023"` |
| `fHolding(months)` | `"1y 3mo"` or `"8 mo"` |
| `signStr(v)` | `'+'` or `'−'` |
| `ltcgDate(dateAcquired)` | Returns ISO date 24 months after acquisition (for equity awards LTCG threshold) |
| `daysUntil(isoDate)` | Days from TODAY to future date (positive = future) |
| `parseCsvLine(line)` | RFC-4180 CSV line parser with quote handling |
| `isMMDDYYYY(s)` | Tests `MM/DD/YYYY` or `MM-DD-YYYY` format |
| `mmddToISO(s)` | Converts `MM/DD/YYYY` or `MM-DD-YYYY` → `YYYY-MM-DD`. Also accepts already-ISO format. |
| `numOf(s)` | `parseFloat` after stripping `$`, `,` |
| `intOf(s)` | `parseInt` after stripping `,` |
| `monthsDiff(d1, d2)` | Difference in calendar months |
| `groupBy(arr, key)` | Groups array into `{ key: [items] }` |
| `emptyMsg(msg)` | Returns styled empty-state HTML div |

---

## 17. Global State Variables

| Variable | File | Description |
|---|---|---|
| `allLots` | globals | Schwab equity awards lots |
| `ratesMap` | globals | `{ isoDate: { rate, source } }` — RBI rates by date |
| `currency` | globals | `'USD'` or `'INR'` — Schwab awards display currency |
| `activeFilter` | globals | `'all'`, `'RSU'`, `'ESPP'`, `'LTCG'`, `'STCG'` |
| `taxRegime` | globals | `'new'` or `'old'` — Schwab awards regime |
| `TODAY` | globals | Today's ISO date string |
| `NEW_SLABS` / `OLD_SLABS` | globals | FY 2025-26 slab arrays |
| `selectedMarkets` | landing | `Set<'us' \| 'india'>` |
| `activePlatforms` | landing | `Set<'schwab' \| 'indmoney' \| 'zerodha' \| 'groww'>` |
| `wizCurrentStep` | landing | 1–4 |
| `pendingLots` | schwab | Awards CSV waiting for XLS |
| `pendingXlsRates` | schwab | XLS rates waiting for CSV |
| `pendingRetailTrades` | schwab | Retail CSV waiting for XLS |
| `schwabMode` | schwab | `'awards'` \| `'retail'` \| `null` |
| `schwabRDataReady` | schwab | boolean — retail data loaded |
| `schwabRRealized` | schwab | Realized trades array (retail) |
| `schwabROpen` | schwab | Open lots object (retail) |
| `schwabRIntradayPnl` | schwab | Intraday sessions (retail) |
| `schwabRTaxRegime` | schwab | `'new'` or `'old'` (retail) |
| `imRawFiles` | indmoney | `{ us: {cg, fa}, in: {cg, fa} }` — raw XLSX rows |
| `imUsParsed` / `imInParsed` | indmoney | `{ stcg, ltcg, dividends, interest }` |
| `imUsHoldings` / `imInHoldings` | indmoney | FA schedule holdings |
| `imSubMode` | indmoney | `'us'` or `'in'` |
| `imCurrency` | indmoney | `'USD'` or `'INR'` |
| `imTaxRegime` | indmoney | `'new'` or `'old'` |
| `imActiveMarket` | indmoney | `'us'` \| `'in'` \| `null` |
| `zRawFiles` | zerodha | `{ eq, fo, mf }` each `{ trades, files }` |
| `zRealized`, `zOpen`, `zIntradayPnl`, `zFoPnl`, `zMfOpen` | zerodha | Computed state |
| `zTaxRegime`, `zFilter` | zerodha | UI state |
| `gRawFiles` | groww | Same structure as `zRawFiles` |
| `gRealized`, `gOpen`, etc. | groww | Computed state |
| `_openCalcMeta` | card_builders | `{ symId: { lots, ltcgDays, ltcgRateId, stcgRateId } }` — sell simulator registry |

---

## 18. Key HTML Element IDs

### Wizard
| ID | Description |
|---|---|
| `landingPanel` | Outer wrapper for 4-step wizard |
| `combinedResultsPanel` | Outer wrapper for all results |
| `wizStep1..4` | Step indicator buttons |
| `wizardPanel1..4` | Step content panels |
| `wizardError` | Error message div |
| `mkCard_us`, `mkCard_india` | Market selection cards |
| `pfCard_schwab`, `pfCard_indmoney`, `pfCard_zerodha`, `pfCard_groww` | Platform selection cards |
| `pfupBlock_schwab` etc. | Upload accordion blocks |
| `analyzeAllBtn` | Main analyze button |

### Schwab Awards Results
| ID | Description |
|---|---|
| `settingsPanel` | Portfolio & Tax Settings panel |
| `currentPrice`, `todayINR`, `ltcgRate`, `otherIncome` | Settings inputs |
| `regimeNew`, `regimeOld` | Regime toggle buttons |
| `stcgRateDisplay` | STCG rate computed display |
| `catSummarySection`, `catSummaryGrid` | RSU/ESPP summary cards |
| `summarySection`, `summaryGrid` | Portfolio summary |
| `lotsWrap` | Lot cards container |
| `disclaimerSection` | Tax disclaimer |
| `rateTableSection`, `rateTableBody` | RBI rate table |
| `missingRatesBanner` | Warning when rates are missing |

### Schwab Retail Results
| ID | Description |
|---|---|
| `schwabRSection` | Retail results wrapper |
| `schwabROtherIncome`, `schwabRStcgRate`, `schwabRLtcgRate` | Retail settings inputs |
| `schwabRRegimeNew`, `schwabRRegimeOld` | Retail regime |
| `schwabRConsolidated` | Summary grid |
| `schwabRRealCards`, `schwabROpenCards`, `schwabRIntradayContent` | Content containers |

### IndMoney
| ID | Description |
|---|---|
| `pra_indmoney` | IndMoney result panel |
| `imStcgRate`, `imLtcgRate`, `imOtherIncome`, `imUsdRate` | Settings inputs |
| `imRegimeNew`, `imRegimeOld` | Regime |
| `imCurrUSD`, `imCurrINR` | Currency toggle |
| `imConsolidated` | US CG summary table |
| `imUsResults`, `imInResults` | Market-specific result sections |
| `imInConsolidated` | India CG summary |

### Zerodha
| ID | Description |
|---|---|
| `pra_zerodha` | Zerodha result panel |
| `zStcgRate`, `zLtcgRate`, `zOtherIncome` | Settings inputs |
| `zRegimeNew`, `zRegimeOld` | Regime |
| `zConsolidated` | Summary grid |
| `zRealizedCards`, `zOpenCards`, `zFoContent`, `zIntradayContent`, `zMfContent` | Content containers |

### Groww
| ID | Description |
|---|---|
| `pra_groww` | Groww result panel |
| `gStcgRate`, `gLtcgRate`, `gOtherIncome` | Settings inputs |
| `gRegimeNew`, `gRegimeOld` | Regime |
| `gConsolidated` | Summary grid |
| Same pattern as Zerodha but prefixed `g` | Content containers |

---

## 19. Tax Settings Per Platform

| Platform | Tax Regime | LTCG Rate | STCG Rate | Other Income | Currency | LTCG Days |
|---|---|---|---|---|---|---|
| Schwab Awards | New/Old | `ltcgRate` (12.5%) | Computed from slab | `otherIncome` (₹L) | USD/INR toggle | 730 days (24mo) |
| Schwab Retail | New/Old | `schwabRLtcgRate` (12.5%) | `schwabRStcgRate` (30%) | `schwabROtherIncome` | — (INR only) | 730 days |
| IndMoney | New/Old | `imLtcgRate` (12.5%) | `imStcgRate` (30%) | `imOtherIncome` | USD/INR toggle | 365 (India) |
| Zerodha | New/Old | `zLtcgRate` (12.5%) | `zStcgRate` (20%) | `zOtherIncome` | — (INR only) | 365 days |
| Groww | New/Old | `gLtcgRate` (12.5%) | `gStcgRate` (20%) | `gOtherIncome` | — (INR only) | 365 days |

Note: Zerodha and Groww default STCG is 20% (post-Jul 2024 Budget change). IndMoney/Schwab US default STCG is 30% (slab).

---

## 20. Known Limitations & Caveats

1. **No actual ITR filing** — this is an estimator. Always verify with a CA before filing.

2. **Schwab retail: INR gain method** — buy-date rate × buy price subtracted from sell-date rate × sell price. This is one valid interpretation; an alternative is to compute USD gain first and convert at sell-date rate.

3. **IndMoney US: gains are from pre-computed CG statement** — the app does not re-compute from raw trades; it trusts IndMoney's `gainINR` column. Forex rate used by IndMoney is xe.com, not RBI.

4. **LTCG ₹1.25L exemption is per person per year** — this tool does not aggregate exemption across platforms when multiple platforms are selected simultaneously.

5. **F&O tax** — shown as estimated business income. Actual ITR treatment requires books of accounts, expenses, etc.

6. **Intraday classification** — same-day buy+sell detected automatically. Delivery trades on same day that happen to net out may be misclassified. Verify against broker's Tax P&L.

7. **Short-selling / missing buy data** — FIFO silently skips sells with no matching buy lots.

8. **MF LTCG threshold** — Equity MFs: 12 months (365 days). Debt MFs: no LTCG benefit (taxed at slab). The app does not distinguish MF types — treats all MF as equity MF.

9. **Surcharge and cess** — not calculated. Actual tax = estimated tax × (1 + surcharge) × 1.04 (health + education cess).

10. **Currency for Schwab awards sell simulator** — the sell simulator for open positions shows INR amounts using the `_openCalcMeta`-stored lots (which are already in INR for Schwab retail).

---

## 21. Bug History

### Fixed in commit `95800ae` (2026-05-27)

**BUG 1 — Schwab retail Analyze button showed "No data found"**
- File: `10_landing.js`, `runAnalysisAll()`
- Root cause: only checked `allLots.length > 0` (equity awards). Retail mode sets `schwabRDataReady = true` but leaves `allLots = []`.
- Fix: added `else if (activePlatforms.has('schwab') && schwabRDataReady)` branch calling `showSchwabRetailUI()` + `rerenderSchwabRetail()`.

**BUG 2 — Schwab retail CSV parsed 0 trades**
- File: `02_utils.js`, `isMMDDYYYY()` and `mmddToISO()`
- Root cause: regex only matched `MM-DD-YYYY` with dashes. Real Schwab CSVs use `MM/DD/YYYY` with slashes. Every trade date returned `null` → 0 trades parsed.
- Fix: updated both regexes to `[\/\-]` separator — accepts either `/` or `-`.

**BUG 3+4 — Sell simulator silently broken for Groww, IndMoney India, Schwab Retail**
- File: `05_card_builders.js`, `updateOpenCalc()`
- Root cause: hardcoded `zOpen[sym]` (undefined for non-Zerodha) and `zLtcgRate`/`zStcgRate` input IDs.
- Fix: introduced `_openCalcMeta` registry populated by `buildOpenCard`. Added `opts` param to `buildOpenCard`. Updated callers in `06_schwab.js`, `07_indmoney.js`, `09_groww.js` to pass platform-specific rate IDs.

**BUG 5 — Wrong LTCG threshold (365 days) shown for US equity open positions**
- File: `05_card_builders.js`, `buildOpenCard()`
- Root cause: hardcoded `365` days in lot rows calculation.
- Fix: `ltcgDays` from `opts` (default 365, Schwab retail passes 730). Same fix as BUG 3+4.

---

## 22. Enhancement Ideas / Future Work

The following are identified gaps and possible next enhancements:

### High value
- **Cross-platform LTCG ₹1.25L exemption aggregation** — currently each platform independently applies the ₹1.25L exemption. A combined view would show the true total taxable LTCG across all platforms.
- **Export to CSV / PDF** — let user download the realized gains summary for record-keeping / CA handover.
- **Surcharge + cess calculation** — add health & education cess (4%) and surcharge (10-37% depending on income) to show final tax payable.
- **Multi-year view** — user selects FY; currently shows all trades regardless of year.

### Medium value
- **Groww: verify MF LTCG threshold** — Equity MFs held > 12 months = LTCG; Debt MFs = slab. Currently all MF treated as equity MF.
- **IndMoney India tradebook: FA Schedule upload** — currently only equity awards mode has the FA schedule; IndMoney India could also benefit.
- **Schwab retail: USD gain view** — option to show gain in USD (sale USD − buy USD) in addition to INR gain (sell-date INR − buy-date INR).
- **Short-selling warning** — when FIFO encounters a sell with no matching buy (short position or missing historical data), surface a visible warning rather than silently skipping.
- **Tax-loss harvesting suggestion** — identify unrealized losses that could offset LTCG/STCG.

### Low value / polish
- **Dark mode** — CSS variables are partially set up; would need full dark palette.
- **Print / print-friendly view** — remove interactive controls, add page breaks.
- **Rate table toggle** — currently hidden in Schwab awards results; could be made user-accessible.
- **Keyboard navigation** — wizard step buttons have `tabindex` and `role="button"` but no `keydown` handler for Enter/Space.
