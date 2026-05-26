// ═══════════════════════════════════════════════════════════════════
// LANDING PANEL — MARKET & PLATFORM SELECTION
// ═══════════════════════════════════════════════════════════════════
const selectedMarkets = new Set(['us']);
const activePlatforms = new Set(['schwab']);

function toggleMarket(m) {
  if (selectedMarkets.has(m)) {
    if (selectedMarkets.size === 1) return; // must keep at least one market selected
    selectedMarkets.delete(m);
  } else {
    selectedMarkets.add(m);
  }
  renderMarketCards();
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
  document.getElementById('analyzeAllRow').style.display = anySelected ? 'flex' : 'none';
  if (activePlatforms.has('indmoney')) syncImSubTabs();
}

function updateAnalyzeAllBtn() {
  let hasData = false;
  if (activePlatforms.has('schwab') && (typeof pendingLots !== 'undefined' && pendingLots)) hasData = true;
  if (activePlatforms.has('indmoney') && ((typeof imRawFiles !== 'undefined' && imRawFiles.us.cg) ||
      (typeof imInRawFiles !== 'undefined' && Object.values(imInRawFiles).some(s => s.trades && s.trades.length > 0)))) hasData = true;
  if (activePlatforms.has('zerodha') && typeof zRawFiles !== 'undefined' && Object.values(zRawFiles).some(s => s.trades.length > 0)) hasData = true;
  if (activePlatforms.has('groww') && typeof gRawFiles !== 'undefined' && Object.values(gRawFiles).some(s => s.trades.length > 0)) hasData = true;
  document.getElementById('analyzeAllBtn').disabled = !hasData;
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