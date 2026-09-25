"use client";

import { useEffect, useMemo, useState, Fragment } from "react";
import Link from "next/link";
import { Download, RefreshCw, AlertTriangle } from "lucide-react";
import { FilterPillPopover } from "../../components/FilterPillPopover";
import {
  DashboardData,
  brandMonthlyValues,
  seriesMonthlyValues,
  modelBrandPairs,
  modelOwnerLookup,
} from "../selectors";
import {
  buildDeepDiveExportRows,
  buildDeepDiveMatrixRows,
  buildDeepDiveModelExportRows,
  buildDeepDiveModelRanking,
  deepDiveFilterKey,
  referenceDeepDiveTotal,
  selectDeepDiveMatrixOptions,
} from "../deepDiveModelMatrix";

const DATA_BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function ModelsPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters State
  const [activeYears, setActiveYears] = useState<string[]>([]);
  const [selectedBrands, setSelectedBrands] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [selectedVehicleTypes, setSelectedVehicleTypes] = useState<string[]>([]);
  const [selectedProvinces, setSelectedProvinces] = useState<string[]>([]);
  const [selectedPowertrains, setSelectedPowertrains] = useState<string[]>([]);
  const [selectedSegments, setSelectedSegments] = useState<string[]>([]);

  const [expandedBrands, setExpandedBrands] = useState<Set<string>>(new Set());
  // "brands" groups series under their brand; "models" drops the grouping and ranks every
  // series against every other, biggest first.
  const [viewMode, setViewMode] = useState<"brands" | "models">("brands");

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [exporting, setExporting] = useState(false);

  // Reset page to 1 whenever any filter or active year changes (using render-phase state updates)
  const [prevFilterKey, setPrevFilterKey] = useState("");
  const filters = useMemo(() => ({
    activeYears,
    selectedBrands,
    selectedModels,
    selectedProvinces,
    selectedVehicleTypes,
    selectedPowertrains,
    selectedSegments,
  }), [activeYears, selectedBrands, selectedModels, selectedProvinces, selectedVehicleTypes, selectedPowertrains, selectedSegments]);
  const currentFilterKey = `${viewMode}|${deepDiveFilterKey(filters)}`;
  if (currentFilterKey !== prevFilterKey) {
    setPrevFilterKey(currentFilterKey);
    setCurrentPage(1);
  }

  const loadData = () => {
    setLoading(true);
    setError(null);
    fetch(`${DATA_BASE}/data/dashboard_models.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
        return r.json();
      })
      .then((j: DashboardData) => {
        setData(j);
        if (j.meta?.years && j.meta.years.length > 0) {
          setActiveYears(j.meta.years.slice(-1).map(String));
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load dashboard_models.json:", err);
        setError("Failed to load dashboard data. Please try again.");
        setLoading(false);
      });
  };

  useEffect(() => {
    fetch(`${DATA_BASE}/data/dashboard_models.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
        return r.json();
      })
      .then((j: DashboardData) => {
        setData(j);
        if (j.meta?.years && j.meta.years.length > 0) {
          setActiveYears(j.meta.years.slice(-1).map(String));
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load dashboard_models.json:", err);
        setError("Failed to load dashboard data. Please try again.");
        setLoading(false);
      });
  }, []);

  const meta = data?.meta;
  const years = meta?.years ?? [];
  const latestYear = years.length > 0 ? String(years[years.length - 1]) : null;

  // Available filter options based on raw tree data
  const { allBrands, allModels, allProvinces, allPowertrains, allMarketSegments } = useMemo(
    () => selectDeepDiveMatrixOptions(data?.brand_model_tree, selectedBrands, meta?.provinces ?? []),
    [data?.brand_model_tree, selectedBrands, meta?.provinces]
  );

  // "N/A" is the registry's own label for a series no human review has classified.
  const powertrainOptions = useMemo(
    () => allPowertrains.map((pt) => ({ id: pt, label: pt === "N/A" ? "Unclassified" : pt })),
    [allPowertrains]
  );

  const handleSelectedBrandsChange = (brands: string[]) => {
    setSelectedBrands(brands);
    const validModels = new Set(selectDeepDiveMatrixOptions(data?.brand_model_tree, brands).allModels);
    setSelectedModels((models) => models.filter((model) => validModels.has(model)));
  };

  // Built once per tree load; selection handler does an O(1) lookup instead of re-flattening.
  const modelOwners = useMemo(
    () => modelOwnerLookup(modelBrandPairs(data?.brand_model_tree)),
    [data?.brand_model_tree]
  );

  // Selecting a model whose name belongs to exactly one brand syncs that brand in; a model
  // shared across brands is left alone (no guess).
  const handleSelectedModelsChange = (models: string[]) => {
    const added = models.filter((m) => !selectedModels.includes(m));
    setSelectedModels(models);
    if (added.length === 0) return;
    setSelectedBrands((prev) => {
      const next = new Set(prev);
      added.forEach((m) => { const b = modelOwners.get(m); if (b) next.add(b); });
      return next.size === prev.length ? prev : [...next];
    });
  };

  // Filtered Rows Assembly — brand and series totals come only from segments matching the
  // active Powertrain filter; a brand/series with zero matching units is dropped entirely.
  const filteredTree = useMemo(
    () => buildDeepDiveMatrixRows(data?.brand_model_tree, filters, latestYear, expandedBrands),
    [data?.brand_model_tree, filters, latestYear, expandedBrands]
  );

  // Compute Grand Total of all filtered rows
  const superGrandTotal = useMemo(() => {
    return filteredTree.reduce((sum, b) => sum + b.totals.grandTotal, 0);
  }, [filteredTree]);

  // Any filter narrowing the table, used to name the export so a filtered workbook is
  // recognisable as one on disk.
  const hasActiveFilters =
    selectedBrands.length > 0 ||
    selectedModels.length > 0 ||
    selectedVehicleTypes.length > 0 ||
    selectedProvinces.length > 0 ||
    selectedPowertrains.length > 0 ||
    selectedSegments.length > 0;

  const superYtdTotal = useMemo(() => {
    return filteredTree.reduce((sum, b) => sum + b.totals.ytdTotal, 0);
  }, [filteredTree]);

  // Month-by-month totals for the summary row: every filtered brand, not just this page.
  const superMonthlyByYear = useMemo(() => {
    const out: Record<string, number[]> = {};
    activeYears.forEach((year) => {
      const acc = Array(12).fill(0) as number[];
      filteredTree.forEach((brandNode) => {
        const monthly = brandMonthlyValues(brandNode, year, selectedPowertrains, selectedVehicleTypes, selectedProvinces);
        for (let i = 0; i < 12; i++) acc[i] += monthly[i];
      });
      out[year] = acc;
    });
    return out;
  }, [filteredTree, activeYears, selectedPowertrains, selectedVehicleTypes, selectedProvinces]);

  // Ranking Rows Assembly — the same filtered series, ungrouped and ranked by volume.
  const modelRanking = useMemo(
    () => buildDeepDiveModelRanking(data?.brand_model_tree, filters, latestYear),
    [data?.brand_model_tree, filters, latestYear]
  );

  const rowCount = viewMode === "models" ? modelRanking.length : filteredTree.length;
  const rowNoun = viewMode === "models" ? "models" : "brands";

  const paginatedModels = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return modelRanking.slice(start, start + pageSize);
  }, [modelRanking, currentPage, pageSize]);

  // Paginated Rows Assembly
  const paginatedTree = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    return filteredTree.slice(start, end);
  }, [filteredTree, currentPage, pageSize]);

  // Calculate Reference Grand Total of ALL data unfiltered (source totals, ignores every filter)
  const referenceTotal = useMemo(() => {
    return referenceDeepDiveTotal(data?.brand_model_tree);
  }, [data?.brand_model_tree]);

  const toggleBrand = (key: string) => {
    setExpandedBrands((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandVisibleBrands = () => {
    setExpandedBrands((previous) => new Set([...previous, ...paginatedTree.map((brand) => brand.toggleKey)]));
  };

  const hideAllModels = () => setExpandedBrands(new Set());

  const visibleBrandsExpanded = paginatedTree.length > 0 && paginatedTree.every((brand) => brand.isExpanded);

  const handleExportExcel = async () => {
    if (!data || exporting) return;
    setExporting(true);
    try {
      const XLSX = await import("xlsx");

      // The workbook is built from the very rows the table renders, so "Filtered View" is
      // always exactly what was on screen -- filters, active years, and which brands are
      // expanded -- and it is the sheet Excel opens on. Collapse a brand and its series stay
      // out of the workbook too; "Hide all models" therefore exports brand lines only.
      // "All Data" stays as the unfiltered reference, at the same level of detail.
      const unfiltered = {
        activeYears,
        selectedBrands: [],
        selectedModels: [],
        selectedProvinces: [],
        selectedVehicleTypes: [],
        selectedPowertrains: [],
        selectedSegments: [],
      };
      const ranking = viewMode === "models";
      const filteredRows = ranking
        ? buildDeepDiveModelExportRows(data.brand_model_tree, filters, latestYear)
        : buildDeepDiveExportRows(data.brand_model_tree, filters, latestYear, "Filtered Total", expandedBrands);
      const fullRows = ranking
        ? buildDeepDiveModelExportRows(data.brand_model_tree, unfiltered, latestYear, "Grand Total")
        : buildDeepDiveExportRows(data.brand_model_tree, unfiltered, latestYear, "Grand Total", expandedBrands);

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filteredRows), "Filtered View");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fullRows), "All Data");
      const detail = viewMode === "models" ? "_modelrank" : expandedBrands.size === 0 ? "_brands" : "";
      XLSX.writeFile(wb, `Thailand_EV_Model_DeepDive${hasActiveFilters ? "_filtered" : ""}${detail}.xlsx`);
    } catch (e) {
      console.error(e);
      alert("Excel export failed");
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-slate-950 text-slate-100 min-h-screen p-6" role="status" aria-live="polite">
        <span className="sr-only">Loading Deep-Dive models data…</span>
        <div className="max-w-7xl mx-auto space-y-4" aria-hidden="true">
          <div className="h-20 rounded-md border border-slate-800 bg-slate-900" />
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
          <h2 className="text-sm font-semibold text-red-400">Failed to Load Data</h2>
          <p className="text-xs text-slate-400">{error || "Data could not be retrieved."}</p>
          <button onClick={loadData} className="bg-teal-600 hover:bg-teal-500 text-white font-medium text-xs px-4 py-2 rounded-md transition-colors flex items-center gap-1.5 focus:ring-2 focus:ring-teal-400 outline-none">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-950 text-slate-100 px-4 py-4 md:px-6 min-h-screen select-none font-sans antialiased overflow-x-hidden">
      <div className="w-full max-w-none mx-auto space-y-3">
        {/* Navigation Breadcrumb */}
        <nav aria-label="Breadcrumb" className="flex items-center">
          <Link href="/" className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-teal-400 transition-colors focus:ring-1 focus:ring-teal-400 focus:outline-none rounded px-1 py-0.5">
            <span aria-hidden="true">←</span>
            <span>Back to Dashboard</span>
          </Link>
        </nav>

        {/* Header Section */}
        <div className="bg-slate-900 border border-slate-800 rounded-md p-4 space-y-3">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
            <div>
              <h1 className="text-sm font-semibold text-teal-400 tracking-tight">
                Brand & Model Deep-Dive Matrix
              </h1>
              <p className="text-[10px] text-slate-500 mt-0.5">Thailand Department of Land Transport — Multi-Year Registration Details</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs bg-slate-950 text-teal-300 font-semibold px-3 py-2 rounded border border-slate-800">
                Data through: {meta?.reporting_period ?? "N/A"}
              </span>
              <span className="text-xs bg-slate-950 text-slate-400 px-3 py-2 rounded border border-slate-800 tabular-nums">
                Reference Grand Total: {referenceTotal.toLocaleString()}
              </span>
              <button
                onClick={handleExportExcel}
                disabled={exporting}
                className="bg-teal-600 hover:bg-teal-500 active:bg-teal-700 text-white text-xs px-4 py-2 rounded-md font-medium transition-colors flex items-center gap-1.5 focus:ring-2 focus:ring-teal-400 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Export all matrices to Excel spreadsheet"
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

          {/* Filters Bar */}
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3 text-sm pt-1">
            <div className="min-w-[150px]"><FilterPillPopover label="Brand" placeholder="Search brands..." options={allBrands} value={selectedBrands} onChange={handleSelectedBrandsChange} /></div>
            <div className="min-w-[150px]"><FilterPillPopover label="Model" placeholder="Search models..." options={allModels} value={selectedModels} onChange={handleSelectedModelsChange} /></div>
            <div className="min-w-[170px]"><FilterPillPopover label="Province" placeholder="Search provinces..." options={allProvinces} value={selectedProvinces} onChange={setSelectedProvinces} /></div>
            <div className="min-w-[190px]"><FilterPillPopover label="Vehicle Type" placeholder="Search vehicle types..." options={meta?.vehicle_types_list?.map(v => ({ id: v.code, label: v.label })) ?? []} value={selectedVehicleTypes} onChange={setSelectedVehicleTypes} /></div>
            <div className="min-w-[150px]"><FilterPillPopover label="Powertrain" placeholder="Search powertrains..." options={powertrainOptions} value={selectedPowertrains} onChange={setSelectedPowertrains} /></div>
            <div className="min-w-[150px]"><FilterPillPopover label="Segment" placeholder="Search segments..." options={allMarketSegments} value={selectedSegments} onChange={setSelectedSegments} /></div>

            {/* Year Checklist */}
            <div className="flex flex-col justify-center md:ml-auto">
              <span className="block text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1">Active Years (B.E.)</span>
              <div className="flex items-center gap-2 flex-wrap">
                {years.map((y) => {
                  const yStr = String(y);
                  const isChecked = activeYears.includes(yStr);
                  return (
                    <label key={yStr} className={`flex items-center gap-1 cursor-pointer text-xs font-semibold px-2 py-1 rounded border transition-colors ${isChecked ? "bg-teal-650/20 text-teal-400 border-teal-550/40" : "bg-slate-800 border-slate-700 text-slate-400"}`}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={isChecked}
                        onChange={() => {
                          if (isChecked) setActiveYears(activeYears.filter(x => x !== yStr));
                          else setActiveYears([...activeYears, yStr].sort());
                        }}
                      />
                      <span>{yStr}{yStr === latestYear ? " (YTD)" : ""}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3 text-xs text-slate-400">
            <div role="tablist" aria-label="Table view" className="flex items-center gap-1 rounded-sm border border-slate-700 p-0.5">
              {([
                { id: "brands", label: "By brand" },
                { id: "models", label: "Model ranking" },
              ] as const).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={viewMode === tab.id}
                  onClick={() => setViewMode(tab.id)}
                  className={`rounded-sm px-2.5 py-1 font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-light ${
                    viewMode === tab.id ? "bg-teal-650/20 text-teal-300" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {viewMode === "models" ? (
              <span>Every model matching the filters, ranked by volume — no brand grouping.</span>
            ) : (
            <>
            <span>Model rows are hidden by default.</span>
            <button
              type="button"
              onClick={expandVisibleBrands}
              disabled={visibleBrandsExpanded || paginatedTree.length === 0}
              className="rounded-sm border border-slate-700 px-2 py-1 font-medium text-slate-300 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-light"
            >
              Show models on this page
            </button>
            <button
              type="button"
              onClick={hideAllModels}
              disabled={expandedBrands.size === 0}
              className="rounded-sm px-2 py-1 font-medium text-slate-400 transition-colors hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-light"
            >
              Hide all models
            </button>
            </>
            )}
          </div>
        </div>

        {/* Pivot/Matrix Table */}
        <div className="bg-slate-900 border border-slate-800 rounded-md overflow-hidden">
          <div className="overflow-x-auto overflow-y-auto custom-scrollbar max-h-[calc(100vh-18rem)] min-h-[360px]">
            <table className="min-w-full w-max text-left border-collapse text-xs whitespace-nowrap">
              <thead>
                <tr className="bg-slate-800/80 border-b border-slate-700 text-slate-300 font-semibold align-middle">
                  <th scope="col" className="px-3 py-2.5 min-w-[220px] sticky top-0 left-0 bg-slate-800 z-40 border-r border-slate-700">{viewMode === "models" ? "Rank / Model" : "Brand / Model"}</th>

                  {activeYears.map((year) => (
                    <Fragment key={year}>
                      {MONTHS_EN.map((m) => (
                        <th key={`${year}-${m}`} scope="col" className="px-2 py-2.5 border-l border-slate-700/60 text-center font-normal text-slate-400 min-w-[64px] sticky top-0 bg-slate-800 z-30">{m}</th>
                      ))}
                      <th scope="col" className="px-3 py-2.5 border-l-2 border-slate-600 bg-slate-800 text-center font-bold text-teal-300 min-w-[110px] sticky top-0 z-30">Total {year}</th>
                    </Fragment>
                  ))}

                  <th scope="col" className="px-3 py-2.5 border-l-2 border-slate-600 text-right text-emerald-400 font-bold bg-slate-800 min-w-[110px] sticky top-0 z-30">YTD</th>
                  <th scope="col" className="px-3 py-2.5 border-l border-slate-600 text-right text-amber-400 font-bold bg-slate-800 min-w-[120px] sticky top-0 z-30">Grand Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {rowCount === 0 ? (
                  <tr>
                    <td colSpan={40} className="p-12 text-center text-slate-500 font-medium">
                      No matching {viewMode === "models" ? "model" : "brand or model"} registrations found for current selection.
                    </td>
                  </tr>
                ) : (
                  <>
                  {/* Filtered total — every brand matching the current filters, not just this page */}
                  <tr className="bg-slate-800/60 border-b-2 border-slate-600 font-semibold">
                    <th scope="row" className="px-3 py-2.5 text-left sticky left-0 bg-slate-800 z-20 border-r border-slate-700">
                      <span className="text-xs font-bold tracking-wide text-slate-100">Filtered Total</span>
                      <span className="ml-2 text-[10px] font-normal text-slate-400">{rowCount.toLocaleString()} {rowNoun}</span>
                    </th>

                    {activeYears.map((year) => {
                      const monthly = superMonthlyByYear[year] ?? Array(12).fill(0);
                      const total = monthly.reduce((s, v) => s + v, 0);
                      return (
                        <Fragment key={`total-${year}`}>
                          {monthly.map((val, idx) => (
                            <td key={`total-val-${year}-${idx}`} className="px-2 py-2.5 border-l border-slate-700/60 text-center font-mono text-slate-100">
                              {val ? val.toLocaleString() : "—"}
                            </td>
                          ))}
                          <td className="px-3 py-2.5 border-l-2 border-slate-600 bg-slate-800/60 text-center font-mono font-bold text-teal-300">
                            {total ? total.toLocaleString() : "—"}
                          </td>
                        </Fragment>
                      );
                    })}

                    <td className="px-3 py-2.5 border-l-2 border-slate-600 text-right font-mono font-bold text-emerald-300 bg-emerald-950/20">
                      {superYtdTotal ? superYtdTotal.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2.5 border-l border-slate-600 text-right font-mono font-bold text-amber-300 bg-slate-900">
                      {superGrandTotal ? superGrandTotal.toLocaleString() : "—"}
                    </td>
                  </tr>

                  {viewMode === "models" ? paginatedModels.map((model) => (
                    <tr
                      key={`${model.brand}-${model.name}`}
                      className="bg-slate-900/95 hover:bg-slate-850 border-b border-slate-800/90 transition-colors"
                    >
                      <td className="px-3 py-2.5 sticky left-0 bg-slate-900 z-10 border-r border-slate-800/90">
                        <div className="flex items-center gap-2">
                          <span aria-hidden="true" className="w-8 text-right text-[10px] font-mono text-slate-500">{model.rank}</span>
                          <span className="flex flex-col">
                            <span className="font-bold text-xs tracking-wide text-slate-100">{model.name}</span>
                            <span className="text-[10px] font-normal text-teal-400">
                              {model.brand}{model.market_segment ? ` · ${model.market_segment}` : ""}
                            </span>
                          </span>
                        </div>
                      </td>

                      {activeYears.map((year) => {
                        const monthly = seriesMonthlyValues(model, year, selectedPowertrains, selectedVehicleTypes, selectedProvinces);
                        const total = monthly.reduce((s, v) => s + v, 0);
                        return (
                          <Fragment key={year}>
                            {monthly.map((val, idx) => (
                              <td key={`rank-val-${model.brand}-${model.name}-${year}-${idx}`} className="px-2 py-2.5 border-l border-slate-800/70 text-center font-mono text-slate-300">
                                {val ? val.toLocaleString() : "—"}
                              </td>
                            ))}
                            <td className="px-3 py-2.5 border-l-2 border-slate-700/80 bg-slate-800/30 text-center font-mono font-bold text-teal-400">
                              {total ? total.toLocaleString() : "—"}
                            </td>
                          </Fragment>
                        );
                      })}

                      <td className="px-3 py-2.5 border-l-2 border-slate-800 text-right font-mono font-bold text-emerald-400 bg-emerald-950/10">
                        {model.totals.ytdTotal ? model.totals.ytdTotal.toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2.5 border-l border-slate-800 text-right font-mono font-bold text-amber-400 bg-slate-950">
                        {model.totals.grandTotal ? model.totals.grandTotal.toLocaleString() : "—"}
                      </td>
                    </tr>
                  )) : paginatedTree.map((brandNode) => (
                    <Fragment key={brandNode.toggleKey}>
                      {/* Brand Row */}
                      <tr
                        className="bg-slate-900/95 hover:bg-slate-850 font-semibold border-b border-slate-800/90 transition-colors"
                      >
                        <td className="px-3 py-2.5 sticky left-0 bg-slate-900 z-10 border-r border-slate-800/90">
                          <button
                            type="button"
                            onClick={() => toggleBrand(brandNode.toggleKey)}
                            aria-expanded={brandNode.isExpanded}
                            aria-label={`${brandNode.isExpanded ? "Collapse" : "Expand"} ${brandNode.brand} models`}
                            className="flex w-full items-center space-x-2 text-left text-teal-400"
                          >
                            <span aria-hidden="true" className="text-[10px] bg-slate-800 px-1 py-0.5 rounded text-slate-400">
                              {brandNode.isExpanded ? "▼" : "▶"}
                            </span>
                            <span className="font-bold text-xs tracking-wide">{brandNode.brand}</span>
                          </button>
                        </td>

                        {activeYears.map((year) => {
                          const monthly = brandMonthlyValues(brandNode, year, selectedPowertrains, selectedVehicleTypes, selectedProvinces);
                          const total = monthly.reduce((s, v) => s + v, 0);
                          return (
                            <Fragment key={year}>
                              {monthly.map((val, idx) => (
                                <td key={`brand-val-${brandNode.toggleKey}-${year}-${idx}`} className="px-2 py-2.5 border-l border-slate-800/70 text-center font-mono text-slate-300">
                                  {val ? val.toLocaleString() : "—"}
                                </td>
                              ))}
                              <td className="px-3 py-2.5 border-l-2 border-slate-700/80 bg-slate-800/30 text-center font-mono font-bold text-teal-400">
                                {total ? total.toLocaleString() : "—"}
                              </td>
                            </Fragment>
                          );
                        })}

                        <td className="px-3 py-2.5 border-l-2 border-slate-800 text-right font-mono font-bold text-emerald-400 bg-emerald-950/10">
                          {brandNode.totals.ytdTotal ? brandNode.totals.ytdTotal.toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-2.5 border-l border-slate-800 text-right font-mono font-bold text-amber-400 bg-slate-950">
                          {brandNode.totals.grandTotal ? brandNode.totals.grandTotal.toLocaleString() : "—"}
                        </td>
                      </tr>

                      {/* Series (Model) Rows */}
                      {brandNode.isExpanded && brandNode.models.map((model) => (
                        <tr
                          key={`${brandNode.toggleKey}-${model.name}`}
                          className="bg-slate-950/50 hover:bg-slate-900/60 border-b border-slate-900/60 text-slate-300 transition-colors"
                        >
                          <td className="py-2.5 pl-8 pr-3 sticky left-0 bg-slate-950/90 z-10 border-r border-slate-900/60">
                            <div className="flex items-center space-x-1.5">
                              <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-slate-600 flex-shrink-0"></span>
                              <span className="font-medium text-slate-200 text-xs">{model.name}</span>
                            </div>
                          </td>

                          {activeYears.map((year) => {
                            const monthly = seriesMonthlyValues(model, year, selectedPowertrains, selectedVehicleTypes, selectedProvinces);
                            const total = monthly.reduce((s, v) => s + v, 0);
                            return (
                              <Fragment key={year}>
                                {monthly.map((val, idx) => (
                                  <td key={`mod-val-${brandNode.toggleKey}-${model.name}-${year}-${idx}`} className="px-2 py-2.5 border-l border-slate-800/30 text-center font-mono text-slate-400/90">
                                    {val ? val.toLocaleString() : "—"}
                                  </td>
                                ))}
                                <td className="px-3 py-2.5 border-l-2 border-slate-800/50 bg-slate-950/30 text-center font-mono text-slate-300">
                                  {total ? total.toLocaleString() : "—"}
                                </td>
                              </Fragment>
                            );
                          })}

                          <td className="px-3 py-2.5 border-l-2 border-slate-900 text-right font-mono text-emerald-500">
                            {model.totals.ytdTotal ? model.totals.ytdTotal.toLocaleString() : "—"}
                          </td>
                          <td className="px-3 py-2.5 border-l border-slate-900 text-right font-mono font-bold text-amber-500/90 bg-slate-950/50">
                            {model.totals.grandTotal ? model.totals.grandTotal.toLocaleString() : "—"}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  </>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {rowCount > 0 && (
            <div className="bg-slate-900 px-5 py-3 border-t border-slate-800 flex flex-col sm:flex-row justify-between items-center gap-3 text-xs text-slate-400">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <span>Show</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setCurrentPage(1);
                    }}
                    className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-100 font-semibold focus:outline-none focus:border-teal-500"
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                  <span>{rowNoun} per page</span>
                </div>
                <span>
                  Showing {Math.min(rowCount, (currentPage - 1) * pageSize + 1)}-{Math.min(rowCount, currentPage * pageSize)} of {rowCount.toLocaleString()} {rowNoun}
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
                  Page {currentPage} of {Math.ceil(rowCount / pageSize) || 1}
                </span>
                <button
                  onClick={() => setCurrentPage(prev => Math.min(Math.ceil(rowCount / pageSize), prev + 1))}
                  disabled={currentPage >= Math.ceil(rowCount / pageSize)}
                  className="bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 text-slate-100 px-3 py-1.5 rounded transition-colors disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {/* Table Footer / Summary Row */}
          <div className="bg-slate-950 p-5 border-t border-slate-800 flex justify-between items-center text-xs font-bold text-slate-300">
            <span>Filtered Grand Total registrations:</span>
            <span className="text-slate-100 text-xs font-mono tabular-nums text-right">
              {superGrandTotal.toLocaleString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
