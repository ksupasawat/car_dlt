#!/usr/bin/env python3
"""operator_preflight.py — friendly, stdlib-only preflight for the monthly update.

Validates backend/config/model_powertrain_review.csv BEFORE the long build runs and
prints clear Thai guidance (file / row / column / what to fix) so a non-coding operator
never sees a raw Python stack trace for a CSV typo.

Stdlib only (no pandas) on purpose: this is the safety net — it must run in any Python
and be testable without the full pipeline environment. It mirrors the same contract
enforced by model_map.load_model_powertrain_review(); the drift-guard test keeps the two
in sync. model_map remains the authority.

CLI:
    python operator_preflight.py [path-to-csv]   # validate; exit 1 with Thai errors on failure

Exit 0 = ready. Exit 1 = operator must fix the CSV and re-run.
"""
import csv
import sys
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent
DEFAULT_CSV = BASE / "config" / "model_powertrain_review.csv"

# ponytail: kept in sync with model_map.py by hand (that module owns the contract but
# imports pandas, which this pandas-free safety net must not require). test_operator_preflight
# asserts these match model_map when pandas is available.
REVIEW_HEADERS = [
    "brand2", "raw_model", "model2", "candidate_powertrain", "review_status",
    "evidence", "reviewer", "reviewed_at", "notes",
]
VALID_CANDIDATE_POWERTRAIN = {"BEV", "HEV", "PHEV", "ICE", "ambiguous", "unknown", ""}
VALID_REVIEW_STATUS = {"pending", "approved", "rejected", "ambiguous"}


def normalize_reviewed_at(value):
    """Accept the same common Excel/ISO date values as model_map.py."""
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
        raise ValueError("invalid date") from error


def _norm(v):
    return " ".join(str(v or "").strip().split()).upper()


def validate_review_csv(path=DEFAULT_CSV):
    """Return a list of Thai error strings for model_powertrain_review.csv.

    Empty list means the file passes every rule the build enforces. All rows are
    checked so the operator can fix every problem in one pass, not one per re-run.
    """
    path = Path(path)
    errors = []
    fname = path.name

    if not path.exists():
        return [f"ไม่พบไฟล์: {path} — ต้องมีไฟล์นี้อยู่ (อย่าลบ)"]

    # utf-8-sig: tolerate a BOM from Excel's "CSV UTF-8" save so a real (BOM-only)
    # difference in the header doesn't masquerade as a wrong-columns error.
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != REVIEW_HEADERS:
            errors.append(
                f"{fname}: หัวตาราง (แถวแรก) ไม่ถูกต้อง ต้องเป็นเป๊ะ ๆ ตามนี้:\n"
                f"    {','.join(REVIEW_HEADERS)}\n"
                f"  ที่พบ: {reader.fieldnames}\n"
                f"  วิธีแก้: อย่าแก้/สลับ/ลบชื่อคอลัมน์ในแถวแรก"
            )
            return errors  # column names unknown -> row checks would be meaningless

        seen = {}
        for i, row in enumerate(reader, start=2):  # i = line number in the file
            brand2 = (row.get("brand2") or "").strip()
            raw_model = (row.get("raw_model") or "").strip()
            model2 = (row.get("model2") or "").strip()
            # Skip fully-blank rows (trailing blank lines Excel appends on save);
            # they carry no review data and must never block the update.
            if not (brand2 or raw_model or model2):
                continue
            candidate = (row.get("candidate_powertrain") or "").strip()
            status = (row.get("review_status") or "").strip()
            evidence = (row.get("evidence") or "").strip()
            reviewer = (row.get("reviewer") or "").strip()
            reviewed_at = (row.get("reviewed_at") or "").strip()
            where = f"{fname} แถวที่ {i} ({brand2} / {raw_model})"

            if not brand2 or not raw_model or not model2:
                errors.append(
                    f"{where}: คอลัมน์ brand2 / raw_model / model2 ห้ามเว้นว่าง — เติมให้ครบ"
                )

            if status not in VALID_REVIEW_STATUS:
                errors.append(
                    f"{where}: คอลัมน์ review_status = {status!r} ใช้ไม่ได้ — "
                    f"ต้องเป็นอย่างใดอย่างหนึ่ง: pending, approved, rejected, ambiguous"
                )

            if candidate not in VALID_CANDIDATE_POWERTRAIN:
                errors.append(
                    f"{where}: คอลัมน์ candidate_powertrain = {candidate!r} ใช้ไม่ได้ — "
                    f"ต้องเป็น BEV, HEV, PHEV, ICE, ambiguous, unknown หรือเว้นว่าง"
                )

            if status == "approved" and not (candidate and evidence and reviewer and reviewed_at):
                missing = [
                    name for name, val in (
                        ("candidate_powertrain", candidate), ("evidence", evidence),
                        ("reviewer", reviewer), ("reviewed_at", reviewed_at),
                    ) if not val
                ]
                errors.append(
                    f"{where}: แถวที่ review_status=approved ต้องกรอกให้ครบ — "
                    f"ยังขาดคอลัมน์: {', '.join(missing)}"
                )

            if reviewed_at:
                try:
                    normalize_reviewed_at(reviewed_at)
                except ValueError:
                    errors.append(
                        f"{where}: คอลัมน์ reviewed_at = {reviewed_at!r} ไม่ถูกต้อง — "
                        f"ต้องเป็นฟอร์แมต YYYY-MM-DD (เช่น 2026-07-30)"
                    )

            key = (_norm(brand2), _norm(raw_model))
            if key in seen:
                errors.append(
                    f"{where}: ซ้ำกับแถวที่ {seen[key]} (brand2 + raw_model เดียวกัน) — "
                    f"ต้องมีได้แถวเดียวต่อรุ่น ให้ลบแถวที่ซ้ำออก"
                )
            else:
                seen[key] = i

    return errors


def count_pending(path=DEFAULT_CSV):
    """Number of rows still awaiting human review (review_status=pending)."""
    path = Path(path)
    if not path.exists():
        return 0
    with open(path, encoding="utf-8-sig", newline="") as f:
        return sum(1 for r in csv.DictReader(f) if (r.get("review_status") or "").strip() == "pending")


def _main(argv):
    path = Path(argv[1]) if len(argv) > 1 else DEFAULT_CSV
    errors = validate_review_csv(path)
    if errors:
        print("=" * 60)
        print(f"  พบปัญหาในไฟล์รีวิวรุ่นรถ ({len(errors)} จุด) — ต้องแก้ก่อนถึงจะรันต่อได้")
        print("=" * 60)
        for e in errors:
            print(f"\n- {e}")
        print("\nแก้ไฟล์ backend/config/model_powertrain_review.csv ตามด้านบน แล้วรันใหม่อีกครั้ง")
        return 1
    print(f"OK: ไฟล์รีวิวรุ่นรถผ่านการตรวจสอบ (รอรีวิว {count_pending(path)} แถว)")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(_main(sys.argv))
