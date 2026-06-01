"""
Morningstar India — Direct API Fetcher  (no browser needed after first run)
============================================================================
Fetches the JWT token from the screener page once, then hits the real
Morningstar APAC API directly with pagination to pull ALL Indian mutual funds.

Typical run time: ~10–30 seconds for 1500+ funds.

Usage:
    python api_fetcher.py               # fetch all funds → mf_data.json + mf_data.csv
    python api_fetcher.py --page-size 50 # smaller batches
    python api_fetcher.py --token <jwt> # skip page-load, use cached token
"""

import argparse
import json
import time
import sys
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs, urlunparse

try:
    import requests
except ImportError:
    print("requests not installed: pip install requests")
    sys.exit(1)

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

SCREENER_PAGE = "https://www.morningstar.in/tools/ECFundscreener.aspx"

# The real Morningstar APAC API endpoint discovered via network inspection
API_BASE = "https://www.apac-api.morningstar.com/ecint/v1/screener"

# Universe: FOIND$$ALL = Open-End India funds, FCIND$$ALL = Closed-End India
UNIVERSE = "FOIND$$ALL|FCIND$$ALL"

# All useful data points available from the API
DATA_POINTS = ",".join([
    "secId", "name", "legalName",
    "closePrice", "closePriceDate",
    "yield_M12",
    "ongoingCharge",
    "purchasemode",
    "categoryName",
    "Medalist_RatingNumber",      # Morningstar Analyst/Medalist Rating (1–5, 6=NR)
    "starRatingM255",             # Morningstar Star Rating (1–5)
    "returnD1", "returnW1",
    "returnM1", "returnM3", "returnM6", "returnM0",
    "returnM12",                  # 1-year return
    "returnM36",                  # 3-year return
    "returnM60",                  # 5-year return
    "returnM120",                 # 10-year return
    "maxFrontEndLoad",
    "maxDeferredLoad",
    "expenseRatio",
    "initialPurchase",
    "fundTnav",                   # AUM in INR
    "equityStyleBox",             # 1–9 style box
    "bondStyleBox",
    "averageMarketCapital",
    "averageCreditQualityCode",
    "effectiveDuration",
    "morningstarRiskM255",        # Morningstar risk (1=Low, 5=High)
    "alphaM36", "betaM36", "r2M36",
    "standardDeviationM36",
    "sharpeM36",                  # Sharpe ratio (3Y)
    "trackRecordExtension",
    "managerTenure",
    "BrandingCompanyName",        # AMC name
])

OUTPUT_JSON = Path(__file__).parent / "mf_data.json"
OUTPUT_CSV  = Path(__file__).parent / "mf_data.csv"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.morningstar.in/",
    "Origin":  "https://www.morningstar.in",
}


def get_jwt_token() -> str:
    """Load the screener page and extract the embedded JWT token."""
    print(f"[1] Fetching screener page for JWT token …")
    resp = requests.get(SCREENER_PAGE, headers=HEADERS, timeout=30)
    resp.raise_for_status()

    # Try BeautifulSoup first
    if BeautifulSoup:
        soup = BeautifulSoup(resp.text, "html.parser")
        el = soup.find("input", {"id": "hfApiToken"})
        if el and el.get("value"):
            token = el["value"]
            print(f"[2] JWT extracted ({len(token)} chars)")
            return token

    # Fallback: regex
    import re
    m = re.search(r'id="hfApiToken"[^>]+value="([^"]+)"', resp.text)
    if m:
        token = m.group(1)
        print(f"[2] JWT extracted via regex ({len(token)} chars)")
        return token

    raise RuntimeError("Could not extract JWT token from page. The site may have changed.")


def fetch_page(token: str, page: int, page_size: int) -> dict:
    """Fetch a single page of fund results from the Morningstar API."""
    params = {
        "languageId":         "en-IN",
        "currencyId":         "INR",
        "universeIds":        UNIVERSE,
        "outputType":         "json",
        "version":            "1",
        "page":               str(page),
        "pageSize":           str(page_size),
        "sortOrder":          "name asc",
        "securityDataPoints": DATA_POINTS,
        "term":               "",
    }
    hdrs = {**HEADERS, "Authorization": f"Bearer {token}"}
    resp = requests.get(API_BASE, params=params, headers=hdrs, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_all(token: str, page_size: int = 100) -> list[dict]:
    """Paginate through all results and return every fund."""
    print(f"[3] Fetching fund data (page_size={page_size}) …")

    # First call: get total count
    first = fetch_page(token, page=1, page_size=page_size)
    total = first.get("total", 0)
    rows  = first.get("rows", [])
    print(f"    Total funds available: {total}")
    print(f"    Page 1: {len(rows)} funds")

    if not total:
        print("[!] API returned 0 funds. Token may be expired.")
        return rows

    total_pages = (total + page_size - 1) // page_size
    for page in range(2, total_pages + 1):
        time.sleep(0.3)  # polite delay
        data  = fetch_page(token, page=page, page_size=page_size)
        chunk = data.get("rows", [])
        rows.extend(chunk)
        print(f"    Page {page}/{total_pages}: {len(chunk)} funds  (total so far: {len(rows)})")

    return rows


def save(funds: list[dict]):
    OUTPUT_JSON.write_text(json.dumps(funds, indent=2, ensure_ascii=False))
    print(f"\n[OK] {len(funds)} funds saved → {OUTPUT_JSON}")

    if HAS_PANDAS:
        df = pd.DataFrame(funds)
        df.to_csv(OUTPUT_CSV, index=False)
        print(f"     CSV saved → {OUTPUT_CSV}")
        return df
    else:
        import csv
        if funds:
            with open(OUTPUT_CSV, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=funds[0].keys())
                w.writeheader()
                w.writerows(funds)
            print(f"     CSV saved → {OUTPUT_CSV}")
    return None


def main():
    parser = argparse.ArgumentParser(description="Morningstar India API Fetcher")
    parser.add_argument("--token",     default=None, help="JWT Bearer token (skip page load)")
    parser.add_argument("--page-size", type=int, default=100, help="Results per API page (default 100)")
    args = parser.parse_args()

    token = args.token or get_jwt_token()
    funds = fetch_all(token, page_size=args.page_size)

    if not funds:
        print("[!] No funds fetched.")
        sys.exit(1)

    df = save(funds)

    # Quick summary
    if df is not None:
        print("\n── Quick Stats ───────────────────────────────────")
        if "categoryName" in df.columns:
            print(f"  Categories : {df['categoryName'].nunique()}")
        if "starRatingM255" in df.columns:
            rated = df[df["starRatingM255"].notna()]
            print(f"  Rated funds: {len(rated)}  (5★: {(rated['starRatingM255']==5).sum()}  "
                  f"4★: {(rated['starRatingM255']==4).sum()}  "
                  f"3★: {(rated['starRatingM255']==3).sum()})")
        if "BrandingCompanyName" in df.columns:
            print(f"  AMCs       : {df['BrandingCompanyName'].nunique()}")
        print("──────────────────────────────────────────────────")
        print("  Run analyzer next:  python analyzer.py")


if __name__ == "__main__":
    main()
