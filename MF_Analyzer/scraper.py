"""
Morningstar India Mutual Fund Scraper
======================================
Uses Playwright to:
  1. Load the fund screener page
  2. Intercept all API/XHR calls made by the Web Component
  3. Extract JWT token + real API endpoint
  4. Dump all funds with full details to JSON + CSV

Usage:
    python scraper.py                  # scrape all funds, save to mf_data.csv
    python scraper.py --headless false # run with visible browser (debug)
    python scraper.py --limit 500      # limit to first N funds
"""

import asyncio
import json
import re
import argparse
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

try:
    from playwright.async_api import async_playwright, Route, Request
except ImportError:
    print("Playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)

try:
    import pandas as pd
except ImportError:
    pd = None

TARGET_URL = "https://www.morningstar.in/tools/ECFundscreener.aspx"
OUTPUT_JSON = Path(__file__).parent / "mf_data.json"
OUTPUT_CSV  = Path(__file__).parent / "mf_data.csv"

# ── helpers ──────────────────────────────────────────────────────────────────

def _flatten(fund: dict, prefix="") -> dict:
    """Recursively flatten nested dict for CSV export."""
    out = {}
    for k, v in fund.items():
        key = f"{prefix}{k}" if prefix else k
        if isinstance(v, dict):
            out.update(_flatten(v, key + "_"))
        elif isinstance(v, list):
            out[key] = json.dumps(v)
        else:
            out[key] = v
    return out


# ── main scraper ──────────────────────────────────────────────────────────────

async def scrape(headless: bool = True, limit: int = 0):
    captured_requests: list[dict] = []
    jwt_token: list[str] = []          # mutable container so closure can write
    screener_api_base: list[str] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)
        context = await browser.new_context(
            viewport={"width": 1400, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = await context.new_page()

        # ── intercept all requests to find the real screener API ──────────────
        async def on_request(request: Request):
            url = request.url
            # skip noise
            if any(x in url for x in ["google", "newrelic", "nr-data", "analytics", ".css", ".png", ".woff"]):
                return
            if any(x in url for x in ["screener", "fundscreener", "fund-screener", "api", "handler", "ashx"]):
                captured_requests.append({
                    "method": request.method,
                    "url": url,
                    "headers": dict(request.headers),
                    "post_data": request.post_data,
                })

        page.on("request", on_request)

        # ── also intercept responses to capture fund JSON payload ─────────────
        all_funds: list[dict] = []

        async def on_response(response):
            url = response.url
            if any(x in url for x in ["screener", "fundlist", "fund-list", "search", "api"]):
                try:
                    content_type = response.headers.get("content-type", "")
                    if "json" in content_type:
                        body = await response.json()
                        # Morningstar often wraps in rows/total/filters
                        rows = (
                            body.get("rows")
                            or body.get("data")
                            or body.get("funds")
                            or body.get("results")
                            or (body if isinstance(body, list) else None)
                        )
                        if rows:
                            print(f"  [+] Captured {len(rows)} funds from {url[:80]}")
                            all_funds.extend(rows)
                except Exception:
                    pass

        page.on("response", on_response)

        # ── Step 1: load page and extract JWT ────────────────────────────────
        print(f"[1] Loading {TARGET_URL} …")
        await page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=60_000)

        # grab the hidden JWT token from the ASP.NET form field
        token_el = page.locator("#hfApiToken")
        try:
            raw_jwt = await token_el.input_value(timeout=5_000)
            if raw_jwt:
                jwt_token.append(raw_jwt)
                print(f"[2] JWT token extracted ({len(raw_jwt)} chars)")
        except Exception:
            print("[2] JWT token not found in DOM (may load later)")

        # wait for the Web Component to boot and make its first data call
        print("[3] Waiting for screener component to load fund data …")
        try:
            await page.wait_for_selector(
                "table, [class*='screener'], [class*='fund'], [data-testid*='row']",
                timeout=30_000,
            )
        except Exception:
            pass  # continue anyway, data may arrive via XHR

        # give the component extra time to paginate / load
        await asyncio.sleep(4)

        # ── Step 2: scroll through results to trigger lazy-loading ───────────
        print("[4] Scrolling to trigger pagination …")
        prev_count = len(all_funds)
        for _ in range(8):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(1.5)
            if len(all_funds) > prev_count:
                prev_count = len(all_funds)
                print(f"     … {len(all_funds)} funds so far")

        # ── Step 3: if we still have nothing, try clicking "Load More" ────────
        if not all_funds:
            for selector in ["button:has-text('Load More')", "[class*='load-more']", "[class*='next']"]:
                btns = page.locator(selector)
                count = await btns.count()
                if count:
                    print(f"[5] Clicking '{selector}' ({count} found) …")
                    for i in range(min(count, 5)):
                        try:
                            await btns.nth(i).click()
                            await asyncio.sleep(2)
                        except Exception:
                            pass

        # ── Step 4: dump intercepted request info for debugging ──────────────
        if captured_requests:
            api_dump = OUTPUT_JSON.parent / "captured_api_calls.json"
            api_dump.write_text(json.dumps(captured_requests, indent=2))
            print(f"[6] Saved {len(captured_requests)} intercepted API calls → {api_dump}")

        # ── Step 5: if response-capture missed data, try scraping the DOM ────
        if not all_funds:
            print("[7] Response capture empty — attempting DOM table scrape …")
            all_funds = await _dom_scrape(page)

        await browser.close()

    # ── post-process ──────────────────────────────────────────────────────────
    if not all_funds:
        print("\n[!] No fund data captured.")
        print("    Tip: run with --headless false to inspect the page manually.")
        print(f"    Review {OUTPUT_JSON.parent / 'captured_api_calls.json'} for clues.")
        return []

    if limit:
        all_funds = all_funds[:limit]

    # deduplicate by id / secId
    seen = set()
    unique_funds = []
    for f in all_funds:
        key = f.get("secId") or f.get("id") or f.get("fundId") or json.dumps(f, sort_keys=True)
        if key not in seen:
            seen.add(key)
            unique_funds.append(f)

    print(f"\n[OK] {len(unique_funds)} unique funds captured.")

    # save JSON
    OUTPUT_JSON.write_text(json.dumps(unique_funds, indent=2, ensure_ascii=False))
    print(f"     Saved → {OUTPUT_JSON}")

    # save CSV
    if pd is not None:
        flat = [_flatten(f) for f in unique_funds]
        df = pd.DataFrame(flat)
        df.to_csv(OUTPUT_CSV, index=False)
        print(f"     Saved → {OUTPUT_CSV}")
    else:
        import csv
        flat = [_flatten(f) for f in unique_funds]
        if flat:
            with open(OUTPUT_CSV, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=flat[0].keys())
                w.writeheader()
                w.writerows(flat)
            print(f"     Saved → {OUTPUT_CSV}")

    return unique_funds


async def _dom_scrape(page) -> list[dict]:
    """Fallback: parse visible HTML table if XHR capture failed."""
    funds = []
    try:
        rows = page.locator("table tbody tr")
        count = await rows.count()
        if not count:
            return funds
        # get header
        headers = []
        header_cells = page.locator("table thead th")
        for i in range(await header_cells.count()):
            headers.append((await header_cells.nth(i).inner_text()).strip())
        for i in range(count):
            cells = rows.nth(i).locator("td")
            cell_count = await cells.count()
            row = {}
            for j in range(cell_count):
                key = headers[j] if j < len(headers) else f"col_{j}"
                row[key] = (await cells.nth(j).inner_text()).strip()
            if row:
                funds.append(row)
        print(f"  [DOM] scraped {len(funds)} rows from visible table")
    except Exception as e:
        print(f"  [DOM] failed: {e}")
    return funds


# ── entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Morningstar India MF Scraper")
    parser.add_argument("--headless", default="true", choices=["true", "false"],
                        help="Run browser headless (default: true)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Max funds to save (0 = all)")
    args = parser.parse_args()
    headless = args.headless.lower() == "true"
    funds = asyncio.run(scrape(headless=headless, limit=args.limit))
    return funds


if __name__ == "__main__":
    main()
