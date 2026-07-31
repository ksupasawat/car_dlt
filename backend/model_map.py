"""model_map.py — loaders for model_map.csv and model_powertrain_review.csv.

Sparse CSV-based model name resolution and human-reviewed powertrain classification,
replacing registry-based lookups. The DLT model source does not prove Powertrain — new
rows are always appended as pending; only a human reviewer can approve/reject/mark
ambiguous.
"""
import csv
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

BASE = Path(__file__).resolve().parent
MODEL_MAP_PATH = BASE / "config" / "model_map.csv"
MODEL_POWERTRAIN_REVIEW_PATH = BASE / "config" / "model_powertrain_review.csv"

MODEL_MAP_HEADERS = ["brand2", "raw_model", "model2"]
REVIEW_HEADERS = [
    "brand2", "raw_model", "model2", "candidate_powertrain", "review_status",
    "evidence", "reviewer", "reviewed_at", "notes",
]
VALID_CANDIDATE_POWERTRAIN = {"BEV", "HEV", "PHEV", "ICE", "ambiguous", "unknown", ""}
VALID_REVIEW_STATUS = {"pending", "approved", "rejected", "ambiguous"}


def normalize_reviewed_at(value):
    """Accept common Excel date values and return the canonical YYYY-MM-DD form."""
    text = str(value or "").strip()
    if not text:
        return ""

    if text.isdigit() and 1 <= int(text) <= 100000:
        return (datetime(1899, 12, 30) + timedelta(days=int(text))).date().isoformat()

    for date_format in (
        "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%m-%d-%Y", "%m.%d.%Y",
        "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y",
    ):
        try:
            return datetime.strptime(text, date_format).date().isoformat()
        except ValueError:
            pass

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError as error:
        raise ValueError(
            f"reviewed_at {text!r} must be a valid Excel-style date or ISO timestamp"
        ) from error


def normalize_key(brand2, raw_model):
    """Normalize composite key (brand2, raw_model) for lookup.

    Composite keys strip whitespace, collapse repeated spaces, and uppercase values.
    """
    def _norm(v):
        return " ".join(str(v or "").strip().split()).upper()
    return _norm(brand2), _norm(raw_model)


def _check_headers(reader, expected, path):
    if reader.fieldnames != expected:
        raise ValueError(f"{path}: expected headers {expected}, got {reader.fieldnames}")


def load_model_map():
    """Load model_map.csv into a dict {normalized_key: model2}."""
    result = {}
    with open(MODEL_MAP_PATH, encoding='utf-8-sig') as f:  # tolerate Excel-saved BOM
        reader = csv.DictReader(f)
        _check_headers(reader, MODEL_MAP_HEADERS, MODEL_MAP_PATH)
        for i, row in enumerate(reader, start=2):
            brand2 = (row.get("brand2") or "").strip()
            raw_model = (row.get("raw_model") or "").strip()
            model2 = (row.get("model2") or "").strip()

            # Skip fully-blank rows (trailing blank lines Excel appends on save);
            # they carry no review data and must never fail the build.
            if not (brand2 or raw_model or model2):
                continue

            if not brand2 or not raw_model or not model2:
                raise ValueError(f"{MODEL_MAP_PATH}:{i}: blank brand2/raw_model/model2")

            key = normalize_key(brand2, raw_model)
            if key in result:
                raise ValueError(f"Duplicate key {key} in model_map.csv")
            result[key] = model2

    return result


def model2_map():
    """Convenience loader: returns the model_map dict for name resolution.

    Returns {normalized_key: model2} where normalized_key = (brand2, raw_model).
    """
    return load_model_map()


def load_model_powertrain_review():
    """Load model_powertrain_review.csv into a dict {normalized_key: row}, validating
    the review contract: required headers, no duplicate (brand2, raw_model) keys,
    review_status/candidate_powertrain in their allowed sets, and approved rows
    carrying candidate_powertrain, evidence, reviewer, and reviewed_at.
    """
    result = {}
    with open(MODEL_POWERTRAIN_REVIEW_PATH, encoding='utf-8-sig') as f:  # tolerate Excel-saved BOM
        reader = csv.DictReader(f)
        _check_headers(reader, REVIEW_HEADERS, MODEL_POWERTRAIN_REVIEW_PATH)
        for i, row in enumerate(reader, start=2):
            brand2 = (row.get("brand2") or "").strip()
            raw_model = (row.get("raw_model") or "").strip()
            model2 = (row.get("model2") or "").strip()
            candidate_powertrain = (row.get("candidate_powertrain") or "").strip()
            review_status = (row.get("review_status") or "").strip()
            evidence = (row.get("evidence") or "").strip()
            reviewer = (row.get("reviewer") or "").strip()
            reviewed_at = (row.get("reviewed_at") or "").strip()

            if not brand2 or not raw_model or not model2:
                raise ValueError(f"{MODEL_POWERTRAIN_REVIEW_PATH}:{i}: blank brand2/raw_model/model2")

            if review_status not in VALID_REVIEW_STATUS:
                raise ValueError(
                    f"{MODEL_POWERTRAIN_REVIEW_PATH}:{i}: invalid review_status {review_status!r}, "
                    f"expected one of {sorted(VALID_REVIEW_STATUS)}"
                )

            if candidate_powertrain not in VALID_CANDIDATE_POWERTRAIN:
                raise ValueError(
                    f"{MODEL_POWERTRAIN_REVIEW_PATH}:{i}: invalid candidate_powertrain {candidate_powertrain!r}, "
                    f"expected one of {sorted(VALID_CANDIDATE_POWERTRAIN - {''})} or blank"
                )

            if review_status == "approved" and not (candidate_powertrain and evidence and reviewer and reviewed_at):
                raise ValueError(
                    f"{MODEL_POWERTRAIN_REVIEW_PATH}:{i}: approved row requires candidate_powertrain, "
                    f"evidence, reviewer, and reviewed_at"
                )

            if reviewed_at:
                try:
                    reviewed_at = normalize_reviewed_at(reviewed_at)
                except ValueError as error:
                    raise ValueError(f"{MODEL_POWERTRAIN_REVIEW_PATH}:{i}: {error}") from error
                row["reviewed_at"] = reviewed_at

            key = normalize_key(brand2, raw_model)
            if key in result:
                raise ValueError(f"Duplicate key {key} in model_powertrain_review.csv")
            result[key] = row

    return result


def approved_bev_keys():
    """Return set of normalized keys approved as BEV in model_powertrain_review.csv.

    Only rows with review_status='approved' and candidate_powertrain='BEV' are included.
    """
    review = load_model_powertrain_review()
    return {
        k for k, v in review.items()
        if v.get("review_status", "").strip() == "approved"
        and v.get("candidate_powertrain", "").strip() == "BEV"
    }


def approved_bev_model_keys():
    """Return canonical (brand2, model2) keys approved as BEV for report validation."""
    review = load_model_powertrain_review()
    return {
        normalize_key(v.get("brand2"), v.get("model2"))
        for v in review.values()
        if v.get("review_status", "").strip() == "approved"
        and v.get("candidate_powertrain", "").strip() == "BEV"
    }


def sync_model_powertrain_review(df_model, path=None):
    """Append pending rows for every (brand2, raw_model) pair observed in df_model
    that isn't already present in model_powertrain_review.csv. Never overwrites or
    reorders existing rows — approval/rejection is human-only.

    df_model must carry ยี่ห้อรถ2, รุ่นรถ, รุ่นรถ2 (model grain). Rows are matched by
    the same normalized (brand2, raw_model) key used everywhere else in this module,
    so multiple raw triples differing only in whitespace/case collapse to one
    appended row (first model2 wins).
    """
    path = path or MODEL_POWERTRAIN_REVIEW_PATH

    existing_rows = []
    existing_keys = set()
    if path.exists():
        with open(path, encoding='utf-8-sig', newline='') as f:  # BOM written on rewrite so Excel renders Thai text
            reader = csv.DictReader(f)
            _check_headers(reader, REVIEW_HEADERS, path)
            for row in reader:
                # Drop fully-blank rows (e.g. trailing blank lines Excel appends on save)
                # so they are never carried into the next rewrite.
                if not any((row.get(c) or "").strip() for c in ("brand2", "raw_model", "model2")):
                    continue
                existing_rows.append(row)
                existing_keys.add(normalize_key(row.get("brand2", ""), row.get("raw_model", "")))

    required = {"ยี่ห้อรถ2", "รุ่นรถ", "รุ่นรถ2"}
    if not required.issubset(df_model.columns):
        return

    distinct = df_model[list(required)].dropna(subset=["ยี่ห้อรถ2", "รุ่นรถ"]).drop_duplicates()

    new_rows = []
    for _, r in distinct.iterrows():
        brand2 = str(r["ยี่ห้อรถ2"]).strip()
        raw_model = str(r["รุ่นรถ"]).strip()
        model2_val = r["รุ่นรถ2"]
        model2 = str(model2_val).strip() if pd.notna(model2_val) else raw_model
        if not brand2 or not raw_model:
            continue
        key = normalize_key(brand2, raw_model)
        if key in existing_keys:
            continue
        existing_keys.add(key)
        new_rows.append({
            "brand2": brand2, "raw_model": raw_model, "model2": model2,
            "candidate_powertrain": "", "review_status": "pending",
            "evidence": "", "reviewer": "", "reviewed_at": "",
            "notes": "auto-added from latest model data",
        })

    if not new_rows:
        return

    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=REVIEW_HEADERS)
        w.writeheader()
        w.writerows(existing_rows + new_rows)
