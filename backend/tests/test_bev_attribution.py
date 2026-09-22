"""Model-grain BEV must reconcile to fuel-grain BEV cell by cell, without moving units."""
import sys
from pathlib import Path

import pandas as pd

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from bev_attribution import UNATTRIBUTED_MODEL, attribute_bev
from export_dashboard import build_brand_model_tree

CELL = {"จังหวัด": "BANGKOK", "v_code": "รย.1", "ปี": 2569, "เดือน": "Jan"}


def model(rows):
    return pd.DataFrame([{**CELL, "ยี่ห้อรถ2": b, "ยี่ห้อรถ": b, "รุ่นรถ": r, "รุ่นรถ2": r, "จำนวนรถ": u}
                         for b, r, u in rows])


def fuel(rows):
    return pd.DataFrame([{**CELL, "ยี่ห้อรถ2": b, "PT": pt, "จำนวนรถ": u} for b, pt, u in rows])


def bev(df):
    return int(df.loc[df["PT"] == "BEV", "จำนวนรถ"].sum())


def test_mixed_nameplate_takes_only_the_fuel_residual():
    m = model([("GWM", "ORA 5", 100), ("GWM", "ORA 07", 30), ("GWM", "HAVAL H6", 50)])
    f = fuel([("GWM", "BEV", 110), ("GWM", "HEV", 70)])
    out, stats = attribute_bev(m, f, approved={("GWM", "ORA 07")}, mixed={("GWM", "ORA 5")})
    assert bev(out) == 110
    ora5 = out[out["รุ่นรถ"] == "ORA 5"].groupby("PT")["จำนวนรถ"].sum().to_dict()
    assert ora5 == {"BEV": 80, "N/A": 20}
    assert int(out["จำนวนรถ"].sum()) == 180 and stats["unattributed_bev"] == 0


def test_unattributed_line_is_net_zero_for_the_brand():
    m = model([("TOYOTA", "BZ4X", 10), ("TOYOTA", "YARIS", 90)])
    f = fuel([("TOYOTA", "BEV", 13), ("TOYOTA", "ICE", 87)])
    out, stats = attribute_bev(m, f, approved={("TOYOTA", "BZ4X")}, mixed=set())
    assert bev(out) == 13 and stats["unattributed_bev"] == 3
    line = out[out["รุ่นรถ2"] == UNATTRIBUTED_MODEL]
    assert line.groupby("PT")["จำนวนรถ"].sum().to_dict() == {"BEV": 3, "N/A": -3}
    assert int(out["จำนวนรถ"].sum()) == 100


def test_tree_keeps_the_negative_segment_so_brand_totals_hold():
    m = model([("TOYOTA", "BZ4X", 10), ("TOYOTA", "YARIS", 90)])
    m["v"] = "รย.1"
    f = fuel([("TOYOTA", "BEV", 13), ("TOYOTA", "ICE", 87)])
    import model_map
    orig = model_map.approved_bev_keys
    model_map.approved_bev_keys = lambda: {("TOYOTA", "BZ4X")}
    try:
        tree = build_brand_model_tree(m, f)
    finally:
        model_map.approved_bev_keys = orig
    brand = tree[0]
    assert sum(brand["monthly"]["รย.1"]["BANGKOK"]["2569"]) == 100
    line = next(s for s in brand["models"] if s["name"] == UNATTRIBUTED_MODEL)
    segs = {s["powertrain"]: sum(s["monthly"]["รย.1"]["BANGKOK"]["2569"]) for s in line["segments"]}
    assert segs == {"BEV": 3, "N/A": -3}
