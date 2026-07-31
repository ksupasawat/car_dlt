"""test_model_powertrain_review.py — unit tests for model_map.py's review CSV contract.

Covers backend/config/model_powertrain_review.csv: auto-add of newly observed models as
pending, no overwrite of already-reviewed rows, duplicate-key validation, and the
evidence/reviewer/reviewed_at requirement on approved rows. The DLT model source does
not prove Powertrain — new rows are always pending; only a human reviewer can approve.

No pytest — matches the existing test_*.py convention. Runs from any directory. Exits 0
on PASS, 1 on FAIL.
"""
import csv
import os
import sys
import tempfile
from pathlib import Path
import pandas as pd

sys.stdout.reconfigure(encoding="utf-8")

TESTS = Path(__file__).resolve().parent
BACKEND = TESTS.parent
sys.path.insert(0, str(BACKEND))

import model_map

failures = []


def _write_review(rows):
    fd, path = tempfile.mkstemp(suffix=".csv")
    os.close(fd)
    tmp = Path(path)
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=model_map.REVIEW_HEADERS)
        w.writeheader()
        w.writerows(rows)
    return tmp


def test_new_model_appended_as_pending():
    """A model not yet in the review CSV is appended as pending with blank fields."""
    tmp = _write_review([])
    try:
        df = pd.DataFrame([{"ยี่ห้อรถ2": "BYD", "รุ่นรถ": "SEAL", "รุ่นรถ2": "SEAL"}])
        model_map.sync_model_powertrain_review(df, path=tmp)
        with open(tmp, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        if len(rows) != 1:
            failures.append(f"expected 1 appended row, got {len(rows)}")
        else:
            r = rows[0]
            if r["review_status"] != "pending" or r["candidate_powertrain"] != "" or "auto-added" not in r["notes"]:
                failures.append(f"new model row not pending/blank as expected: {r}")
    finally:
        tmp.unlink()


def test_sync_is_idempotent():
    """Running sync twice on the same data must not duplicate the appended row."""
    tmp = _write_review([])
    try:
        df = pd.DataFrame([{"ยี่ห้อรถ2": "BYD", "รุ่นรถ": "SEAL", "รุ่นรถ2": "SEAL"}])
        model_map.sync_model_powertrain_review(df, path=tmp)
        model_map.sync_model_powertrain_review(df, path=tmp)
        with open(tmp, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        if len(rows) != 1:
            failures.append(f"expected sync to be idempotent (1 row), got {len(rows)}")
    finally:
        tmp.unlink()


def test_existing_approved_row_not_overwritten():
    """An already-approved row must survive a sync untouched, even if re-observed."""
    tmp = _write_review([{
        "brand2": "BYD", "raw_model": "ATTO 3", "model2": "ATTO 3",
        "candidate_powertrain": "BEV", "review_status": "approved",
        "evidence": "brochure.pdf", "reviewer": "jet", "reviewed_at": "2026-07-22",
        "notes": "",
    }])
    try:
        df = pd.DataFrame([{"ยี่ห้อรถ2": "BYD", "รุ่นรถ": "ATTO 3", "รุ่นรถ2": "ATTO 3"}])
        model_map.sync_model_powertrain_review(df, path=tmp)
        with open(tmp, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        if len(rows) != 1:
            failures.append(f"expected existing row untouched (1 row), got {len(rows)}")
        elif rows[0]["review_status"] != "approved" or rows[0]["evidence"] != "brochure.pdf":
            failures.append(f"existing approved row was overwritten: {rows[0]}")
    finally:
        tmp.unlink()


def test_duplicate_keys_fail_validation():
    """Two rows normalizing to the same (brand2, raw_model) key must raise on load."""
    tmp = _write_review([
        {"brand2": "BYD", "raw_model": "ATTO 3", "model2": "ATTO 3",
         "candidate_powertrain": "", "review_status": "pending",
         "evidence": "", "reviewer": "", "reviewed_at": "", "notes": ""},
        {"brand2": "byd", "raw_model": " atto 3 ", "model2": "ATTO 3",
         "candidate_powertrain": "", "review_status": "pending",
         "evidence": "", "reviewer": "", "reviewed_at": "", "notes": ""},
    ])
    orig_path = model_map.MODEL_POWERTRAIN_REVIEW_PATH
    model_map.MODEL_POWERTRAIN_REVIEW_PATH = tmp
    try:
        model_map.load_model_powertrain_review()
        failures.append("duplicate (brand2, raw_model) keys did not raise")
    except ValueError:
        pass
    finally:
        model_map.MODEL_POWERTRAIN_REVIEW_PATH = orig_path
        tmp.unlink()


def test_approved_missing_evidence_fails_validation():
    """review_status=approved without evidence/reviewer/reviewed_at must raise."""
    tmp = _write_review([{
        "brand2": "BYD", "raw_model": "ATTO 3", "model2": "ATTO 3",
        "candidate_powertrain": "BEV", "review_status": "approved",
        "evidence": "", "reviewer": "", "reviewed_at": "", "notes": "",
    }])
    orig_path = model_map.MODEL_POWERTRAIN_REVIEW_PATH
    model_map.MODEL_POWERTRAIN_REVIEW_PATH = tmp
    try:
        model_map.load_model_powertrain_review()
        failures.append("approved row missing evidence/reviewer/reviewed_at did not raise")
    except ValueError:
        pass
    finally:
        model_map.MODEL_POWERTRAIN_REVIEW_PATH = orig_path
        tmp.unlink()


def test_invalid_candidate_powertrain_fails_validation():
    """candidate_powertrain outside the allowed set must raise."""
    tmp = _write_review([{
        "brand2": "BYD", "raw_model": "ATTO 3", "model2": "ATTO 3",
        "candidate_powertrain": "DIESEL", "review_status": "pending",
        "evidence": "", "reviewer": "", "reviewed_at": "", "notes": "",
    }])
    orig_path = model_map.MODEL_POWERTRAIN_REVIEW_PATH
    model_map.MODEL_POWERTRAIN_REVIEW_PATH = tmp
    try:
        model_map.load_model_powertrain_review()
        failures.append("invalid candidate_powertrain did not raise")
    except ValueError:
        pass
    finally:
        model_map.MODEL_POWERTRAIN_REVIEW_PATH = orig_path
        tmp.unlink()


def test_blank_rows_dropped_on_sync():
    """Fully-blank rows (Excel trailing blank lines) must be dropped on rewrite."""
    fd, path = tempfile.mkstemp(suffix=".csv")
    os.close(fd)
    tmp = Path(path)
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=model_map.REVIEW_HEADERS)
        w.writeheader()
        w.writerows([{
            "brand2": "BYD", "raw_model": "SEAL", "model2": "SEAL",
            "candidate_powertrain": "", "review_status": "pending",
            "evidence": "", "reviewer": "", "reviewed_at": "", "notes": "",
        }])
        f.write(",,,,,,,,\n" * 5)
    try:
        df = pd.DataFrame([{"ยี่ห้อรถ2": "BYD", "รุ่นรถ": "ATTO 3", "รุ่นรถ2": "ATTO 3"}])
        model_map.sync_model_powertrain_review(df, path=tmp)
        with open(tmp, encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        if len(rows) != 2:
            failures.append(f"expected 2 rows after blank-row cleanup, got {len(rows)}")
        elif any(not r["brand2"].strip() for r in rows):
            failures.append("blank rows survived sync rewrite")
    finally:
        tmp.unlink()


if __name__ == "__main__":
    test_new_model_appended_as_pending()
    test_sync_is_idempotent()
    test_existing_approved_row_not_overwritten()
    test_duplicate_keys_fail_validation()
    test_approved_missing_evidence_fails_validation()
    test_invalid_candidate_powertrain_fails_validation()
    test_blank_rows_dropped_on_sync()
    if failures:
        print(f"FAIL — {len(failures)} issue(s) in model-powertrain-review tests:")
        for f in failures:
            print(f)
        sys.exit(1)
    print("PASS — All model-powertrain-review tests passed successfully.")
