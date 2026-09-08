import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildAnalystRowsFromFacts,
  buildModelSegmentMap,
  filterAnalystRows,
  filterFactsBySegment,
  selectAnalystFilterOptions,
  type AnalystFact,
} from "./analystFilters.ts";
import { modelOwnerLookup } from "./selectors.ts";

const rows = [
  { brand: "ACME", model: "ALPHA" },
  { brand: "ACME", model: "BETA" },
  { brand: "MITSUBISHI", model: "TRITON" },
  { brand: "Grand Total", is_grand_total: true },
];

test("Analyst Brand selection narrows Model options", () => {
  assert.deepEqual(selectAnalystFilterOptions(rows, "").models, ["ALPHA", "BETA", "TRITON"]);
  assert.deepEqual(selectAnalystFilterOptions(rows, "ACME").models, ["ALPHA", "BETA"]);
  assert.deepEqual(selectAnalystFilterOptions(rows, "MITSUBISHI").models, ["TRITON"]);
});

test("Analyst Model selection narrows rows while preserving Grand Total", () => {
  assert.deepEqual(
    filterAnalystRows(rows, "ACME", "BETA"),
    [rows[1], rows[3]],
  );
});

test("Analyst Brand selection becomes invalid when Vehicle Type narrows the brand universe", () => {
  const rowsForAllVehicleType = rows;
  const rowsForRy11 = [{ brand: "MITSUBISHI", model: "TRITON" }];

  assert.ok(selectAnalystFilterOptions(rowsForAllVehicleType, "").brands.includes("ACME"));
  assert.ok(!selectAnalystFilterOptions(rowsForRy11, "").brands.includes("ACME"));
});

test("Analyst Model selection syncs a single-owner brand but not a shared model", () => {
  // The page passes rows with is_grand_total excluded; TRITON is MITSUBISHI-only here.
  const owners = modelOwnerLookup(rows.filter((r) => !r.is_grand_total));
  assert.equal(owners.get("TRITON"), "MITSUBISHI");
  assert.equal(owners.get("ALPHA"), "ACME");

  const shared = modelOwnerLookup([
    { brand: "ACME", model: "COMMON" },
    { brand: "MITSUBISHI", model: "COMMON" },
  ]);
  assert.equal(shared.get("COMMON"), null);
});

test("Analyst model data never exposes Powertrain segmentation", () => {
  const artifact = JSON.parse(
    readFileSync(new URL("../../public/data/analyst_data.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(Object.keys(artifact.data.model), ["ALL"]);
});

test("Analyst metadata exposes province filter options", () => {
  const artifact = JSON.parse(
    readFileSync(new URL("../../public/data/analyst_data.json", import.meta.url), "utf8"),
  );

  assert.ok(Array.isArray(artifact.meta.provinces));
  assert.ok(artifact.meta.provinces.length > 0);
});

test("Analyst province data preserves the analyst view contract", () => {
  const artifact = JSON.parse(
    readFileSync(new URL("../../public/data/analyst_province_data.json", import.meta.url), "utf8"),
  );

  assert.ok(Array.isArray(artifact.facts.brand));
  assert.ok(Array.isArray(artifact.facts.model));
  assert.ok(artifact.facts.brand.length > 0);
  assert.ok(artifact.facts.model.length > 0);
  assert.ok(["p", "b", "y", "mo", "v", "pt", "u"].every((key) => key in artifact.facts.brand[0]));
  assert.ok(["p", "b", "m", "y", "mo", "v", "u"].every((key) => key in artifact.facts.model[0]));
});

test("Analyst province facts can build province-scoped rows", () => {
  const facts = [
    { p: "BANGKOK", b: "ACME", y: 2568, mo: 6, v: "รย.1", pt: "ICE", u: 10 },
    { p: "BANGKOK", b: "ACME", y: 2569, mo: 5, v: "รย.1", pt: "ICE", u: 8 },
    { p: "BANGKOK", b: "ACME", y: 2569, mo: 6, v: "รย.1", pt: "ICE", u: 12 },
    { p: "CHIANG MAI", b: "ACME", y: 2569, mo: 6, v: "รย.1", pt: "ICE", u: 99 },
  ];

  const out = buildAnalystRowsFromFacts({
    facts,
    viewBy: "brand",
    powertrain: "ICE",
    vehicleType: "รย.1",
    province: "BANGKOK",
    currentYear: 2569,
    currentMonthNum: 6,
  });

  assert.equal(out[0].is_grand_total, true);
  assert.equal(out[0].curr_month_units, 12);
  assert.equal(out[1].brand, "ACME");
  assert.equal(out[1].curr_growth_vs_prev_month, 0.5);
});

// --- Market segment: the same filter the Deep Dive matrix uses, applied to analyst facts ---

const SEG_TRIPLES: [string, string, string][] = [
  ["TOYOTA", "YARIS CROSS", "B-SUV"],
  ["Deepal + Changan", "S05 BEV", "B-SUV"],
  ["TOYOTA", "CAMRY", "D-Segment"],
];

const segFacts: AnalystFact[] = [
  { p: "ALL", b: "TOYOTA", m: "YARIS CROSS", y: 2569, mo: 8, v: "รย.1", u: 10 },
  { p: "ALL", b: "TOYOTA", m: "Yaris Cross", y: 2569, mo: 8, v: "รย.1", u: 5 },
  { p: "ALL", b: "Deepal + Changan", m: "S05 BEV", y: 2569, mo: 8, v: "รย.1", u: 7 },
  { p: "ALL", b: "TOYOTA", m: "CAMRY", y: 2569, mo: 8, v: "รย.1", u: 3 },
  { p: "ALL", b: "TOYOTA", m: "SOME UNLISTED MODEL", y: 2569, mo: 8, v: "รย.1", u: 99 },
  { p: "ALL", b: "TOYOTA", y: 2569, mo: 8, v: "รย.1", u: 42 },
];

test("segment map matches brand and model case-insensitively", () => {
  const map = buildModelSegmentMap(SEG_TRIPLES);

  assert.equal(map.get("TOYOTA||YARIS CROSS"), "B-SUV");
  assert.equal(map.get("DEEPAL + CHANGAN||S05 BEV"), "B-SUV");
  assert.equal(map.size, 3);
});

test("segment filter keeps only facts whose model the map lists in that segment", () => {
  const map = buildModelSegmentMap(SEG_TRIPLES);
  const kept = filterFactsBySegment(segFacts, map, "B-SUV");

  assert.deepEqual(kept.map((f) => f.u), [10, 5, 7]);
  // An unlisted model and a fact with no model at all belong to no segment, never to this one.
  assert.equal(kept.some((f) => f.u === 99 || f.u === 42), false);
});

test("segment ALL, or an empty map, filters nothing away", () => {
  const map = buildModelSegmentMap(SEG_TRIPLES);

  assert.equal(filterFactsBySegment(segFacts, map, "ALL").length, segFacts.length);
  assert.equal(filterFactsBySegment(segFacts, buildModelSegmentMap([]), "B-SUV").length, 0);
  assert.equal(buildModelSegmentMap(undefined).size, 0);
});

test("brand rows under a segment are that segment's models grouped by brand", () => {
  const map = buildModelSegmentMap(SEG_TRIPLES);
  const rowsBySegment = buildAnalystRowsFromFacts({
    facts: filterFactsBySegment(segFacts, map, "B-SUV"),
    viewBy: "brand",
    powertrain: "ALL",
    vehicleType: "ALL",
    province: "ALL",
    currentYear: 2569,
    currentMonthNum: 8,
  });

  const grand = rowsBySegment.find((r) => r.is_grand_total);
  const details = rowsBySegment.filter((r) => !r.is_grand_total);

  assert.equal(grand?.curr_month_units, 22);
  assert.deepEqual(details.map((r) => [r.brand, r.curr_month_units]), [
    ["TOYOTA", 15],
    ["Deepal + Changan", 7],
  ]);
  // Shares are computed inside the segment, so they add up to 1 across its brands.
  assert.equal(details.reduce((sum, r) => sum + (r.curr_month_share ?? 0), 0), 1);
});

test("Analyst segment tables are self-contained: model-grain, powertrain-free, and they add up", () => {
  const artifact = JSON.parse(
    readFileSync(new URL("../../public/data/analyst_data.json", import.meta.url), "utf8"),
  );

  const segments: string[] = artifact.meta.segments;
  assert.ok(Array.isArray(segments) && segments.length > 0);
  assert.deepEqual(Object.keys(artifact.data_by_segment).sort(), segments.slice().sort());
  assert.ok(Array.isArray(artifact.meta.model_segments) && artifact.meta.model_segments.length > 0);

  segments.forEach((segment) => {
    const table = artifact.data_by_segment[segment];
    // A segment table has exactly the two views and no powertrain axis of its own.
    assert.deepEqual(Object.keys(table).sort(), ["brand", "model"]);

    const brandRows = table.brand.ALL;
    const modelRows = table.model.ALL;
    const grand = brandRows.find((r: { is_grand_total?: boolean }) => r.is_grand_total);
    const sum = (rows: { is_grand_total?: boolean; curr_ytd_units?: number }[]) =>
      rows.filter((r) => !r.is_grand_total).reduce((n, r) => n + (r.curr_ytd_units ?? 0), 0);

    // Brand rows are the same units as the model rows, grouped one level up, and the
    // Grand Total is the segment's own total -- not the whole market's.
    assert.equal(grand.curr_ytd_units, sum(brandRows));
    assert.equal(grand.curr_ytd_units, sum(modelRows));
    assert.equal(modelRows.find((r: { is_grand_total?: boolean }) => r.is_grand_total).curr_ytd_units, grand.curr_ytd_units);
  });
});
