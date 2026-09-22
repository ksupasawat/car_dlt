"""Model-grain BEV attribution that reconciles exactly with the fuel grain.

The fuel grain (ชนิดเชื้อเพลิง) is the source of truth for how many BEVs a brand
registered in each province x vehicle type x month cell. The model grain has no
powertrain, so a model row only counts as BEV when a human said so:

  1. Pure BEV rows   - (brand2, raw_model) approved as BEV in
                       config/model_powertrain_review.csv. The whole row is BEV.
  2. Mixed nameplates - (brand2, raw_model) listed in
                       config/model_powertrain_mixed.csv: DLT files the BEV and the
                       non-BEV version under one identical name (GWM ORA 5, VOLVO XC40,
                       PORSCHE MACAN). Per cell, the nameplate's BEV part is
                       fuel BEV - pure BEV rows, clipped to [0, nameplate units].
                       That is arithmetic on two exact counts, not a guess.
  3. Unattributed    - whatever fuel-grain BEV is still left in a cell after 1-2 is
                       carried by one synthetic series per brand, UNATTRIBUTED_MODEL,
                       as +x BEV and -x N/A. The -x takes those cars back out of the
                       brand's unclassified rows (they are already in some model row
                       we cannot identify), so brand and series totals never change.

After this, sum(model BEV) == sum(fuel BEV) in every cell where the fuel BEV is not
below the approved rows (reported as `overshoot`, expected to be zero).
"""
import csv
from pathlib import Path

import pandas as pd

import model_map

BASE = Path(__file__).resolve().parent
MIXED_PATH = BASE / "config" / "model_powertrain_mixed.csv"
MIXED_HEADERS = ["brand2", "raw_model", "evidence", "reviewer", "reviewed_at", "notes"]
UNATTRIBUTED_MODEL = "BEV (ไม่ระบุรุ่น)"
CELL = ["ยี่ห้อรถ2", "จังหวัด", "v_code", "ปี", "เดือน"]


def load_mixed_keys(path=MIXED_PATH) -> set:
    """Normalized (brand2, raw_model) keys a human marked as one name for BEV + non-BEV."""
    path = Path(path)
    if not path.exists():
        return set()
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        missing = [h for h in MIXED_HEADERS if h not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"{path.name}: missing columns {missing}")
        keys = set()
        for i, row in enumerate(reader, start=2):
            if not all((row.get(h) or "").strip() for h in ("brand2", "raw_model", "evidence", "reviewer", "reviewed_at")):
                raise ValueError(f"{path.name}:{i}: brand2, raw_model, evidence, reviewer and reviewed_at are required")
            keys.add(model_map.normalize_key(row["brand2"], row["raw_model"]))
    return keys


def attribute_bev(df_model: pd.DataFrame, df_fuel: pd.DataFrame, approved=None, mixed=None):
    """Return (model rows with a PT column of BEV/N/A, stats dict).

    `df_model` and `df_fuel` must come from export_dashboard.load_data (same province,
    vehicle-type and month normalization). Units are preserved per cell and per series.
    """
    approved = model_map.approved_bev_keys() if approved is None else approved
    mixed = load_mixed_keys() if mixed is None else mixed
    approved = approved - mixed          # a mixed nameplate is never whole-row BEV

    d = df_model.copy()
    keys = [model_map.normalize_key(b, r) for b, r in zip(d["ยี่ห้อรถ2"], d["รุ่นรถ"])]
    is_pure = pd.Series([k in approved for k in keys], index=d.index)
    is_mixed = pd.Series([k in mixed for k in keys], index=d.index)
    d["PT"] = "N/A"
    d.loc[is_pure, "PT"] = "BEV"

    fuel_bev = df_fuel[df_fuel["PT"] == "BEV"].groupby(CELL)["จำนวนรถ"].sum()
    pure_bev = d[is_pure].groupby(CELL)["จำนวนรถ"].sum()
    resid = fuel_bev.sub(pure_bev, fill_value=0)
    overshoot = int(-resid[resid < 0].sum())
    resid = resid.clip(lower=0)

    # 2. mixed nameplates take the residual first, row by row, never above their own units.
    mixed_rows = d[is_mixed]
    split = []
    taken = pd.Series(0, index=resid.index, dtype="int64")
    if not mixed_rows.empty:
        room = resid.reindex(pd.MultiIndex.from_frame(mixed_rows[CELL])).fillna(0).to_numpy()
        before = mixed_rows.groupby(CELL)["จำนวนรถ"].cumsum().to_numpy() - mixed_rows["จำนวนรถ"].to_numpy()
        bev_part = (room - before).clip(0, None)
        bev_part = pd.Series(bev_part, index=mixed_rows.index).clip(upper=mixed_rows["จำนวนรถ"]).astype(int)
        for part, pt in ((bev_part, "BEV"), (mixed_rows["จำนวนรถ"] - bev_part, "N/A")):
            piece = mixed_rows.copy()
            piece["จำนวนรถ"] = part
            piece["PT"] = pt
            split.append(piece[piece["จำนวนรถ"] > 0])
        taken = mixed_rows.assign(_b=bev_part).groupby(CELL)["_b"].sum()
    left = resid.sub(taken, fill_value=0)
    left = left[left > 0].astype(int)

    # 3. unattributed: +x BEV and -x N/A under one synthetic series per brand.
    synth = []
    if not left.empty:
        cells = left.reset_index().rename(columns={0: "จำนวนรถ"})
        cells.columns = CELL + ["จำนวนรถ"]
        labels = d.drop_duplicates("v_code").set_index("v_code")
        for col in d.columns:
            if col in cells.columns or col == "PT":
                continue
            if col in ("v", "ประเภทรถ") and col in labels.columns:
                cells[col] = cells["v_code"].map(labels[col])
            elif col == "ยี่ห้อรถ":
                cells[col] = cells["ยี่ห้อรถ2"]
            elif col in ("รุ่นรถ", "รุ่นรถ2"):
                cells[col] = UNATTRIBUTED_MODEL
            else:
                cells[col] = None
        for sign, pt in ((1, "BEV"), (-1, "N/A")):
            piece = cells.copy()
            piece["จำนวนรถ"] = sign * piece["จำนวนรถ"]
            piece["PT"] = pt
            synth.append(piece[d.columns])

    out = pd.concat([d[~is_mixed]] + split + synth, ignore_index=True)
    stats = {
        "fuel_bev": int(fuel_bev.sum()),
        "pure_bev": int(pure_bev.sum()),
        "mixed_bev": int(taken.sum()) if len(taken) else 0,
        "unattributed_bev": int(left.sum()),
        "overshoot": overshoot,
        "model_bev": int(out.loc[out["PT"] == "BEV", "จำนวนรถ"].sum()),
    }
    return out, stats
