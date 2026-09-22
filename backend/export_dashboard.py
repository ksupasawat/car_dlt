"""Export multi-year dashboard data from parquet to flat JSON."""
import os
import sys
import json
import datetime
from pathlib import Path

import pandas as pd

from aggregate import aggregate, current_period
from schema import validate_model, validate_fuel
from build_cleaned import load_powertrain_map
import model_map
import bev_attribution

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path(__file__).resolve().parent
MODEL_PARQUET = BASE / "test_model_cleaned.parquet"
FUEL_PARQUET  = BASE / "test_fuel_cleaned.parquet"
# PUBLIC_DATA_DIR lets the monthly operator build into a staging dir (safe no-collapse
# publish); unset = the live public dir, so normal runs are unchanged.
FRONTEND_DATA_DIR = Path(os.environ.get("PUBLIC_DATA_DIR") or (BASE.parent / "frontend" / "public" / "data"))
FRONTEND_DATA_DIR.mkdir(parents=True, exist_ok=True)

# Master dictionary for vehicle types from user prompt
VEHICLE_TYPE_DICT = {
    "รย.1": "รย.1 (รถยนต์นั่งส่วนบุคคลไม่เกิน 7 คน / เก๋ง)",
    "รย.2": "รย.2 (รถยนต์นั่งส่วนบุคคลเกิน 7 คน / ตู้)",
    "รย.3": "รย.3 (รถยนต์บรรทุกส่วนบุคคล / กระบะ)",
    "รย.6": "รย.6 (รถยนต์รับจ้างบรรทุกคนโดยสารไม่เกิน 7 คน / แท็กซี่)",
    "รย.9": "รย.9 (รถยนต์บริการธุรกิจ / รถเช่า)",
    "รย.10": "รย.10 (รถยนต์บริการทัศนาจร / รถตู้เช่า)",
    "รย.11": "รย.11 (รถยนต์บริการให้เช่า)"
}


# Canonical fuel->powertrain mapping, single source of truth (see config/powertrain_map.csv).
FUEL_MAP = load_powertrain_map(str(BASE / "config" / "powertrain_map.csv"))

MODEL_SEGMENT_PATH = BASE / "config" / "model_segment.csv"


def load_model_segment_map(path=MODEL_SEGMENT_PATH) -> dict:
    """(brand2, model2) -> market segment, e.g. B-SUV / C-Segment / MPV.

    DLT publishes no segment of any kind, so this is a curated CSV using the naming
    Autolifethailand uses in its price announcements. Absent or unlisted models stay
    unclassified rather than being guessed at export time; edit the CSV to extend it.
    """
    if not path.exists():
        return {}
    import csv

    out = {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            brand = (row.get("brand2") or "").strip()
            model = (row.get("model2") or "").strip()
            seg = (row.get("market_segment") or "").strip()
            if brand and model and seg:
                out[(brand.upper(), model.upper())] = seg
    return out

MONTH_MAP = {
    "มกราคม": "Jan", "กุมภาพันธ์": "Feb", "มีนาคม": "Mar",
    "เมษายน": "Apr", "พฤษภาคม": "May", "มิถุนายน": "Jun",
    "กรกฎาคม": "Jul", "สิงหาคม": "Aug", "กันยายน": "Sep",
    "ตุลาคม": "Oct", "พฤศจิกายน": "Nov", "ธันวาคม": "Dec",
}

MONTH_IDX = {m: i for i, m in enumerate(MONTH_MAP.values())}

FULL_MONTH_EN = {
    "Jan": "January", "Feb": "February", "Mar": "March", "Apr": "April",
    "May": "May", "Jun": "June", "Jul": "July", "Aug": "August",
    "Sep": "September", "Oct": "October", "Nov": "November", "Dec": "December",
}

def build_brand_model_tree(df_model_rows: pd.DataFrame, df_fuel: pd.DataFrame | None = None) -> list:
    """Build model facts as brand -> canonical series -> unclassified PT segments.

    Brand and series nodes expose source totals in ``monthly``. A series splits into one
    powertrain segment per proven class: rows whose (brand2, raw_model) a human approved
    as BEV in model_powertrain_review.csv become a ``BEV`` segment, everything else stays
    ``N/A``. Nothing is guessed from the fuel grain — an unreviewed row is unclassified.
    When ``df_fuel`` is given, BEV is reconciled to the fuel grain cell by cell: nameplates
    listed in config/model_powertrain_mixed.csv are split, and any BEV the fuel grain still
    holds goes to a per-brand ``BEV (ไม่ระบุรุ่น)`` series (+BEV / -N/A, net zero). The segments must still sum back to the series total at every
    vehicle/province/year/month coordinate.

    Series also carry ``market_segment`` (B-SUV, C-Segment, MPV, ...) from
    config/model_segment.csv, or None when that model is not listed there.
    """
    df_model_rows = df_model_rows.copy()
    if df_fuel is not None:
        # Exact reconciliation with the fuel grain: approved rows, mixed nameplates split
        # per cell, and a per-brand unattributed line (see bev_attribution.py).
        df_model_rows, stats = bev_attribution.attribute_bev(df_model_rows, df_fuel)
        print(f"  BEV attribution: fuel {stats['fuel_bev']:,} = approved {stats['pure_bev']:,} "
              f"+ mixed {stats['mixed_bev']:,} + unattributed {stats['unattributed_bev']:,} "
              f"(overshoot {stats['overshoot']:,})")
    else:
        approved = model_map.approved_bev_keys()
        if approved and "รุ่นรถ" in df_model_rows.columns:
            keys = [
                model_map.normalize_key(b, r)
                for b, r in zip(df_model_rows["ยี่ห้อรถ2"], df_model_rows["รุ่นรถ"])
            ]
            df_model_rows["PT"] = ["BEV" if k in approved else "N/A" for k in keys]

    segment_map = load_model_segment_map()

    # Not aggregate(): it drops non-positive cells, and the unattributed series carries a
    # deliberate negative N/A segment that must survive to keep brand totals exact.
    model_grp = (
        df_model_rows.groupby(["ยี่ห้อรถ2", "รุ่นรถ2", "PT", "v_code", "จังหวัด", "ปี", "เดือน"])["จำนวนรถ"]
        .sum().reset_index()
    )
    model_grp = model_grp[model_grp["จำนวนรถ"] != 0]

    brand_map: dict = {}

    def add_month(monthly: dict, vehicle_type, province, year, month_idx, units):
        monthly.setdefault(vehicle_type, {}).setdefault(province, {}).setdefault(year, [0] * 12)[month_idx] += units

    for _, row in model_grp.iterrows():
        brand = row["ยี่ห้อรถ2"]
        series = row["รุ่นรถ2"]
        powertrain = row["PT"] or "N/A"
        vehicle_type = row["v_code"]
        province = row["จังหวัด"]
        year = str(int(row["ปี"]))
        month_idx = MONTH_IDX.get(row["เดือน"])
        units = int(row["จำนวนรถ"])
        if month_idx is None:
            continue

        brand_node = brand_map.setdefault(brand, {"brand": brand, "monthly": {}, "models": {}})
        series_node = brand_node["models"].setdefault(series, {"name": series, "monthly": {}, "segments": {}})
        segment = series_node["segments"].setdefault(powertrain, {"powertrain": powertrain, "monthly": {}})
        for node in (brand_node, series_node, segment):
            add_month(node["monthly"], vehicle_type, province, year, month_idx, units)

    def total(node: dict) -> int:
        return sum(
            sum(arr)
            for province_buckets in node["monthly"].values()
            for year_buckets in province_buckets.values()
            for arr in year_buckets.values()
        )

    result = []
    for bn in sorted(brand_map.values(), key=lambda x: -total(x)):
        models = []
        for series in sorted(bn["models"].values(), key=lambda x: -total(x)):
            models.append({
                "name": series["name"],
                "market_segment": segment_map.get((bn["brand"].upper(), series["name"].upper())),
                "monthly": series["monthly"],
                "segments": list(series["segments"].values()),
            })
        result.append({
            "brand": bn["brand"],
            "monthly": bn["monthly"],
            "models": models,
        })
    return result


def short_code(label: str) -> str:
    import re
    return re.split(r'[\s(]', str(label))[0].strip()

def load_data(parquet: Path, is_fuel: bool) -> pd.DataFrame:
    df = pd.read_parquet(str(parquet))
    validate_fuel(df) if is_fuel else validate_model(df)

    # Strip whitespace from ประเภทรถ to match correctly
    df["ประเภทรถ"] = df["ประเภทรถ"].astype(str).str.strip()

    # Extract just the numbers for "รย.XX" to normalize them
    codes = df["ประเภทรถ"].str.extract(r"รย\.\s*0*(\d+)")[0]

    # Create clean vehicle type column
    df["v_code"] = "รย." + codes
    df["v_code"] = df["v_code"].fillna(df["ประเภทรถ"])

    # Map to full Thai name if in dictionary, otherwise keep the source label.
    df["v"] = df["v_code"].map(VEHICLE_TYPE_DICT).fillna(df["ประเภทรถ"])

    # Fuel facts derive PT from fuel. Model grain never carries Powertrain (source-of-truth
    # lives in the fuel grain only), so model PT is always N/A.
    if is_fuel:
        df["PT"] = df["ชนิดเชื้อเพลิง"].map(FUEL_MAP).fillna("N/A")
    else:
        df["PT"] = "N/A"

    df["จำนวนรถ"] = pd.to_numeric(df["จำนวนรถ"], errors="coerce").fillna(0).astype(int)
    df["ปี"] = pd.to_numeric(df["ปี"], errors="coerce").dropna().astype(int)
    df["เดือน"] = df["เดือน"].map(MONTH_MAP)
    df = df.dropna(subset=["ปี", "เดือน"])
    df["จังหวัด"] = df["จังหวัด"].fillna("ไม่ระบุจังหวัด").astype(str).str.strip()
    df.loc[df["จังหวัด"] == "", "จังหวัด"] = "ไม่ระบุจังหวัด"
    return df


def export_data():
    missing = [p for p in [MODEL_PARQUET, FUEL_PARQUET] if not p.exists()]
    if missing:
        print(f"Parquet not found: {', '.join(str(p) for p in missing)}")
        return

    print(f"Reading {MODEL_PARQUET.name} for model data...")
    df_model_all = load_data(MODEL_PARQUET, is_fuel=False)
    print(f"  {len(df_model_all):,} model rows loaded")

    print(f"Reading {FUEL_PARQUET.name} for brand/powertrain data...")
    df_fuel_all = load_data(FUEL_PARQUET, is_fuel=True)
    df_fuel_all["ชนิดเชื้อเพลิง"] = df_fuel_all["ชนิดเชื้อเพลิง"].fillna("")
    print(f"  {len(df_fuel_all):,} fuel rows loaded")

    # Use all rows, no รย filter
    df = df_model_all
    df_fuel = df_fuel_all

    # 1. Powertrain master from fuel parquet
    pm_grp = aggregate(
        df_fuel,
        ["ชนิดเชื้อเพลิง", "PT", "ปี"],
        {"mode": "monthly", "units_col": "จำนวนรถ"},
    )
    pm_data = []
    for _, row in pm_grp.iterrows():
        pm_data.append({
            "f": row["ชนิดเชื้อเพลิง"], "pt": row["PT"],
            "y": int(row["ปี"]), "u": int(row["จำนวนรถ"])
        })

    # 2. Brand/model tree from model facts only
    print("  Building brand_model_tree...")
    brand_model_tree = build_brand_model_tree(df, df_fuel)
    classified = sum(1 for b in brand_model_tree for m in b["models"] if m.get("market_segment"))
    bev_series = sum(1 for b in brand_model_tree for m in b["models"]
                     for s in m["segments"] if s.get("powertrain") == "BEV")
    print(f"  model series with a market segment: {classified:,}")
    print(f"  model series carrying a proven BEV segment: {bev_series:,}")
    tree_total = sum(
        sum(arr)
        for bn in brand_model_tree
        for province_buckets in bn["monthly"].values()
        for year_buckets in province_buckets.values()
        for arr in year_buckets.values()
    )
    print(f"  brand_model_tree total units (model): {tree_total:,}")

    # 3. Fuel & Powertrain monthly (from fuel parquet)
    fuel_grp = aggregate(
        df_fuel,
        ["ปี", "เดือน", "PT", "ชนิดเชื้อเพลิง", "v"],
        {"mode": "monthly", "units_col": "จำนวนรถ"},
    )
    fuel_data = []
    for _, row in fuel_grp.iterrows():
        fuel_data.append({
            "y": int(row["ปี"]), "m": row["เดือน"], "pt": row["PT"],
            "f": row["ชนิดเชื้อเพลิง"], "v": short_code(row["v"]), "u": int(row["จำนวนรถ"])
        })

    # 4. Brand monthly (from fuel parquet)
    brand_grp = aggregate(
        df_fuel,
        ["ปี", "เดือน", "PT", "ยี่ห้อรถ2", "v"],
        {"mode": "monthly", "units_col": "จำนวนรถ"},
    )
    brand_data = []
    for _, row in brand_grp.iterrows():
        brand_data.append({
            "y": int(row["ปี"]), "m": row["เดือน"], "pt": row["PT"],
            "b": row["ยี่ห้อรถ2"], "v": short_code(row["v"]), "u": int(row["จำนวนรถ"])
        })

    # 5. Model monthly from model parquet (export all models)
    model_grp = aggregate(
        df,
        ["ปี", "เดือน", "PT", "ยี่ห้อรถ2", "รุ่นรถ2", "v"],
        {"mode": "monthly", "units_col": "จำนวนรถ"},
    )
    model_data = []
    for _, row in model_grp.iterrows():
        model_data.append({
            "y": int(row["ปี"]), "m": row["เดือน"], "pt": row["PT"],
            "b": row["ยี่ห้อรถ2"], "mod": row["รุ่นรถ2"], "v": short_code(row["v"]), "u": int(row["จำนวนรถ"])
        })

    # Meta from model parquet (has province + full vehicle type list)
    years = sorted(df_model_all["ปี"].unique().tolist())
    all_v = sorted(df["v"].unique().tolist())
    provinces = sorted(df_model_all["จังหวัด"].unique().tolist())
    vehicle_labels = (
        df_model_all[["v_code", "v"]]
        .drop_duplicates()
        .sort_values("v_code", key=lambda s: s.str.extract(r"(\d+)")[0].astype(int))
    )
    vehicle_types_list = [
        {"code": row["v_code"], "label": row["v"]}
        for _, row in vehicle_labels.iterrows()
    ]

    # --- BRAND FOCUS ---
    TARGET_BRAND = "Deepal + Changan"
    BEV_PT = "BEV"

    month_order = list(MONTH_MAP.values())

    all_periods = set((row["y"], row["m"]) for row in brand_data)
    sorted_periods = sorted(list(all_periods), key=lambda x: (x[0], month_order.index(x[1])))
    if sorted_periods:
        latest_y, latest_m_num = current_period(df_fuel, year_col="ปี", month_col="เดือน", month_order=month_order)
        latest_m = month_order[latest_m_num - 1]
    else:
        latest_y, latest_m = None, None

    reporting_period = (
        f"{FULL_MONTH_EN.get(latest_m, latest_m)} {latest_y}" if latest_y is not None else None
    )

    if latest_y is not None:
        latest_m_idx = month_order.index(latest_m)
        if latest_m_idx == 0:
            prev_m_idx = 11
            prev_y = latest_y - 1
        else:
            prev_m_idx = latest_m_idx - 1
            prev_y = latest_y
        prev_m = month_order[prev_m_idx]

        monthly_units_dict = {}
        monthly_bev_dict = {}
        total_bev_monthly_dict = {}
        latest_month_bev = {}

        for row in brand_data:
            k = (row["y"], row["m"])
            u = row["u"]
            b = row["b"]
            pt = row["pt"]

            if b == TARGET_BRAND:
                monthly_units_dict[k] = monthly_units_dict.get(k, 0) + u
                if pt == BEV_PT:
                    monthly_bev_dict[k] = monthly_bev_dict.get(k, 0) + u

            if pt == BEV_PT:
                total_bev_monthly_dict[k] = total_bev_monthly_dict.get(k, 0) + u
                if k == (latest_y, latest_m):
                    latest_month_bev[b] = latest_month_bev.get(b, 0) + u

        monthly_units = []
        monthly_bev = []
        bev_share_monthly = []

        for y, m in sorted_periods:
            k = (y, m)
            mu = monthly_units_dict.get(k, 0)
            mbev = monthly_bev_dict.get(k, 0)
            tbev = total_bev_monthly_dict.get(k, 0)

            monthly_units.append({"y": y, "m": m, "u": mu})
            monthly_bev.append({"y": y, "m": m, "u": mbev})

            share = mbev / tbev if tbev > 0 else 0.0
            bev_share_monthly.append({"y": y, "m": m, "share": round(share, 4)})

        ytd = sum(u for (y, m), u in monthly_units_dict.items() if y == latest_y)
        ytd_bev = sum(u for (y, m), u in monthly_bev_dict.items() if y == latest_y)

        latest_units = monthly_units_dict.get((latest_y, latest_m), 0)
        prev_units = monthly_units_dict.get((prev_y, prev_m), 0)
        mom_change = latest_units - prev_units

        bev_competitor_ranking = [{"brand": b, "u": u} for b, u in latest_month_bev.items() if u > 0]
        bev_competitor_ranking.sort(key=lambda x: -x["u"])

        bev_rank_latest = next((i + 1 for i, item in enumerate(bev_competitor_ranking) if item["brand"] == TARGET_BRAND), None)

        top_models_dict = {}
        for row in model_data:
            if row["b"] == TARGET_BRAND and row["y"] == latest_y and row["m"] == latest_m:
                k = (row["mod"], row["pt"])
                top_models_dict[k] = top_models_dict.get(k, 0) + row["u"]

        top_models = [{"mod": mod, "pt": pt, "u": u} for (mod, pt), u in top_models_dict.items()]
        top_models.sort(key=lambda x: -x["u"])

        brand_focus = {
            "monthly_units": monthly_units,
            "monthly_bev": monthly_bev,
            "ytd": ytd,
            "ytd_bev": ytd_bev,
            "mom_change": mom_change,
            "bev_share_monthly": bev_share_monthly,
            "bev_rank_latest": bev_rank_latest,
            "bev_competitor_ranking": bev_competitor_ranking,
            "top_models": top_models,
            "latest": {"y": latest_y, "m": latest_m}
        }
    else:
        brand_focus = {}

    print("brand_focus keys: " + str(list(brand_focus.keys())))

    summary_data = {
        "meta": {"years": years, "months": list(MONTH_MAP.values()),
                 "vehicle_types": all_v, "vehicle_types_list": vehicle_types_list,
                 "provinces": provinces,
                 "generated_at": datetime.datetime.now().isoformat(),
                 "latest_year": latest_y, "latest_month": latest_m,
                 "reporting_period": reporting_period},
        "powertrain_master": pm_data,
        "fuel_monthly": fuel_data,
        "brand_monthly": brand_data,
        "brand_focus": brand_focus,
    }

    models_data = {
        "meta": summary_data["meta"],
        "brand_model_tree": brand_model_tree,
    }

    print(f"  powertrain_master rows: {len(pm_data):,}")
    print(f"  fuel_monthly rows: {len(fuel_data):,}")
    print(f"  brand_monthly rows: {len(brand_data):,}")
    print(f"  brand_model_tree brands: {len(brand_model_tree):,}")

    summary_file = FRONTEND_DATA_DIR / "dashboard_summary.json"
    with open(summary_file, "w", encoding="utf-8") as f:
        json.dump(summary_data, f, ensure_ascii=False)

    models_file = FRONTEND_DATA_DIR / "dashboard_models.json"
    with open(models_file, "w", encoding="utf-8") as f:
        json.dump(models_data, f, ensure_ascii=False)

    sum_mb = summary_file.stat().st_size / (1024 * 1024)
    mod_mb = models_file.stat().st_size / (1024 * 1024)
    print(f"Exported to {summary_file.name} ({sum_mb:.2f} MB)")
    print(f"Exported to {models_file.name} ({mod_mb:.2f} MB)")

    print(f"Filtered model summary total: {df['จำนวนรถ'].sum():,}")

    # Run validation
    validate_export(summary_data, models_data, int(df_model_all["จำนวนรถ"].sum()), int(df_fuel_all["จำนวนรถ"].sum()))

    # --- Export Metadata Manifest Only (No Parquet Copies) ---
    raw_model_cols = list(pd.read_parquet(MODEL_PARQUET).columns)
    raw_fuel_cols = list(pd.read_parquet(FUEL_PARQUET).columns)

    manifest = {
        "generated_at": datetime.datetime.now().isoformat(),
        "latest_year": latest_y,
        "latest_month": latest_m,
        "reporting_period": reporting_period,
        "model_row_count": len(df_model_all),
        "fuel_row_count": len(df_fuel_all),
        "model_total_units": int(df_model_all["จำนวนรถ"].sum()),
        "fuel_total_units": int(df_fuel_all["จำนวนรถ"].sum()),
        "years_present": sorted([int(y) for y in df_model_all["ปี"].unique() if pd.notnull(y)]),
        "vehicle_type_codes": sorted([str(v) for v in df_model_all["v_code"].unique() if pd.notnull(v)]),
        "model_columns": raw_model_cols,
        "fuel_columns": raw_fuel_cols
    }

    manifest_dest = FRONTEND_DATA_DIR / "cleaned_data_manifest.json"
    with open(manifest_dest, "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, indent=2, ensure_ascii=False)

    print(f"Exported manifest to {FRONTEND_DATA_DIR.name}")

def validate_export(summary: dict, models: dict, source_model_sum: int, source_fuel_sum: int):
    print("\n--- VALIDATING DASHBOARD EXPORT ---")
    fuel_total = sum(d.get("u", 0) for d in summary.get("fuel_monthly", []))
    brand_monthly_total = sum(d.get("u", 0) for d in summary.get("brand_monthly", []))

    brand_total = 0
    model_total = 0
    tree_by_v = set()

    for b in models.get("brand_model_tree", []):
        b_sum = 0
        for v, v_data in b.get("monthly", {}).items():
            tree_by_v.add(v)
            for p, p_data in v_data.items():
                for y, y_data in p_data.items():
                    if isinstance(y_data, list):
                        b_sum += sum(x for x in y_data if x)
        brand_total += b_sum

        m_sum = 0
        for m in b.get("models", []):
            for v, v_data in m.get("monthly", {}).items():
                tree_by_v.add(v)
                for p, p_data in v_data.items():
                    for y, y_data in p_data.items():
                        if isinstance(y_data, list):
                            m_sum += sum(x for x in y_data if x)
        model_total += m_sum

    print(f"  fuel_monthly total: {fuel_total:,}")
    print(f"  brand_monthly total: {brand_monthly_total:,}")
    print(f"  brand_model_tree brand total: {brand_total:,}")
    print(f"  brand_model_tree model total: {model_total:,}")
    print(f"  Source model parquet total: {source_model_sum:,}")
    print(f"  Source fuel parquet total: {source_fuel_sum:,}")

    meta_v_list = summary.get("meta", {}).get("vehicle_types_list", [])
    meta_v_codes = {v["code"] for v in meta_v_list}

    print(f"  Vehicle types exported in tree: {len(tree_by_v)} codes")
    print(f"  {sorted(list(tree_by_v))}")

    # Assertions
    if not (fuel_total == brand_monthly_total == brand_total == model_total == source_model_sum == source_fuel_sum):
        raise ValueError(
            f"VALIDATION FAILED: Totals do not match!\n"
            f"  fuel_monthly={fuel_total}\n"
            f"  brand_monthly={brand_monthly_total}\n"
            f"  brand_tree={brand_total}\n"
            f"  model_tree={model_total}\n"
            f"  source_model={source_model_sum}\n"
            f"  source_fuel={source_fuel_sum}"
        )

    missing_in_meta = tree_by_v - meta_v_codes
    if missing_in_meta:
        raise ValueError(f"VALIDATION FAILED: Vehicle types in tree missing from meta.vehicle_types_list: {missing_in_meta}")

    # Invariant: No duplicated dataset or wrong shapes
    if "brand_model_tree" in summary:
        raise ValueError("VALIDATION FAILED: brand_model_tree should not be present in dashboard_summary.json")
    if "model_monthly_all" in models:
        raise ValueError("VALIDATION FAILED: model_monthly_all should not be present in dashboard_models.json")
    if "fuel_monthly" in models:
        raise ValueError("VALIDATION FAILED: fuel_monthly should not be present in dashboard_models.json")

    print("VALIDATION PASSED: All totals reconcile, shapes are correct, and vehicle types are properly mapped.\n")

if __name__ == "__main__":
    export_data()
