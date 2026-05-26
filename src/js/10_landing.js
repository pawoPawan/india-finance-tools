// ═══════════════════════════════════════════════════════════════════
// LANDING PANEL — MARKET & PLATFORM SELECTION
// ═══════════════════════════════════════════════════════════════════
const selectedMarkets = new Set();
const activePlatforms = new Set();
let wizCurrentStep = 1;

// Show only the active tab panel; mark steps done/active accordingly.
// Does NOT validate — use switchToStep() for user-initiated navigation.
function advanceWizard(toStep) {
  wizCurrentStep = toStep;
  for (let n = 1; n <= 4; n++) {
    const step  = document.getElementById('wizStep' + n);
    const panel = document.getElementById('wizardPanel' + n);
    if (step) {
      step.classList.toggle('is-active', n === toStep);
      step.classList.toggle('is-done',   n < toStep);
    }
    if (panel) panel.classList.toggle('is-visible', n === toStep);
  }
  hideWizardError();
}

// User-initiated tab click — validates before switching.
function switchToStep(n) {
  if (n === wizCurrentStep) return;

  // Going backward is always free
  if (n < wizCurrentStep) {
    advanceWizard(n);
    return;
  }

  // Going forward — check prerequisites for each step being crossed
  if (n >= 2 && selectedMarkets.size === 0) {
    showWizardError('Please select at least one market before continuing.');
    return;
  }
  if (n >= 3) {
    if (activePlatforms.size === 0) {
      showWizardError('Please select at least one platform before continuing.');
      return;
    }
    const warn = getPlatformWarning();
    if (warn) { showWizardError(warn); return; }
  }

  // Recompute derived state from current selections before showing the target panel,
  // so any changes made on a previous step are always reflected.
  if (n === 2) {
    // Refresh platform card visibility based on current market selection
    const showUs    = selectedMarkets.has('us');
    const showIndia = selectedMarkets.has('india');
    document.getElementById('pfCard_schwab').style.display   = showUs    ? '' : 'none';
    document.getElementById('pfCard_indmoney').style.display = '';
    document.getElementById('pfCard_zerodha').style.display  = showIndia ? '' : 'none';
    document.getElementById('pfCard_groww').style.display    = showIndia ? '' : 'none';
    const pfGrid = document.getElementById('pfGrid');
    const pfHint = document.getElementById('pfGridHint');
    if (pfGrid) pfGrid.style.display = 'flex';
    if (pfHint) pfHint.style.display = 'none';
    renderPlatformCards();
  }
  if (n >= 3) {
    updateUploads();
  }
  if (n >= 4) {
    updateAnalyzeAllBtn();
    if (document.getElementById('analyzeAllBtn').disabled) {
      showWizardError('Please upload files for your selected platforms first.');
      return;
    }
  }

  advanceWizard(n);
}

function showWizardError(msg) {
  const el = document.getElementById('wizardError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = '';
}

function hideWizardError() {
  const el = document.getElementById('wizardError');
  if (el) el.style.display = 'none';
}

function toggleMarket(m) {
  if (selectedMarkets.has(m)) {
    if (selectedMarkets.size === 1) return; // must keep at least one market selected
    selectedMarkets.delete(m);
  } else {
    selectedMarkets.add(m);
  }
  renderMarketCards();
  // show/hide pfGrid based on market selection
  const pfGrid = document.getElementById('pfGrid');
  const pfHint = document.getElementById('pfGridHint');
  const anyMkt = selectedMarkets.size > 0;
  if (pfGrid) pfGrid.style.display = anyMkt ? 'flex' : 'none';
  if (pfHint) pfHint.style.display = anyMkt ? 'none' : '';
  const showUs    = selectedMarkets.has('us');
  const showIndia = selectedMarkets.has('india');
  document.getElementById('pfCard_schwab').style.display   = showUs    ? '' : 'none';
  document.getElementById('pfCard_indmoney').style.display = '';
  document.getElementById('pfCard_zerodha').style.display  = showIndia ? '' : 'none';
  document.getElementById('pfCard_groww').style.display    = showIndia ? '' : 'none';
  if (!showUs)    { activePlatforms.delete('schwab'); }
  if (!showIndia) { activePlatforms.delete('zerodha'); activePlatforms.delete('groww'); }
  renderPlatformCards();
  updateUploads();
  syncImSubTabs();
  updateAnalyzeAllBtn();
}

function renderMarketCards() {
  for (const m of ['us', 'india']) {
    const card = document.getElementById('mkCard_' + m);
    const chk  = document.getElementById('mkChk_' + m);
    if (!card) continue;
    const sel = selectedMarkets.has(m);
    card.classList.toggle('selected', sel);
    if (chk) chk.textContent = sel ? '✓' : '';
  }
}

function togglePlatform(p) {
  if (activePlatforms.has(p)) activePlatforms.delete(p);
  else activePlatforms.add(p);
  renderPlatformCards();
  updateUploads();
  updateAnalyzeAllBtn();
}

function renderPlatformCards() {
  for (const p of ['schwab','indmoney','zerodha','groww']) {
    const card = document.getElementById('pfCard_' + p);
    const chk  = document.getElementById('pfChk_' + p);
    if (!card) continue;
    const sel = activePlatforms.has(p);
    card.classList.toggle('selected', sel);
    if (chk) chk.textContent = sel ? '✓' : '';
  }
}

function updateUploads() {
  const anySelected = activePlatforms.size > 0;
  const pfUploads = document.getElementById('pfUploads');
  pfUploads.style.display = anySelected ? 'flex' : 'none';
  for (const p of ['schwab','indmoney','zerodha','groww']) {
    const block = document.getElementById('pfupBlock_' + p);
    if (block) block.style.display = activePlatforms.has(p) ? 'block' : 'none';
  }
  if (activePlatforms.has('indmoney')) syncImSubTabs();
}

function getPlatformWarning() {
  const hasUs    = selectedMarkets.has('us');
  const hasIndia = selectedMarkets.has('india');
  const usPlatforms     = ['schwab', 'indmoney'];
  const indiaPlatforms  = ['zerodha', 'groww', 'indmoney'];
  const missingUs    = hasUs    && !usPlatforms.some(p   => activePlatforms.has(p));
  const missingIndia = hasIndia && !indiaPlatforms.some(p => activePlatforms.has(p));
  if (missingUs && missingIndia) return 'Please select at least one platform for US market (Schwab or IndMoney) and one for India market (Zerodha, Groww, or IndMoney).';
  if (missingUs)    return 'US market selected — please choose at least one platform: Charles Schwab or IndMoney.';
  if (missingIndia) return 'India market selected — please choose at least one platform: Zerodha, Groww, or IndMoney.';
  return null;
}

function updateAnalyzeAllBtn() {
  const warning = getPlatformWarning();
  const warnEl  = document.getElementById('platformWarning');
  if (warnEl) {
    warnEl.style.display = warning ? '' : 'none';
    warnEl.textContent   = warning || '';
  }

  let hasData = false;
  if (activePlatforms.has('schwab') && typeof allLots !== 'undefined' && allLots.length > 0) hasData = true;
  if (activePlatforms.has('indmoney') && ((typeof imRawFiles !== 'undefined' && imRawFiles.us.cg && imRawFiles.us.cg.length > 0) ||
      (typeof imInRawFiles !== 'undefined' && Object.values(imInRawFiles).some(s => s.trades && s.trades.length > 0)))) hasData = true;
  if (activePlatforms.has('zerodha') && typeof zRawFiles !== 'undefined' && Object.values(zRawFiles).some(s => s.trades.length > 0)) hasData = true;
  if (activePlatforms.has('groww') && typeof gRawFiles !== 'undefined' && Object.values(gRawFiles).some(s => s.trades.length > 0)) hasData = true;
  document.getElementById('analyzeAllBtn').disabled = !hasData || !!warning;
}

function togglePfup(p) {
  const body   = document.getElementById('pfupBody_' + p);
  const toggle = document.getElementById('pfupToggle_' + p);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  toggle.textContent = isOpen ? '▶' : '▼';
}

function runAnalysisAll() {
  // Hide all platform result panels first so stale results from a previous run don't bleed through
  for (const p of ['schwab', 'indmoney', 'zerodha', 'groww']) {
    document.getElementById('pra_' + p).style.display = 'none';
  }

  let hasResults = false;

  if (activePlatforms.has('schwab') && allLots.length > 0) {
    showMainUI();
    document.getElementById('pra_schwab').style.display = 'block';
    hasResults = true;
  }

  if (activePlatforms.has('indmoney')) {
    let imAny = false;
    if (imRawFiles.us.cg) { runIndMoneyAnalysis('us'); imAny = true; }
    if (Object.values(imInRawFiles).some(s => s.trades && s.trades.length > 0)) { runIndMoneyIndiaAnalysis(); imAny = true; }
    if (imAny) { document.getElementById('pra_indmoney').style.display = 'block'; hasResults = true; }
  }

  if (activePlatforms.has('zerodha') && Object.values(zRawFiles).some(s => s.trades.length > 0)) {
    runZerodhaAnalysis();
    document.getElementById('pra_zerodha').style.display = 'block';
    hasResults = true;
  }

  if (activePlatforms.has('groww') && Object.values(gRawFiles).some(s => s.trades.length > 0)) {
    runGrowwAnalysis();
    document.getElementById('pra_groww').style.display = 'block';
    hasResults = true;
  }

  if (hasResults) {
    document.getElementById('landingPanel').style.display = 'none';
    document.getElementById('combinedResultsPanel').style.display = 'block';
    const names = ['schwab','indmoney','zerodha','groww']
      .filter(p => document.getElementById('pra_' + p).style.display !== 'none')
      .map(p => ({schwab:'Schwab',indmoney:'IndMoney',zerodha:'Zerodha',groww:'Groww'}[p]));
    document.getElementById('crpPlatforms').textContent = names.join(' · ');
  } else {
    alert('No data found. Please upload files for your selected platforms first.');
  }
}

function backToSetup() {
  document.getElementById('combinedResultsPanel').style.display = 'none';
  document.getElementById('landingPanel').style.display = 'block';
}

function togglePlatformResult(p) {
  const body   = document.getElementById('praBody_' + p);
  const toggle = document.getElementById('praToggle_' + p);
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  toggle.textContent = isOpen ? '▶' : '▼';
}

function checkAndMaybeGoBack() {
  const anyVisible = ['schwab','indmoney','zerodha','groww']
    .some(p => document.getElementById('pra_' + p).style.display !== 'none');
  if (!anyVisible) backToSetup();
}

function resetSchwabToLanding() {
  document.getElementById('pra_schwab').style.display = 'none';
  checkAndMaybeGoBack();
}
function resetImToLanding() {
  resetImIndia();
  document.getElementById('pra_indmoney').style.display = 'none';
  imActiveMarket = null;
  checkAndMaybeGoBack();
}
function resetZerodhaToLanding() {
  zRealized = []; zOpen = {}; zFoPnl = []; zMfOpen = {}; zIntradayPnl = [];
  document.getElementById('pra_zerodha').style.display = 'none';
  checkAndMaybeGoBack();
}
function resetGrowwToLanding() {
  gRealized = []; gOpen = {}; gFoPnl = []; gMfOpen = {}; gIntradayPnl = [];
  document.getElementById('pra_groww').style.display = 'none';
  checkAndMaybeGoBack();
}
