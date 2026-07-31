"""test_operator_preflight.py — unit tests for operator_preflight.py's CSV validator.

Stdlib only, no pytest — matches the existing test_*.py convention. Exits 0 on PASS,
1 on FAIL. Also drift-guards the preflight contract against model_map (skipped if
pandas is unavailable in this environment).
"""
import csv
import os
import sys
import tempfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

TESTS = Path(__file__).resolve().parent
BACKEND = TESTS.parent
sys.path.insert(0, str(BACKEND))

import operator_preflight as op

failures = []

GOOD = {
    "brand2": "BYD", "raw_model": "ATTO 3", "model2": "ATTO 3",
    "candidate_powertrain": "BEV", "review_status": "approved",
    "evidence": "brochure.pdf", "reviewer": "jet", "reviewed_at": "2026-07-22", "notes": "",
}
PENDING = {
    "brand2": "TESLA", "raw_model": "MODEL Y", "model2": "MODEL Y",
    "candidate_powertrain": "", "review_status": "pending",
    "evidence": "", "reviewer": "", "reviewed_at": "", "notes": "auto-added",
}


def _write(rows, headers=None):
    fd, path = tempfile.mkstemp(suffix=".csv")
    os.close(fd)
    tmp = Path(path)
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers or op.REVIEW_HEADERS)
        w.writeheader()
        w.writerows(rows)
    return tmp


def check(name, tmp, expect_error, needle=None):
    try:
        errors = op.validate_review_csv(tmp)
        has = bool(errors)
        if has != expect_error:
            failures.append(f"{name}: expected error={expect_error}, got {errors}")
        elif needle and not any(needle in e for e in errors):
            failures.append(f"{name}: expected an error mentioning {needle!r}, got {errors}")
    finally:
        tmp.unlink()


def test_real_file_passes():
    """The live model_powertrain_review.csv must pass preflight."""
    errors = op.validate_review_csv()  # default path = the real file
    if errors:
        failures.append(f"real CSV failed preflight ({len(errors)} errors), first: {errors[0]!r}")


def test_valid_and_pending_pass():
    check("valid+pending", _write([GOOD, PENDING]), expect_error=False)


def test_bom_tolerated():
    """A BOM (from Excel's 'CSV UTF-8' save) must not be reported as a header error."""
    tmp = _write([GOOD, PENDING])
    raw = tmp.read_bytes()
    tmp.write_bytes(b"\xef\xbb\xbf" + raw)
    check("bom tolerated", tmp, expect_error=False)


def test_bad_headers():
    check("bad headers", _write([], headers=["a", "b"]), expect_error=True, needle="หัวตาราง")


def test_duplicate_keys():
    dup = dict(PENDING, brand2="tesla", raw_model=" model y ")
    check("dup keys", _write([PENDING, dup]), expect_error=True, needle="ซ้ำ")


def test_bad_status():
    check("bad status", _write([dict(PENDING, review_status="done")]),
          expect_error=True, needle="review_status")


def test_bad_candidate():
    check("bad candidate", _write([dict(PENDING, candidate_powertrain="DIESEL")]),
          expect_error=True, needle="candidate_powertrain")


def test_approved_missing_fields():
    check("approved missing", _write([dict(GOOD, evidence="", reviewer="")]),
          expect_error=True, needle="approved")


def test_blank_rows_skipped():
    """Fully-blank trailing rows (Excel save artifact) must not be reported as errors."""
    tmp = _write([PENDING])
    with open(tmp, "a", newline="") as f:
        f.write(",,,,,,,,\n" * 5)
    check("blank rows skipped", tmp, expect_error=False)


def test_blank_required():
    check("blank required", _write([dict(PENDING, model2="")]),
          expect_error=True, needle="ห้ามเว้นว่าง")


def test_collects_all_errors():
    tmp = _write([dict(PENDING, review_status="done"), dict(PENDING, brand2="X", candidate_powertrain="DIESEL")])
    try:
        errors = op.validate_review_csv(tmp)
        if len(errors) < 2:
            failures.append(f"expected multiple errors collected, got {errors}")
    finally:
        tmp.unlink()


def test_count_pending():
    tmp = _write([GOOD, PENDING, dict(PENDING, raw_model="MODEL 3")])
    try:
        n = op.count_pending(tmp)
        if n != 2:
            failures.append(f"count_pending expected 2, got {n}")
    finally:
        tmp.unlink()


def test_common_excel_date_formats_pass():
    for value in ("7/30/2026", "30/7/2026", "2026/07/30", "2026-07-30T09:00:00Z", "46233"):
        check(f"valid date {value}", _write([dict(GOOD, reviewed_at=value)]), expect_error=False)


def test_bad_date_format():
    check("bad date format", _write([dict(GOOD, reviewed_at="not a date")]),
          expect_error=True, needle="reviewed_at")
    check("blank date format", _write([dict(PENDING, reviewed_at="")]),
          expect_error=False)


def test_contract_matches_model_map():
    """Drift guard: preflight constants must equal model_map's (skipped without pandas)."""
    try:
        import model_map
    except Exception as e:
        print(f"  (skipped drift guard: model_map import failed: {e})")
        return
    if op.REVIEW_HEADERS != model_map.REVIEW_HEADERS:
        failures.append("REVIEW_HEADERS drifted from model_map")
    if op.VALID_REVIEW_STATUS != model_map.VALID_REVIEW_STATUS:
        failures.append("VALID_REVIEW_STATUS drifted from model_map")
    if op.VALID_CANDIDATE_POWERTRAIN != model_map.VALID_CANDIDATE_POWERTRAIN:
        failures.append("VALID_CANDIDATE_POWERTRAIN drifted from model_map")
    for value in ("2026-07-30", "7/30/2026", "30/7/2026", "46233"):
        if op.normalize_reviewed_at(value) != model_map.normalize_reviewed_at(value):
            failures.append(f"date normalization differs for {value}")


if __name__ == "__main__":
    test_real_file_passes()
    test_valid_and_pending_pass()
    test_bom_tolerated()
    test_bad_headers()
    test_duplicate_keys()
    test_bad_status()
    test_bad_candidate()
    test_approved_missing_fields()
    test_blank_rows_skipped()
    test_blank_required()
    test_collects_all_errors()
    test_count_pending()
    test_common_excel_date_formats_pass()
    test_bad_date_format()
    test_contract_matches_model_map()
    if failures:
        print(f"FAIL — {len(failures)} issue(s) in operator-preflight tests:")
        for f in failures:
            print(f)
        sys.exit(1)
    print("PASS — All operator-preflight tests passed successfully.")
