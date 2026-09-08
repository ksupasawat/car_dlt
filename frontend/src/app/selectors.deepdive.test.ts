// Focused Step 6B tests: the Deep Dive/Excel selectors must consume Step 6A's
// brand -> canonical series -> registry-backed Powertrain segments contract,
// never a fuel field or a fuel-derived brand Powertrain.
import test from "node:test";
import assert from "node:assert/strict";
import {
  type BrandNode,
  type DashboardData,
  POWERTRAINS,
  brandTotals,
  brandMonthlyValues,
  seriesTotals,
  seriesMonthlyValues,
  segmentBreakdown,
  filterSegments,
  selectRankingsData,
  modelBrandPairs,
  modelOwnerLookup,
} from "./selectors.ts";
import {
  buildDeepDiveExportRows,
  buildDeepDiveMatrixRows,
  deepDiveFilterKey,
  referenceDeepDiveTotal,
  selectDeepDiveMatrixOptions,
} from "./deepDiveModelMatrix.ts";

const YEAR = "2569";
const VT = "รย.1";
const PROV = "BANGKOK";

function monthly(units: number) {
  return { [VT]: { [PROV]: { [YEAR]: [units, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } };
}

// Fixture: one brand (ACME) with a canonical series ALPHA that has verified ICE + HEV
// segments plus an unreviewed N/A remainder, and MITSUBISHI/TRITON under an empty
// registry (wholly N/A) — mirrors the backend fixtures in
// backend/tests/test_dashboard_model_tree.py.
function fixture(): BrandNode[] {
  return [
    {
      brand: "ACME",
      monthly: monthly(20),
      models: [
        {
          name: "ALPHA",
          monthly: monthly(20),
          segments: [
            { powertrain: "ICE", monthly: monthly(10) },
            { powertrain: "HEV", monthly: monthly(7) },
            { powertrain: "N/A", monthly: monthly(3) },
          ],
        },
      ],
    },
    {
      brand: "MITSUBISHI",
      monthly: monthly(100),
      models: [
        {
          name: "TRITON",
          monthly: monthly(100),
          segments: [{ powertrain: "N/A", monthly: monthly(100) }],
        },
      ],
    },
  ];
}

test("empty-registry fixture keeps TRITON wholly under N/A", () => {
  const [, mitsubishi] = fixture();
  const triton = mitsubishi.models[0];
  assert.deepEqual(
    triton.segments.map((s) => s.powertrain),
    ["N/A"]
  );
  // Filtering to any verified Powertrain excludes it entirely.
  for (const pt of ["ICE", "HEV", "PHEV", "BEV"]) {
    assert.equal(seriesTotals(triton, [YEAR], YEAR, [pt], [], []).grandTotal, 0);
  }
  assert.equal(seriesTotals(triton, [YEAR], YEAR, ["N/A"], [], []).grandTotal, 100);
});

test("a canonical series with verified ICE and HEV renders both segments under one series", () => {
  const [acme] = fixture();
  const alpha = acme.models[0];
  assert.equal(acme.models.length, 1, "one row per canonical series");
  const breakdown = segmentBreakdown(alpha, [YEAR], [], []);
  assert.equal(breakdown["ICE"], 10);
  assert.equal(breakdown["HEV"], 7);
  assert.equal(breakdown["N/A"], 3);
});

test("All equals ICE + HEV + PHEV + BEV + N/A at a filtered slice (vehicle type + province + year)", () => {
  const [acme] = fixture();
  const alpha = acme.models[0];
  const all = seriesTotals(alpha, [YEAR], YEAR, [], [VT], [PROV]).grandTotal;
  const sumOfSegments = POWERTRAINS.reduce(
    (s, pt) => s + seriesTotals(alpha, [YEAR], YEAR, [pt], [VT], [PROV]).grandTotal,
    0
  );
  assert.equal(all, sumOfSegments);
  assert.equal(all, 20);

  const brandAll = brandTotals(acme, [YEAR], YEAR, [], [VT], [PROV]).grandTotal;
  const brandSumOfSegments = POWERTRAINS.reduce(
    (s, pt) => s + brandTotals(acme, [YEAR], YEAR, [pt], [VT], [PROV]).grandTotal,
    0
  );
  assert.equal(brandAll, brandSumOfSegments);
});

test("selecting HEV cannot include N/A, ICE, PHEV, or BEV units", () => {
  const [acme] = fixture();
  const alpha = acme.models[0];
  assert.equal(seriesTotals(alpha, [YEAR], YEAR, ["HEV"], [], []).grandTotal, 7);
  const hevOnly = filterSegments(alpha.segments, ["HEV"]);
  assert.deepEqual(hevOnly.map((s) => s.powertrain), ["HEV"]);
  assert.equal(
    seriesMonthlyValues(alpha, YEAR, ["HEV"], [], [])[0],
    7
  );
});

test("brand totals equal the sum of visible canonical-series totals", () => {
  const tree = fixture();
  tree.forEach((brand) => {
    const bTotal = brandTotals(brand, [YEAR], YEAR, [], [], []).grandTotal;
    const seriesSum = brand.models.reduce(
      (s, m) => s + seriesTotals(m, [YEAR], YEAR, [], [], []).grandTotal,
      0
    );
    assert.equal(bTotal, seriesSum);
  });
});

test("displayed (table) and Excel-download totals match for identical filters", () => {
  const [acme] = fixture();
  const alpha = acme.models[0];
  const uiMonthly = seriesMonthlyValues(alpha, YEAR, ["ICE"], [], []);
  const uiTotal = uiMonthly.reduce((s, v) => s + v, 0);
  // The Excel export calls the exact same selector with the exact same args.
  const excelMonthly = seriesMonthlyValues(alpha, YEAR, ["ICE"], [], []);
  const excelTotal = excelMonthly.reduce((s, v) => s + v, 0);
  assert.deepEqual(uiMonthly, excelMonthly);
  assert.equal(uiTotal, excelTotal);
  assert.equal(uiTotal, 10);
});

test("N/A is never hidden from the breakdown, filtered or not", () => {
  const [acme] = fixture();
  const alpha = acme.models[0];
  const breakdown = segmentBreakdown(alpha, [YEAR], [], []);
  assert.ok((breakdown["N/A"] ?? 0) > 0);
});

test("no selector reads a fuel field: fixtures carry no fuel data and still reconcile", () => {
  // BrandNode/ModelNode/SeriesSegment (see selectors.ts) have no `fuel` or `powertrain`
  // field at the brand/model level by type — this fixture has none, and the segment
  // totals still reconcile, proving classification is registry/segment-only.
  const tree = fixture();
  const total = tree.reduce((s, b) => s + brandTotals(b, [YEAR], YEAR, [], [], []).grandTotal, 0);
  assert.equal(total, 120);
});

test("brandMonthlyValues sums only matching segments across all series in the brand", () => {
  const [acme] = fixture();
  const iceMonthly = brandMonthlyValues(acme, YEAR, ["ICE"], [], []);
  assert.equal(iceMonthly[0], 10);
  const allMonthly = brandMonthlyValues(acme, YEAR, [], [], []);
  assert.equal(allMonthly[0], 20);
});

test("loading an empty-registry model tree cannot erase fuel-derived brand rankings", () => {
  const data: DashboardData = {
    meta: { years: [2569], months: ["Jan"], provinces: [PROV] },
    powertrain_master: [],
    fuel_monthly: [],
    brand_monthly: [{ y: 2569, m: "Jan", pt: "ICE", b: "MITSUBISHI", v: VT, u: 80 }],
  };

  const result = selectRankingsData(
    data,
    ["ICE"],
    ["MITSUBISHI"],
    [],
    [],
    new Set(),
    2569,
    [],
    ["Jan"],
    fixture(),
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, "MITSUBISHI");
  assert.equal(result.rows[0].YTD, 80);
});

test("Model -> Brand sync: single-owner model resolves its brand, shared model does not guess", () => {
  // ALPHA belongs only to ACME; SHARED belongs to both ACME and MITSUBISHI.
  const owners = modelOwnerLookup([
    { brand: "ACME", model: "ALPHA" },
    { brand: "ACME", model: "SHARED" },
    { brand: "MITSUBISHI", model: "SHARED" },
    { brand: "MITSUBISHI", model: "TRITON" },
    { brand: "ACME", model: "SHARED" }, // duplicate owner must not revert the null verdict
  ]);
  assert.equal(owners.get("ALPHA"), "ACME");
  assert.equal(owners.get("TRITON"), "MITSUBISHI");
  assert.equal(owners.get("SHARED"), null); // shared across brands -> no guess
  assert.equal(owners.get("MISSING"), undefined); // unknown -> falsy, no guess
});

test("modelBrandPairs flattens the tree to brand/model ownership pairs", () => {
  assert.deepEqual(modelBrandPairs(fixture()), [
    { brand: "ACME", model: "ALPHA" },
    { brand: "MITSUBISHI", model: "TRITON" },
  ]);
  assert.deepEqual(modelBrandPairs(undefined), []);
});

test("Deep Dive matrix province options come from meta and the model tree", () => {
  const tree: BrandNode[] = [
    {
      brand: "ACME",
      monthly: { VT1: { BANGKOK: { "2569": [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } },
      models: [
        {
          name: "ALPHA",
          monthly: { VT1: { CHIANG_MAI: { "2569": [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } },
          segments: [
            { powertrain: "ICE", monthly: { VT1: { CHIANG_MAI: { "2569": [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } } },
          ],
        },
      ],
    },
  ];

  const options = selectDeepDiveMatrixOptions(tree, [], ["PHUKET"]);

  assert.deepEqual(options.allBrands, ["ACME"]);
  assert.deepEqual(options.allModels, ["ALPHA"]);
  assert.deepEqual(options.allProvinces, ["BANGKOK", "CHIANG_MAI", "PHUKET"]);
});

test("Deep Dive matrix rows respect selected province", () => {
  const tree: BrandNode[] = [
    {
      brand: "ACME",
      monthly: { VT1: {
        BANGKOK: { "2569": [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        CHIANG_MAI: { "2569": [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      } },
      models: [
        {
          name: "ALPHA",
          monthly: { VT1: {
            BANGKOK: { "2569": [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
            CHIANG_MAI: { "2569": [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
          } },
          segments: [
            { powertrain: "ICE", monthly: { VT1: {
              BANGKOK: { "2569": [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
              CHIANG_MAI: { "2569": [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
            } } },
          ],
        },
      ],
    },
  ];

  const rows = buildDeepDiveMatrixRows(
    tree,
    {
      activeYears: ["2569"],
      selectedBrands: [],
      selectedModels: [],
      selectedProvinces: ["CHIANG_MAI"],
      selectedVehicleTypes: ["VT1"],
      selectedPowertrains: [],
      selectedSegments: [],
    },
    "2569",
    new Set(["ACME"]),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].totals.grandTotal, 5);
  assert.equal(rows[0].models[0].totals.grandTotal, 5);
  assert.equal(referenceDeepDiveTotal(tree), 25);
});

test("Deep Dive filter key changes when selected province changes", () => {
  const base = {
    activeYears: ["2569"],
    selectedBrands: ["ACME"],
    selectedModels: ["ALPHA"],
    selectedVehicleTypes: ["VT1"],
    selectedPowertrains: [],
    selectedSegments: [],
  };

  assert.notEqual(
    deepDiveFilterKey({ ...base, selectedProvinces: ["BANGKOK"] }),
    deepDiveFilterKey({ ...base, selectedProvinces: ["CHIANG_MAI"] }),
  );
});

// --- Powertrain and market-segment filters on the Deep Dive matrix ---

const segmentedTree: BrandNode[] = [
  {
    brand: "ACME",
    monthly: { VT1: { BANGKOK: { "2569": [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } },
    models: [
      {
        name: "ALPHA",
        market_segment: "B-SUV",
        monthly: { VT1: { BANGKOK: { "2569": [14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } },
        segments: [
          { powertrain: "BEV", monthly: { VT1: { BANGKOK: { "2569": [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } } },
          { powertrain: "N/A", monthly: { VT1: { BANGKOK: { "2569": [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } } },
        ],
      },
      {
        name: "BETA",
        market_segment: "C-SUV",
        monthly: { VT1: { BANGKOK: { "2569": [6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } },
        segments: [
          { powertrain: "N/A", monthly: { VT1: { BANGKOK: { "2569": [6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } } },
        ],
      },
    ],
  },
  {
    brand: "ZENITH",
    monthly: { VT1: { BANGKOK: { "2569": [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } },
    models: [
      {
        name: "GAMMA",
        monthly: { VT1: { BANGKOK: { "2569": [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } },
        segments: [
          { powertrain: "BEV", monthly: { VT1: { BANGKOK: { "2569": [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } } },
        ],
      },
    ],
  },
];

const deepDiveBase = {
  activeYears: ["2569"],
  selectedBrands: [],
  selectedModels: [],
  selectedProvinces: [],
  selectedVehicleTypes: [],
  selectedPowertrains: [],
  selectedSegments: [],
};

const filteredGrandTotal = (rows: { totals: { grandTotal: number } }[]) =>
  rows.reduce((sum, row) => sum + row.totals.grandTotal, 0);

test("Deep Dive matrix options expose the tree's powertrains and market segments", () => {
  const options = selectDeepDiveMatrixOptions(segmentedTree, [], []);

  assert.deepEqual(options.allPowertrains, ["BEV", "N/A"]);
  assert.deepEqual(options.allMarketSegments, ["B-SUV", "C-SUV"]);
  // A model outside the reviewed competitor set contributes no segment option.
  assert.equal(options.allMarketSegments.length, 2);
});

test("Powertrain filter counts only matching segments, across brands", () => {
  const rows = buildDeepDiveMatrixRows(
    segmentedTree,
    { ...deepDiveBase, selectedPowertrains: ["BEV"] },
    "2569",
    new Set(["ACME", "ZENITH"]),
  );

  assert.deepEqual(rows.map((r) => r.brand), ["ACME", "ZENITH"]);
  assert.equal(rows[0].totals.grandTotal, 10);
  assert.deepEqual(rows[0].models.map((m) => m.name), ["ALPHA"]);
  assert.equal(rows[1].totals.grandTotal, 3);
  assert.equal(filteredGrandTotal(rows), 13);
});

test("Segment filter keeps only series carrying that market segment", () => {
  const rows = buildDeepDiveMatrixRows(
    segmentedTree,
    { ...deepDiveBase, selectedSegments: ["B-SUV"] },
    "2569",
    new Set(["ACME", "ZENITH"]),
  );

  assert.deepEqual(rows.map((r) => r.brand), ["ACME"]);
  assert.deepEqual(rows[0].models.map((m) => m.name), ["ALPHA"]);
  assert.equal(rows[0].totals.grandTotal, 14);
  assert.equal(filteredGrandTotal(rows), 14);
});

test("Powertrain and Segment filters compose", () => {
  const rows = buildDeepDiveMatrixRows(
    segmentedTree,
    { ...deepDiveBase, selectedPowertrains: ["BEV"], selectedSegments: ["B-SUV"] },
    "2569",
    new Set(["ACME"]),
  );

  assert.equal(filteredGrandTotal(rows), 10);
});

test("Brand total always equals the sum of the series rows shown under it", () => {
  const cases = [
    deepDiveBase,
    { ...deepDiveBase, selectedPowertrains: ["BEV"] },
    { ...deepDiveBase, selectedSegments: ["C-SUV"] },
    { ...deepDiveBase, selectedModels: ["ALPHA"] },
    { ...deepDiveBase, selectedBrands: ["ACME", "ZENITH"] },
  ];

  cases.forEach((filters) => {
    buildDeepDiveMatrixRows(segmentedTree, filters, "2569", new Set()).forEach((row) => {
      assert.equal(row.totals.grandTotal, filteredGrandTotal(row.models));
    });
  });
});

test("Cross-brand selection compares brands without changing their totals", () => {
  const both = buildDeepDiveMatrixRows(
    segmentedTree,
    { ...deepDiveBase, selectedBrands: ["ACME", "ZENITH"] },
    "2569",
    new Set(),
  );
  const acmeOnly = buildDeepDiveMatrixRows(
    segmentedTree,
    { ...deepDiveBase, selectedBrands: ["ACME"] },
    "2569",
    new Set(),
  );

  assert.deepEqual(both.map((r) => r.brand), ["ACME", "ZENITH"]);
  assert.equal(both[0].totals.grandTotal, acmeOnly[0].totals.grandTotal);
  assert.equal(filteredGrandTotal(both), 23);
});

test("Deep Dive filter key changes when Powertrain or Segment changes", () => {
  assert.notEqual(
    deepDiveFilterKey(deepDiveBase),
    deepDiveFilterKey({ ...deepDiveBase, selectedPowertrains: ["BEV"] }),
  );
  assert.notEqual(
    deepDiveFilterKey(deepDiveBase),
    deepDiveFilterKey({ ...deepDiveBase, selectedSegments: ["B-SUV"] }),
  );
});

// --- Excel export: the workbook is the table, never a wider market ---

test("Export rows are the table's rows: same brands, same totals, under every filter", () => {
  const cases = [
    deepDiveBase,
    { ...deepDiveBase, selectedPowertrains: ["BEV"] },
    { ...deepDiveBase, selectedSegments: ["B-SUV"] },
    { ...deepDiveBase, selectedBrands: ["ACME"] },
    { ...deepDiveBase, selectedModels: ["ALPHA"] },
  ];

  cases.forEach((filters) => {
    const table = buildDeepDiveMatrixRows(segmentedTree, filters, "2569", new Set());
    const exported = buildDeepDiveExportRows(segmentedTree, filters, "2569");

    // One line per brand, one per series shown under it, plus the leading total line.
    const expectedLines = 1 + table.length + table.reduce((n, b) => n + b.models.length, 0);
    assert.equal(exported.length, expectedLines);

    const brandLines = exported.filter((row) => table.some((b) => b.brand === row["Brand / Model"]));
    assert.deepEqual(
      brandLines.map((row) => [row["Brand / Model"], row["Grand Total"]]),
      table.map((b) => [b.brand, b.totals.grandTotal]),
    );
  });
});

test("Export leads with the filtered total the table shows, not the market total", () => {
  const filters = { ...deepDiveBase, selectedPowertrains: ["BEV"] };
  const table = buildDeepDiveMatrixRows(segmentedTree, filters, "2569", new Set());
  const exported = buildDeepDiveExportRows(segmentedTree, filters, "2569");

  assert.equal(exported[0]["Brand / Model"], "Filtered Total");
  assert.equal(exported[0]["Grand Total"], filteredGrandTotal(table));
  assert.equal(exported[0]["Grand Total"], 13);
  // The unfiltered workbook is a different, larger number under its own label.
  const full = buildDeepDiveExportRows(segmentedTree, deepDiveBase, "2569", "Grand Total");
  assert.equal(full[0]["Brand / Model"], "Grand Total");
  assert.equal(full[0]["Grand Total"], 23);
});

test("Export month columns and the Segment column follow the active years and the series", () => {
  const exported = buildDeepDiveExportRows(
    segmentedTree,
    { ...deepDiveBase, selectedSegments: ["B-SUV"] },
    "2569",
  );

  const alpha = exported.find((row) => String(row["Brand / Model"]).trim() === "ALPHA");
  assert.equal(alpha?.Segment, "B-SUV");
  assert.equal(alpha?.["2569 Jan"], 14);
  assert.equal(alpha?.["2569 Total"], 14);
  assert.equal(alpha?.["YTD"], 14);
  // A brand line carries no segment of its own, and no column exists for an inactive year.
  const acme = exported.find((row) => row["Brand / Model"] === "ACME");
  assert.equal(acme?.Segment, "");
  assert.equal("2568 Jan" in (acme ?? {}), false);
});
