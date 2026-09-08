"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import Link from "next/link";
import { Download, RefreshCw, AlertTriangle, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import {
  buildAnalystRowsFromFacts,
  buildModelSegmentMap,
  filterAnalystRows,
  filterFactsBySegment,
  selectAnalystFilterOptions,
  type AnalystFact,
  type ModelSegmentTriple,
} from "../analystFilters";
import { FilterPillPopover } from "../../components/FilterPillPopover";
import { modelOwnerLookup } from "../selectors";

const DATA_BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MISSING = "—";
const POWERTRAIN_OPTIONS = ["ICE", "BEV", "HEV", "PHEV"];

type AnalystRow = {
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

export type AnalystData = {
  meta: {
    current_year?: number;
    current_month_num: number;
    years?: number[];
    months?: string[];
    provinces?: string[];
    segments?: string[];
    model_segments?: ModelSegmentTriple[];
    vehicle_types_list?: { code: string; label: string }[];
    [key: string]: unknown;
  };
  data: {
    brand?: Record<string, Record<string, AnalystRow[]>>;
    model?: Record<string, Record<string, AnalystRow[]>>;
  };
  // One calculation table per market segment, built from model rows only: shares, ranks
  // and the Grand Total are computed within the segment, never carried over from the
  // whole market. Powertrain is always ALL here — model rows carry no powertrain.
  data_by_segment?: Record<string, {
    brand?: Record<string, AnalystRow[]>;
    model?: Record<string, AnalystRow[]>;
  }>;
};

type AnalystProvinceData = {
  meta: AnalystData["meta"];
  facts: {
    brand: AnalystFact[];
    model: AnalystFact[];
  };
};

export default function AnalystPage() {
  const [data, setData] = useState<AnalystData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [provinceData, setProvinceData] = useState<AnalystProvinceData | null>(null);
  const [provinceError, setProvinceError] = useState<string | null>(null);

  // Filters State
  const [currentViewBy, setCurrentViewBy] = useState<"brand" | "model">("brand");
  const [currentPowertrain, setCurrentPowertrain] = useState<string>("ALL");
  const [selectedVehicleType, setSelectedVehicleType] = useState<string>("ALL");
  const [selectedProvince, setSelectedProvince] = useState<string>("ALL");
  const [selectedSegment, setSelectedSegment] = useState<string>("ALL");
  const [selectedBrand, setSelectedBrand] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  
  // Sort State
  const [sortField, setSortField] = useState<keyof AnalystRow>("curr_ytd_units");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  
  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(100);
  const [exporting, setExporting] = useState(false);

  // Refs for sticky table header height measurement
  const tableRef = useRef<HTMLTableElement>(null);
  const tr1Ref = useRef<HTMLTableRowElement>(null);
  const tr2Ref = useRef<HTMLTableRowElement>(null);
  const tr3Ref = useRef<HTMLTableRowElement>(null);
  const provinceFetchStartedRef = useRef(false);

  const loadData = () => {
    setLoading(true);
    setError(null);
    fetch(`${DATA_BASE}/data/analyst_data.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
        return r.json();
      })
      .then((j: AnalystData) => {
        setData(j);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load analyst_data.json:", err);
        setError("Failed to load data. Please try again.");
        setLoading(false);
      });
  };

  useEffect(() => {
    fetch(`${DATA_BASE}/data/analyst_data.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
        return r.json();
      })
      .then((j: AnalystData) => {
        setData(j);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load analyst_data.json:", err);
        setError("Failed to load data. Please try again.");
        setLoading(false);
      });
  }, []);

  // Reset page to 1 when filters or sorting changes (using render-phase state updates)
  const [prevFilterKey, setPrevFilterKey] = useState("");
  const currentFilterKey = `${selectedBrand}||${selectedModel}||${currentViewBy}||${currentPowertrain}||${selectedVehicleType}||${selectedProvince}||${selectedSegment}||${sortField}||${sortDirection}`;
  if (currentFilterKey !== prevFilterKey) {
    setPrevFilterKey(currentFilterKey);
    setCurrentPage(1);
  }

  useEffect(() => {
    if (selectedProvince === "ALL" || provinceData || provinceError || provinceFetchStartedRef.current) return;
    provinceFetchStartedRef.current = true;
    fetch(`${DATA_BASE}/data/analyst_province_data.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
        return r.json();
      })
      .then((j: AnalystProvinceData) => {
        setProvinceData(j);
      })
      .catch((err) => {
        console.error("Failed to load analyst_province_data.json:", err);
        provinceFetchStartedRef.current = false;
        setProvinceError("Province data could not be loaded. National rows are still available.");
      });
  }, [selectedProvince, provinceData, provinceError]);

  // Recalculate sticky offsets using ResizeObserver and CSS custom properties
  useEffect(() => {
    if (loading || !data) return;

    const table = tableRef.current;
    if (!table) return;

    const tr1 = tr1Ref.current;
    const tr2 = tr2Ref.current;

    const measure = () => {
      const h1 = tr1?.getBoundingClientRect().height || 0;
      const h2 = tr2?.getBoundingClientRect().height || 0;
      table.style.setProperty("--header-h1", `${h1}px`);
      table.style.setProperty("--header-h2", `${h1 + h2}px`);
    };

    // Initial measurement
    measure();

    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(table);

    // Re-run measurement when custom fonts are loaded to prevent layout jank
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.ready.then(measure);
    }

    return () => {
      observer.disconnect();
    };
  }, [loading, data, currentViewBy, currentPowertrain, selectedVehicleType, selectedProvince, selectedSegment]);

  const meta = data?.meta;
  const currYear = meta?.current_year;
  const prevYear = currYear ? currYear - 1 : "";
  const monthLabel = MONTHS_EN[(meta?.current_month_num ?? 0) - 1] || "";
  const isProvinceMode = selectedProvince !== "ALL";
  const isProvincePending = isProvinceMode && !provinceData && !provinceError;
  const isSegmentMode = selectedSegment !== "ALL";
  // Segments are a model-grain fact, so a segment view always reads model rows and its
  // powertrain is ALL — the same rule the Model view already follows.
  const effectivePowertrain = currentViewBy === "model" || isSegmentMode ? "ALL" : currentPowertrain;
  const segmentMap = useMemo(() => buildModelSegmentMap(meta?.model_segments), [meta?.model_segments]);
  const segmentOptions = meta?.segments ?? [];
  const currentFacts = useMemo(
    () => {
      if (!isProvinceMode || !provinceData) return [];
      if (isSegmentMode) return filterFactsBySegment(provinceData.facts.model, segmentMap, selectedSegment);
      return provinceData.facts[currentViewBy] ?? [];
    },
    [isProvinceMode, provinceData, currentViewBy, isSegmentMode, segmentMap, selectedSegment],
  );
  const currentMonthNum = meta?.current_month_num ?? 0;
  const currentYearNum = meta?.current_year ?? 0;

  const handleViewByChange = (viewBy: "brand" | "model") => {
    setCurrentViewBy(viewBy);
    if (viewBy === "model") setCurrentPowertrain("ALL");
    if (viewBy === "brand") setSelectedModel("");
  };

  const modelFilterRows = useMemo(
    () => {
      if (isProvinceMode && provinceData && currentYearNum && currentMonthNum) {
        return buildAnalystRowsFromFacts({
          facts: isSegmentMode
            ? filterFactsBySegment(provinceData.facts.model, segmentMap, selectedSegment)
            : provinceData.facts.model,
          viewBy: "model",
          powertrain: "ALL",
          vehicleType: selectedVehicleType,
          province: selectedProvince,
          currentYear: currentYearNum,
          currentMonthNum,
        });
      }
      if (isSegmentMode) return data?.data_by_segment?.[selectedSegment]?.model?.[selectedVehicleType] || [];
      return data?.data?.model?.ALL?.[selectedVehicleType] || [];
    },
    [isProvinceMode, provinceData, currentYearNum, currentMonthNum, selectedVehicleType, selectedProvince, data, isSegmentMode, segmentMap, selectedSegment],
  );

  // Model view options come from the already-loaded analyst rows for the active vehicle type.
  const modelViewOptions = useMemo(
    () => selectAnalystFilterOptions(modelFilterRows, selectedBrand),
    [modelFilterRows, selectedBrand],
  );

  // Ownership index rebuilt only when the VT-scoped rows change, not on every model pick.
  const modelOwners = useMemo(
    () => modelOwnerLookup(modelFilterRows.filter((r) => !r.is_grand_total)),
    [modelFilterRows],
  );

  const brandOptions = useMemo(() => {
    if (currentViewBy === "model") return modelViewOptions.brands;
    const brandsSet = new Set<string>();
    if (isSegmentMode && !isProvinceMode) {
      (data?.data_by_segment?.[selectedSegment]?.brand?.[selectedVehicleType] ?? []).forEach((r) => {
        if (!r.is_grand_total && r.brand) brandsSet.add(r.brand);
      });
      return Array.from(brandsSet).sort();
    }
    if (isProvinceMode && provinceData && currentYearNum && currentMonthNum) {
      buildAnalystRowsFromFacts({
        facts: isSegmentMode ? currentFacts : provinceData.facts.brand,
        viewBy: "brand",
        powertrain: "ALL",
        vehicleType: selectedVehicleType,
        province: selectedProvince,
        currentYear: currentYearNum,
        currentMonthNum,
      }).forEach((r) => {
        if (!r.is_grand_total && r.brand) brandsSet.add(r.brand);
      });
    } else if (data?.data?.brand) {
      Object.values(data.data.brand).forEach((byVehicleType) => {
        Object.values(byVehicleType).forEach((ptRows: AnalystRow[]) => {
          ptRows.forEach((r: AnalystRow) => {
            if (!r.is_grand_total && r.brand) brandsSet.add(r.brand);
          });
        });
      });
    }
    return Array.from(brandsSet).sort();
  }, [currentViewBy, isProvinceMode, provinceData, currentYearNum, currentMonthNum, selectedVehicleType, selectedProvince, data, modelViewOptions.brands, isSegmentMode, selectedSegment, currentFacts]);

  const handleBrandChange = (brand: string) => {
    setSelectedBrand(brand);
    if (currentViewBy !== "model") return;
    const validModels = new Set(selectAnalystFilterOptions(modelFilterRows, brand).models);
    if (selectedModel && !validModels.has(selectedModel)) setSelectedModel("");
  };

  // Selecting a model owned by exactly one brand (in the current vehicle-type context) syncs
  // that brand; a model shared across brands is left alone (no guess). Only in Model view —
  // syncing Brand in Brand view would silently filter Brand-view rows via Model, which the
  // spec forbids.
  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    if (!model || selectedBrand || currentViewBy !== "model") return;
    const owner = modelOwners.get(model);
    if (owner) setSelectedBrand(owner);
  };

  const handleVehicleTypeChange = (vehicleType: string) => {
    setSelectedVehicleType(vehicleType);
    setSelectedModel("");
    if (currentViewBy === "model" && selectedBrand) {
      const rows = isProvinceMode && provinceData && currentYearNum && currentMonthNum
        ? buildAnalystRowsFromFacts({
            facts: provinceData.facts.model,
            viewBy: "model",
            powertrain: "ALL",
            vehicleType,
            province: selectedProvince,
            currentYear: currentYearNum,
            currentMonthNum,
          })
        : data?.data?.model?.ALL?.[vehicleType] || [];
      const validBrands = new Set(selectAnalystFilterOptions(rows, "").brands);
      if (!validBrands.has(selectedBrand)) setSelectedBrand("");
    }
  };

  // Picking a segment swaps the whole table to that segment's own calculation, so the
  // Model pick never survives and the Brand pick survives only if that brand sells in the
  // segment. Powertrain goes back to ALL because model rows cannot carry one.
  const handleSegmentChange = (segment: string) => {
    setSelectedSegment(segment);
    setSelectedModel("");
    if (segment === "ALL") return;
    setCurrentPowertrain("ALL");
    if (!selectedBrand) return;
    const validBrands = new Set(
      (data?.data_by_segment?.[segment]?.brand?.[selectedVehicleType] ?? [])
        .filter((r) => !r.is_grand_total)
        .map((r) => r.brand),
    );
    if (!validBrands.has(selectedBrand)) setSelectedBrand("");
  };

  const handleProvinceChange = (province: string) => {
    setSelectedProvince(province);
    setProvinceError(null);
    setSelectedBrand("");
    setSelectedModel("");
  };

  // Formatter functions
  const formatNum = (n?: number) => {
    if (n === null || n === undefined) return MISSING;
    return new Intl.NumberFormat("en-US").format(n);
  };

  const formatPct = (n?: number) => {
    if (n === null || n === undefined) return MISSING;
    return new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
  };

  const formatSignedPct = (n?: number) => {
    if (n === null || n === undefined) return MISSING;
    const sign = n > 0 ? "+" : "";
    return `${sign}${formatPct(n)}`;
  };

  const formatPP = (n?: number) => {
    if (n === null || n === undefined) return MISSING;
    const sign = n > 0 ? "+" : "";
    return `${sign}${(n * 100).toFixed(1)} pp`;
  };

  const getTrendColor = (n?: number) => {
    if (!n) return "text-slate-300";
    if (n > 0) return "text-emerald-400";
    if (n < 0) return "text-rose-400";
    return "text-slate-300";
  };

  // Get sort value helper
  const getSortValue = (row: AnalystRow, field: keyof AnalystRow) => {
    const val = row[field];
    if (val === null || val === undefined || val === "") return -Infinity;
    if (field === "rank_diff" && val === "NEW") return Infinity;
    if (typeof val === "string") {
      const num = Number(val.replace(/,/g, ""));
      return isNaN(num) ? -Infinity : num;
    }
    return val as number;
  };

  // Sort and Filter rows
  const filteredAndSortedRows = useMemo(() => {
    const rawRows: AnalystRow[] = isProvinceMode && provinceData && currentYearNum && currentMonthNum
      ? buildAnalystRowsFromFacts({
          facts: currentFacts,
          viewBy: currentViewBy,
          powertrain: effectivePowertrain,
          vehicleType: selectedVehicleType,
          province: selectedProvince,
          currentYear: currentYearNum,
          currentMonthNum,
        })
      : isSegmentMode
        ? data?.data_by_segment?.[selectedSegment]?.[currentViewBy]?.[selectedVehicleType] || []
        : data?.data?.[currentViewBy]?.[currentPowertrain]?.[selectedVehicleType] || [];
    if (rawRows.length === 0) return [];

    let filtered = rawRows.slice();

    // Cascading Brand and Model filters
    filtered = filterAnalystRows(filtered, selectedBrand, currentViewBy === "model" ? selectedModel : "");

    // Sorting (keep Grand Total at the top, sort details)
    const grandTotals = filtered.filter((r) => r.is_grand_total);
    const details = filtered.filter((r) => !r.is_grand_total);

    details.sort((a, b) => {
      const aVal = getSortValue(a, sortField);
      const bVal = getSortValue(b, sortField);
      if (aVal === bVal) return 0;
      const compare = aVal > bVal ? 1 : -1;
      return sortDirection === "asc" ? compare : -compare;
    });

    return grandTotals.concat(details);
  }, [isProvinceMode, provinceData, currentYearNum, currentMonthNum, currentFacts, currentViewBy, currentPowertrain, effectivePowertrain, selectedVehicleType, selectedProvince, data, selectedBrand, selectedModel, sortField, sortDirection, isSegmentMode, selectedSegment]);

  const paginatedRows = useMemo(() => {
    const grandTotals = filteredAndSortedRows.filter(r => r.is_grand_total);
    const details = filteredAndSortedRows.filter(r => !r.is_grand_total);

    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    const paginatedDetails = details.slice(start, end);

    return grandTotals.concat(paginatedDetails);
  }, [filteredAndSortedRows, currentPage, pageSize]);

  // Handle Sort Change
  const handleSort = (field: keyof AnalystRow) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const handleExportExcel = async () => {
    if (!data || exporting) return;
    setExporting(true);

    try {
      const XLSX = await import("xlsx");

      // Sheet 1: Analyst Full Data (unfiltered)
      const fullRows: AnalystRow[] = isProvinceMode && provinceData && currentYearNum && currentMonthNum
        ? buildAnalystRowsFromFacts({
            facts: currentFacts,
            viewBy: currentViewBy,
            powertrain: effectivePowertrain,
            vehicleType: selectedVehicleType,
            province: selectedProvince,
            currentYear: currentYearNum,
            currentMonthNum,
          })
        : isSegmentMode
          ? data.data_by_segment?.[selectedSegment]?.[currentViewBy]?.[selectedVehicleType] || []
          : data.data[currentViewBy]?.[currentPowertrain]?.[selectedVehicleType] || [];
      const excelFull = getExcelRows(fullRows);

      // Sheet 2: Analyst View (currently filtered & sorted)
      const excelFiltered = getExcelRows(filteredAndSortedRows);

      // The workbook opens on the operator's current view, not the whole market, so an
      // export taken under a filter cannot be mistaken for an unfiltered one.
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(excelFiltered), "Filtered Analyst View");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(excelFull), "Full Analyst Data");

      const fileDate = `${meta?.current_year ?? ""}-${String(meta?.current_month_num ?? "").padStart(2, "0")}`;
      const hasActiveFilters = Boolean(selectedBrand) || Boolean(selectedModel) || isSegmentMode
        || selectedVehicleType !== "ALL" || selectedProvince !== "ALL" || currentPowertrain !== "ALL";
      XLSX.writeFile(wb, `EternityOne_Analyst_Report_${fileDate}${hasActiveFilters ? "_filtered" : ""}.xlsx`);
    } catch (e) {
      console.error(e);
      alert("Excel export failed");
    } finally {
      setExporting(false);
    }
  };

  const getExcelRows = (rowsList: AnalystRow[]) => {
    return rowsList.map((r) => {
      const isGrand = r.is_grand_total;
      return {
        "Brand / Model": isGrand ? "Grand Total" : (currentViewBy === "model" ? `${r.brand} - ${r.model}` : r.brand),
        [`${prevYear} ${monthLabel} Units`]: r.prev_month_units ?? "",
        [`${prevYear} ${monthLabel} Share`]: r.prev_month_share ? `${(r.prev_month_share * 100).toFixed(1)}%` : "",
        [`${prevYear} YTD Units`]: r.prev_ytd_units ?? "",
        [`${prevYear} YTD Share`]: r.prev_ytd_share ? `${(r.prev_ytd_share * 100).toFixed(1)}%` : "",
        [`${prevYear} Total Units`]: r.prev_full_units ?? "",
        [`${prevYear} Total Share`]: r.prev_full_share ? `${(r.prev_full_share * 100).toFixed(1)}%` : "",
        [`${currYear} ${monthLabel} Units`]: r.curr_month_units ?? "",
        [`${currYear} ${monthLabel} Share`]: r.curr_month_share ? `${(r.curr_month_share * 100).toFixed(1)}%` : "",
        [`${currYear} ${monthLabel} Diff`]: r.curr_month_diff ? `${(r.curr_month_diff * 100).toFixed(1)} pp` : "",
        [`${currYear} Growth vs Prev Month`]: r.curr_growth_vs_prev_month ? `${(r.curr_growth_vs_prev_month * 100).toFixed(1)}%` : "",
        [`${currYear} Growth vs Same Month ${prevYear}`]: r.curr_growth_vs_same_month_prev_year ? `${(r.curr_growth_vs_same_month_prev_year * 100).toFixed(1)}%` : "",
        [`${currYear} YTD Units`]: r.curr_ytd_units ?? "",
        [`${currYear} YTD Share`]: r.curr_ytd_share ? `${(r.curr_ytd_share * 100).toFixed(1)}%` : "",
        [`${currYear} YTD Diff`]: r.curr_ytd_diff ? `${(r.curr_ytd_diff * 100).toFixed(1)} pp` : "",
        [`${currYear} YTD Growth`]: r.curr_ytd_growth ? `${(r.curr_ytd_growth * 100).toFixed(1)}%` : "",
        [`${prevYear} Rank`]: r.prev_rank ?? "",
        [`${currYear} Rank`]: r.curr_rank ?? "",
        "Rank Diff": r.rank_diff ?? ""
      };
    });
  };

  const renderSortHeader = (field: keyof AnalystRow, label: string, center = false) => {
    const isSorted = sortField === field;
    return (
      <button 
        type="button" 
        onClick={() => handleSort(field)}
        className={`w-full flex items-center gap-1 hover:text-white transition-colors outline-none focus:ring-1 focus:ring-teal-400 rounded px-1 ${center ? "justify-center" : "justify-end"}`}
      >
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
        {isSorted ? (
          sortDirection === "asc" ? <ArrowUp className="h-3 w-3 text-teal-400 flex-shrink-0" /> : <ArrowDown className="h-3 w-3 text-teal-400 flex-shrink-0" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30 flex-shrink-0" />
        )}
      </button>
    );
  };

  if (loading) {
    return (
      <div className="bg-slate-950 text-slate-100 min-h-screen p-6" role="status" aria-live="polite">
        <span className="sr-only">Loading Analyst data…</span>
        <div className="max-w-[95rem] mx-auto space-y-4" aria-hidden="true">
          <div className="h-24 rounded-md border border-slate-800 bg-slate-900" />
          <div className="h-96 rounded-md border border-slate-800 bg-slate-900" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-slate-950 text-slate-100 min-h-screen flex flex-col items-center justify-center p-6" role="alert" aria-live="assertive">
        <div className="flex flex-col items-center gap-4 bg-slate-900 border border-slate-800 p-6 rounded-md max-w-md text-center">
          <AlertTriangle className="h-10 w-10 text-red-500" />
          <h2 className="text-sm font-semibold text-red-400">Failed to Load Analyst Data</h2>
          <p className="text-xs text-slate-400">{error || "Data could not be loaded."}</p>
          <button onClick={loadData} className="bg-teal-600 hover:bg-teal-500 text-white font-medium text-xs px-4 py-2 rounded-md transition-colors flex items-center gap-1.5 focus:ring-2 focus:ring-teal-400 outline-none">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-950 text-slate-100 p-6 min-h-screen font-sans antialiased">
      <div className="max-w-[95rem] mx-auto space-y-4">
        {/* Breadcrumb Navigation */}
        <nav aria-label="Breadcrumb" className="flex items-center">
          <Link href="/" className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-teal-400 transition-colors focus:ring-1 focus:ring-teal-400 focus:outline-none rounded px-1 py-0.5">
            <span aria-hidden="true">←</span>
            <span>Back to Dashboard</span>
          </Link>
        </nav>

        {/* Header & Controls Panel */}
        <div className="bg-slate-900 border border-slate-800 rounded-md p-5 space-y-4">
          <div className="flex justify-between items-center flex-wrap gap-3">
            <div>
              <h1 className="text-sm font-semibold text-teal-400 tracking-tight">Analyst Calculation Table</h1>
              <p className="text-[10px] text-slate-500 mt-0.5">Thailand Department of Land Transport — Detailed Registration Analysis</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs bg-slate-950 text-teal-300 font-semibold px-3 py-2 rounded border border-slate-800">
                Data through: {monthLabel} {currYear}
              </span>
              <button
                id="btn-export-excel"
                disabled={exporting}
                onClick={handleExportExcel}
                className="bg-teal-600 hover:bg-teal-500 active:bg-teal-700 text-white text-xs px-4 py-2.5 rounded-md font-medium transition-colors flex items-center gap-1.5 focus:ring-2 focus:ring-teal-400 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Export analyst calculations to Excel spreadsheet"
              >
                {exporting ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Exporting...</span>
                  </>
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5" />
                    <span>Export Excel</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Primary filter pills mirror the Deep-Dive filter vocabulary. */}
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3 pt-1 text-sm">
            <div className="min-w-[150px]">
              <FilterPillPopover
                label="Brand"
                placeholder="Search brands..."
                options={brandOptions}
                value={selectedBrand ? [selectedBrand] : []}
                onChange={(v) => handleBrandChange(v[0] ?? "")}
                singleSelect
              />
            </div>
            <div className="min-w-[150px]">
              <FilterPillPopover
                label="Model"
                placeholder="Search models..."
                options={modelViewOptions.models}
                value={selectedModel ? [selectedModel] : []}
                onChange={(v) => handleModelChange(v[0] ?? "")}
                singleSelect
              />
            </div>
            <div className="min-w-[190px]">
              <FilterPillPopover
                label="Vehicle Type"
                placeholder="Search vehicle types..."
                options={meta?.vehicle_types_list?.map(v => ({ id: v.code, label: v.label })) ?? []}
                value={selectedVehicleType === "ALL" ? [] : [selectedVehicleType]}
                onChange={(v) => handleVehicleTypeChange(v[0] ?? "ALL")}
                singleSelect
              />
            </div>
            <div className="min-w-[170px]">
              <FilterPillPopover
                label="Province"
                placeholder="Search provinces..."
                options={meta?.provinces ?? []}
                value={selectedProvince === "ALL" ? [] : [selectedProvince]}
                onChange={(v) => handleProvinceChange(v[0] ?? "ALL")}
                singleSelect
              />
            </div>
            <div className="min-w-[150px]">
              <FilterPillPopover
                label="Segment"
                placeholder="Search segments..."
                options={segmentOptions}
                value={selectedSegment === "ALL" ? [] : [selectedSegment]}
                onChange={(v) => handleSegmentChange(v[0] ?? "ALL")}
                singleSelect
              />
            </div>
            <div
              className={`min-w-[150px] ${currentViewBy === "model" || isSegmentMode ? "opacity-40 pointer-events-none" : ""}`}
              title={
                isSegmentMode
                  ? "Powertrain locked to ALL — a segment is a model-level fact and model data has no powertrain breakdown"
                  : currentViewBy === "model"
                    ? "Powertrain locked to ALL — model data has no powertrain breakdown"
                    : undefined
              }
            >
              <FilterPillPopover
                label="Powertrain"
                placeholder="Search powertrain..."
                options={POWERTRAIN_OPTIONS}
                value={currentPowertrain === "ALL" ? [] : [currentPowertrain]}
                onChange={(v) => setCurrentPowertrain(v[0] ?? "ALL")}
                singleSelect
              />
            </div>

            {/* View By is Analyst-only and secondary to the Deep-Dive-style filter pills. */}
            <div className="flex flex-col justify-center md:ml-auto">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">View By</span>
              <div className="flex items-center rounded-full border border-slate-700 bg-slate-800 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => handleViewByChange("brand")}
                  className={`rounded-full px-2.5 py-1 font-medium transition-colors ${currentViewBy === "brand" ? "bg-teal-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
                >
                  Brand
                </button>
                <button
                  type="button"
                  onClick={() => handleViewByChange("model")}
                  className={`rounded-full px-2.5 py-1 font-medium transition-colors ${currentViewBy === "model" ? "bg-teal-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
                >
                  Model
                </button>
              </div>
            </div>
          </div>
        </div>

        {(isProvincePending || provinceError) && (
          <div
            role={provinceError ? "alert" : "status"}
            aria-live="polite"
            className={`rounded-md border px-3 py-2 text-xs ${
              provinceError
                ? "border-amber-900/60 bg-amber-950/30 text-amber-200"
                : "border-slate-800 bg-slate-900 text-slate-400"
            }`}
          >
            {provinceError ?? `Loading analyst rows for ${selectedProvince}...`}
          </div>
        )}

        {/* Pivot/Calculation Table Container */}
        <div className="bg-slate-900 border border-slate-800 rounded-md overflow-hidden">
          <div className="overflow-x-auto overflow-y-auto max-h-[68vh] custom-scrollbar">
            <table ref={tableRef} className="w-full text-left border-separate border-spacing-0 text-xs whitespace-nowrap">
              <thead>
                {/* Header Row 1: Years */}
                <tr ref={tr1Ref} className="bg-slate-800 border-b border-slate-700 text-center">
                  <th scope="col" rowSpan={3} className="p-3 sticky top-0 left-0 z-50 bg-slate-800 text-left pl-4 border-r border-slate-500">
                    {currentViewBy === "model" ? "Brand / Model" : "Brand"}
                  </th>
                  <th scope="col" colSpan={6} className="p-2 border-r border-slate-500 bg-slate-800 font-bold text-slate-300 sticky top-0 z-30">
                    {prevYear}
                  </th>
                  <th scope="col" colSpan={9} className="p-2 border-r border-slate-500 bg-slate-800 font-bold text-slate-300 sticky top-0 z-30">
                    {currYear}
                  </th>
                  <th scope="col" colSpan={3} rowSpan={2} className="p-2 bg-slate-800 font-bold text-slate-300 sticky top-0 z-30">
                    Rankings
                  </th>
                </tr>

                {/* Header Row 2: Periods */}
                <tr ref={tr2Ref} className="bg-slate-800 text-slate-400 border-b border-slate-700 text-center text-[9px] uppercase tracking-wider">
                  <th scope="col" colSpan={2} className="p-1 border-r border-slate-800 bg-slate-800 font-semibold sticky z-30" style={{ top: "var(--header-h1, 38px)" }}>{monthLabel}</th>
                  <th scope="col" colSpan={2} className="p-1 border-r border-slate-800 bg-slate-800 font-semibold sticky z-30" style={{ top: "var(--header-h1, 38px)" }}>Jan-{monthLabel}</th>
                  <th scope="col" colSpan={2} className="p-1 border-r border-slate-500 bg-slate-800 font-semibold sticky z-30" style={{ top: "var(--header-h1, 38px)" }}>{prevYear} Total</th>
                  <th scope="col" colSpan={5} className="p-1 border-r border-slate-800 bg-slate-800 font-semibold sticky z-30" style={{ top: "var(--header-h1, 38px)" }}>{monthLabel}</th>
                  <th scope="col" colSpan={4} className="p-1 border-r border-slate-500 bg-slate-800 font-semibold sticky z-30" style={{ top: "var(--header-h1, 38px)" }}>Jan-{monthLabel} {currYear}</th>
                </tr>

                {/* Header Row 3: Action Sort Headers */}
                <tr ref={tr3Ref} className="bg-slate-800 text-slate-400 border-b border-slate-700 text-center">
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("prev_month_units", "Units")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 border-r border-slate-800 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("prev_month_share", "Share")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("prev_ytd_units", "Units")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 border-r border-slate-800 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("prev_ytd_share", "Share")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("prev_full_units", "Units")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 border-r border-slate-500 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("prev_full_share", "Share")}</th>
                  
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 text-slate-350 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_month_units", "Units")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 text-slate-350 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_month_share", "Share")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_month_diff", "Diff")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_growth_vs_prev_month", "Gr MoM")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 border-r border-slate-800 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_growth_vs_same_month_prev_year", `Gr YoY`)}</th>
                  
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 text-slate-350 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_ytd_units", "Units")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 text-slate-350 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_ytd_share", "Share")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_ytd_diff", "Diff")}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 border-r border-slate-500 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_ytd_growth", "Gr YTD")}</th>
                  
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("prev_rank", String(prevYear), true)}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("curr_rank", String(currYear), true)}</th>
                  <th scope="col" className="p-2 bg-slate-800 border-b border-slate-600 sticky z-30" style={{ top: "var(--header-h2, 60px)" }}>{renderSortHeader("rank_diff", "Diff", true)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850">
                  {filteredAndSortedRows.length === 0 ? (
                    <tr>
                      <td colSpan={20} className="p-10 text-center text-slate-500">No analyst rows match filters.</td>
                    </tr>
                  ) : (
                    paginatedRows.map((r, rIdx) => {
                    const isGrand = r.is_grand_total;
                    const trClass = isGrand 
                      ? "bg-slate-900 font-bold text-teal-400 border-b-2 border-slate-500" 
                      : "hover:bg-slate-800/40 text-slate-300 transition-colors";
                      
                    return (
                      <tr key={isGrand ? "grand-total" : `${r.brand}-${r.model ?? rIdx}`} className={trClass}>
                        {/* Brand Column (Sticky Left) */}
                        <td className="p-3 sticky left-0 z-20 bg-slate-900 border-r border-slate-500">
                          {isGrand ? (
                            <span className="text-teal-400 font-bold">Grand Total</span>
                          ) : currentViewBy === "model" ? (
                            <div>
                              <div className="font-semibold text-slate-200 text-xs">{r.brand}</div>
                              <div className="text-[10px] text-slate-500 mt-0.5">{r.model ?? MISSING}</div>
                            </div>
                          ) : (
                            <span className="font-semibold text-slate-200">{r.brand}</span>
                          )}
                        </td>

                        {/* Prev Year Month */}
                        <td className="p-3 text-right font-mono text-slate-400 tabular-nums">{formatNum(r.prev_month_units)}</td>
                        <td className="p-3 text-right font-mono text-slate-400 border-r border-slate-800 tabular-nums">{formatPct(r.prev_month_share)}</td>
                        
                        {/* Prev Year YTD */}
                        <td className="p-3 text-right font-mono text-slate-400 tabular-nums">{formatNum(r.prev_ytd_units)}</td>
                        <td className="p-3 text-right font-mono text-slate-400 border-r border-slate-800 tabular-nums">{formatPct(r.prev_ytd_share)}</td>
                        
                        {/* Prev Year Total */}
                        <td className="p-3 text-right font-mono text-slate-400 tabular-nums">{formatNum(r.prev_full_units)}</td>
                        <td className="p-3 text-right font-mono text-slate-400 border-r border-slate-500 tabular-nums">{formatPct(r.prev_full_share)}</td>

                        {/* Curr Year Month */}
                        <td className="p-3 text-right font-mono font-semibold text-slate-200 tabular-nums">{formatNum(r.curr_month_units)}</td>
                        <td className="p-3 text-right font-mono font-semibold text-slate-200 tabular-nums">{formatPct(r.curr_month_share)}</td>
                        <td className={`p-3 text-right font-mono tabular-nums ${getTrendColor(r.curr_month_diff)}`}>{formatPP(r.curr_month_diff)}</td>
                        <td className={`p-3 text-right font-mono tabular-nums ${getTrendColor(r.curr_growth_vs_prev_month)}`}>{formatSignedPct(r.curr_growth_vs_prev_month)}</td>
                        <td className={`p-3 text-right font-mono border-r border-slate-800 tabular-nums ${getTrendColor(r.curr_growth_vs_same_month_prev_year)}`}>{formatSignedPct(r.curr_growth_vs_same_month_prev_year)}</td>

                        {/* Curr Year YTD */}
                        <td className="p-3 text-right font-mono font-semibold text-slate-200 tabular-nums">{formatNum(r.curr_ytd_units)}</td>
                        <td className="p-3 text-right font-mono font-semibold text-slate-200 tabular-nums">{formatPct(r.curr_ytd_share)}</td>
                        <td className={`p-3 text-right font-mono tabular-nums ${getTrendColor(r.curr_ytd_diff)}`}>{formatPP(r.curr_ytd_diff)}</td>
                        <td className={`p-3 text-right font-mono border-r border-slate-500 tabular-nums ${getTrendColor(r.curr_ytd_growth)}`}>{formatSignedPct(r.curr_ytd_growth)}</td>

                        {/* Ranks */}
                        <td className="p-3 text-center font-mono text-slate-450 tabular-nums">{formatNum(r.prev_rank)}</td>
                        <td className="p-3 text-center font-mono font-medium tabular-nums">{formatNum(r.curr_rank)}</td>
                        <td className="p-3 text-center">
                          {r.rank_diff === "NEW" ? (
                            <span className="text-emerald-400 font-bold bg-emerald-400/10 px-2 py-0.5 rounded text-[10px]">NEW</span>
                          ) : String(r.rank_diff).startsWith("+") ? (
                            <span className="text-emerald-400 font-bold bg-emerald-400/10 px-2 py-0.5 rounded text-[10px]">{r.rank_diff}</span>
                          ) : String(r.rank_diff).startsWith("-") ? (
                            <span className="text-rose-400 font-bold bg-rose-400/10 px-2 py-0.5 rounded text-[10px]">{r.rank_diff}</span>
                          ) : (
                            r.rank_diff ?? MISSING
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {filteredAndSortedRows.length > 1 && (
            <div className="bg-slate-900 px-5 py-3 border-t border-slate-800 flex flex-col sm:flex-row justify-between items-center gap-3 text-xs text-slate-400">
              <div>
                <span>
                  Showing {Math.min(filteredAndSortedRows.length - 1, (currentPage - 1) * pageSize + 1)}-{Math.min(filteredAndSortedRows.length - 1, currentPage * pageSize)} of {filteredAndSortedRows.length - 1} rows (excluding Grand Total)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                  className="bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 text-slate-100 px-3 py-1.5 rounded transition-colors disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="font-semibold text-slate-200 px-1">
                  Page {currentPage} of {Math.ceil((filteredAndSortedRows.length - 1) / pageSize) || 1}
                </span>
                <button
                  onClick={() => setCurrentPage(prev => Math.min(Math.ceil((filteredAndSortedRows.length - 1) / pageSize), prev + 1))}
                  disabled={currentPage >= Math.ceil((filteredAndSortedRows.length - 1) / pageSize)}
                  className="bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 text-slate-100 px-3 py-1.5 rounded transition-colors disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
