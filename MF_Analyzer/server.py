"""
MF Analyzer — Flask Backend
============================
GET  /                      → mf_ui.html
GET  /api/meta              → categories, AMCs, counts
GET  /api/funds             → filtered / sorted / paginated list
GET  /api/holdings/<secId>  → full equity + bond + other + allocation + sectors
POST /api/refresh           → re-run api_fetcher.py in background
GET  /api/refresh/status    → polling endpoint for refresh state
"""

import argparse, json, os, queue, re, subprocess, sys, threading, time
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    from flask import Flask, jsonify, request, send_from_directory
    from flask_cors import CORS
    import requests as req_lib
except ImportError:
    print("Run: pip install flask flask-cors requests")
    sys.exit(1)

# ── paths ──────────────────────────────────────────────────────────────────────
BASE         = Path(__file__).parent
DATA_FILE    = BASE / "mf_data.json"
HOLD_CACHE   = BASE / "holdings_cache.json"
ANL_CACHE    = BASE / "anl_cache.json"        # lightweight bulk-analytics cache
SAL_HDR_FILE = BASE / "sal_headers.json"
UI_FILE      = BASE / "mf_ui.html"

app = Flask(__name__, static_folder=str(BASE))
CORS(app)

# ── SAL API config ─────────────────────────────────────────────────────────────
SAL_BASE   = "https://www.us-api.morningstar.com/sal/sal-service/fund"
SAL_PARAMS = {"locale":"en","clientId":"RSIN_SAL","benchmarkId":"morningstar","version":"4.86.0"}
SAL_HDR_TTL = 4 * 3600  # 4 hours (JWT valid for weeks)
_sal_headers: dict = {}
_sal_hdr_ts: float = 0
_sal_hdr_lock = threading.Lock()

# ── fund data ──────────────────────────────────────────────────────────────────
_funds: list = []
_funds_lock  = threading.Lock()

def load_funds():
    global _funds
    if not DATA_FILE.exists(): return
    with open(DATA_FILE) as f:
        raw = json.load(f)
    with _funds_lock:
        _funds = raw
    print(f"[data] {len(_funds)} funds loaded")

load_funds()

# ── SAL header management ──────────────────────────────────────────────────────
def load_cached_sal_headers() -> dict:
    """Load headers from file if fresh enough."""
    if SAL_HDR_FILE.exists():
        with open(SAL_HDR_FILE) as f:
            data = json.load(f)
        ts = data.get("_ts", 0)
        if time.time() - ts < SAL_HDR_TTL:
            return {k:v for k,v in data.items() if not k.startswith("_")}
    return {}

def save_sal_headers(hdrs: dict):
    to_save = {**hdrs, "_ts": time.time()}
    with open(SAL_HDR_FILE, "w") as f:
        json.dump(to_save, f, indent=2)

def get_sal_headers(force_refresh=False) -> dict:
    """Return valid SAL request headers, refreshing via Playwright if needed."""
    global _sal_headers, _sal_hdr_ts
    with _sal_hdr_lock:
        if not force_refresh and time.time() - _sal_hdr_ts < SAL_HDR_TTL and _sal_headers:
            return dict(_sal_headers)
        # Try cached file first
        cached = load_cached_sal_headers()
        if cached and not force_refresh:
            _sal_headers = cached
            _sal_hdr_ts  = SAL_HDR_FILE.stat().st_mtime if SAL_HDR_FILE.exists() else 0
            return dict(_sal_headers)
        # Refresh via Playwright
        print("[sal] Refreshing SAL headers via Playwright…")
        new_hdrs = _capture_sal_headers_pw()
        if new_hdrs:
            _sal_headers = new_hdrs
            _sal_hdr_ts  = time.time()
            save_sal_headers(new_hdrs)
            print("[sal] Headers refreshed OK")
        else:
            print("[sal] Header capture failed")
        return dict(_sal_headers)

def _capture_sal_headers_pw() -> dict:
    """Use Playwright to load a fund page and capture the SAL request headers."""
    import asyncio
    try:
        return asyncio.run(_pw_capture_headers())
    except Exception as e:
        print(f"[sal] Playwright error: {e}")
        return {}

async def _pw_capture_headers() -> dict:
    from playwright.async_api import async_playwright
    captured = {}

    async with async_playwright() as pw:
        br  = await pw.chromium.launch(headless=True)
        ctx = await br.new_context(
            viewport={"width":1400,"height":900},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        page = await ctx.new_page()

        async def on_req(r):
            if "us-api.morningstar.com" in r.url and not captured:
                h = dict(r.headers)
                h.pop("credentials", None)
                captured.update(h)

        page.on("request", on_req)
        url = ("https://www.morningstar.in/mutualfunds/F00001GP7E/"
               "360-ONE-Balanced-Hybrid-Fund-Regular-Growth/overview.aspx")
        await page.goto(url, wait_until="networkidle", timeout=40000)
        import asyncio as _aio; await _aio.sleep(5)
        await br.close()

    return captured

# Pre-load headers at startup (synchronous so first request doesn't miss them)
def _bg_load_headers():
    try:
        h = get_sal_headers()
        if h:
            print(f"[sal] Headers ready ({len(h)} keys)")
        else:
            print("[sal] No headers — will capture on first holdings request")
    except Exception as e:
        print(f"[sal] Startup header load failed: {e}")

# Run synchronously only if file doesn't exist; otherwise use cached
if SAL_HDR_FILE.exists():
    _bg_load_headers()
else:
    threading.Thread(target=_bg_load_headers, daemon=True).start()

# ── holdings cache ─────────────────────────────────────────────────────────────
HOLD_TTL = 6 * 3600   # 6 hours

def load_hold_cache() -> dict:
    if HOLD_CACHE.exists():
        with open(HOLD_CACHE) as f:
            return json.load(f)
    return {}

def save_hold_cache(cache: dict):
    with open(HOLD_CACHE, "w") as f:
        json.dump(cache, f)

# ── SAL API helpers ────────────────────────────────────────────────────────────
def _sal_get(path: str, extra_params: dict = None, hdrs: dict = None):
    params = {**SAL_PARAMS, **(extra_params or {})}
    headers = hdrs or get_sal_headers()
    if not headers:
        return None
    try:
        r = req_lib.get(f"{SAL_BASE}/{path}", params=params, headers=headers, timeout=12)
        if r.status_code == 401:
            # Try refreshing headers once
            headers = get_sal_headers(force_refresh=True)
            r = req_lib.get(f"{SAL_BASE}/{path}", params=params, headers=headers, timeout=12)
        if r.status_code == 200:
            return r.json()
    except Exception as e:
        print(f"[sal] {path}: {e}")
    return None

def fetch_all_holding_data(sec_id: str) -> dict:
    """Fetch holdings, allocation, sector, style, market cap in parallel."""
    hdrs = get_sal_headers()

    tasks = {
        "holdings":    (f"portfolio/holding/v2/{sec_id}/data",
                        {"premiumNum":"500","freeNum":"50","hideesg":"false","secId":sec_id}),
        "asset":       (f"process/asset/v3/{sec_id}/data",          {"secId":sec_id}),
        "sector":      (f"portfolio/v2/sector/{sec_id}/data",        {"secId":sec_id}),
        "stockStyle":  (f"process/stockStyle/v2/{sec_id}/data",      {"secId":sec_id}),
        "marketCap":   (f"process/marketCap/{sec_id}/data",          {"secId":sec_id}),
        "financial":   (f"process/financialMetrics/{sec_id}/data",   {"secId":sec_id}),
        "perf":        (f"performance/table/{sec_id}",
                        {"secExchangeList":"","limitAge":"","hideYTD":"false","secId":sec_id}),
        "creditQual":  (f"portfolio/creditQuality/{sec_id}/data",    {"secId":sec_id}),
        "people":      (f"people/{sec_id}/data",
                        {"locale":"en","secId":sec_id}),
        "fixedStyle":  (f"process/fixedIncomeStyle/{sec_id}/data",   {"secId":sec_id}),
    }

    results = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(_sal_get, path, xp, hdrs): name
                   for name, (path, xp) in tasks.items()}
        for fut in as_completed(futures):
            name = futures[fut]
            try:
                results[name] = fut.result()
            except Exception as e:
                print(f"[sal] {name}: {e}")

    return _parse_holding_data(sec_id, results)


def _parse_holding_data(sec_id: str, raw: dict) -> dict:
    out = {"secId": sec_id, "_ts": time.time()}

    # ── holdings ──────────────────────────────────────────────────────────────
    h = raw.get("holdings") or {}
    out.update({
        "portfolioDate":          _clean_date(h.get("holdingSummary",{}).get("portfolioDate")),
        "numberOfHolding":        h.get("numberOfHolding"),
        "numberOfEquityHolding":  h.get("numberOfEquityHolding"),
        "numberOfBondHolding":    h.get("numberOfBondHolding"),
        "numberOfOtherHolding":   h.get("numberOfOtherHolding"),
    })

    def _parse_hl(page_key):
        page = h.get(page_key, {})
        return [_clean_holding(x) for x in page.get("holdingList", []) if x]

    out["equityHoldings"] = _parse_hl("equityHoldingPage")
    out["bondHoldings"]   = _parse_hl("boldHoldingPage")
    out["otherHoldings"]  = _parse_hl("otherHoldingPage")

    # ── asset allocation ──────────────────────────────────────────────────────
    a = raw.get("asset") or {}
    alloc_map = a.get("allocationMap", {})
    def _net_f(key):
        v = alloc_map.get(key)
        if isinstance(v, dict):
            raw_v = v.get("netAllocation") or v.get("longAllocation")
        else:
            raw_v = v
        try: return float(raw_v) if raw_v is not None else None
        except: return None
    out["assetAllocation"] = {
        "stock":              _net_f("INDAssetAllocStock"),
        "bond":               _net_f("INDAssetAllocBond"),
        "cash":               _net_f("INDAssetAllocCash"),
        "other":              _net_f("INDAssetAllocOther"),
        "convertible":        _net_f("INDAssetAllocConvertible"),
        "preferred":          _net_f("INDAssetAllocPreferred"),
        "asOfDate":           _clean_date(a.get("portfolioDate")),
        # category averages for comparison
        "stockCategory":      _net_f("INDAssetAllocStock") and _safe(alloc_map.get("INDAssetAllocStock",{}), "longAllocationCategory"),
    }

    # ── sector breakdown ──────────────────────────────────────────────────────
    s = raw.get("sector") or {}
    SECTOR_NAMES = {
        "basicMaterials":"Basic Materials","consumerCyclical":"Consumer Cyclical",
        "financialServices":"Financial Services","realEstate":"Real Estate",
        "communicationServices":"Communication","energy":"Energy",
        "industrials":"Industrials","technology":"Technology",
        "consumerDefensive":"Consumer Defensive","healthcare":"Healthcare",
        "utilities":"Utilities",
    }
    def _parse_sector_portfolio(portfolio_dict, cat_dict=None):
        if not isinstance(portfolio_dict, dict): return []
        result = []
        for k, name in SECTOR_NAMES.items():
            v = portfolio_dict.get(k)
            if v is not None:
                cat_v = cat_dict.get(k) if isinstance(cat_dict, dict) else None
                result.append({"name": name, "fund": float(v) if v else 0,
                                "category": float(cat_v) if cat_v else None})
        return sorted(result, key=lambda x: x["fund"], reverse=True)

    eq_data = s.get("EQUITY", {})
    fi_data = s.get("FIXEDINCOME", {})
    out["equitySectors"]      = _parse_sector_portfolio(eq_data.get("fundPortfolio",{}),
                                                         eq_data.get("categoryPortfolio",{}))
    out["fixedIncomeSectors"] = _parse_sector_portfolio(fi_data.get("fundPortfolio",{}),
                                                         fi_data.get("categoryPortfolio",{}))

    # ── stock style box ───────────────────────────────────────────────────────
    ss = raw.get("stockStyle") or {}
    fund_style = ss.get("fund", {})
    if isinstance(fund_style, dict):
        out["styleBox"]     = fund_style.get("styleBox")
    out["stockStylePortfolioDate"] = _clean_date(ss.get("portfolioDate"))

    # ── market cap ────────────────────────────────────────────────────────────
    mc = (raw.get("marketCap") or {}).get("fund", {})
    out["marketCap"] = {
        "giant":      _safe(mc, "giant"),
        "large":      _safe(mc, "large"),
        "medium":     _safe(mc, "medium"),
        "small":      _safe(mc, "small"),
        "micro":      _safe(mc, "micro"),
        "avgMarketCap": _safe(mc, "avgMarketCap"),
    }

    # ── financial metrics ─────────────────────────────────────────────────────
    fm = (raw.get("financial") or {}).get("fund", {})
    out["financialMetrics"] = {
        "priceToEarnings":       _safe(fm, "priceToEarnings"),
        "priceToBook":           _safe(fm, "priceToBook"),
        "priceToSales":          _safe(fm, "priceToSales"),
        "priceToCashFlow":       _safe(fm, "priceToCashFlow"),
        "returnOnEquity":        _safe(fm, "returnOnEquity"),
        "debtToCapital":         _safe(fm, "debtToCapital"),
        "netMargin":             _safe(fm, "netMargin"),
        "revenueGrowth":         _safe(fm, "revenueGrowth"),
        "earningsGrowth":        _safe(fm, "earningsGrowth"),
        "dividendYield":         _safe(fm, "dividendYield"),
        "yieldToMaturity":       _safe(fm, "yieldToMaturity"),
        "modifiedDuration":      _safe(fm, "modifiedDuration"),
        "effectiveDuration":     _safe(fm, "effectiveDuration"),
        "averageCreditQuality":  fm.get("averageCreditQuality"),
        "averageCoupon":         _safe(fm, "averageCoupon"),
    }

    # ── performance history ───────────────────────────────────────────────────
    pf = raw.get("perf") or {}
    table = pf.get("table", {})
    cols  = table.get("columnDefs", [])
    rows  = table.get("growth10KReturnData", [])
    perf_out = {"columns": cols, "rows": {}}
    for row in rows:
        label = row.get("label","")
        if label in ("fund", "category", "percentileRank"):
            datum = row.get("datum", [])
            parsed = []
            for v in datum:
                try: parsed.append(round(float(v), 2) if v not in (None,"") else None)
                except: parsed.append(None)
            perf_out["rows"][label] = parsed
    out["performanceHistory"] = perf_out

    # ── credit quality ────────────────────────────────────────────────────────
    cq_raw = (raw.get("creditQual") or {}).get("fund", {})
    CQ_MAP = {
        "creditQualityAAA":"AAA","creditQualityAA":"AA","creditQualityA":"A",
        "creditQualityBBB":"BBB","creditQualityBB":"BB","creditQualityB":"B",
        "creditQualityBelowB":"Below B","creditQualityNotRated":"Not Rated",
    }
    cq_list = []
    for k, label in CQ_MAP.items():
        v = cq_raw.get(k)
        if v is not None:
            try:
                fv = float(v)
                if fv > 0: cq_list.append({"rating": label, "value": round(fv, 2)})
            except: pass
    out["creditQuality"] = sorted(cq_list, key=lambda x: x["value"], reverse=True)
    out["creditQualityDate"] = _clean_date(cq_raw.get("creditQualityDate"))

    # ── fund managers ─────────────────────────────────────────────────────────
    ppl = raw.get("people") or {}
    mgr_list = (ppl.get("managedBy") or ppl.get("managerList") or [])
    # Sometimes wrapped differently
    if not mgr_list and isinstance(ppl, dict):
        for v in ppl.values():
            if isinstance(v, list) and v and isinstance(v[0], dict) and "displayName" in v[0]:
                mgr_list = v; break
    out["managers"] = [{
        "name":     m.get("displayName") or m.get("name",""),
        "startDate":_clean_date(m.get("startDate")),
        "tenure":   m.get("tenure"),
    } for m in (mgr_list or []) if m.get("displayName") or m.get("name")]
    out["inceptionDate"]        = _clean_date(ppl.get("inceptionDate"))
    out["averageManagerTenure"] = ppl.get("averageManagerTenure")

    # ── fixed income style ────────────────────────────────────────────────────
    fs = (raw.get("fixedStyle") or {}).get("fund", {})
    out["fixedIncomeStyleBox"] = fs.get("styleBox") if isinstance(fs, dict) else None

    return out


def _clean_holding(x: dict) -> dict:
    if not x: return {}
    return {
        "securityName":   x.get("securityName",""),
        "ticker":         x.get("ticker",""),
        "isin":           x.get("isin",""),
        "weighting":      x.get("weighting"),
        "numberOfShare":  x.get("numberOfShare"),
        "marketValue":    x.get("marketValue"),
        "shareChange":    x.get("shareChange"),
        "currency":       x.get("currency") or x.get("localCurrencyCode","INR"),
        "sector":         x.get("sector",""),
        "country":        x.get("country",""),
        "firstBoughtDate":_clean_date(x.get("firstBoughtDate")),
        "totalReturn1Year":    x.get("totalReturn1Year"),
        "forwardPERatio":      x.get("forwardPERatio"),
        "stockRating":         x.get("stockRating"),
        "assessment":          x.get("assessment",""),
        "economicMoat":        x.get("economicMoat",""),
        "susEsgRiskScore":     x.get("susEsgRiskScore"),
        "susEsgRiskCategory":  x.get("susEsgRiskCategory",""),
        "susEsgRiskGlobes":    x.get("susEsgRiskGlobes"),
        "holdingTrend":        (x.get("holdingTrend") or {}).get("trend", []),
        "holdingType":         x.get("holdingType",""),
        # Bond-specific
        "coupon":         x.get("coupon"),
        "maturityDate":   _clean_date(x.get("maturityDate")),
        "creditRating":   x.get("creditQuality",""),
    }

def _ms_slug(name: str) -> str:
    return re.sub(r'[^a-zA-Z0-9-]', '', (name or '').replace(' ', '-'))

_ms_url_cache: dict = {}

_MS_HDR = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
}

def _resolve_ms_url(sec_id: str, legal_name: str) -> str:
    """Return a verified Morningstar India fund URL; falls back to search URL."""
    if sec_id in _ms_url_cache:
        return _ms_url_cache[sec_id]

    slug = _ms_slug(legal_name)
    candidate = f"https://www.morningstar.in/mutualfunds/{sec_id}/{slug}/overview.aspx"

    # 1. Try the generated slug URL
    try:
        r = req_lib.get(candidate, allow_redirects=True, timeout=10, headers=_MS_HDR)
        final = r.url
        if r.status_code < 400 and "NotWorking" not in final and sec_id in final:
            _ms_url_cache[sec_id] = final
            return final
    except Exception as e:
        print(f"[ms-url] GET {sec_id}: {e}")

    # 2. Try the no-slug URL — Morningstar might redirect to the correct URL
    try:
        bare = f"https://www.morningstar.in/mutualfunds/{sec_id}/overview.aspx"
        r = req_lib.get(bare, allow_redirects=True, timeout=10, headers=_MS_HDR)
        final = r.url
        if r.status_code < 400 and "NotWorking" not in final and sec_id in final and "/overview.aspx" in final:
            _ms_url_cache[sec_id] = final
            return final
    except Exception as e:
        print(f"[ms-url] bare {sec_id}: {e}")

    # 3. Fallback: Morningstar India screener search
    search = f"https://www.morningstar.in/tools/ECFundscreener.aspx?KeY={quote(legal_name)}"
    _ms_url_cache[sec_id] = search
    return search

def _clean_date(d):
    if not d: return None
    return str(d)[:10]  # ISO date only

def _net(v):
    if isinstance(v, dict): return v.get("netAllocation")
    return v

def _safe(d, k):
    v = d.get(k) if isinstance(d, dict) else None
    try: return float(v) if v is not None else None
    except: return None


# ── scoring ────────────────────────────────────────────────────────────────────
FIELD_MAP = {
    "starRating":  ["starRatingM255"],
    "return_1y":   ["returnM12"],
    "return_3y":   ["returnM36"],
    "return_5y":   ["returnM60"],
    "expenseRatio":["expenseRatio", "ongoingCharge"],
    "riskRating":  ["morningstarRiskM255"],
    "sharpe":      ["sharpeM36"],
    "alpha":       ["alphaM36"],
    "beta":        ["betaM36"],
    "category":    ["categoryName"],
    "name":        ["name", "legalName"],
    "amc":         ["BrandingCompanyName"],
    "aum":         ["fundTnav"],
    "nav":         ["closePrice"],
}

def _get(f, field, default=None):
    for alias in FIELD_MAP.get(field, [field]):
        v = f.get(alias)
        if v is not None and v != "":
            try: return float(v)
            except: return v
    return default

def _get_str(f, field, default=""):
    for alias in FIELD_MAP.get(field, [field]):
        v = f.get(alias)
        if v: return str(v)
    return default

def score_fund(f, mx1, mx3, mx5):
    star   = (_get(f,"starRating") or 0) / 5.0
    r1     = max(_get(f,"return_1y") or 0, 0) / max(mx1, 1)
    r3     = max(_get(f,"return_3y") or 0, 0) / max(mx3, 1)
    r5     = max(_get(f,"return_5y") or 0, 0) / max(mx5, 1)
    exp    = _get(f,"expenseRatio")
    exp_sc = max(0, 1 - (exp/2.5)) if exp else 0.5
    risk   = _get(f,"riskRating") or 3
    if isinstance(risk, str):
        risk = {"Low":1,"Below Average":2,"Average":3,"Above Average":4,"High":5}.get(risk, 3)
    risk_sc = 1 - (float(risk) - 1) / 4.0
    return round(0.30*star*100 + 0.25*r3*100 + 0.15*r1*100 +
                 0.15*r5*100   + 0.10*exp_sc*100 + 0.05*risk_sc*100, 2)

def make_fund_row(f, mx1, mx3, mx5):
    aum = _get(f,"aum")
    return {
        "secId":          f.get("secId",""),
        "name":           _get_str(f,"name"),
        "legalName":      f.get("legalName",""),
        "category":       _get_str(f,"category"),
        "amc":            _get_str(f,"amc"),
        "stars":          int(_get(f,"starRating") or 0),
        "score":          score_fund(f, mx1, mx3, mx5),
        "ret1m":          _get(f,"returnM1"),
        "ret6m":          _get(f,"returnM6"),
        "ret1y":          _get(f,"returnM12"),
        "ret3y":          _get(f,"returnM36"),
        "ret5y":          _get(f,"returnM60"),
        "ret10y":         _get(f,"returnM120"),
        "expense":        _get(f,"expenseRatio"),
        "risk":           _get(f,"riskRating"),
        "sharpe":         _get(f,"sharpeM36"),
        "alpha":          _get(f,"alphaM36"),
        "beta":           _get(f,"betaM36"),
        "aum":            round(aum/1e7, 2) if aum else None,
        "nav":            _get(f,"nav"),
        "navDate":        f.get("closePriceDate",""),
        "styleBox":       f.get("equityStyleBox"),
        "medalist":       f.get("Medalist_RatingNumber"),
        "managerTenure":  f.get("managerTenure"),
        "initialPurchase":f.get("initialPurchase"),
        "purchaseMode":   f.get("purchasemode"),
    }

def _safe_float(v):
    try: return float(v) if v not in (None, "") else None
    except: return None


# ── /api/meta ──────────────────────────────────────────────────────────────────
@app.route("/api/meta")
def api_meta():
    with _funds_lock:
        funds = list(_funds)
    cats  = sorted({_get_str(f,"category") for f in funds if _get_str(f,"category")})
    amcs  = sorted({_get_str(f,"amc") for f in funds if _get_str(f,"amc")})
    stars = {str(i): sum(1 for f in funds if _get(f,"starRating")==i) for i in range(1,6)}
    return jsonify({
        "total": len(funds), "categories": cats, "amcs": amcs, "starCounts": stars,
        "lastUpdated": DATA_FILE.stat().st_mtime if DATA_FILE.exists() else None,
    })


# ── /api/funds ─────────────────────────────────────────────────────────────────
# ── Fund type → category keyword mapping ───────────────────────────────────────
FUND_TYPE_KEYWORDS = {
    "equity": [
        "large-cap","mid-cap","small-cap","large & mid","multi-cap","flexi cap",
        "focused fund","contra","value","dividend yield","elss","equity savings",
        "sector -","equity -","equity long-short","equity ex-top",
    ],
    "index":  ["index funds"],
    "hybrid": [
        "aggressive allocation","balanced allocation","conservative allocation",
        "dynamic asset allocation","multi asset allocation","hybrid long-short",
        "arbitrage","fund of funds","children","retirement",
    ],
    "debt": [
        "corporate bond","banking & psu","credit risk","dynamic bond",
        "government bond","10 yr government","short duration","medium duration",
        "medium to long duration","long duration","ultra short duration",
        "low duration","floating rate","fixed maturity","other bond",
    ],
    "liquid": ["liquid","money market","overnight"],
    "global": ["global -","alternative other"],
}

def _cat_matches_type(cat: str, fund_type: str) -> bool:
    cat_l = cat.lower()
    for kw in FUND_TYPE_KEYWORDS.get(fund_type, []):
        if kw in cat_l:
            return True
    return False


@app.route("/api/fund-type-counts")
def api_fund_type_counts():
    with _funds_lock:
        funds = list(_funds)
    counts = {"all": len(funds)}
    for ft in FUND_TYPE_KEYWORDS:
        counts[ft] = sum(1 for f in funds if _cat_matches_type(_get_str(f,"category"), ft))
    return jsonify(counts)


@app.route("/api/funds")
def api_funds():
    q         = request.args.get("q","").lower()
    category  = request.args.get("category","")
    fund_type = request.args.get("fund_type","")
    amc       = request.args.get("amc","")
    stars_raw = request.args.get("stars","")
    min_r1    = _safe_float(request.args.get("min_ret1y"))
    min_r3    = _safe_float(request.args.get("min_ret3y"))
    min_r5    = _safe_float(request.args.get("min_ret5y"))
    max_exp   = _safe_float(request.args.get("max_exp"))
    min_aum   = _safe_float(request.args.get("min_aum"))
    sort_by   = request.args.get("sort","score")
    sort_dir  = request.args.get("dir","desc")
    page      = max(1, int(request.args.get("page","1")))
    page_size = min(200, int(request.args.get("page_size","50")))
    stars_f   = {int(x) for x in stars_raw.split(",") if x.strip().isdigit()} if stars_raw else set()

    with _funds_lock:
        funds = list(_funds)

    r1s=[_get(f,"return_1y") for f in funds]; r1s=[x for x in r1s if x]; mx1=max(r1s,default=1)
    r3s=[_get(f,"return_3y") for f in funds]; r3s=[x for x in r3s if x]; mx3=max(r3s,default=1)
    r5s=[_get(f,"return_5y") for f in funds]; r5s=[x for x in r5s if x]; mx5=max(r5s,default=1)

    result = []
    for f in funds:
        name_s = _get_str(f,"name").lower()
        amc_s  = _get_str(f,"amc").lower()
        cat_s  = _get_str(f,"category")
        if q and q not in name_s and q not in amc_s and q not in cat_s.lower() and q.upper() not in f.get("secId","").upper(): continue
        if fund_type and not _cat_matches_type(cat_s, fund_type): continue
        if category and category.lower() not in cat_s.lower(): continue
        if amc and amc.lower() not in amc_s: continue
        star = int(_get(f,"starRating") or 0)
        if stars_f and star not in stars_f: continue
        r1=_get(f,"return_1y"); r3=_get(f,"return_3y"); r5=_get(f,"return_5y")
        if min_r1 is not None and (r1 is None or r1 < min_r1): continue
        if min_r3 is not None and (r3 is None or r3 < min_r3): continue
        if min_r5 is not None and (r5 is None or r5 < min_r5): continue
        exp = _get(f,"expenseRatio")
        if max_exp is not None and exp is not None and exp > max_exp: continue
        aum = _get(f,"aum"); aum_cr = aum/1e7 if aum else None
        if min_aum is not None and (aum_cr is None or aum_cr < min_aum): continue
        result.append(make_fund_row(f, mx1, mx3, mx5))

    sort_key = {
        "score":   lambda x: x["score"],
        "name":    lambda x: x["name"].lower(),
        "stars":   lambda x: x["stars"],
        "ret1y":   lambda x: x["ret1y"] or -999,
        "ret3y":   lambda x: x["ret3y"] or -999,
        "ret5y":   lambda x: x["ret5y"] or -999,
        "expense": lambda x: x["expense"] or 99,
        "aum":     lambda x: x["aum"] or 0,
        "sharpe":  lambda x: x["sharpe"] or -999,
    }.get(sort_by, lambda x: x["score"])
    result.sort(key=sort_key, reverse=(sort_dir=="desc"))

    total = len(result)
    start = (page-1)*page_size
    return jsonify({
        "total": total, "page": page, "pageSize": page_size,
        "pages": max(1,(total+page_size-1)//page_size),
        "funds": result[start:start+page_size],
    })


# ── /api/holdings/<secId> ──────────────────────────────────────────────────────
@app.route("/api/holdings/<sec_id>")
def api_holdings(sec_id):
    cache = load_hold_cache()
    cached = cache.get(sec_id,{})
    if cached and time.time() - cached.get("_ts",0) < HOLD_TTL:
        return jsonify(cached)

    data = fetch_all_holding_data(sec_id)

    # Merge with fund metadata from screener
    with _funds_lock:
        fund_meta = next((f for f in _funds if f.get("secId")==sec_id), {})
    if fund_meta:
        data["name"]     = fund_meta.get("name") or fund_meta.get("legalName","")
        data["legalName"]= fund_meta.get("legalName","")
        data["category"] = fund_meta.get("categoryName","")
        data["amc"]      = fund_meta.get("BrandingCompanyName","")

    # msUrl is served by /api/ms-url endpoint; don't bake into file cache

    cache[sec_id] = data
    save_hold_cache(cache)
    return jsonify(data)


# ── /api/ms-url/<sec_id> ───────────────────────────────────────────────────────
@app.route("/api/ms-url/<sec_id>")
def api_ms_url(sec_id):
    """Return a verified Morningstar India URL for the given secId."""
    if sec_id in _ms_url_cache:
        return jsonify({"url": _ms_url_cache[sec_id]})
    with _funds_lock:
        fund = next((f for f in _funds if f.get("secId") == sec_id), {})
    legal = fund.get("legalName") or fund.get("name","")
    url = _resolve_ms_url(sec_id, legal)
    return jsonify({"url": url})


# ── analytics cache helpers ────────────────────────────────────────────────────
ANL_CACHE_LOCK = threading.Lock()
ANL_TTL = 7 * 24 * 3600   # re-fetch fund holdings after 7 days

# ── security autocomplete index (lazy, file-mtime invalidated) ──────────────────
_sec_index: dict = {}
_sec_index_ts: float = 0

def _build_sec_index() -> dict:
    cache = {}
    cache.update(load_anl_cache())
    cache.update(load_hold_cache())
    eq_map: dict[str, int] = {}
    bd_map: dict[str, int] = {}
    for data in cache.values():
        seen_eq, seen_bd = set(), set()
        for h in (data.get("equityHoldings") or []):
            nm = (h.get("securityName") or "").strip()
            if nm and nm not in seen_eq:
                eq_map[nm] = eq_map.get(nm, 0) + 1
                seen_eq.add(nm)
        for h in (data.get("bondHoldings") or []):
            nm = (h.get("securityName") or "").strip()
            if nm and nm not in seen_bd:
                bd_map[nm] = bd_map.get(nm, 0) + 1
                seen_bd.add(nm)
    return {"equity": eq_map, "bond": bd_map}

def get_sec_index() -> dict:
    global _sec_index, _sec_index_ts
    anl_mt  = ANL_CACHE.stat().st_mtime  if ANL_CACHE.exists()  else 0
    hold_mt = HOLD_CACHE.stat().st_mtime if HOLD_CACHE.exists() else 0
    latest  = max(anl_mt, hold_mt)
    if not _sec_index or latest > _sec_index_ts:
        _sec_index = _build_sec_index()
        _sec_index_ts = latest
    return _sec_index

def load_anl_cache() -> dict:
    with ANL_CACHE_LOCK:
        if not ANL_CACHE.exists():
            return {}
        try:
            with open(ANL_CACHE) as f:
                return json.load(f)
        except Exception:
            return {}

def save_anl_cache(data: dict):
    # Atomic write: dump to temp file then rename to avoid partial reads
    tmp = ANL_CACHE.with_suffix(".tmp")
    with ANL_CACHE_LOCK:
        with open(tmp, "w") as f:
            json.dump(data, f)
        tmp.replace(ANL_CACHE)

# ── bulk-fetch state ───────────────────────────────────────────────────────────
_bulk = {"running": False, "done": 0, "total": 0, "errors": 0, "stop": False, "savedAt": 0, "stopped": False}

def _start_bulk_run():
    """Spawn the background bulk-fetch thread (no-op if already running)."""
    if _bulk["running"]: return
    _bulk["stop"] = False

    def run():
        with _funds_lock:
            funds = list(_funds)
        anl  = load_anl_cache()
        # Start progress from already-cached funds so it doesn't appear to reset
        already_done = sum(
            1 for f in funds
            if anl.get(f.get("secId","")) and
               time.time() - anl[f.get("secId","")].get("_ts", 0) < ANL_TTL
        )
        _bulk.update({"running": True, "done": already_done, "errors": 0, "stopped": False})
        _bulk["total"] = len(funds)
        hdrs = get_sal_headers()

        _CACHED = object()  # sentinel: fund was already in cache, don't re-count

        def fetch_one(fund):
            if _bulk["stop"]: return None
            sec_id = fund.get("secId","")
            if not sec_id: return None
            cached = anl.get(sec_id,{})
            if cached and time.time() - cached.get("_ts",0) < ANL_TTL:
                return _CACHED   # fresh in cache — already counted in already_done
            try:
                raw = _sal_get(
                    f"portfolio/holding/v2/{sec_id}/data",
                    {"premiumNum":"500","freeNum":"50","hideesg":"false","secId":sec_id},
                    hdrs
                )
                if not raw: return None
                def _ph(page_key):
                    return [_clean_holding(x)
                            for x in raw.get(page_key,{}).get("holdingList",[]) if x]
                return {
                    "secId":   sec_id, "_ts": time.time(),
                    "name":    fund.get("name") or fund.get("legalName",""),
                    "category":fund.get("categoryName",""),
                    "equityHoldings": _ph("equityHoldingPage"),
                    "bondHoldings":   _ph("boldHoldingPage"),
                }
            except Exception as e:
                print(f"[bulk] {sec_id}: {e}")
            return None

        WORKERS    = 30    # parallel HTTP workers
        SAVE_EVERY = 100   # flush to disk after every N new results

        # ── background save thread ─────────────────────────────────────────
        # Decouples disk I/O from the result-collection loop so workers
        # never stall waiting for a 100MB JSON write to finish.
        save_q    = queue.Queue()
        save_stop = threading.Event()

        def _save_worker():
            batch = {}
            while not save_stop.is_set() or not save_q.empty():
                try:
                    item = save_q.get(timeout=0.3)
                    batch[item["secId"]] = item
                    save_q.task_done()
                except queue.Empty:
                    pass
                if len(batch) >= SAVE_EVERY:
                    anl.update(batch)
                    batch.clear()
                    save_anl_cache(anl)
                    _bulk["savedAt"] = _bulk["done"]
            if batch:
                anl.update(batch)
                save_anl_cache(anl)
                _bulk["savedAt"] = _bulk["done"]

        save_thread = threading.Thread(target=_save_worker, daemon=True)
        save_thread.start()

        # ── fetch loop ─────────────────────────────────────────────────────
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futures = {ex.submit(fetch_one, f): f for f in funds}
            for fut in as_completed(futures):
                if _bulk["stop"]:
                    for f in futures:
                        f.cancel()
                    break
                try:
                    r = fut.result()
                    if r is _CACHED:
                        pass  # already counted in already_done — don't increment
                    else:
                        _bulk["done"] += 1
                        if r:
                            save_q.put(r)   # hand off to save thread immediately
                except Exception:
                    _bulk["done"] += 1
                    _bulk["errors"] += 1

        # Signal save thread to flush and exit, then wait for it
        save_stop.set()
        save_thread.join()
        save_anl_cache(anl)   # final guaranteed flush
        _bulk.update({"running": False, "savedAt": _bulk["done"]})

    threading.Thread(target=run, daemon=True).start()


@app.route("/api/analytics/bulk-fetch", methods=["POST"])
def api_bulk_fetch_start():
    _start_bulk_run()
    return jsonify({"status": "already_running" if not _bulk.get("stop") and _bulk["running"] else "started"})


@app.route("/api/analytics/bulk-stop", methods=["POST"])
def api_bulk_fetch_stop():
    _bulk["stop"] = True
    _bulk["running"] = False
    _bulk["stopped"] = True
    return jsonify({"status": "stopping"})


@app.route("/api/analytics/bulk-restart", methods=["POST"])
def api_bulk_fetch_restart():
    """Clear the analytics cache and start a fresh bulk fetch."""
    if _bulk["running"]:
        return jsonify({"status": "already_running"}), 409
    # Wipe analytics cache so everything is re-fetched
    if ANL_CACHE.exists():
        with ANL_CACHE_LOCK:
            ANL_CACHE.unlink(missing_ok=True)
    _bulk["stopped"] = False
    _start_bulk_run()
    return jsonify({"status": "restarted"})


# ── /api/analytics/securities — autocomplete ───────────────────────────────────
@app.route("/api/analytics/securities")
def api_analytics_securities():
    q   = (request.args.get("q") or "").strip().lower()
    typ = request.args.get("type", "equity")
    if typ not in ("equity", "bond"):
        return jsonify([])
    if len(q) < 2:
        return jsonify([])
    idx      = get_sec_index()
    name_map = idx.get(typ, {})   # {securityName: fundCount}
    matches  = [nm for nm in name_map if q in nm.lower()]
    matches.sort(key=lambda nm: (0 if nm.lower().startswith(q) else 1, -name_map[nm], nm.lower()))
    return jsonify([{"name": nm, "fundCount": name_map[nm]} for nm in matches[:20]])


# ── /api/analytics/find-funds — custom fund finder ─────────────────────────────
@app.route("/api/analytics/find-funds", methods=["POST"])
def api_analytics_find_funds():
    try:
        body     = request.get_json(force=True) or {}
        eq_names = [s.strip() for s in (body.get("equities") or []) if s.strip()]
        bd_names = [s.strip() for s in (body.get("bonds")    or []) if s.strip()]
        if not eq_names and not bd_names:
            return jsonify({"error": "Provide at least one equity or bond"}), 400

        total_requested = len(eq_names) + len(bd_names)
        eq_set = set(eq_names)
        bd_set = set(bd_names)

        cache = {}
        cache.update(load_anl_cache())
        cache.update(load_hold_cache())

        with _funds_lock:
            funds_snap = list(_funds)
        r1s = [x for x in (_get(f,"return_1y") for f in funds_snap) if x]; mx1 = max(r1s, default=1)
        r3s = [x for x in (_get(f,"return_3y") for f in funds_snap) if x]; mx3 = max(r3s, default=1)
        r5s = [x for x in (_get(f,"return_5y") for f in funds_snap) if x]; mx5 = max(r5s, default=1)
        meta = {
            f.get("secId",""): {
                "stars":    int(_get(f,"starRating") or 0),
                "score":    round(score_fund(f, mx1, mx3, mx5), 1),
                "category": _get_str(f,"category"),
                "amc":      _get_str(f,"amc"),
                "name":     _get_str(f,"name"),
            }
            for f in funds_snap if f.get("secId")
        }

        results = []
        for sec_id, data in cache.items():
            if not data.get("_ts"):
                continue
            matched_eq, matched_bd = [], []
            seen_eq, seen_bd = set(), set()
            for h in (data.get("equityHoldings") or []):
                nm = (h.get("securityName") or "").strip()
                if nm in eq_set and nm not in seen_eq:
                    matched_eq.append({"name": nm, "weight": round(h.get("weighting") or 0, 4)})
                    seen_eq.add(nm)
            for h in (data.get("bondHoldings") or []):
                nm = (h.get("securityName") or "").strip()
                if nm in bd_set and nm not in seen_bd:
                    matched_bd.append({"name": nm, "weight": round(h.get("weighting") or 0, 4)})
                    seen_bd.add(nm)
            matched_count = len(matched_eq) + len(matched_bd)
            if matched_count == 0:
                continue

            coverage    = matched_count / total_requested
            m           = meta.get(sec_id, {})
            stars       = m.get("stars", 0)
            fund_score  = m.get("score") or 0
            finder_score = round(coverage * 0.5 + (stars / 5) * 0.3 + (fund_score / 100) * 0.2, 4)
            total_wt    = round(sum(h["weight"] for h in matched_eq + matched_bd), 2)

            results.append({
                "secId":              sec_id,
                "name":               m.get("name") or data.get("name", sec_id),
                "category":           m.get("category") or data.get("category",""),
                "amc":                m.get("amc",""),
                "stars":              stars,
                "score":              fund_score,
                "finderScore":        finder_score,
                "matchedCount":       matched_count,
                "totalRequested":     total_requested,
                "coveragePct":        round(coverage * 100, 1),
                "totalMatchedWeight": total_wt,
                "matchedEquities":    matched_eq,
                "matchedBonds":       matched_bd,
            })

        results.sort(key=lambda x: x["finderScore"], reverse=True)
        return jsonify({
            "totalMatched":  len(results),
            "equitiesFound": len(eq_names),
            "bondsFound":    len(bd_names),
            "funds":         results[:50],
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/analytics/bulk-status")
def api_bulk_status():
    anl = load_anl_cache()
    hold = load_hold_cache()
    cached_total = len(set(list(anl.keys()) + list(hold.keys())))
    return jsonify({**dict(_bulk), "cachedFunds": cached_total})


# ── /api/analytics — with mtime-based result cache ─────────────────────────────
_anl_result_cache = None
_anl_result_mtime: float = 0.0

def _compute_analytics() -> dict:
    """Aggregate holdings across all cached funds. Returns serialisable dict."""
    cache = {}
    cache.update(load_anl_cache())
    cache.update(load_hold_cache())
    if not cache:
        return {"fundsAnalyzed":0,"equities":[],"bonds":[],"sectors":[],"totalEquities":0,"totalBonds":0}

    eq_map  = {}
    bd_map  = {}
    sec_map = {}
    fund_analyzed = 0   # all cached funds, not just those with equity holdings

    for sec_id, data in cache.items():
        if not data.get("_ts"): continue
        fund_analyzed += 1
        fname = data.get("name", sec_id)

        for h in (data.get("equityHoldings") or []):
            nm = h.get("securityName",""); wt = h.get("weighting") or 0
            if not nm: continue
            if nm not in eq_map:
                eq_map[nm] = {"funds":[], "totalWeight":0.0,
                              "ticker":h.get("ticker",""), "sector":h.get("sector",""),
                              "moat":h.get("economicMoat",""), "esg":h.get("susEsgRiskScore")}
            eq_map[nm]["funds"].append({"name":fname,"secId":sec_id,"weight":round(wt,2)})
            eq_map[nm]["totalWeight"] += wt
            sec = h.get("sector","Other") or "Other"
            if sec not in sec_map: sec_map[sec] = {"fundCount":0,"totalWeight":0.0}
            sec_map[sec]["fundCount"] += 1; sec_map[sec]["totalWeight"] += wt

        for h in (data.get("bondHoldings") or []):
            nm = h.get("securityName",""); wt = h.get("weighting") or 0
            if not nm: continue
            if nm not in bd_map:
                bd_map[nm] = {"funds":[], "totalWeight":0.0,
                              "ticker":h.get("ticker",""), "coupon":h.get("coupon"),
                              "creditRating":h.get("creditRating","")}
            bd_map[nm]["funds"].append({"name":fname,"secId":sec_id,"weight":round(wt,2)})
            bd_map[nm]["totalWeight"] += wt

    def _fmt_eq(nm, d):
        fc = len(d["funds"])
        return {"name":nm,"ticker":d["ticker"],"sector":d["sector"],
                "moat":d["moat"],"esg":d["esg"],"fundCount":fc,
                "totalWeight":round(d["totalWeight"],2),
                "avgWeight":round(d["totalWeight"]/fc,2) if fc else 0,
                "topFunds":sorted(d["funds"],key=lambda x:x["weight"],reverse=True)[:5]}

    def _fmt_bd(nm, d):
        fc = len(d["funds"])
        return {"name":nm,"ticker":d["ticker"],"coupon":d["coupon"],
                "creditRating":d["creditRating"],"fundCount":fc,
                "totalWeight":round(d["totalWeight"],2),
                "avgWeight":round(d["totalWeight"]/fc,2) if fc else 0,
                "topFunds":sorted(d["funds"],key=lambda x:x["weight"],reverse=True)[:5]}

    equities = sorted([_fmt_eq(nm,d) for nm,d in eq_map.items()],
                      key=lambda x:x["fundCount"], reverse=True)
    bonds    = sorted([_fmt_bd(nm,d) for nm,d in bd_map.items()],
                      key=lambda x:x["fundCount"], reverse=True)
    sectors  = sorted([{"name":s,"fundCount":v["fundCount"],
                        "totalWeight":round(v["totalWeight"],2),
                        "avgWeight":round(v["totalWeight"]/max(v["fundCount"],1),2)}
                       for s,v in sec_map.items()],
                      key=lambda x:x["fundCount"], reverse=True)

    return {"fundsAnalyzed":fund_analyzed,"totalEquities":len(equities),
            "totalBonds":len(bonds),"equities":equities,"bonds":bonds,"sectors":sectors}


@app.route("/api/analytics")
def api_analytics():
    global _anl_result_cache, _anl_result_mtime
    anl_mt  = ANL_CACHE.stat().st_mtime  if ANL_CACHE.exists()  else 0.0
    hold_mt = HOLD_CACHE.stat().st_mtime if HOLD_CACHE.exists() else 0.0
    latest  = max(anl_mt, hold_mt)
    if _anl_result_cache is None or latest > _anl_result_mtime:
        _anl_result_cache = _compute_analytics()
        _anl_result_mtime = latest
    return jsonify(_anl_result_cache)


# ── /api/analytics/entity ──────────────────────────────────────────────────────
@app.route("/api/analytics/entity")
def api_analytics_entity():
    """All mutual funds holding a specific equity/bond, with rating & first-bought."""
    try:
        name = request.args.get("name", "")
        typ  = request.args.get("type", "equity")
        if not name:
            return jsonify({"error": "name required"}), 400

        cache = {}
        cache.update(load_anl_cache())
        cache.update(load_hold_cache())

        # Snapshot _funds without holding the lock during heavy computation
        with _funds_lock:
            funds_snapshot = list(_funds)

        rets = [x for x in (_get(f, "return_1y") for f in funds_snapshot) if x]
        mx1  = max(rets, default=1)
        rets = [x for x in (_get(f, "return_3y") for f in funds_snapshot) if x]
        mx3  = max(rets, default=1)
        rets = [x for x in (_get(f, "return_5y") for f in funds_snapshot) if x]
        mx5  = max(rets, default=1)

        meta = {
            f.get("secId", ""): {
                "stars":    int(_get(f, "starRating") or 0),
                "score":    round(score_fund(f, mx1, mx3, mx5), 1),
                "category": _get_str(f, "category"),
                "amc":      _get_str(f, "amc"),
            }
            for f in funds_snapshot if f.get("secId")
        }

        key = "equityHoldings" if typ == "equity" else "bondHoldings"
        results = []
        for sec_id, data in cache.items():
            for h in (data.get(key) or []):
                if h.get("securityName", "") == name:
                    m = meta.get(sec_id, {})
                    results.append({
                        "secId":           sec_id,
                        "fundName":        data.get("name", sec_id),
                        "category":        m.get("category") or data.get("category", ""),
                        "amc":             m.get("amc", ""),
                        "stars":           m.get("stars", 0),
                        "score":           m.get("score"),
                        "weight":          h.get("weighting"),
                        "firstBoughtDate": h.get("firstBoughtDate"),
                        "marketValue":     h.get("marketValue"),
                        "numberOfShare":   h.get("numberOfShare"),
                        "shareChange":     h.get("shareChange"),
                        "totalReturn1Year": h.get("totalReturn1Year"),
                    })

        results.sort(key=lambda x: x.get("firstBoughtDate") or "9999")
        return jsonify({"name": name, "type": typ, "totalFunds": len(results), "funds": results})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── /api/refresh ───────────────────────────────────────────────────────────────
_refresh = {"running":False,"last":None,"error":None}

@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    if _refresh["running"]: return jsonify({"status":"already_running"})
    def run():
        _refresh.update({"running":True,"error":None})
        try:
            r = subprocess.run([sys.executable, str(BASE/"api_fetcher.py")],
                               capture_output=True, text=True, timeout=360)
            if r.returncode==0: load_funds(); _refresh["last"]=time.time()
            else: _refresh["error"] = r.stderr[-400:] if r.stderr else "Unknown"
        except Exception as e: _refresh["error"] = str(e)
        finally: _refresh["running"] = False
    threading.Thread(target=run, daemon=True).start()
    return jsonify({"status":"started"})

@app.route("/api/refresh/status")
def api_refresh_status():
    return jsonify(_refresh)


# ── static ─────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(str(BASE), "mf_ui.html")


def _auto_start_bulk():
    """Auto-start bulk holdings fetch if cache is incomplete."""
    try:
        anl_count  = len(load_anl_cache())
        hold_count = len(load_hold_cache())
        cached = anl_count + hold_count
        with _funds_lock:
            total = len(_funds)
        if cached < total:
            print(f"[bulk] Cache has {cached}/{total} funds — auto-starting bulk fetch")
            _start_bulk_run()
        else:
            print(f"[bulk] Cache complete ({cached} funds) — skipping auto-fetch")
    except Exception as e:
        print(f"[bulk] Auto-start check failed: {e}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=5001)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args()
    print(f"\n  MF Analyzer →  http://{args.host}:{args.port}\n")
    # Start bulk fetch in background after a short delay (let headers load first)
    threading.Timer(5.0, _auto_start_bulk).start()
    app.run(host=args.host, port=args.port, debug=False, threaded=True)
