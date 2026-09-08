export type AnalystFilterRow = {
  brand: string;
  model?: string;
  is_grand_total?: boolean;
};

export type AnalystFact = {
  p: string;
  b: string;
  m?: string;
  y: number;
  mo: number;
  v: string;
  pt?: string;
  u: number;
};

export type AnalystCalculatedRow = {
  brand: string;
  model?: string;
  is_grand_total?: boolean;
  prev_month_units?: number;
  prev_month_share?: number;
  prev_ytd_units?: number;
  prev_ytd_share?: number;
  prev_full_units?: number;
  prev_full_share?: number;
  curr_month_units?: number;
  curr_month_share?: number;
  curr_month_diff?: number;
  curr_growth_vs_prev_month?: number;
  curr_growth_vs_same_month_prev_year?: number;
  curr_ytd_units?: number;
  curr_ytd_share?: number;
  curr_ytd_diff?: number;
  curr_ytd_growth?: number;
  prev_rank?: number;
  curr_rank?: number;
  rank_diff?: string | number | null;
};

// (brand, model, market segment) triples exactly as the facts spell brand and model, so a
// province view can apply the same segment filter the precomputed segment tables use.
export type ModelSegmentTriple = [string, string, string];

function segmentKey(brand: string, model: string) {
  return `${brand.trim().toUpperCase()}||${model.trim().toUpperCase()}`;
}

export function buildModelSegmentMap(triples?: ModelSegmentTriple[] | null): Map<string, string> {
  const map = new Map<string, string>();
  (triples ?? []).forEach((triple) => {
    const [brand, model, segment] = triple ?? [];
    if (!brand || !model || !segment) return;
    map.set(segmentKey(brand, model), segment);
  });
  return map;
}

// A fact with no model, or a model the segment map does not list, belongs to no segment and
// is dropped rather than guessed into one.
export function filterFactsBySegment(
  facts: AnalystFact[],
  segmentMap: Map<string, string>,
  segment: string,
): AnalystFact[] {
  if (!segment || segment === "ALL") return facts;
  return facts.filter((fact) => !!fact.m && segmentMap.get(segmentKey(fact.b, fact.m)) === segment);
}

export function selectAnalystFilterOptions(rows: AnalystFilterRow[], selectedBrand: string) {
  const brands = new Set<string>();
  const models = new Set<string>();

  rows.forEach((row) => {
    if (row.is_grand_total) return;
    if (row.brand) brands.add(row.brand);
    if ((!selectedBrand || row.brand === selectedBrand) && row.model) models.add(row.model);
  });

  return {
    brands: Array.from(brands).sort(),
    models: Array.from(models).sort(),
  };
}

export function filterAnalystRows<T extends AnalystFilterRow>(
  rows: T[],
  selectedBrand: string,
  selectedModel: string,
) {
  return rows.filter((row) => {
    if (row.is_grand_total) return true;
    if (selectedBrand && row.brand !== selectedBrand) return false;
    return !selectedModel || row.model === selectedModel;
  });
}

function rankBy(values: Map<string, number>) {
  const ranks = new Map<string, number>();
  let rank = 1;
  Array.from(values.entries())
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .forEach(([key], idx) => {
      rank = idx + 1;
      ranks.set(key, rank);
    });
  return ranks;
}

function rankDiff(prevRank?: number, currRank?: number): string {
  if (!prevRank) return "NEW";
  if (!currRank) return "—";
  const diff = prevRank - currRank;
  if (diff === 0) return "—";
  return diff > 0 ? `+${diff}` : String(diff);
}

function div(n: number, d: number) {
  return d ? n / d : undefined;
}

function cleanCount(n: number) {
  return n > 0 ? n : undefined;
}

export function buildAnalystRowsFromFacts({
  facts,
  viewBy,
  powertrain,
  vehicleType,
  province,
  currentYear,
  currentMonthNum,
}: {
  facts: AnalystFact[];
  viewBy: "brand" | "model";
  powertrain: string;
  vehicleType: string;
  province: string;
  currentYear: number;
  currentMonthNum: number;
}): AnalystCalculatedRow[] {
  const prevYear = currentYear - 1;
  const prevMonthNum = currentMonthNum === 1 ? 12 : currentMonthNum - 1;
  const prevMonthYear = currentMonthNum === 1 ? currentYear - 1 : currentYear;
  const scoped = facts.filter((fact) => {
    if (fact.p !== province) return false;
    if (vehicleType !== "ALL" && fact.v !== vehicleType) return false;
    if (viewBy === "brand" && powertrain !== "ALL" && fact.pt !== powertrain) return false;
    return true;
  });

  const buckets = new Map<string, {
    brand: string;
    model?: string;
    prevMonth: number;
    prevYtd: number;
    prevFull: number;
    currMonth: number;
    currPrevMonth: number;
    currYtd: number;
  }>();
  const totals = { prevMonth: 0, prevYtd: 0, prevFull: 0, currMonth: 0, currPrevMonth: 0, currYtd: 0 };

  const ensure = (fact: AnalystFact) => {
    const key = viewBy === "model" ? `${fact.b}||${fact.m ?? ""}` : fact.b;
    const existing = buckets.get(key);
    if (existing) return existing;
    const created = {
      brand: fact.b,
      model: viewBy === "model" ? fact.m : undefined,
      prevMonth: 0,
      prevYtd: 0,
      prevFull: 0,
      currMonth: 0,
      currPrevMonth: 0,
      currYtd: 0,
    };
    buckets.set(key, created);
    return created;
  };

  scoped.forEach((fact) => {
    const bucket = ensure(fact);
    const add = (field: keyof typeof totals) => {
      bucket[field] += fact.u;
      totals[field] += fact.u;
    };
    if (fact.y === prevYear && fact.mo === currentMonthNum) add("prevMonth");
    if (fact.y === prevYear && fact.mo <= currentMonthNum) add("prevYtd");
    if (fact.y === prevYear) add("prevFull");
    if (fact.y === currentYear && fact.mo === currentMonthNum) add("currMonth");
    if (fact.y === prevMonthYear && fact.mo === prevMonthNum) add("currPrevMonth");
    if (fact.y === currentYear && fact.mo <= currentMonthNum) add("currYtd");
  });

  const prevRanks = rankBy(new Map(Array.from(buckets.entries()).map(([key, row]) => [key, row.prevFull])));
  const currRanks = rankBy(new Map(Array.from(buckets.entries()).map(([key, row]) => [key, row.currYtd])));

  const rows: AnalystCalculatedRow[] = Array.from(buckets.entries()).map(([key, row]) => {
    const prevMonthShare = div(row.prevMonth, totals.prevMonth);
    const prevYtdShare = div(row.prevYtd, totals.prevYtd);
    const prevFullShare = div(row.prevFull, totals.prevFull);
    const currMonthShare = div(row.currMonth, totals.currMonth);
    const currYtdShare = div(row.currYtd, totals.currYtd);
    const prevRank = prevRanks.get(key);
    const currRank = currRanks.get(key);
    return {
      brand: row.brand,
      model: row.model,
      is_grand_total: false,
      prev_month_units: cleanCount(row.prevMonth),
      prev_month_share: prevMonthShare,
      prev_ytd_units: cleanCount(row.prevYtd),
      prev_ytd_share: prevYtdShare,
      prev_full_units: cleanCount(row.prevFull),
      prev_full_share: prevFullShare,
      curr_month_units: cleanCount(row.currMonth),
      curr_month_share: currMonthShare,
      curr_month_diff: currMonthShare !== undefined && prevMonthShare !== undefined ? currMonthShare - prevMonthShare : undefined,
      curr_growth_vs_prev_month: div(row.currMonth, row.currPrevMonth) !== undefined ? (row.currMonth / row.currPrevMonth) - 1 : undefined,
      curr_growth_vs_same_month_prev_year: div(row.currMonth, row.prevMonth) !== undefined ? (row.currMonth / row.prevMonth) - 1 : undefined,
      curr_ytd_units: cleanCount(row.currYtd),
      curr_ytd_share: currYtdShare,
      curr_ytd_diff: currYtdShare !== undefined && prevYtdShare !== undefined ? currYtdShare - prevYtdShare : undefined,
      curr_ytd_growth: div(row.currYtd, row.prevYtd) !== undefined ? (row.currYtd / row.prevYtd) - 1 : undefined,
      prev_rank: prevRank,
      curr_rank: currRank,
      rank_diff: rankDiff(prevRank, currRank),
    };
  });

  rows.sort((a, b) => (b.curr_ytd_units ?? -1) - (a.curr_ytd_units ?? -1) || (b.curr_month_units ?? -1) - (a.curr_month_units ?? -1) || a.brand.localeCompare(b.brand));

  const grandPrevMonthShare = totals.prevMonth ? 1 : undefined;
  const grandPrevYtdShare = totals.prevYtd ? 1 : undefined;
  const grandCurrMonthShare = totals.currMonth ? 1 : undefined;
  const grandCurrYtdShare = totals.currYtd ? 1 : undefined;
  rows.unshift({
    brand: "Grand Total",
    is_grand_total: true,
    prev_month_units: cleanCount(totals.prevMonth),
    prev_month_share: grandPrevMonthShare,
    prev_ytd_units: cleanCount(totals.prevYtd),
    prev_ytd_share: grandPrevYtdShare,
    prev_full_units: cleanCount(totals.prevFull),
    prev_full_share: totals.prevFull ? 1 : undefined,
    curr_month_units: cleanCount(totals.currMonth),
    curr_month_share: grandCurrMonthShare,
    curr_month_diff: grandCurrMonthShare !== undefined && grandPrevMonthShare !== undefined ? grandCurrMonthShare - grandPrevMonthShare : undefined,
    curr_growth_vs_prev_month: totals.currPrevMonth ? (totals.currMonth / totals.currPrevMonth) - 1 : undefined,
    curr_growth_vs_same_month_prev_year: totals.prevMonth ? (totals.currMonth / totals.prevMonth) - 1 : undefined,
    curr_ytd_units: cleanCount(totals.currYtd),
    curr_ytd_share: grandCurrYtdShare,
    curr_ytd_diff: grandCurrYtdShare !== undefined && grandPrevYtdShare !== undefined ? grandCurrYtdShare - grandPrevYtdShare : undefined,
    curr_ytd_growth: totals.prevYtd ? (totals.currYtd / totals.prevYtd) - 1 : undefined,
    rank_diff: null,
  });

  return rows;
}
