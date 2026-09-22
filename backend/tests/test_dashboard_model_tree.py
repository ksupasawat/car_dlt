"""Focused Step 6A tests for the model-grain Deep Dive export."""
import sys
from pathlib import Path

import pandas as pd
import pytest

TESTS = Path(__file__).resolve().parent
BACKEND = TESTS.parent
sys.path.insert(0, str(BACKEND))

from export_dashboard import build_brand_model_tree
from validate_public_release import validate_public_model_tree


def model_frame(rows):
    defaults = {
        "v_code": "\u0e23\u0e22.1",
        "\u0e08\u0e31\u0e07\u0e2b\u0e27\u0e31\u0e14": "BANGKOK",
        "\u0e1b\u0e35": 2569,
        "\u0e40\u0e14\u0e37\u0e2d\u0e19": "Jan",
    }
    return pd.DataFrame([{**defaults, **row} for row in rows])


def test_model_tree_has_one_brand_and_unclassified_series_segment():
    model = model_frame([
        {"\u0e22\u0e35\u0e48\u0e2b\u0e49\u0e2d\u0e23\u0e162": "ACME", "\u0e23\u0e38\u0e48\u0e19\u0e23\u0e16": "ALPHA ICE", "\u0e23\u0e38\u0e48\u0e19\u0e23\u0e162": "ALPHA", "PT": "N/A", "\u0e08\u0e33\u0e19\u0e27\u0e19\u0e23\u0e16": 10},
        {"\u0e22\u0e35\u0e48\u0e2b\u0e49\u0e2d\u0e23\u0e162": "ACME", "\u0e23\u0e38\u0e48\u0e19\u0e23\u0e16": "ALPHA HEV", "\u0e23\u0e38\u0e48\u0e19\u0e23\u0e162": "ALPHA", "PT": "N/A", "\u0e08\u0e33\u0e19\u0e27\u0e19\u0e23\u0e16": 7},
        {"\u0e22\u0e35\u0e48\u0e2b\u0e49\u0e2d\u0e23\u0e162": "ACME", "\u0e23\u0e38\u0e48\u0e19\u0e23\u0e162": "ALPHA", "PT": "N/A", "\u0e08\u0e33\u0e19\u0e27\u0e19\u0e23\u0e16": 3},
    ])

    tree = build_brand_model_tree(model)

    assert [node["brand"] for node in tree] == ["ACME"]
    series = tree[0]["models"][0]
    assert series["name"] == "ALPHA"
    assert [segment["powertrain"] for segment in series["segments"]] == ["N/A"]
    assert sum(segment["monthly"]["\u0e23\u0e22.1"]["BANGKOK"]["2569"][0] for segment in series["segments"]) == 20
    assert series["monthly"]["\u0e23\u0e22.1"]["BANGKOK"]["2569"][0] == 20
    assert tree[0]["monthly"]["\u0e23\u0e22.1"]["BANGKOK"]["2569"][0] == 20
    assert "\u0e0a\u0e19\u0e34\u0e14\u0e40\u0e0a\u0e37\u0e49\u0e2d\u0e40\u0e1e\u0e25\u0e34\u0e07" not in series
    assert validate_public_model_tree(tree_payload(tree)) == 1


def test_empty_registry_keeps_triton_wholly_in_na():
    model = model_frame([
        {"\u0e22\u0e35\u0e48\u0e2b\u0e49\u0e2d\u0e23\u0e162": "MITSUBISHI", "\u0e23\u0e38\u0e48\u0e19\u0e23\u0e162": "TRITON", "PT": "N/A", "\u0e08\u0e33\u0e19\u0e27\u0e19\u0e23\u0e16": 100},
    ])

    tree = build_brand_model_tree(model)

    assert [segment["powertrain"] for segment in tree[0]["models"][0]["segments"]] == ["N/A"]
    assert validate_public_model_tree(tree_payload(tree)) == 1


def test_fuel_facts_cannot_change_model_segments():
    model = model_frame([
        {"\u0e22\u0e35\u0e48\u0e2b\u0e49\u0e2d\u0e23\u0e162": "MITSUBISHI", "\u0e23\u0e38\u0e48\u0e19\u0e23\u0e162": "TRITON", "PT": "N/A", "\u0e08\u0e33\u0e19\u0e27\u0e19\u0e23\u0e16": 100},
    ])
    fuel = model.assign(PT="HEV", **{"\u0e0a\u0e19\u0e34\u0e14\u0e40\u0e0a\u0e37\u0e49\u0e2d\u0e40\u0e1e\u0e25\u0e34\u0e07": "hybrid"})

    before = build_brand_model_tree(model)
    fuel["PT"] = "BEV"
    fuel["\u0e08\u0e33\u0e19\u0e27\u0e19\u0e23\u0e16"] = 999999
    after = build_brand_model_tree(model)

    assert before == after


def test_validator_rejects_classified_or_unreconciled_segments():
    tree = build_brand_model_tree(model_frame([
        {"\u0e22\u0e35\u0e48\u0e2b\u0e49\u0e2d\u0e23\u0e162": "ACME", "\u0e23\u0e38\u0e48\u0e19\u0e23\u0e162": "ALPHA", "PT": "N/A", "\u0e08\u0e33\u0e19\u0e27\u0e19\u0e23\u0e16": 7},
    ]))

    tree[0]["models"][0]["segments"][0]["powertrain"] = "HEV"
    with pytest.raises(ValueError, match="only carry BEV/N/A Powertrain"):
        validate_public_model_tree(tree_payload(tree))

    tree[0]["models"][0]["segments"][0]["powertrain"] = "N/A"
    tree[0]["models"][0]["segments"][0]["monthly"]["\u0e23\u0e22.1"]["BANGKOK"]["2569"][0] = 6
    with pytest.raises(ValueError, match="segments do not reconcile"):
        validate_public_model_tree(tree_payload(tree))


def tree_payload(tree):
    return {"brand_model_tree": tree}
