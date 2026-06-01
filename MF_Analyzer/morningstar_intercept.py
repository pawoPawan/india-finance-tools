#!/usr/bin/env python3
"""
Playwright script to intercept ALL network requests on Morningstar India fund pages.
Captures XHR/fetch API calls, especially JSON responses.
"""

import asyncio
import json
import sys
from playwright.async_api import async_playwright


URLS = [
    "https://www.morningstar.in/mutualfunds/F00001QVOT/Zerodha-Silver-ETF-FoF-Direct-Growth/overview.aspx",
    "https://www.morningstar.in/mutualfunds/F00001GP7E/360-ONE-Balanced-Hybrid-Fund-Regular-Growth/overview.aspx",
]


async def intercept_page(playwright, page_url: str):
    print("\n" + "=" * 100)
    print(f"PROCESSING: {page_url}")
    print("=" * 100)

    browser = await playwright.chromium.launch(
        headless=True,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-setuid-sandbox",
        ],
    )

    context = await browser.new_context(
        viewport={"width": 1280, "height": 900},
        user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        extra_http_headers={
            "Accept-Language": "en-US,en;q=0.9",
        },
    )

    page = await context.new_page()

    captured_responses = []

    # ── intercept responses ──────────────────────────────────────────────────
    async def handle_response(response):
        url = response.url
        content_type = response.headers.get("content-type", "")
        # capture anything that looks like JSON
        if (
            "json" in content_type
            or "javascript" in content_type
            or "api" in url.lower()
            or "apac" in url.lower()
            or "morningstar" in url.lower()
        ):
            try:
                body = await response.body()
                text = body.decode("utf-8", errors="replace")
                # only keep if it looks like JSON
                stripped = text.strip()
                if stripped.startswith(("{", "[")):
                    captured_responses.append(
                        {
                            "url": url,
                            "status": response.status,
                            "content_type": content_type,
                            "body": text,
                        }
                    )
            except Exception as e:
                pass  # body may not be readable for some responses

    page.on("response", handle_response)

    # ── navigate ─────────────────────────────────────────────────────────────
    print(f"\n[*] Navigating to page...")
    try:
        await page.goto(page_url, wait_until="networkidle", timeout=60_000)
    except Exception as e:
        print(f"[!] Navigation warning: {e}")

    print("[*] Initial page load done. Waiting 5s for dynamic content...")
    await asyncio.sleep(5)

    # ── try to click Holdings / Portfolio tabs ────────────────────────────────
    tab_keywords = [
        "holdings", "portfolio", "equity", "bond", "allocation",
        "Holdings", "Portfolio", "Equity", "Bond", "Allocation",
    ]

    print("\n[*] Looking for Holdings / Portfolio tabs...")
    for keyword in tab_keywords:
        try:
            # try various selectors
            selectors = [
                f"text={keyword}",
                f"a:has-text('{keyword}')",
                f"button:has-text('{keyword}')",
                f"li:has-text('{keyword}')",
                f"[class*='tab']:has-text('{keyword}')",
                f"[role='tab']:has-text('{keyword}')",
            ]
            for sel in selectors:
                elements = await page.query_selector_all(sel)
                if elements:
                    for el in elements:
                        try:
                            visible = await el.is_visible()
                            if visible:
                                text = await el.inner_text()
                                print(f"  [+] Clicking tab element: '{text.strip()}' (selector: {sel})")
                                await el.click()
                                await asyncio.sleep(3)
                                break
                        except Exception:
                            pass
        except Exception:
            pass

    # ── wait for more network activity after tab clicks ───────────────────────
    print("\n[*] Waiting 5 more seconds for additional API calls after tab clicks...")
    await asyncio.sleep(5)

    # ── also try scrolling to trigger lazy-loaded content ────────────────────
    print("[*] Scrolling page to trigger lazy-loaded content...")
    try:
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await asyncio.sleep(2)
        await page.evaluate("window.scrollTo(0, 0)")
        await asyncio.sleep(2)
    except Exception:
        pass

    # ── print all captured page HTML snippet for tab discovery ───────────────
    try:
        tabs_html = await page.evaluate("""
            () => {
                const candidates = [
                    ...document.querySelectorAll('a, button, li, [role="tab"]')
                ].filter(el => {
                    const t = el.innerText || '';
                    return /holding|portfolio|equity|bond|alloc|overview|performance/i.test(t);
                }).map(el => `<${el.tagName} class="${el.className}" href="${el.href||''}">${(el.innerText||'').trim()}</${el.tagName}>`);
                return candidates.join('\\n');
            }
        """)
        if tabs_html:
            print("\n[*] Found tab-like elements on page:")
            print(tabs_html[:3000])
    except Exception as e:
        print(f"[!] Could not enumerate tabs: {e}")

    # ── print all captured JSON responses ────────────────────────────────────
    print(f"\n\n{'='*100}")
    print(f"CAPTURED {len(captured_responses)} JSON RESPONSES for: {page_url}")
    print("=" * 100)

    if not captured_responses:
        print("[!] No JSON responses captured. The site may require JS rendering that failed.")
    else:
        for i, r in enumerate(captured_responses, 1):
            print(f"\n--- Response #{i} ---")
            print(f"  URL    : {r['url']}")
            print(f"  Status : {r['status']}")
            print(f"  Type   : {r['content_type']}")
            body_preview = r["body"][:3000]
            print(f"  Body (first 3000 chars):")
            print(body_preview)
            print()

    # ── also dump all request URLs captured (even non-JSON) ──────────────────
    print("\n[*] All URLs with 'api', 'apac', or 'morningstar' in path that returned any response:")

    await browser.close()
    return captured_responses


async def main():
    async with async_playwright() as p:
        all_results = {}
        for url in URLS:
            responses = await intercept_page(p, url)
            all_results[url] = responses

    # ── final summary ─────────────────────────────────────────────────────────
    print("\n\n" + "=" * 100)
    print("FINAL SUMMARY — UNIQUE API ENDPOINTS DISCOVERED")
    print("=" * 100)

    all_urls = set()
    for fund_url, responses in all_results.items():
        fund_id = fund_url.split("/")[4]
        print(f"\nFund: {fund_id}")
        for r in responses:
            all_urls.add(r["url"])
            print(f"  {r['status']}  {r['url']}")

    print(f"\n\nTotal unique endpoints: {len(all_urls)}")
    for u in sorted(all_urls):
        print(f"  {u}")


if __name__ == "__main__":
    asyncio.run(main())
