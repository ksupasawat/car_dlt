"""Export the canonical Manual Report (sheets 1-9) to frontend/public/data/manual_report.json.

This is the single source the /report page renders. It reproduces the manual report sheets
from the two DLT raw files plus repo mapping tables so the frontend never recomputes
spreadsheet logic.

Source rules for the Manual Report sheets:
  * Sheets 1-6 and 9 -> test_fuel_cleaned.parquet, fuel-derived powertrain (PT).
  * Sheets 7-8      -> test_model_cleaned.parquet, filtered to (Brand2, raw model) pairs
                       explicitly approved as BEV in config/model_powertrain_review.csv
                       (model_map.approved_bev_keys(): review_status=approved AND
                       candidate_powertrain=BEV). No inference from brand fuel totals,
                       dominant fuel, or model-name guessing. An empty/unreviewed table
                       yields empty sheet7/8 sections, not a crash.
  * Vehicle types default to รย.1,2,3,6,9,10,11.
  * Current period is auto-detected from the fuel parquet (never hardcoded).
"""
import os
import sys
import json
import datetime
from pathlib import Path

import pandas as pd

from export_dashboard import load_data, MONTH_MAP, FULL_MONTH_EN
from aggregate import current_period
import model_map

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path(__file__).resolve().parent
FUEL_PARQUET = BASE / "test_fuel_cleaned.parquet"
MODEL_PARQUET = BASE / "test_model_cleaned.parquet"
OUT = Path(os.environ.get("PUBLIC_DATA_DIR") or (BASE.parent / "frontend" / "public" / "data")) / "manual_report.json"

DEFAULT_VEHICLE_TYPES = ["รย.1", "รย.2", "รย.3", "รย.6", "รย.9", "รย.10", "รย.11"]
MONTHS = list(MONTH_MAP.values())  # Jan .. Dec
POWERTRAIN_ROWS = ["ICE", "BEV", "HEV", "PHEV"]


def _safe_div(num, den):
    return (num / den) if den else None


def month_matrix(df: pd.DataFrame, key_col: str) -> dict:
    """key -> {year -> [12 monthly ints]} from an already-filtered frame."""
    grp = df.groupby([key_col, "ปี", "เดือน"], observed=True)["จำนวนรถ"].sum()
    out: dict = {}
    for (key, year, month), units in grp.items():
        if month not in MONTHS:
            continue
        mi = MONTHS.index(month)
        out.setdefault(key, {}).setdefault(int(year), [0] * 12)
        out[key][int(year)][mi] += int(units)
    return out


def build_rows(mat: dict, latest_year: int, prev_year: int, lm_idx: int, *, ranked: bool, has_prev_year: bool = True) -> list:
    """Turn a month-matrix into report rows with a pinned Grand Total first.

    lm_idx is the 0-based index of the latest month (e.g. Jun -> 5).
    Every row carries the full field set the frontend renders without recomputation.

    has_prev_year=False means prev_year has no data anywhere in the source (e.g. report
    year 2564 has no 2563 data). In that case every prior-year field is null instead of
    a fabricated zero, and ranks/rank_diff for prev_year are also null.
    """
    details = []
    for key, years in mat.items():
        curr_months = list(years.get(latest_year, [0] * 12))
        curr_ytd = sum(curr_months[: lm_idx + 1])
        if has_prev_year:
            prev_months = list(years.get(prev_year, [0] * 12))
            prev_total = sum(prev_months)
            prev_ytd = sum(prev_months[: lm_idx + 1])
            if prev_total == 0 and curr_ytd == 0:
                continue
        else:
            prev_months = [None] * 12
            prev_total = None
            prev_ytd = None
            if curr_ytd == 0:
                continue
        details.append({
            "key": str(key),
            "label": str(key),
            "prev_months": prev_months,
            "curr_months": curr_months,
            "prev_total": prev_total,
            "prev_ytd": prev_ytd,
            "curr_ytd": curr_ytd,
        })

    # Grand Total (sum of all detail rows)
    gt_prev = [0] * 12 if has_prev_year else [None] * 12
    gt_curr = [0] * 12
    for r in details:
        for i in range(12):
            if has_prev_year:
                gt_prev[i] += r["prev_months"][i]
            gt_curr[i] += r["curr_months"][i]
    grand = {
        "key": "Grand Total",
        "label": "Grand Total",
        "prev_months": gt_prev,
        "curr_months": gt_curr,
        "prev_total": sum(gt_prev) if has_prev_year else None,
        "prev_ytd": sum(gt_prev[: lm_idx + 1]) if has_prev_year else None,
        "curr_ytd": sum(gt_curr[: lm_idx + 1]),
    }

    # Ranks over detail rows only
    if ranked and has_prev_year:
        for r in details:
            r["_pt"] = r["prev_total"]
            r["_ct"] = r["curr_ytd"]
        prev_order = sorted(details, key=lambda r: -r["_pt"])
        curr_order = sorted(details, key=lambda r: -r["_ct"])
        prev_rank = {r["key"]: i + 1 for i, r in enumerate(prev_order)}
        curr_rank = {r["key"]: i + 1 for i, r in enumerate(curr_order)}
    elif ranked:
        curr_order = sorted(details, key=lambda r: -r["curr_ytd"])
        curr_rank = {r["key"]: i + 1 for i, r in enumerate(curr_order)}
        prev_rank = {}
    else:
        prev_rank = curr_rank = {}

    base_prev_total = grand["prev_total"]
    base_prev_ytd = grand["prev_ytd"]
    base_curr_ytd = grand["curr_ytd"]
    base_prev_month = grand["prev_months"][lm_idx] if has_prev_year else None
    base_curr_month = grand["curr_months"][lm_idx]

    def finalize(r: dict, is_grand: bool) -> dict:
        cm = r["curr_months"][lm_idx]
        pm = r["curr_months"][lm_idx - 1] if lm_idx > 0 else 0
        prev_month = r["prev_months"][lm_idx] if has_prev_year else None
        prev_month_share = _safe_div(prev_month, base_prev_month) if has_prev_year else None
        curr_month_share = _safe_div(cm, base_curr_month)
        prev_ytd_share = _safe_div(r["prev_ytd"], base_prev_ytd) if has_prev_year else None
        curr_ytd_share = _safe_div(r["curr_ytd"], base_curr_ytd)
        row = {
            "key": r["key"],
            "label": r["label"],
            "prev_months": r["prev_months"],
            "prev_total": r["prev_total"],
            "prev_ytd": r["prev_ytd"],
            "prev_total_share": _safe_div(r["prev_total"], base_prev_total) if has_prev_year else None,
            "prev_month_units": prev_month,
            "prev_month_share": prev_month_share,
            "prev_ytd_share": prev_ytd_share,
            "curr_months": r["curr_months"],
            "curr_month_units": cm,
            "curr_month_share": curr_month_share,
            "curr_month_diff": (curr_month_share - prev_month_share) if (curr_month_share is not None and prev_month_share is not None) else None,
            "curr_ytd": r["curr_ytd"],
            "curr_ytd_share": curr_ytd_share,
            "curr_ytd_diff": (curr_ytd_share - prev_ytd_share) if (curr_ytd_share is not None and prev_ytd_share is not None) else None,
            "growth_vs_prev_month": _safe_div(cm - pm, pm),
            "growth_vs_same_month_prev_year": _safe_div(cm - r["prev_months"][lm_idx], r["prev_months"][lm_idx]) if has_prev_year else None,
            "growth_vs_prev_ytd": _safe_div(r["curr_ytd"] - r["prev_ytd"], r["prev_ytd"]) if has_prev_year else None,
        }
        if ranked and not is_grand:
            pr = prev_rank.get(r["key"])
            cr = curr_rank.get(r["key"])
            row["prev_rank"] = pr
            row["curr_rank"] = cr
            row["rank_diff"] = (pr - cr) if (pr and cr) else None
        elif ranked:
            row["prev_rank"] = None
            row["curr_rank"] = None
            row["rank_diff"] = None
        return row

    ordered = sorted(details, key=lambda r: -r["curr_ytd"])
    return [finalize(grand, True)] + [finalize(r, False) for r in ordered]


def sheet_powertrain(df_fuel: pd.DataFrame, ly, py, lm, *, has_prev_year=True) -> list:
    d = df_fuel[df_fuel["PT"].isin(POWERTRAIN_ROWS)]
    mat = month_matrix(d, "PT")
    # ensure all four powertrain rows exist even if empty
    for pt in POWERTRAIN_ROWS:
        mat.setdefault(pt, {})
    rows = build_rows(mat, ly, py, lm, ranked=False, has_prev_year=has_prev_year)
    # order details ICE, BEV, HEV, PHEV (grand stays first)
    order = {pt: i for i, pt in enumerate(POWERTRAIN_ROWS)}
    grand, details = rows[0], rows[1:]
    details.sort(key=lambda r: order.get(r["key"], 99))
    return [grand] + details


def sheet_brand(df_fuel: pd.DataFrame, ly, py, lm, powertrain=None, *, has_prev_year=True) -> list:
    d = df_fuel if powertrain is None else df_fuel[df_fuel["PT"] == powertrain]
    mat = month_matrix(d, "ยี่ห้อรถ2")
    return build_rows(mat, ly, py, lm, ranked=True, has_prev_year=has_prev_year)


def sheet_bev_by_model(df_model: pd.DataFrame, ly, py, lm, *, has_prev_year=True) -> list:
    """Brand header rows + child model rows from the explicit BEV model report mapping."""
    d = bev_model_report_slice(df_model)
    if d.empty:
        return []
    brand_mat = month_matrix(d, "ยี่ห้อรถ2")
    brand_rows = build_rows(brand_mat, ly, py, lm, ranked=True, has_prev_year=has_prev_year)
    grand, brand_details = brand_rows[0], brand_rows[1:]

    # model rows per brand
    model_mat_by_brand: dict = {}
    for brand, sub in d.groupby("ยี่ห้อรถ2", observed=True):
        model_mat_by_brand[brand] = build_rows(
            month_matrix(sub, "รุ่นรถ2"), ly, py, lm, ranked=False, has_prev_year=has_prev_year
        )[1:]  # drop the per-brand grand total

    grand["level"] = "grand"
    out = [grand]
    for b in brand_details:
        b["level"] = "brand"
        b["group"] = b["key"]
        out.append(b)
        for m in sorted(model_mat_by_brand.get(b["key"], []), key=lambda r: -r["curr_ytd"]):
            m["level"] = "model"
            m["group"] = b["key"]
            m["brand"] = b["key"]
            out.append(m)
    return out


def sheet_model_top_rank(df_model: pd.DataFrame, ly, py, lm, *, has_prev_year=True) -> list:
    """Flat model ranking (brand||model) from the explicit BEV model report mapping."""
    d = bev_model_report_slice(df_model).copy()
    if d.empty:
        return []
    d["_mk"] = d["ยี่ห้อรถ2"].astype(str) + " || " + d["รุ่นรถ2"].astype(str)
    label_map = d.drop_duplicates("_mk").set_index("_mk")[["ยี่ห้อรถ2", "รุ่นรถ2"]].to_dict("index")
    mat = month_matrix(d, "_mk")
    rows = build_rows(mat, ly, py, lm, ranked=True, has_prev_year=has_prev_year)
    for r in rows:
        info = label_map.get(r["key"])
        if info:
            r["brand"] = info["ยี่ห้อรถ2"]
            r["model"] = info["รุ่นรถ2"]
            r["label"] = f'{info["รุ่นรถ2"]}  ·  {info["ยี่ห้อรถ2"]}'
    return rows


def bev_model_report_slice(df_model: pd.DataFrame) -> pd.DataFrame:
    """Rows explicitly approved as BEV for Sheets 7-8 via config/model_powertrain_review.csv.

    Inclusion is a maintainer-reviewed CSV lookup only — never inferred from brand
    fuel totals, dominant fuel, or model-name guessing. No approved BEV rows yields an
    empty (but valid) slice rather than raising.
    """
    approved = model_map.approved_bev_keys()
    if not approved:
        return df_model.iloc[0:0]
    keys = df_model.apply(lambda r: model_map.normalize_key(r["ยี่ห้อรถ2"], r["รุ่นรถ"]), axis=1)
    return df_model[keys.isin(approved)]


def sheet_by_province(df_fuel: pd.DataFrame, ly, py, lm, *, has_prev_year=True) -> list:
    """Province header rows + child brand rows; each row also carries an overall total."""
    prov_rows = build_rows(month_matrix(df_fuel, "จังหวัด"), ly, py, lm, ranked=False, has_prev_year=has_prev_year)
    grand, prov_details = prov_rows[0], prov_rows[1:]

    brand_by_prov: dict = {}
    for prov, sub in df_fuel.groupby("จังหวัด", observed=True):
        brand_by_prov[prov] = build_rows(
            month_matrix(sub, "ยี่ห้อรถ2"), ly, py, lm, ranked=False, has_prev_year=has_prev_year
        )[1:]

    def _sort_key(r):
        return -(r["curr_ytd"] if r["prev_total"] is None else r["prev_total"] + r["curr_ytd"])

    def with_overall(r):
        r["overall"] = None if r["prev_total"] is None else r["prev_total"] + r["curr_ytd"]
        return r

    grand["level"] = "grand"
    out = [with_overall(grand)]
    prov_details.sort(key=_sort_key)
    for p in prov_details:
        p["level"] = "province"
        p["group"] = p["key"]
        out.append(with_overall(p))
        for b in sorted(brand_by_prov.get(p["key"], []), key=_sort_key):
            b["level"] = "brand"
            b["group"] = p["key"]
            out.append(with_overall(b))
    return out


SECTION_VT_LABEL = "ประเภทรถ = รย.1,2,3,6,9,10,11"
SECTIONS = {
    "sheet1_powertrain": {"title": "1.Reg by Powertrain", "source": "test_fuel_cleaned.parquet", "filter": SECTION_VT_LABEL, "powertrain": "ICE/BEV/HEV/PHEV"},
    "sheet2_brand_all": {"title": "2.Rank by Brand", "source": "test_fuel_cleaned.parquet", "filter": SECTION_VT_LABEL, "powertrain": "All"},
    "sheet3_brand_ice": {"title": "3.ICE by Brand", "source": "test_fuel_cleaned.parquet", "filter": SECTION_VT_LABEL, "powertrain": "ICE (fuel-derived)"},
    "sheet4_brand_bev": {"title": "4.BEV by Brand", "source": "test_fuel_cleaned.parquet", "filter": SECTION_VT_LABEL, "powertrain": "BEV (fuel-derived)"},
    "sheet5_brand_hev": {"title": "5.HEV by Brand", "source": "test_fuel_cleaned.parquet", "filter": SECTION_VT_LABEL, "powertrain": "HEV (fuel-derived)"},
    "sheet6_brand_phev": {"title": "6.PHEV by Brand", "source": "test_fuel_cleaned.parquet", "filter": SECTION_VT_LABEL, "powertrain": "PHEV (fuel-derived)"},
    "sheet7_bev_by_model": {"title": "7.BEV by Model", "source": "test_model_cleaned.parquet", "filter": SECTION_VT_LABEL, "model_report_filter": "review_status=approved, candidate_powertrain=BEV in config/model_powertrain_review.csv"},
    "sheet8_model_top_rank": {"title": "8.Model Top Rank", "source": "test_model_cleaned.parquet", "filter": SECTION_VT_LABEL, "model_report_filter": "review_status=approved, candidate_powertrain=BEV in config/model_powertrain_review.csv"},
    "sheet9_by_province": {"title": "9.by Province", "source": "test_fuel_cleaned.parquet", "filter": SECTION_VT_LABEL, "powertrain": "All"},
}


def year_last_month_idx(df: pd.DataFrame, year: int) -> int:
    """0-based index of the last month with data in `year` (never hardcoded)."""
    present = set(df.loc[df["ปี"] == year, "เดือน"].unique()) & set(MONTHS)
    if not present:
        raise ValueError(f"no month data found for year {year}")
    return max(MONTHS.index(m) for m in present)


def build_report_payload(fuel: pd.DataFrame, model: pd.DataFrame, latest_year: int) -> dict:
    """One full sheets1-9 report payload for a single requested report year."""
    prev_year = latest_year - 1
    lm_idx = year_last_month_idx(fuel, latest_year)
    latest_month_num = lm_idx + 1
    latest_month = MONTHS[lm_idx]
    reporting_period = f"{FULL_MONTH_EN.get(latest_month, latest_month)} {latest_year}"

    has_prev_fuel = bool((fuel["ปี"] == prev_year).any())
    has_prev_model = bool((model["ปี"] == prev_year).any())

    sheets = {
        "sheet1_powertrain": sheet_powertrain(fuel, latest_year, prev_year, lm_idx, has_prev_year=has_prev_fuel),
        "sheet2_brand_all": sheet_brand(fuel, latest_year, prev_year, lm_idx, powertrain=None, has_prev_year=has_prev_fuel),
        "sheet3_brand_ice": sheet_brand(fuel, latest_year, prev_year, lm_idx, powertrain="ICE", has_prev_year=has_prev_fuel),
        "sheet4_brand_bev": sheet_brand(fuel, latest_year, prev_year, lm_idx, powertrain="BEV", has_prev_year=has_prev_fuel),
        "sheet5_brand_hev": sheet_brand(fuel, latest_year, prev_year, lm_idx, powertrain="HEV", has_prev_year=has_prev_fuel),
        "sheet6_brand_phev": sheet_brand(fuel, latest_year, prev_year, lm_idx, powertrain="PHEV", has_prev_year=has_prev_fuel),
        "sheet7_bev_by_model": sheet_bev_by_model(model, latest_year, prev_year, lm_idx, has_prev_year=has_prev_model),
        "sheet8_model_top_rank": sheet_model_top_rank(model, latest_year, prev_year, lm_idx, has_prev_year=has_prev_model),
        "sheet9_by_province": sheet_by_province(fuel, latest_year, prev_year, lm_idx, has_prev_year=has_prev_fuel),
    }

    meta = {
        "reporting_period": reporting_period,
        "latest_year": latest_year,
        "latest_month": latest_month,
        "latest_month_num": latest_month_num,
        "prev_year": prev_year,
        "has_prev_year": has_prev_fuel and has_prev_model,
        "months": MONTHS,
        "default_vehicle_types": DEFAULT_VEHICLE_TYPES,
        "source_files": {
            "brand_powertrain": "test_fuel_cleaned.parquet",
            "model": "test_model_cleaned.parquet",
        },
        "sections": SECTIONS,
        "generated_at": datetime.datetime.now().isoformat(),
    }
    return {"meta": meta, "sheets": sheets}


def export():
    for p in (FUEL_PARQUET, MODEL_PARQUET):
        if not p.exists():
            print(f"ERROR: parquet not found: {p}")
            sys.exit(1)

    print(f"Reading {FUEL_PARQUET.name} ...")
    fuel = load_data(FUEL_PARQUET, is_fuel=True)
    print(f"Reading {MODEL_PARQUET.name} ...")
    model = load_data(MODEL_PARQUET, is_fuel=False)

    # Vehicle-type filter (default markdown set)
    fuel = fuel[fuel["v_code"].isin(DEFAULT_VEHICLE_TYPES)].copy()
    model = model[model["v_code"].isin(DEFAULT_VEHICLE_TYPES)].copy()

    latest_year, latest_month_num = current_period(fuel, year_col="ปี", month_col="เดือน", month_order=MONTHS)
    # Every year with fuel data gets its own report payload (auto-detected, never hardcoded).
    report_years = sorted(int(y) for y in fuel["ปี"].dropna().unique())
    print(f"Report years: {report_years} (latest {latest_year}, YTD through month {latest_month_num})")

    payloads = {year: build_report_payload(fuel, model, year) for year in report_years}
    latest_payload = payloads[latest_year]

    payload = {
        "meta": latest_payload["meta"],
        "sheets": latest_payload["sheets"],
        # Historical years only; the latest year stays at the top level for
        # backward compatibility with existing validators/consumers.
        "reports_by_year": {
            str(year): p for year, p in payloads.items() if year != latest_year
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    size_kb = OUT.stat().st_size / 1024
    print(f"Wrote {OUT.relative_to(BASE.parent)} ({size_kb:.0f} KB)")
    for sid, rows in latest_payload["sheets"].items():
        print(f"  {sid} ({latest_year}): {len(rows)} rows")


if __name__ == "__main__":
    try:
        export()
    except ValueError as error:
        print()
        print("MANUAL REPORT NOT EXPORTED")
        print(f"Problem: {error}")
        print("Fix: open backend/config/model_powertrain_review.csv, correct the named row, save it as CSV UTF-8, then run MONTHLY_UPDATE.bat again.")
        sys.exit(1)
