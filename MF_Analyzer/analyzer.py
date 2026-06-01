"""
Mutual Fund Analyzer
=====================
Reads mf_data.json (produced by scraper.py) and produces:
  - Top funds to BUY  (high rating + strong returns + low risk)
  - Funds to AVOID    (poor rating / high risk / poor consistency)
  - Category-level summary
  - Individual fund drill-down

Usage:
    python analyzer.py                        # full report to terminal
    python analyzer.py --top 20               # show top 20 buy candidates
    python analyzer.py --category "Flexi Cap" # filter by category
    python analyzer.py --export report.xlsx   # export to Excel (needs openpyxl)
"""

import json
import argparse
import sys
from pathlib import Path
from typing import Optional

DATA_FILE = Path(__file__).parent / "mf_data.json"

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False
    print("[!] pandas not installed — install it for full analysis: pip install pandas")

# ── scoring weights ────────────────────────────────────────────────────────────
# Adjust these to your personal risk appetite

WEIGHTS = {
    "starRating":           0.30,   # Morningstar star rating (1–5)
    "return_3y":            0.25,   # 3-year annualised return
    "return_1y":            0.15,   # 1-year return
    "return_5y":            0.15,   # 5-year return
    "expenseRatio_penalty": 0.10,   # lower is better (inverted)
    "risk_penalty":         0.05,   # lower risk is better (inverted)
}

# Column name aliases — Morningstar JSON fields vary; map common variants
FIELD_MAP = {
    # star rating — actual Morningstar field name from the APAC API
    "starRating":    ["starRatingM255", "starRating", "StarRating", "MorningstarRating", "rating"],
    # returns (Morningstar uses returnM12 = 1Y, returnM36 = 3Y, returnM60 = 5Y)
    "return_1y":     ["returnM12", "TrailingReturn1Yr", "trailing1Yr", "return1Y", "annualizedReturn1Yr"],
    "return_3y":     ["returnM36", "TrailingReturn3Yr", "trailing3Yr", "return3Y", "annualizedReturn3Yr"],
    "return_5y":     ["returnM60", "TrailingReturn5Yr", "trailing5Yr", "return5Y", "annualizedReturn5Yr"],
    "return_10y":    ["returnM120"],
    "return_6m":     ["returnM6"],
    "return_1m":     ["returnM1"],
    # expense ratio
    "expenseRatio":  ["expenseRatio", "ongoingCharge", "ExpenseRatio", "TotalExpenseRatio", "ter"],
    # risk  (morningstarRiskM255: 1=Low … 5=High)
    "riskRating":    ["morningstarRiskM255", "riskRating", "RiskRating", "MorningstarRisk"],
    # Sharpe ratio
    "sharpe":        ["sharpeM36"],
    # alpha / beta
    "alpha":         ["alphaM36"],
    "beta":          ["betaM36"],
    # standard deviation
    "stddev":        ["standardDeviationM36"],
    # Medalist/Analyst rating (1–5; 6=NR)
    "analystRating": ["Medalist_RatingNumber"],
    # category
    "category":      ["categoryName", "category", "Category", "FundCategory"],
    # fund name
    "name":          ["name", "legalName", "fundName", "FundName", "LegalName"],
    # fund house / AMC
    "amc":           ["BrandingCompanyName", "brandingCompanyName", "AMC", "amc", "FundFamily"],
    # AUM (in INR, raw value from fundTnav)
    "aum":           ["fundTnav", "GBRAum", "Aum", "aum", "TotalAssets"],
    # nav
    "nav":           ["closePrice", "Nav", "nav", "NAV", "DayEndNav"],
}


def _get(row: dict, field: str, default=None):
    """Fetch a value trying all known aliases for that field."""
    for alias in FIELD_MAP.get(field, [field]):
        if alias in row and row[alias] is not None and row[alias] != "":
            try:
                return float(row[alias])
            except (ValueError, TypeError):
                val = row[alias]
                return val if default is None else default
    return default


def _get_str(row: dict, field: str, default="—") -> str:
    for alias in FIELD_MAP.get(field, [field]):
        if alias in row and row[alias]:
            return str(row[alias])
    return default


# ── normalise data ─────────────────────────────────────────────────────────────

def load_funds(path: Path = DATA_FILE) -> list[dict]:
    if not path.exists():
        print(f"[!] Data file not found: {path}")
        print("    Run scraper.py first:  python scraper.py")
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def enrich(funds: list[dict]) -> list[dict]:
    """Add computed fields to each fund dict."""
    enriched = []
    for f in funds:
        f = dict(f)  # copy
        f["_name"]     = _get_str(f, "name")
        f["_category"] = _get_str(f, "category")
        f["_amc"]      = _get_str(f, "amc")
        f["_stars"]    = _get(f, "starRating", 0)
        f["_ret1y"]    = _get(f, "return_1y", None)
        f["_ret3y"]    = _get(f, "return_3y", None)
        f["_ret5y"]    = _get(f, "return_5y", None)
        f["_expense"]  = _get(f, "expenseRatio", None)
        f["_risk"]     = _get(f, "riskRating", None)  # may be string like "High"
        f["_aum"]      = _get(f, "aum", None)
        f["_nav"]      = _get(f, "nav", None)
        enriched.append(f)
    return enriched


RISK_MAP = {"Low": 1, "Below Average": 2, "Average": 3, "Above Average": 4, "High": 5}

def _risk_score(f: dict) -> float:
    r = f.get("_risk")
    if r is None:
        return 3.0
    if isinstance(r, (int, float)):
        return float(r)
    return float(RISK_MAP.get(str(r), 3))


def score_fund(f: dict, max_ret1y: float, max_ret3y: float, max_ret5y: float) -> float:
    """Return a composite score 0–100 for a fund."""
    # Star rating: 0–5 → 0–1
    star = (f["_stars"] or 0) / 5.0

    # Returns: normalised to 0–1 (clamp negatives to 0)
    r1 = max(f["_ret1y"] or 0, 0) / max(max_ret1y, 1)
    r3 = max(f["_ret3y"] or 0, 0) / max(max_ret3y, 1)
    r5 = max(f["_ret5y"] or 0, 0) / max(max_ret5y, 1)

    # Expense ratio penalty: 0 = expensive, 1 = cheap
    # typical range: 0.1% – 2.5%
    exp = f["_expense"]
    if exp is None:
        exp_score = 0.5
    else:
        exp_score = max(0, 1 - (exp / 2.5))

    # Risk penalty: 1 (low) – 5 (high) → 0–1 inverted
    risk_score = 1 - (_risk_score(f) - 1) / 4.0

    composite = (
        WEIGHTS["starRating"]           * star * 100 +
        WEIGHTS["return_3y"]            * r3   * 100 +
        WEIGHTS["return_1y"]            * r1   * 100 +
        WEIGHTS["return_5y"]            * r5   * 100 +
        WEIGHTS["expenseRatio_penalty"] * exp_score * 100 +
        WEIGHTS["risk_penalty"]         * risk_score * 100
    )
    return round(composite, 2)


# ── analysis routines ─────────────────────────────────────────────────────────

def analyse(funds: list[dict], category_filter: Optional[str] = None,
            top_n: int = 15) -> dict:
    funds = enrich(funds)

    if category_filter:
        funds = [f for f in funds if category_filter.lower() in f["_category"].lower()]
        if not funds:
            print(f"[!] No funds found for category '{category_filter}'")
            return {}

    # compute normalisation bounds
    rets1 = [f["_ret1y"] for f in funds if f["_ret1y"] is not None]
    rets3 = [f["_ret3y"] for f in funds if f["_ret3y"] is not None]
    rets5 = [f["_ret5y"] for f in funds if f["_ret5y"] is not None]
    max_r1 = max(rets1) if rets1 else 1
    max_r3 = max(rets3) if rets3 else 1
    max_r5 = max(rets5) if rets5 else 1

    for f in funds:
        f["_score"] = score_fund(f, max_r1, max_r3, max_r5)

    funds.sort(key=lambda x: x["_score"], reverse=True)

    buy_candidates  = [f for f in funds if f["_stars"] >= 4][:top_n]
    avoid_list      = [f for f in funds if f["_stars"] <= 2][:top_n]
    mid_list        = [f for f in funds if f["_stars"] == 3]

    # category summary
    cat_scores: dict[str, list] = {}
    for f in funds:
        cat_scores.setdefault(f["_category"], []).append(f["_score"])
    cat_summary = {
        cat: {"count": len(scores), "avg_score": round(sum(scores)/len(scores), 1),
              "max_score": round(max(scores), 1)}
        for cat, scores in cat_scores.items()
    }

    return {
        "total": len(funds),
        "buy_candidates": buy_candidates,
        "avoid": avoid_list,
        "watch": mid_list[:top_n],
        "category_summary": cat_summary,
    }


# ── display ────────────────────────────────────────────────────────────────────

def _fmt_pct(v) -> str:
    if v is None:
        return "  —  "
    return f"{v:+.1f}%"

def _fmt_stars(v) -> str:
    if not v:
        return "  -  "
    return "★" * int(v) + "☆" * (5 - int(v))

def _bar(score: float) -> str:
    blocks = int(score / 10)
    return "█" * blocks + "░" * (10 - blocks)


def print_fund_table(funds: list[dict], title: str):
    if not funds:
        print("  (none)\n")
        return
    print(f"\n{'═'*110}")
    print(f"  {title}  ({len(funds)} funds)")
    print(f"{'═'*110}")
    print(f"  {'Score':>6}  {'Stars':<6}  {'1Y':>7}  {'3Y':>7}  {'5Y':>7}  "
          f"{'Exp%':>5}  {'Category':<22}  Fund Name")
    print(f"  {'-'*6}  {'-'*6}  {'-'*7}  {'-'*7}  {'-'*7}  "
          f"{'-'*5}  {'-'*22}  {'-'*40}")
    for f in funds:
        exp = f["_expense"]
        print(
            f"  {f['_score']:>6.1f}  {_fmt_stars(f['_stars']):<6}  "
            f"{_fmt_pct(f['_ret1y']):>7}  {_fmt_pct(f['_ret3y']):>7}  "
            f"{_fmt_pct(f['_ret5y']):>7}  "
            f"{(str(exp)+'%') if exp else '—':>5}  "
            f"{f['_category'][:22]:<22}  "
            f"{f['_name'][:60]}"
        )
    print()


def print_category_table(cat_summary: dict):
    print(f"\n{'═'*70}")
    print("  CATEGORY SUMMARY")
    print(f"{'═'*70}")
    print(f"  {'Avg Score':>9}  {'Max Score':>9}  {'Count':>5}  Category")
    print(f"  {'-'*9}  {'-'*9}  {'-'*5}  {'-'*35}")
    for cat, s in sorted(cat_summary.items(), key=lambda x: -x[1]["avg_score"]):
        print(f"  {s['avg_score']:>9.1f}  {s['max_score']:>9.1f}  {s['count']:>5}  {cat}")
    print()


def print_report(result: dict, top_n: int):
    print(f"\n{'━'*110}")
    print("  MUTUAL FUND ANALYSIS REPORT — Morningstar India")
    print(f"  Total funds analysed: {result['total']}")
    print(f"{'━'*110}")

    print_fund_table(result["buy_candidates"][:top_n],
                     "★★★★+ BUY CANDIDATES (4–5 star, highest composite score)")
    print_fund_table(result["watch"][:top_n],
                     "◑  WATCH LIST (3-star, decent but not standout)")
    print_fund_table(result["avoid"][:top_n],
                     "✗  AVOID / REVIEW (≤2 star or poor metrics)")
    print_category_table(result["category_summary"])

    print("\n  SCORING WEIGHTS (personalise in analyzer.py → WEIGHTS dict):")
    for k, v in WEIGHTS.items():
        print(f"    {k:<28}: {v*100:.0f}%")
    print()


# ── export ─────────────────────────────────────────────────────────────────────

def export_excel(result: dict, path: str):
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        print("[!] openpyxl not installed: pip install openpyxl")
        return

    private_keys = [k for k in next(iter(result["buy_candidates"]), {}).keys()
                    if not k.startswith("_")]

    def to_df(funds):
        rows = []
        for f in funds:
            rows.append({
                "Fund Name": f["_name"],
                "Category":  f["_category"],
                "AMC":        f["_amc"],
                "Score":      f["_score"],
                "Stars":      f["_stars"],
                "1Y Return":  f["_ret1y"],
                "3Y Return":  f["_ret3y"],
                "5Y Return":  f["_ret5y"],
                "Expense %":  f["_expense"],
                "Risk":       f["_risk"],
                "AUM (Cr)":   f["_aum"],
                "NAV":        f["_nav"],
            })
        return pd.DataFrame(rows)

    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        to_df(result["buy_candidates"]).to_excel(writer, sheet_name="BUY", index=False)
        to_df(result["watch"]).to_excel(writer, sheet_name="WATCH", index=False)
        to_df(result["avoid"]).to_excel(writer, sheet_name="AVOID", index=False)
        pd.DataFrame([
            {"Category": c, **s} for c, s in result["category_summary"].items()
        ]).sort_values("avg_score", ascending=False).to_excel(
            writer, sheet_name="Category Summary", index=False)

    print(f"[OK] Report exported → {path}")


# ── entry point ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Mutual Fund Analyzer")
    parser.add_argument("--top",      type=int,   default=15,    help="Top N funds per section")
    parser.add_argument("--category", type=str,   default=None,  help="Filter by category substring")
    parser.add_argument("--export",   type=str,   default=None,  help="Export to Excel file path")
    parser.add_argument("--data",     type=str,   default=str(DATA_FILE), help="Path to mf_data.json")
    args = parser.parse_args()

    funds = load_funds(Path(args.data))
    print(f"[+] Loaded {len(funds)} funds from {args.data}")

    result = analyse(funds, category_filter=args.category, top_n=args.top)
    if not result:
        return

    print_report(result, top_n=args.top)

    if args.export:
        if HAS_PANDAS:
            export_excel(result, args.export)
        else:
            print("[!] pandas required for Excel export")


if __name__ == "__main__":
    main()
