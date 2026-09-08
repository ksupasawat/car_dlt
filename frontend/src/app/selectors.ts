export const VEHICLE_TYPE_DICT: Record<string, string> = {
  "รย.1": "รย.1 (รถยนต์นั่งส่วนบุคคลไม่เกิน 7 คน / เก๋ง)",
  "รย.2": "รย.2 (รถยนต์นั่งส่วนบุคคลเกิน 7 คน / ตู้)",
  "รย.3": "รย.3 (รถยนต์บรรทุกส่วนบุคคล / กระบะ)",
  "รย.6": "รย.6 (รถยนต์รับจ้างบรรทุกคนโดยสารไม่เกิน 7 คน / แท็กซี่)",
  "รย.9": "รย.9 (รถยนต์บริการธุรกิจ)",
  "รย.10": "รย.10 (รถยนต์บริการทัศนาจร)",
  "รย.11": "รย.11 (รถยนต์บริการให้เช่า / รถเช่า)"
};

export type PowertrainMasterRow = { f: string; pt: string; y: number; u: number };
export type FuelRow = { y: number; m: string; pt: string; f: string; v: string; u: number };
export type BrandMonthlyRow = { y: number; m: string; pt: string; b: string; v: string; u: number };
export type TreeMonthly = Record<string, Record<string, Record<string, number[]>>>;

// Registry-backed classification only; ICE/HEV/PHEV/BEV are verified, N/A covers missing,
// unreviewed, ambiguous, or conflicting mappings. Never derived from fuel facts.
export const POWERTRAINS = ["ICE", "HEV", "PHEV", "BEV", "N/A"] as const;
export type Powertrain = typeof POWERTRAINS[number];

export type SeriesSegment = {
  powertrain: string;
  monthly: TreeMonthly;
};

// A canonical series (Step 6A). Source totals live in `monthly`; `segments` partitions
// those same units by registry-backed Powertrain and must sum back to `monthly`.
export type ModelNode = {
  name: string;
  // Market segment (B-SUV, C-Segment, MPV, …) from backend/config/model_segment.csv.
  // Absent when the series is outside the reviewed competitor set — never inferred here.
  market_segment?: string | null;
  monthly: TreeMonthly;
  segments: SeriesSegment[];
};

export type BrandNode = {
  brand: string;
  monthly: TreeMonthly;
  models: ModelNode[];
};

export type DashboardData = {
  meta: {
    years: number[];
    months: string[];
    provinces: string[];
    vehicle_types_list?: { code: string; label: string }[];
    generated_at?: string;
    latest_year?: number | null;
    latest_month?: string | null;
    reporting_period?: string | null;
  };
  powertrain_master: PowertrainMasterRow[];
  fuel_monthly: FuelRow[];
  brand_monthly: BrandMonthlyRow[];
  brand_model_tree?: BrandNode[];
};

export type Rec = Record<string, string | number | boolean | null>;

export type PeriodComparison = {
  selectedYear: number;
  selectedMonth: string;
  selectedMonthIndex: number;
  previousMonthYear: number;
  previousMonth: string;
  priorYear: number;
  currentMonthUnits: number;
  previousMonthUnits: number;
  sameMonthPriorYearUnits: number;
  currentYtdUnits: number;
  priorYtdUnits: number;
  priorFullYearUnits: number;
  momDeltaUnits: number;
  yoyDeltaUnits: number;
  ytdDeltaUnits: number;
  momGrowth: number | null;
  yoyGrowth: number | null;
  ytdGrowth: number | null;
  topPowertrainMover: { name: string; delta: number } | null;
  topBrandMover: { name: string; delta: number } | null;
};

export function modelBrandPairs(tree: BrandNode[] | undefined): { brand: string; model: string }[] {
  return (tree ?? []).flatMap((b) => (b.models ?? []).map((m) => ({ brand: b.brand, model: m.name })));
}

// Memoize-once ownership index: model name -> single owning brand, or null when shared across
// brands (never guess). Missing models return undefined via Map.get. Build once per source-data
// change so selection handlers do an O(1) lookup instead of rescanning the pairs each pick.
export function modelOwnerLookup(pairs: { brand: string; model?: string }[]): Map<string, string | null> {
  const owners = new Map<string, string | null>();
  pairs.forEach((p) => {
    if (p.model === undefined) return;
    if (!owners.has(p.model)) owners.set(p.model, p.brand);
    else if (owners.get(p.model) !== p.brand) owners.set(p.model, null);
  });
  return owners;
}

export function getNodeSums(node: { monthly: TreeMonthly }, selectedYear: number | "All", selectedVehicleTypes: string[], selectedProvinces: string[]) {
  const timeVals: Record<string, number> = {};
  let grandTotal = 0;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const vcs = selectedVehicleTypes.length > 0 ? selectedVehicleTypes : Object.keys(node.monthly || {});

  vcs.forEach(vc => {
    const vcBucket = node.monthly?.[vc];
    if (!vcBucket) return;
    
    const provs = selectedProvinces.length > 0 ? selectedProvinces : Object.keys(vcBucket);
    provs.forEach(prov => {
      const pBucket = vcBucket[prov];
      if (!pBucket) return;

      Object.keys(pBucket).forEach(yStr => {
        if (selectedYear !== "All" && yStr !== String(selectedYear)) return;

        const arr = pBucket[yStr];
        if (!Array.isArray(arr)) return;

        if (selectedYear === "All") {
          let ySum = 0;
          for (let i = 0; i < 12; i++) ySum += arr[i] || 0;
          timeVals[yStr] = (timeVals[yStr] || 0) + ySum;
          grandTotal += ySum;
        } else {
          for (let i = 0; i < 12; i++) {
            const mStr = months[i];
            timeVals[mStr] = (timeVals[mStr] || 0) + (arr[i] || 0);
            grandTotal += (arr[i] || 0);
          }
        }
      });
    });
  });

  return { timeVals, grandTotal };
}

// --- Deep Dive selectors: segments only, never fuel facts. UI table and Excel export share
// these so displayed and downloaded totals are identical by construction. ---

export function sumMonthlyArrays(monthly: TreeMonthly, year: string, selectedVehicleTypes: string[], selectedProvinces: string[]): number[] {
  const out = Array(12).fill(0);
  const buckets = monthly || {};
  const vcs = selectedVehicleTypes.length > 0 ? selectedVehicleTypes : Object.keys(buckets);
  vcs.forEach((vc) => {
    const vehicleBucket = buckets[vc];
    if (!vehicleBucket) return;
    const provs = selectedProvinces.length > 0 ? selectedProvinces : Object.keys(vehicleBucket);
    provs.forEach((province) => {
      const arr = vehicleBucket[province]?.[year];
      if (arr) for (let i = 0; i < 12; i++) out[i] += arr[i] || 0;
    });
  });
  return out;
}

export function filterSegments(segments: SeriesSegment[], selectedPts: string[]): SeriesSegment[] {
  return selectedPts.length > 0 ? segments.filter((s) => selectedPts.includes(s.powertrain)) : segments;
}

export function seriesMonthlyValues(model: ModelNode, year: string, selectedPts: string[], selectedVehicleTypes: string[], selectedProvinces: string[]): number[] {
  const out = Array(12).fill(0);
  filterSegments(model.segments, selectedPts).forEach((seg) => {
    const arr = sumMonthlyArrays(seg.monthly, year, selectedVehicleTypes, selectedProvinces);
    for (let i = 0; i < 12; i++) out[i] += arr[i];
  });
  return out;
}

export function seriesTotals(model: ModelNode, activeYears: string[], latestYear: string | null, selectedPts: string[], selectedVehicleTypes: string[], selectedProvinces: string[]) {
  let grandTotal = 0;
  let ytdTotal = 0;
  activeYears.forEach((year) => {
    const yearSum = seriesMonthlyValues(model, year, selectedPts, selectedVehicleTypes, selectedProvinces).reduce((s, v) => s + v, 0);
    grandTotal += yearSum;
    if (year === latestYear) ytdTotal += yearSum;
  });
  return { grandTotal, ytdTotal };
}

export function brandMonthlyValues(brand: BrandNode, year: string, selectedPts: string[], selectedVehicleTypes: string[], selectedProvinces: string[]): number[] {
  const out = Array(12).fill(0);
  (brand.models || []).forEach((model) => {
    const arr = seriesMonthlyValues(model, year, selectedPts, selectedVehicleTypes, selectedProvinces);
    for (let i = 0; i < 12; i++) out[i] += arr[i];
  });
  return out;
}

export function brandTotals(brand: BrandNode, activeYears: string[], latestYear: string | null, selectedPts: string[], selectedVehicleTypes: string[], selectedProvinces: string[]) {
  let grandTotal = 0;
  let ytdTotal = 0;
  activeYears.forEach((year) => {
    const yearSum = brandMonthlyValues(brand, year, selectedPts, selectedVehicleTypes, selectedProvinces).reduce((s, v) => s + v, 0);
    grandTotal += yearSum;
    if (year === latestYear) ytdTotal += yearSum;
  });
  return { grandTotal, ytdTotal };
}

// Unfiltered-by-Powertrain breakdown (still respects vehicle-type/province/year) so N/A and
// every verified segment stay visible regardless of the active Powertrain filter.
export function segmentBreakdown(model: ModelNode, activeYears: string[], selectedVehicleTypes: string[], selectedProvinces: string[]): Record<string, number> {
  const totals: Record<string, number> = {};
  model.segments.forEach((seg) => {
    let total = 0;
    activeYears.forEach((year) => {
      total += sumMonthlyArrays(seg.monthly, year, selectedVehicleTypes, selectedProvinces).reduce((s, v) => s + v, 0);
    });
    totals[seg.powertrain] = (totals[seg.powertrain] || 0) + total;
  });
  return totals;
}

// Segment-aware equivalents of getNodeSums, for callers using the (year: number | "All")
// convention (the main dashboard's Rankings/Charts, which also consume brand_model_tree).
export function getModelSegmentSums(model: ModelNode, selectedPts: string[], selectedYear: number | "All", selectedVehicleTypes: string[], selectedProvinces: string[]) {
  let grandTotal = 0;
  const timeVals: Record<string, number> = {};
  filterSegments(model.segments, selectedPts).forEach((seg) => {
    const sums = getNodeSums(seg, selectedYear, selectedVehicleTypes, selectedProvinces);
    grandTotal += sums.grandTotal;
    Object.entries(sums.timeVals).forEach(([k, v]) => { timeVals[k] = (timeVals[k] || 0) + v; });
  });
  return { timeVals, grandTotal };
}

export function getBrandSegmentSums(brand: BrandNode, selectedPts: string[], selectedYear: number | "All", selectedVehicleTypes: string[], selectedProvinces: string[]) {
  let grandTotal = 0;
  const timeVals: Record<string, number> = {};
  (brand.models || []).forEach((model) => {
    const sums = getModelSegmentSums(model, selectedPts, selectedYear, selectedVehicleTypes, selectedProvinces);
    grandTotal += sums.grandTotal;
    Object.entries(sums.timeVals).forEach(([k, v]) => { timeVals[k] = (timeVals[k] || 0) + v; });
  });
  return { timeVals, grandTotal };
}

export function determineProvinceStatus(
  share: number,
  totalProvVol: number,
  p25: number,
  p50: number
): string {
  if (share >= 0.15) return "Stronghold";
  if (share >= 0.05) return "Growth Market";
  if (totalProvVol < p25) return "Low Demand";
  if (share === 0 && totalProvVol >= p50) return "Possible Gap";
  if (share < 0.03 && totalProvVol >= p50) return "Weak Spot";
  return "Average";
}

export function selectFilterOptions(data: DashboardData | null, rankingBrand: string[], brandModelTree?: BrandNode[] | null) {
  // Brand names come from brand_monthly (already in the small summary payload) so the
  // Brand filter is populated before the heavy brand_model_tree has loaded.
  const allDataBrands = data?.brand_monthly
    ? Array.from(new Set(data.brand_monthly.map(r => r.b))).sort()
    : [];

  const tree = brandModelTree || data?.brand_model_tree;
  if (!tree) return { allDataBrands, allDataModels: [] };

  const mSet = new Set<string>();
  tree.forEach(b => {
    const cleanBrand = b.brand;
    if (rankingBrand.length > 0 && !rankingBrand.includes(cleanBrand)) return;

    b.models?.forEach(m => mSet.add(m.name));
  });
  const allDataModels = Array.from(mSet).sort();
  
  return { allDataBrands, allDataModels };
}

function monthIndex(months: string[], month: string): number {
  return months.findIndex((m) => m === month);
}

function growth(current: number, baseline: number): number | null {
  return baseline === 0 ? null : (current - baseline) / baseline;
}

function strongestMover(values: Map<string, { current: number; prior: number }>) {
  let best: { name: string; delta: number } | null = null;
  values.forEach((v, name) => {
    const delta = v.current - v.prior;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { name, delta };
  });
  return best;
}

export function availableComparisonMonths(data: DashboardData | null, selectedYear: number | "All"): string[] {
  if (!data?.fuel_monthly || !data.meta?.months) return [];
  const targetYear = selectedYear === "All"
    ? data.meta.latest_year ?? data.meta.years?.[data.meta.years.length - 1]
    : selectedYear;
  if (!targetYear) return [];

  const activeMonths = new Set(data.fuel_monthly.filter((row) => row.y === targetYear && row.u > 0).map((row) => row.m));
  return data.meta.months.filter((month) => activeMonths.has(month));
}

export function defaultComparisonMonth(data: DashboardData | null, selectedYear: number | "All"): string {
  const available = availableComparisonMonths(data, selectedYear);
  if (available.length === 0) return "";
  if (selectedYear !== "All" && selectedYear === data?.meta?.latest_year && data.meta.latest_month && available.includes(data.meta.latest_month)) {
    return data.meta.latest_month;
  }
  if (selectedYear === "All" && data?.meta?.latest_month && available.includes(data.meta.latest_month)) {
    return data.meta.latest_month;
  }
  return available[available.length - 1];
}

export function selectPeriodComparison(
  data: DashboardData | null,
  selectedYear: number | "All",
  selectedMonth: string,
  selectedVehicleTypes: string[],
  rankingPt: string[],
  rankingBrand: string[]
): PeriodComparison | null {
  if (!data?.fuel_monthly || !data?.brand_monthly || !data.meta?.months) return null;
  const targetYear = selectedYear === "All"
    ? data.meta.latest_year ?? data.meta.years?.[data.meta.years.length - 1]
    : selectedYear;
  if (!targetYear) return null;

  const mIdx = monthIndex(data.meta.months, selectedMonth);
  if (mIdx < 0) return null;

  const previousMonthIndex = mIdx === 0 ? data.meta.months.length - 1 : mIdx - 1;
  const previousMonth = data.meta.months[previousMonthIndex];
  const previousMonthYear = mIdx === 0 ? targetYear - 1 : targetYear;
  const priorYear = targetYear - 1;
  const vehicleSet = selectedVehicleTypes.length > 0 ? new Set(selectedVehicleTypes) : null;
  const ptSet = rankingPt.length > 0 ? new Set(rankingPt) : null;
  const brandSet = rankingBrand.length > 0 ? new Set(rankingBrand) : null;

  const fuelInScope = data.fuel_monthly.filter((row) => {
    if (vehicleSet && !vehicleSet.has(row.v)) return false;
    if (ptSet && !ptSet.has(row.pt)) return false;
    return true;
  });

  const brandInScope = data.brand_monthly.filter((row) => {
    if (vehicleSet && !vehicleSet.has(row.v)) return false;
    if (ptSet && !ptSet.has(row.pt)) return false;
    if (brandSet && !brandSet.has(row.b)) return false;
    return true;
  });

  const sumFuel = (year: number, months: string[]) => fuelInScope
    .filter((row) => row.y === year && months.includes(row.m))
    .reduce((s, row) => s + row.u, 0);

  const currentMonthUnits = sumFuel(targetYear, [selectedMonth]);
  const previousMonthUnits = sumFuel(previousMonthYear, [previousMonth]);
  const sameMonthPriorYearUnits = sumFuel(priorYear, [selectedMonth]);
  const ytdMonths = data.meta.months.slice(0, mIdx + 1);
  const currentYtdUnits = sumFuel(targetYear, ytdMonths);
  const priorYtdUnits = sumFuel(priorYear, ytdMonths);
  const priorFullYearUnits = sumFuel(priorYear, data.meta.months);

  const powertrainMovers = new Map<string, { current: number; prior: number }>();
  fuelInScope.forEach((row) => {
    if (row.m !== selectedMonth || (row.y !== targetYear && row.y !== priorYear)) return;
    const bucket = powertrainMovers.get(row.pt) ?? { current: 0, prior: 0 };
    if (row.y === targetYear) bucket.current += row.u;
    if (row.y === priorYear) bucket.prior += row.u;
    powertrainMovers.set(row.pt, bucket);
  });

  const brandMovers = new Map<string, { current: number; prior: number }>();
  brandInScope.forEach((row) => {
    if (row.m !== selectedMonth || (row.y !== targetYear && row.y !== priorYear)) return;
    const bucket = brandMovers.get(row.b) ?? { current: 0, prior: 0 };
    if (row.y === targetYear) bucket.current += row.u;
    if (row.y === priorYear) bucket.prior += row.u;
    brandMovers.set(row.b, bucket);
  });

  return {
    selectedYear: targetYear,
    selectedMonth,
    selectedMonthIndex: mIdx,
    previousMonthYear,
    previousMonth,
    priorYear,
    currentMonthUnits,
    previousMonthUnits,
    sameMonthPriorYearUnits,
    currentYtdUnits,
    priorYtdUnits,
    priorFullYearUnits,
    momDeltaUnits: currentMonthUnits - previousMonthUnits,
    yoyDeltaUnits: currentMonthUnits - sameMonthPriorYearUnits,
    ytdDeltaUnits: currentYtdUnits - priorYtdUnits,
    momGrowth: growth(currentMonthUnits, previousMonthUnits),
    yoyGrowth: growth(currentMonthUnits, sameMonthPriorYearUnits),
    ytdGrowth: growth(currentYtdUnits, priorYtdUnits),
    topPowertrainMover: strongestMover(powertrainMovers),
    topBrandMover: strongestMover(brandMovers),
  };
}

export function selectTrendData(
  data: DashboardData | null,
  selectedYear: number | "All",
  selectedVehicleTypes: string[],
  trendGroupBy: "Powertrain" | "Vehicle Type",
  timeKeys: string[]
) {
  if (!data?.fuel_monthly) return { trendKeys: [], trendData: [], trendTable: [] };

  const d = selectedVehicleTypes.length > 0 
    ? data.fuel_monthly.filter(x => selectedVehicleTypes.includes(x.v))
    : data.fuel_monthly;
  const fuelFiltered = selectedYear === "All" ? d : d.filter(x => x.y === selectedYear);

  let trendKeys: string[] = [];
  if (trendGroupBy === "Powertrain") {
    trendKeys = ["ICE", "BEV", "HEV", "PHEV"];
  } else {
    trendKeys = Array.from(new Set(fuelFiltered.map(x => VEHICLE_TYPE_DICT[x.v] || x.v)));
  }

  const res: Rec[] = [];
  timeKeys.forEach(t => {
    const point: Rec = { name: t, Total: 0 };
    
    if (trendGroupBy === "Powertrain") {
      ["ICE", "BEV", "HEV", "PHEV"].forEach(pt => {
        const sum = fuelFiltered
          .filter(x => x.pt === pt && String(selectedYear === "All" ? x.y : x.m) === t)
          .reduce((acc, curr) => acc + curr.u, 0);
        point[pt] = sum;
        point.Total = Number(point.Total) + sum;
      });
    } else {
      trendKeys.forEach(vKey => {
        const sum = fuelFiltered
          .filter(x => (VEHICLE_TYPE_DICT[x.v] || x.v) === vKey && String(selectedYear === "All" ? x.y : x.m) === t)
          .reduce((acc, curr) => acc + curr.u, 0);
        point[vKey] = sum;
        point.Total = Number(point.Total) + sum;
      });
    }

    res.push(point);
  });
  
  let lastValidIdx = res.length - 1;
  while (lastValidIdx >= 0 && res[lastValidIdx].Total === 0) lastValidIdx--;
  const trendData = res.slice(0, lastValidIdx + 1);

  const trendTable: Rec[] = [];
  [...trendKeys, "Total"].forEach(key => {
    const row: Rec = { name: key === "Total" ? "Grand Total" : key, YTD: 0 };
    timeKeys.forEach(t => {
      const val = trendData.find(x => x.name === t)?.[key] ?? 0;
      row[t] = val;
      row.YTD = Number(row.YTD) + Number(val);
    });
    trendTable.push(row);
  });

  return { trendKeys, trendData, trendTable: trendTable.filter(r => Number(r.YTD) > 0) };
}

// Brand-level-only rankings computed from brand_monthly (present in the small summary
// payload) — used before brand_model_tree has loaded. No model drill-down, no province
// filter (brand_monthly carries no province axis); callers fall back to this only when
// no province/model filter is active and the tree isn't loaded yet.
export function selectBrandRankingsFromMonthly(
  data: DashboardData | null,
  rankingPt: string[],
  rankingBrand: string[],
  expandedBrands: Set<string>,
  selectedYear: number | "All",
  selectedVehicleTypes: string[],
  timeKeys: string[]
) {
  if (!data?.brand_monthly) return { rows: [], totalUnits: 0, bevUnits: 0, ptMix: [] };

  const map = new Map<string, Rec>();
  let totalUnits = 0;
  let bevUnits = 0;
  const ptMixMap: Record<string, number> = { ICE: 0, BEV: 0, HEV: 0, PHEV: 0 };

  data.brand_monthly.forEach(row => {
    if (rankingPt.length > 0 && !rankingPt.includes(row.pt)) return;
    if (rankingBrand.length > 0 && !rankingBrand.includes(row.b)) return;
    if (selectedVehicleTypes.length > 0 && !selectedVehicleTypes.includes(row.v)) return;
    if (selectedYear !== "All" && row.y !== selectedYear) return;

    if (!map.has(row.b)) {
      // Model breakdown isn't known yet (brand_monthly has no model axis) — assume
      // expandable so the "Click Brand to Drill-Down" affordance renders; clicking
      // fetches brand_model_tree, after which rankingsData switches to the tree path.
      const r: Rec = { id: row.b, name: row.b, YTD: 0, hasChildren: true, isExpanded: expandedBrands.has(row.b) };
      timeKeys.forEach(t => r[t] = 0);
      map.set(row.b, r);
    }
    const r = map.get(row.b)!;
    const tKey = selectedYear === "All" ? String(row.y) : row.m;
    if (tKey in r) r[tKey] = Number(r[tKey]) + row.u;
    r.YTD = Number(r.YTD) + row.u;

    totalUnits += row.u;
    if (row.pt === "BEV") bevUnits += row.u;
    if (row.pt in ptMixMap) ptMixMap[row.pt] += row.u;
  });

  const rows = Array.from(map.values())
    .filter(r => Number(r.YTD) > 0)
    .sort((a, b) => Number(b.YTD) - Number(a.YTD));

  const ptMix = Object.entries(ptMixMap).map(([name, val]) => ({ name, YTD: val })).filter(d => d.YTD > 0);

  return { rows, totalUnits, bevUnits, ptMix };
}

// Brands-only version of selectDynamicChartData computed from brand_monthly, for use
// before brand_model_tree has loaded (Models/Provinces grouping still needs the tree).
export function selectDynamicChartDataFromMonthly(
  data: DashboardData | null,
  rankingPt: string[],
  rankingBrand: string[],
  selectedYear: number | "All",
  selectedVehicleTypes: string[]
) {
  if (!data?.brand_monthly) return [];
  const cMap = new Map<string, number>();

  data.brand_monthly.forEach(row => {
    if (rankingPt.length > 0 && !rankingPt.includes(row.pt)) return;
    if (rankingBrand.length > 0 && !rankingBrand.includes(row.b)) return;
    if (selectedVehicleTypes.length > 0 && !selectedVehicleTypes.includes(row.v)) return;
    if (selectedYear !== "All" && row.y !== selectedYear) return;
    cMap.set(row.b, (cMap.get(row.b) || 0) + row.u);
  });

  return Array.from(cMap.entries())
    .map(([name, YTD]) => ({ name, YTD }))
    .sort((a, b) => b.YTD - a.YTD)
    .slice(0, 10);
}

export function selectRankingsData(
  data: DashboardData | null,
  rankingPt: string[],
  rankingBrand: string[],
  rankingModel: string[],
  rankingProvince: string[],
  expandedBrands: Set<string>,
  selectedYear: number | "All",
  selectedVehicleTypes: string[],
  timeKeys: string[],
  brandModelTree?: BrandNode[] | null
) {
  const tree = brandModelTree || data?.brand_model_tree;
  if (!tree) return { rows: [], totalUnits: 0, bevUnits: 0, ptMix: [] };

  // Brand Powertrain is observed in the fuel grain. Keep those parent rankings stable after
  // the model tree loads; canonical-series children remain registry-segment facts. Province or
  // explicit model filters require the model tree because brand_monthly has neither dimension.
  if (rankingProvince.length === 0 && rankingModel.length === 0 && data?.brand_monthly) {
    const fuelRankings = selectBrandRankingsFromMonthly(
      data, rankingPt, rankingBrand, expandedBrands, selectedYear, selectedVehicleTypes, timeKeys,
    );
    const rows: Rec[] = [];
    fuelRankings.rows.forEach(brandRow => {
      rows.push(brandRow);
      if (!expandedBrands.has(String(brandRow.id))) return;
      const brandNode = tree.find(node => node.brand === brandRow.name);
      const modelRows = (brandNode?.models ?? []).map(model => {
        const sums = getModelSegmentSums(model, rankingPt, selectedYear, selectedVehicleTypes, []);
        const row: Rec = {
          id: `${brandRow.id}|${model.name}`,
          parentId: brandRow.id,
          name: model.name,
          YTD: sums.grandTotal,
          isSubRow: true,
        };
        timeKeys.forEach(t => row[t] = sums.timeVals[t] || 0);
        return row;
      }).filter(row => Number(row.YTD) > 0)
        .sort((a, b) => Number(b.YTD) - Number(a.YTD));
      rows.push(...modelRows);
    });
    return { ...fuelRankings, rows };
  }

  const map = new Map<string, Rec>();
  const modelsMap = new Map<string, Rec[]>(); // parentId -> array of model rows

  let totalUnits = 0;
  let bevUnits = 0;
  const ptMixMap: Record<string, number> = { ICE: 0, BEV: 0, HEV: 0, PHEV: 0 };

  tree.forEach(brandNode => {
    const cleanBrand = brandNode.brand;
    if (rankingBrand.length > 0 && !rankingBrand.includes(cleanBrand)) return;

    const key = cleanBrand;
    if (!map.has(key)) {
       const row: Rec = {
          id: key, name: cleanBrand, YTD: 0,
          hasChildren: (brandNode.models?.length ?? 0) > 0,
          isExpanded: expandedBrands.has(key)
       };
       timeKeys.forEach(t => row[t] = 0);
       map.set(key, row);
       modelsMap.set(key, []);
    }
    const row = map.get(key)!;
    // Update hasChildren in case we see models later
    if ((brandNode.models?.length ?? 0) > 0) row.hasChildren = true;
    row.isExpanded = expandedBrands.has(key);

    // Registry-backed segment sums, not a fuel-derived brand classification.
    const { timeVals, grandTotal } = getBrandSegmentSums(brandNode, rankingPt, selectedYear, selectedVehicleTypes, rankingProvince);

    timeKeys.forEach(t => { row[t] = Number(row[t]) + (timeVals[t] || 0); });
    row.YTD = Number(row.YTD) + grandTotal;

    totalUnits += grandTotal;
    (brandNode.models || []).forEach(model => {
      filterSegments(model.segments, rankingPt).forEach(seg => {
        const segTotal = getNodeSums(seg, selectedYear, selectedVehicleTypes, rankingProvince).grandTotal;
        if (seg.powertrain === "BEV") bevUnits += segTotal;
        if (seg.powertrain in ptMixMap) ptMixMap[seg.powertrain] += segTotal;
      });
    });

    // Calculate models if expanded
    if (expandedBrands.has(key)) {
       brandNode.models?.forEach(model => {
          if (rankingModel.length > 0 && !rankingModel.includes(model.name)) return;
          const mKey = `${key}|${model.name}`;
          const mList = modelsMap.get(key)!;
          let mRow = mList.find(r => r.id === mKey);
          if (!mRow) {
             mRow = { id: mKey, parentId: key, name: model.name, YTD: 0, isSubRow: true };
             timeKeys.forEach(t => mRow![t] = 0);
             mList.push(mRow);
          }
          const mSums = getModelSegmentSums(model, rankingPt, selectedYear, selectedVehicleTypes, rankingProvince);
          timeKeys.forEach(t => { mRow![t] = Number(mRow![t]) + (mSums.timeVals[t] || 0); });
          mRow!.YTD = Number(mRow!.YTD) + mSums.grandTotal;
       });
    }
  });

  // Assemble final flat array correctly preserving hierarchy for the table
  const finalRows: Rec[] = [];
  const sortedBrands = Array.from(map.values())
     .filter(r => Number(r.YTD) > 0)
     .sort((a, b) => Number(b.YTD) - Number(a.YTD))
     .map((r, i) => ({ ...r, rank: i + 1 } as Rec));

  sortedBrands.forEach(b => {
     finalRows.push(b);
     if (expandedBrands.has(String(b.id))) {
        const mList = modelsMap.get(String(b.id)) || [];
        const sortedModels = mList
           .filter(r => Number(r.YTD) > 0)
           .sort((a, b) => Number(b.YTD) - Number(a.YTD));
        finalRows.push(...sortedModels);
     }
  });

  const ptMix = Object.entries(ptMixMap).map(([name, val]) => ({ name, YTD: val })).filter(d => d.YTD > 0);

  return { rows: finalRows, totalUnits, bevUnits, ptMix };
}

export function selectDynamicChartData(
  data: DashboardData | null,
  chartGroupBy: "Brands" | "Models" | "Provinces",
  rankingPt: string[],
  rankingBrand: string[],
  rankingModel: string[],
  rankingProvince: string[],
  selectedYear: number | "All",
  selectedVehicleTypes: string[],
  brandModelTree?: BrandNode[] | null
) {
  const tree = brandModelTree || data?.brand_model_tree;
  if (!tree) return [];
  const cMap = new Map<string, number>();

  const addProvinceTotals = (monthly: TreeMonthly) => {
    const vcs = selectedVehicleTypes.length > 0 ? selectedVehicleTypes : Object.keys(monthly || {});
    vcs.forEach(vc => {
       const vcBucket = monthly?.[vc];
       if (!vcBucket) return;
       Object.keys(vcBucket).forEach(prov => {
          if (rankingProvince.length > 0 && !rankingProvince.includes(prov)) return;
          const pBucket = vcBucket[prov];
          let pTotal = 0;
          Object.keys(pBucket).forEach(yStr => {
             if (selectedYear !== "All" && yStr !== String(selectedYear)) return;
             const arr = pBucket[yStr];
             if (Array.isArray(arr)) for (let i=0; i<12; i++) pTotal += arr[i] || 0;
          });
          cMap.set(prov, (cMap.get(prov) || 0) + pTotal);
       });
    });
  };

  tree.forEach(brandNode => {
    const cleanBrand = brandNode.brand;
    if (rankingBrand.length > 0 && !rankingBrand.includes(cleanBrand)) return;

    if (chartGroupBy === "Brands") {
       // Registry-backed segment sums, not a fuel-derived brand classification.
       const { grandTotal } = getBrandSegmentSums(brandNode, rankingPt, selectedYear, selectedVehicleTypes, rankingProvince);
       cMap.set(cleanBrand, (cMap.get(cleanBrand) || 0) + grandTotal);
    } else if (chartGroupBy === "Models") {
       brandNode.models?.forEach(model => {
          if (rankingModel.length > 0 && !rankingModel.includes(model.name)) return;
          const { grandTotal } = getModelSegmentSums(model, rankingPt, selectedYear, selectedVehicleTypes, rankingProvince);
          const label = `${cleanBrand} ${model.name}`;
          cMap.set(label, (cMap.get(label) || 0) + grandTotal);
       });
    } else if (chartGroupBy === "Provinces") {
       if (rankingPt.length === 0) {
          addProvinceTotals(brandNode.monthly);
       } else {
          (brandNode.models || []).forEach(model => {
             filterSegments(model.segments, rankingPt).forEach(seg => addProvinceTotals(seg.monthly));
          });
       }
    }
  });

  return Array.from(cMap.entries())
    .map(([name, YTD]) => ({ name, YTD }))
    .sort((a, b) => b.YTD - a.YTD)
    .slice(0, 10);
}

export function selectProvinceAnalysisData(
  data: DashboardData | null,
  trendProvBrand: string,
  trendProvModel: string,
  selectedVehicleTypes: string[],
  selectedYear: number | "All",
  brandModelTree?: BrandNode[] | null
) {
  const tree = brandModelTree || data?.brand_model_tree;
  if (!tree) return [];
  const provMap = new Map<string, { prov: string; totalProvVol: number; selectedVol: number; rankMap: Map<string, number> }>();
  
  const targetKey = trendProvBrand && trendProvModel ? `${trendProvBrand}|${trendProvModel}` : trendProvBrand;

  tree.forEach(brandNode => {
    const cleanBrand = brandNode.brand;

    const processNode = (node: { monthly: TreeMonthly }, isSelected: boolean, key: string) => {
      const vcs = selectedVehicleTypes.length > 0 ? selectedVehicleTypes : Object.keys(node.monthly || {});
      vcs.forEach(vc => {
        const vcBucket = node.monthly?.[vc];
        if (!vcBucket) return;
        Object.keys(vcBucket).forEach(prov => {
          const pBucket = vcBucket[prov];
          if (!pBucket) return;
          let sum = 0;
          Object.keys(pBucket).forEach(yStr => {
            if (selectedYear !== "All" && yStr !== String(selectedYear)) return;
            const arr = pBucket[yStr];
            if (Array.isArray(arr)) {
              for (let i = 0; i < 12; i++) sum += arr[i] || 0;
            }
          });
          if (sum > 0) {
             if (!provMap.has(prov)) provMap.set(prov, { prov, totalProvVol: 0, selectedVol: 0, rankMap: new Map() });
             const pData = provMap.get(prov)!;
             pData.totalProvVol += sum;
             if (isSelected) pData.selectedVol += sum;
             pData.rankMap.set(key, (pData.rankMap.get(key) || 0) + sum);
          }
        });
      });
    };

    if (trendProvBrand && trendProvModel) {
       brandNode.models?.forEach(model => {
          const key = `${cleanBrand}|${model.name}`;
          const isModelSelected = key === targetKey;
          processNode(model, isModelSelected, key);
       });
    } else {
       const isBrandSelected = cleanBrand === targetKey;
       processNode(brandNode, isBrandSelected, cleanBrand);
    }
  });

  const res = Array.from(provMap.values()).map(p => {
    const share = p.totalProvVol > 0 ? p.selectedVol / p.totalProvVol : 0;
    let topCompetitor = "None";
    let topCompVol = 0;
    let myRank: number | string = "—";
    
    const ranks = Array.from(p.rankMap.entries()).sort((a, b) => b[1] - a[1]);
    
    if (!targetKey) {
       myRank = "—";
    } else {
       let rankCounter = 1;
       let foundMe = false;
       for (const [key, vol] of ranks) {
          if (key === targetKey) {
              myRank = rankCounter;
              foundMe = true;
          } else {
              if (vol > topCompVol) {
                 topCompetitor = key.includes("|") ? key.split("|")[1] : key;
                 topCompVol = vol;
              }
          }
          rankCounter++;
       }
       if (!foundMe) myRank = "—";
    }

    return { ...p, share, topCompetitor, myRank };
  });

  const sortedByVol = [...res].sort((a,b) => b.totalProvVol - a.totalProvVol);
  const p25 = sortedByVol[Math.floor(sortedByVol.length * 0.75)]?.totalProvVol || 0;
  const p50 = sortedByVol[Math.floor(sortedByVol.length * 0.5)]?.totalProvVol || 0;

  return res.map(p => {
    const status = determineProvinceStatus(p.share, p.totalProvVol, p25, p50);

    let shareStr = "—";
    if (p.totalProvVol > 0) {
       if (p.selectedVol > 0 && p.share < 0.0005) shareStr = "<0.1%";
       else shareStr = (p.share * 100).toFixed(1) + "%";
    }

    return {
      prov: p.prov,
      totalProvVol: p.totalProvVol,
      selectedVol: p.selectedVol,
      share: p.share,
      topCompetitor: p.topCompetitor,
      myRank: p.myRank,
      status,
      shareStr
    };
  });
}
