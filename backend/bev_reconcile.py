#!/usr/bin/env python3
"""
bev_reconcile.py — find BEV models the candidate rules miss.

The watchlist in bev_candidates.py only flags a pending model when its name
carries an EV/BEV/ELECTRIC marker or closely resembles an already-approved BEV
name. A model like "NEVO Q05" has neither, so it stays pending forever and never
reaches Sheets 7-8 even while it registers a thousand units a month.

This script closes that gap without inferring anything. The fuel grain already
knows each brand's true monthly BEV total (derived from ชนิดเชื้อเพลิง). For one
brand, the set of BEV models is whatever subset of its model rows reproduces
those monthly totals. Solve that subset exactly, over many months at once, and
only accept the answer when it is the ONLY subset that fits — a set that matches
12 independent monthly sums by coincidence does not happen in practice.

Nothing is guessed: a brand whose answer is not unique, or has no exact answer
(usually a model2 that groups a BEV and a non-BEV trim under one name, e.g. a
nameplate sold as both EV and HEV), is reported and left pending for a human.

Usage:
    python bev_reconcile.py                 # report only, writes nothing
    python bev_reconcile.py --apply         # also approve the proven rows
    python bev_reconcile.py --months 6      # narrow the reconciliation window
    python bev_reconcile.py --reviewer NAME # who to record on approved rows

Reads : test_model_cleaned.parquet, test_fuel_cleaned.parquet,
        config/model_powertrain_review.csv
Writes: reports/bev_reconcile.txt (always)
        config/model_powertrain_review.csv (only with --apply)
"""

import argparse
import csv
import sys
from datetime import date
from pathlib import Path

import pandas as pd

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path(__file__).resolve().parent
MODEL_PARQUET = BASE / "test_model_cleaned.parquet"
FUEL_PARQUET = BASE / "test_fuel_cleaned.parquet"
REVIEW_CSV = BASE / "config" / "model_powertrain_review.csv"
REPORT = BASE.parent / "reports" / "bev_reconcile.txt"

# Same scope as the manual report sheets (export_manual_report.DEFAULT_VEHICLE_TYPES).
VEHICLE_TYPES = ["รย.1", "รย.2", "รย.3", "รย.6", "รย.9", "รย.10", "รย.11"]

THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
               "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"]

# Generic placeholder names carry no model identity, so they are never
# auto-approved even when the arithmetic puts them in the BEV set — the project
# already files these as `ambiguous` by hand (e.g. BYD ไม่ระบุ).
GENERIC_NAMES = {"ไม่ระบุ", "ไม่ทราบ", "-", ""}

MIN_BRAND_UNITS = 20      # ignore brands with a trivial BEV footprint
MAX_MODELS = 80           # above this the search is not worth attempting
NODE_BUDGET = 400_000     # give up rather than hang on a pathological brand


# ── the solver ────────────────────────────────────────────────────────────────

def solve(rows, targets, limit=2):
    """Exact subset selection.

    rows[i] is one model's monthly unit vector; targets is the brand's monthly
    BEV vector. Returns up to `limit` distinct 0/1 selections x with
    sum(x[i] * rows[i]) == targets for every month, plus a flag saying whether
    the search finished (False = hit the node budget, answer not trustworthy).

    Models are tried heaviest-first: the big ones fix most of each month's total
    early, so contradictions surface near the root and the tree stays small.
    """
    n = len(rows)
    months = len(targets)
    order = sorted(range(n), key=lambda i: -sum(rows[i]))

    # suffix[k][m] = units still available from models order[k:] in month m,
    # i.e. the most the remaining choices can still add.
    suffix = [[0] * months for _ in range(n + 1)]
    for k in range(n - 1, -1, -1):
        r = rows[order[k]]
        for m in range(months):
            suffix[k][m] = suffix[k + 1][m] + r[m]

    found = []
    nodes = 0
    exhausted = True

    def walk(k, partial, chosen):
        nonlocal nodes, exhausted
        if len(found) >= limit or not exhausted:
            return
        nodes += 1
        if nodes > NODE_BUDGET:
            exhausted = False
            return
        for m in range(months):
            if partial[m] > targets[m]:
                return                                   # already overshot
            if partial[m] + suffix[k][m] < targets[m]:
                return                                   # can no longer reach
        if k == n:
            if partial == targets:
                found.append(set(chosen))
            return
        i = order[k]
        r = rows[i]
        walk(k + 1, [partial[m] + r[m] for m in range(months)], chosen + [i])  # take
        walk(k + 1, partial, chosen)                                           # skip

    walk(0, [0] * months, [])
    return found, exhausted


# ── data loading ──────────────────────────────────────────────────────────────

def load_frames():
    for p in (MODEL_PARQUET, FUEL_PARQUET):
        if not p.exists():
            print(f"ERROR: ไม่พบไฟล์ {p.name} — ให้รัน build_cleaned.py ก่อน")
            sys.exit(1)
    model = pd.read_parquet(str(MODEL_PARQUET))
    fuel = pd.read_parquet(str(FUEL_PARQUET))
    for df in (model, fuel):
        df["ปี"] = pd.to_numeric(df["ปี"], errors="coerce")
        df["จำนวนรถ"] = pd.to_numeric(df["จำนวนรถ"], errors="coerce").fillna(0).astype(int)
    keep = lambda df: df[df["ประเภทรถ"].astype(str).str.split(" ").str[0].isin(VEHICLE_TYPES)]
    return keep(model), keep(fuel)


def window(fuel, months):
    """The last `months` (year, thai-month) pairs that carry data, oldest first."""
    seen = fuel.groupby(["ปี", "เดือน"])["จำนวนรถ"].sum()
    pairs = [(int(y), m) for (y, m), v in seen.items() if v > 0]
    pairs.sort(key=lambda p: (p[0], THAI_MONTHS.index(p[1])))
    return pairs[-months:]


def read_review():
    if not REVIEW_CSV.exists():
        print(f"ERROR: ไม่พบ {REVIEW_CSV}")
        sys.exit(1)
    with REVIEW_CSV.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh)), None


# ── reconciliation ────────────────────────────────────────────────────────────

def reconcile(model, fuel, months):
    """Per brand: (status, bev_models, bev_units). status in solved/ambiguous/
    infeasible/too-many/budget."""
    cols = window(fuel, months)
    bev = fuel[fuel["Powertrain"] == "BEV"]
    out = {}

    for brand, brand_bev in bev.groupby("ยี่ห้อรถ2")["จำนวนรถ"].sum().items():
        if brand_bev < MIN_BRAND_UNITS:
            continue
        mb = model[model["ยี่ห้อรถ2"] == brand]
        mb = mb[[(y, m) in cols for y, m in zip(mb["ปี"], mb["เดือน"])]]
        if mb.empty:
            continue

        grid = mb.groupby(["รุ่นรถ2", "ปี", "เดือน"])["จำนวนรถ"].sum()
        names = sorted({str(k[0]) for k in grid.index})
        # A model with no units in the window constrains nothing, so leaving it in
        # would make every answer "ambiguous" for a reason that carries no meaning.
        names = [n for n in names if sum(int(grid.get((n, y, m), 0)) for y, m in cols) > 0]
        if not names:
            continue
        if len(names) > MAX_MODELS:
            out[brand] = ("too-many", [], int(brand_bev))
            continue

        rows = [[int(grid.get((n, y, m), 0)) for y, m in cols] for n in names]
        fb = bev[bev["ยี่ห้อรถ2"] == brand].groupby(["ปี", "เดือน"])["จำนวนรถ"].sum()
        targets = [int(fb.get((y, m), 0)) for y, m in cols]

        sols, done = solve(rows, targets)
        if not done:
            out[brand] = ("budget", [], int(brand_bev))
        elif not sols:
            out[brand] = ("infeasible", [], int(brand_bev))
        elif len(sols) > 1:
            differ = sorted({names[i] for i in (sols[0] ^ sols[1])})
            out[brand] = ("ambiguous", differ, int(brand_bev))
        else:
            out[brand] = ("solved", sorted(names[i] for i in sols[0]), int(brand_bev))
    return out, cols


def pending_gaps(review, results):
    """Rows still pending whose model2 the reconciliation proved to be BEV."""
    proven = {(b.strip().lower(), m.strip().lower())
              for b, (st, models, _) in results.items() if st == "solved"
              for m in models if m.strip() not in GENERIC_NAMES}
    gaps = []
    for row in review:
        if (row.get("review_status") or "").strip() != "pending":
            continue
        key = ((row.get("brand2") or "").strip().lower(), (row.get("model2") or "").strip().lower())
        if key in proven:
            gaps.append(row)
    return gaps


def apply_approvals(gaps, reviewer, months):
    """Rewrite only the matched pending rows; every other byte stays put."""
    raw = REVIEW_CSV.read_bytes().decode("utf-8-sig")
    newline = "\r\n" if "\r\n" in raw else "\n"
    lines = raw.split(newline)
    wanted = {((g["brand2"] or "").strip(), (g["raw_model"] or "").strip()) for g in gaps}
    evidence = (f"Fuel-grain reconciliation over the last {months} months: this brand's monthly BEV "
                "totals are reproduced exactly by these model rows and by no other subset.")
    stamp = date.today().strftime("%-m/%-d/%Y") if sys.platform != "win32" else date.today().strftime("%#m/%#d/%Y")
    changed = 0
    for i, line in enumerate(lines):
        f = line.split(",")
        if len(f) != 9 or f[4] != "pending":
            continue
        if (f[0].strip(), f[1].strip()) not in wanted:
            continue
        f[3], f[4] = "BEV", "approved"
        f[5], f[6], f[7] = evidence, reviewer, stamp
        f[8] = "approved via fuel-grain reconciliation"
        lines[i] = ",".join(f)
        changed += 1
    REVIEW_CSV.write_bytes(("﻿" + newline.join(lines)).encode("utf-8"))
    return changed


# ── report ────────────────────────────────────────────────────────────────────

def write_report(results, gaps, cols, applied):
    L = []
    add = L.append
    add("=" * 66)
    add("  ตรวจหารุ่น BEV ที่ยังไม่ได้อนุมัติ (bev_reconcile.py)")
    add("=" * 66)
    add(f"ช่วงที่ใช้กระทบยอด: {cols[0][1]} {cols[0][0]} - {cols[-1][1]} {cols[-1][0]}  ({len(cols)} เดือน)")
    add(f"ขอบเขตประเภทรถ  : {', '.join(VEHICLE_TYPES)}")
    add("")

    by = {}
    for b, (st, m, u) in results.items():
        by.setdefault(st, []).append((b, m, u))

    solved = sorted(by.get("solved", []), key=lambda x: -x[2])
    add(f"[1] แบรนด์ที่พิสูจน์ได้ชุดเดียว: {len(solved)}")
    add("")

    if gaps:
        add(f"[2] รุ่นที่ควรอนุมัติเป็น BEV แต่ยังค้าง pending: {len(gaps)} แถว")
        add("")
        seen = {}
        for g in gaps:
            seen.setdefault((g["brand2"].strip(), g["model2"].strip()), []).append(g["raw_model"].strip())
        for (b, m2), raws in sorted(seen.items()):
            add(f"    {b:<22} {m2:<20} <- {', '.join(raws)}")
        add("")
        add("    " + ("อนุมัติให้แล้วในไฟล์ config/model_powertrain_review.csv"
                      if applied else "รันซ้ำด้วย --apply เพื่ออนุมัติ หรือแก้เองในไฟล์ config"))
    else:
        add("[2] ไม่มีรุ่นที่ค้าง pending ทั้งที่พิสูจน์ได้ว่าเป็น BEV — ครบแล้ว")
    add("")

    add("[3] แบรนด์ที่สรุปไม่ได้ ต้องใช้คนตรวจ")
    reasons = {"infeasible": "ไม่มีชุดใดรวมได้พอดี (มักเกิดจาก model2 เดียวมีทั้ง BEV และไม่ใช่ BEV ปนกัน)",
               "ambiguous": "มีคำตอบมากกว่าหนึ่งชุด",
               "too-many": f"รุ่นเกิน {MAX_MODELS} รุ่น",
               "budget": "ค้นหาไม่จบภายในงบที่ตั้งไว้"}
    any_bad = False
    for st in ("infeasible", "ambiguous", "too-many", "budget"):
        items = sorted(by.get(st, []), key=lambda x: -x[2])
        if not items:
            continue
        any_bad = True
        add(f"    - {reasons[st]}")
        for b, differ, u in items:
            extra = ("  ต่างกันที่: " + ", ".join(differ[:5])) if differ else ""
            add(f"        {b:<22} BEV {u:>7,} คัน{extra}")
    if not any_bad:
        add("    (ไม่มี)")
    add("")
    add("หมายเหตุ: สคริปต์นี้ไม่เดา รุ่นที่สรุปไม่ได้จะคง pending ไว้เสมอ")

    text = "\n".join(L)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(text + "\n", encoding="utf-8")
    print(text)
    print(f"\nเขียนรายงานไว้ที่: {REPORT}")


def main():
    ap = argparse.ArgumentParser(description="Find BEV models the candidate rules miss.")
    ap.add_argument("--apply", action="store_true", help="approve the proven rows in model_powertrain_review.csv")
    ap.add_argument("--months", type=int, default=12, help="months to reconcile over (default 12)")
    ap.add_argument("--reviewer", default="bev_reconcile", help="value recorded in the reviewer column")
    args = ap.parse_args()

    model, fuel = load_frames()
    results, cols = reconcile(model, fuel, args.months)
    review, _ = read_review()
    gaps = pending_gaps(review, results)

    applied = 0
    if args.apply and gaps:
        applied = apply_approvals(gaps, args.reviewer, args.months)

    write_report(results, gaps, cols, applied)
    if applied:
        print(f"อนุมัติแล้ว {applied} แถว — ให้รัน MONTHLY_UPDATE.bat เพื่อสร้างรายงานใหม่")
    return 0


if __name__ == "__main__":
    sys.exit(main())
