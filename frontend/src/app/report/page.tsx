"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, ChevronRight, Download, RefreshCw } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  MANUAL_REPORT_SHEETS as SHEETS,
  buildManualReportFileName,
  buildManualReportSheetRows,
  getReportForYear,
  getReportYears,
  latestMonthLabels,
  safeSheetName,
  type ManualReport,
  type ManualReportMeta,
  type ReportRow,
  type SheetKind,
} from "../reportExport";

// Canonical manual report: /report renders this JSON directly and never recomputes
// spreadsheet logic. Produced by backend/export_manual_report.py.

const DATA_BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nf = new Intl.NumberFormat("en-US");
const pf = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function num(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n === 0 ? "—" : nf.format(n);
}
function pct(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return pf.format(n);
}
function signed(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const s = pf.format(n);
  return n > 0 ? `+${s}` : s;
}
function points(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const v = Math.round(n * 1000) / 10;
  if (v === 0) return "—";
  return v > 0 ? `+${v.toFixed(1)} pp` : `${v.toFixed(1)} pp`;
}
function growthClass(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "text-slate-500";
  return n > 0 ? "text-emerald-400" : n < 0 ? "text-rose-400" : "text-slate-400";
}
function rankChange(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n) || n === 0) return "—";
  return n > 0 ? `+${n}` : String(n);
}

// Same palette and tooltip chrome as the dashboard charts so the two pages read as one product.
const PT_COLORS: Record<string, string> = {
  ICE: "#64748b", BEV: "#169387", HEV: "#fbbf24", PHEV: "#fb923c",
};
const CURR_COLOR = "#169387";
const PREV_COLOR = "#475569";
const TT = {
  contentStyle: {
    backgroundColor: "#0f172a", border: "1px solid #1e293b",
    borderRadius: "2px", color: "#f1f5f9", fontSize: "11px", padding: "8px",
  },
  itemStyle: { color: "#94a3b8" },
  cursor: { fill: "rgba(255,255,255,0.05)" },
};
const AXIS = { stroke: "#334155", tick: { fill: "#64748b", fontSize: 10 } };

// A table of 140 rows answers "what is the number"; the chart answers "who is big and
// which way is it moving" without anyone reading a cell. Sheet 1 is the only one whose
// story is composition over time — the rest are a ranking, so they all get the same
// top-ten shape with last year beside this year.
function SheetChart({ kind, rows, meta, labels }: {
  kind: SheetKind;
  rows: ReportRow[];
  meta: ManualReportMeta;
  labels: ReturnType<typeof latestMonthLabels>;
}) {
  const series = useMemo(
    () => (kind === "powertrain" ? rows.filter((r) => r.label !== "Grand Total").map((r) => r.label) : []),
    [kind, rows],
  );

  const monthly = useMemo(() => {
    if (kind !== "powertrain") return [];
    return meta.months.slice(0, meta.latest_month_num).map((m, i) => {
      const point: Record<string, string | number> = { month: m };
      rows.forEach((r) => {
        if (r.label === "Grand Total") return;
        point[r.label] = r.curr_months?.[i] ?? 0;
      });
      return point;
    });
  }, [kind, rows, meta]);

  // Tree-shaped sheets carry parent rows too; chart the leaves the sheet is named for.
  const top = useMemo(() => {
    if (kind === "powertrain") return [];
    const level = kind === "model_tree" ? "model" : kind === "province_tree" ? "province" : null;
    return rows
      .filter((r) => (level ? r.level === level : r.level !== "grand" && r.label !== "Grand Total"))
      .slice()
      .sort((a, b) => (b.curr_ytd ?? 0) - (a.curr_ytd ?? 0))
      .slice(0, 10)
      .map((r) => ({ name: r.label, prev: r.prev_ytd ?? 0, curr: r.curr_ytd ?? 0 }));
  }, [kind, rows]);

  if (kind === "powertrain" ? monthly.length === 0 : top.length === 0) return null;

  const caption = kind === "powertrain"
    ? `Registrations by powertrain, ${meta.months[0]}–${labels.currMonth} ${meta.latest_year}`
    : `Top ${top.length} by ${labels.currYtdPeriod}, compared with ${labels.prevYtdPeriod}`;

  return (
    <div className="border-t border-slate-800 px-4 pb-4 pt-3">
      <div className="mb-2 text-[11px] text-slate-500">{caption}</div>
      <div style={{ height: kind === "powertrain" ? 260 : 340 }}>
        <ResponsiveContainer width="100%" height="100%">
          {kind === "powertrain" ? (
            <BarChart data={monthly} margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="1 3" stroke="#1e293b" vertical={false} />
              <XAxis dataKey="month" {...AXIS} />
              <YAxis {...AXIS} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
              <Tooltip {...TT} formatter={(v: unknown) => Number(v).toLocaleString()} />
              <Legend verticalAlign="top" height={22} iconType="square" wrapperStyle={{ fontSize: "10px", color: "#94a3b8" }} />
              {series.map((name) => (
                <Bar key={name} dataKey={name} stackId="pt" fill={PT_COLORS[name] ?? "#64748b"} isAnimationActive={false} />
              ))}
            </BarChart>
          ) : (
            <BarChart data={top} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#1e293b" horizontal={false} />
              <XAxis type="number" {...AXIS} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
              <YAxis dataKey="name" type="category" width={150} stroke="#334155" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={0} />
              <Tooltip {...TT} formatter={(v: unknown) => Number(v).toLocaleString()} />
              <Legend verticalAlign="top" height={22} iconType="square" wrapperStyle={{ fontSize: "10px", color: "#94a3b8" }} />
              <Bar dataKey="prev" name={labels.prevYtdPeriod} fill={PREV_COLOR} radius={[0, 2, 2, 0]} barSize={9} isAnimationActive={false} />
              <Bar dataKey="curr" name={labels.currYtdPeriod} fill={CURR_COLOR} radius={[0, 2, 2, 0]} barSize={9} isAnimationActive={false} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function MonthlyDetailPanel({ row, meta, onClose }: { row: ReportRow; meta: ManualReportMeta; onClose: () => void }) {
  const currentMonths = meta.months.slice(0, meta.latest_month_num);
  return (
    <div className="border-b border-slate-800 bg-slate-950/70 p-4">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Monthly detail</p>
          <h3 className="mt-0.5 text-sm font-semibold text-slate-100">{row.label}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="self-start rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100 sm:self-auto"
        >
          Close detail
        </button>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-md border border-slate-800 bg-slate-950">
          <div className="border-b border-slate-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {meta.latest_year} monthly
          </div>
          <div className="grid grid-cols-3 gap-px p-2 sm:grid-cols-6">
            {currentMonths.map((m, mi) => (
              <div key={`${m}-${meta.latest_year}`} className="bg-slate-900 px-2 py-1.5">
                <div className="text-[10px] text-slate-500">{m}</div>
                <div className="mt-0.5 font-mono text-xs text-slate-100">{num(row.curr_months[mi])}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-md border border-slate-800 bg-slate-950">
          <div className="border-b border-slate-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {meta.prev_year} monthly
          </div>
          <div className="grid grid-cols-3 gap-px p-2 sm:grid-cols-6">
            {meta.months.map((m, mi) => (
              <div key={`${m}-${meta.prev_year}`} className="bg-slate-900 px-2 py-1.5">
                <div className="text-[10px] text-slate-500">{m}</div>
                <div className="mt-0.5 font-mono text-xs text-slate-100">{num(row.prev_months[mi])}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ManualReportPage() {
  const [report, setReport] = useState<ManualReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState("sheet1_powertrain");
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [compareFocus, setCompareFocus] = useState(true);
  const [showModelRankMonth, setShowModelRankMonth] = useState(false);
  const [selectedMonthlyRowId, setSelectedMonthlyRowId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetch(`${DATA_BASE}/data/manual_report.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: ManualReport) => {
        setReport(json);
        setSelectedYear(json.meta.latest_year);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load manual_report.json:", err);
        setError("Failed to load manual_report.json. Run backend/export_manual_report.py.");
        setLoading(false);
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`${DATA_BASE}/data/manual_report.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: ManualReport) => {
        if (!cancelled) {
          setReport(json);
          setSelectedYear(json.meta.latest_year);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("Failed to load manual_report.json:", err);
          setError("Failed to load manual_report.json. Run backend/export_manual_report.py.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const years = useMemo(() => (report ? getReportYears(report) : []), [report]);
  const activeReport = useMemo(
    () => (report && selectedYear !== null ? getReportForYear(report, selectedYear) : null),
    [report, selectedYear]
  );

  const handleSelectYear = (year: number) => {
    setSelectedYear(year);
    setSearch("");
    setSelectedMonthlyRowId(null);
  };

  const active = SHEETS.find((s) => s.id === activeId) ?? SHEETS[0];
  const meta = activeReport?.meta;
  const section = meta?.sections?.[active.id];
  const labels = useMemo(
    () => (meta ? latestMonthLabels(meta) : null),
    [meta]
  );

  const rows = useMemo(() => {
    if (!activeReport) return [];
    const all = activeReport.sheets[active.id] ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => {
      if (r.level === "grand") return true;
      const hay = `${r.label} ${r.group ?? ""} ${r.brand ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [activeReport, active.id, search]);

  // Exports exactly the sheet currently on screen (respecting the active search filter
  // and selected report year), not the full 9-sheet workbook — matches what the table
  // is showing right now.
  const handleExportExcel = async () => {
    if (!activeReport || exporting) return;
    setExporting(true);
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      const excelRows = buildManualReportSheetRows(active, rows, activeReport.meta);
      const title = section?.title ?? active.id;
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(excelRows), safeSheetName(title, new Set()));
      XLSX.writeFile(wb, buildManualReportFileName(activeReport.meta, title));
    } catch (e) {
      console.error(e);
      alert("Excel export failed");
    } finally {
      setExporting(false);
    }
  };

  const knownWarning = useMemo(() => {
    if (!meta?.known_mismatches) return null;
    return meta.known_mismatches.find((k) => k.sheets.includes(active.id)) ?? null;
  }, [meta, active.id]);
  const supportsCompareFocus = active.kind === "powertrain" || active.kind === "brand";
  const showCompareFocus = compareFocus && supportsCompareFocus;
  const rowExpandId = (row: ReportRow, i: number) => `${active.id}|${row.key}|${i}`;
  const selectedMonthlyRow = showCompareFocus
    ? rows.find((row, i) => rowExpandId(row, i) === selectedMonthlyRowId) ?? null
    : null;

  // Shared row-emphasis logic across the tree-shaped sheets (model_tree groups by
  // brand, province_tree groups by province); flat sheets just get the grand-total
  // emphasis on row 0.
  function rowVisual(row: ReportRow, i: number, kind: string) {
    const first = i === 0;
    const isChild = row.level === "model" || (row.level === "brand" && kind === "province_tree");
    const isGroup = (row.level === "brand" && kind === "model_tree") || row.level === "province";
    const rowClass = first || row.level === "grand"
      ? "bg-slate-800/60 font-bold text-teal-300"
      : isGroup
      ? "bg-slate-800/20 font-semibold text-slate-200"
      : "text-slate-300 hover:bg-slate-800/30";
    const labelBg = first || row.level === "grand" ? "bg-slate-800" : isChild ? "bg-slate-950" : "bg-slate-900";
    return { first, isChild, rowClass, labelBg };
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 p-6 text-slate-100" role="status" aria-live="polite">
        <div className="mx-auto max-w-[110rem] space-y-4">
          <div className="h-24 rounded-md border border-slate-800 bg-slate-900" />
          <div className="h-96 rounded-md border border-slate-800 bg-slate-900" />
        </div>
      </div>
    );
  }

  if (error || !report || !meta || !labels) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
        <div className="max-w-md rounded-md border border-red-900/60 bg-red-950/30 p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-red-400" />
          <h1 className="mb-2 text-sm font-semibold text-red-200">Manual report failed to load</h1>
          <p className="mb-4 text-xs text-red-200/80">{error}</p>
          <button onClick={load} className="inline-flex items-center gap-2 rounded-md bg-red-700 px-4 py-2 text-xs font-semibold text-white hover:bg-red-600">
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto max-w-[110rem] space-y-4">
        <nav aria-label="Breadcrumb">
          <Link href="/" className="text-xs text-slate-400 transition-colors hover:text-teal-400">← Back to Dashboard</Link>
        </nav>

        {/* Header + status strip */}
        <section className="rounded-md border border-slate-800 bg-slate-900 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-teal-400">Manual Report Mode</p>
              <h1 className="mt-1 text-lg font-semibold text-slate-100">Workbook parity — sheets 1–9</h1>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-400">
                Rendered directly from <span className="font-mono text-slate-300">manual_report.json</span>. No spreadsheet logic is recomputed in the browser.
              </p>
            </div>
            <div className="flex flex-col items-stretch gap-2 lg:items-end">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-slate-800 bg-slate-950 px-4 py-3 text-[10px] text-slate-400">
                <span className="text-slate-500">Reporting period</span>
                <span className="text-right font-mono text-slate-200">{meta.reporting_period}</span>
                <span className="text-slate-500">Comparison year</span>
                <span className="text-right font-mono text-slate-200">
                  {meta.has_prev_year === false ? "N/A" : `${meta.prev_year} (full)`} vs {meta.latest_year} YTD
                </span>
                <span className="text-slate-500">Vehicle filter</span>
                <span className="text-right font-mono text-slate-200">รย.1,2,3,6,9,10,11</span>
              </div>
              <button
                type="button"
                onClick={handleExportExcel}
                disabled={exporting}
                aria-label="Export current sheet to Excel spreadsheet"
                className="flex items-center justify-center gap-1.5 rounded-md bg-teal-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-teal-500 active:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {exporting ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Exporting...</span>
                  </>
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5" />
                    <span>Export this sheet (.xlsx)</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Report year</span>
            {years.map((y) => (
              <button
                key={y}
                type="button"
                onClick={() => handleSelectYear(y)}
                aria-pressed={y === selectedYear}
                className={`rounded-md border px-3 py-1 text-xs font-mono transition-colors ${
                  y === selectedYear
                    ? "border-teal-500 bg-teal-600 text-white"
                    : "border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200"
                }`}
              >
                {y}
              </button>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {SHEETS.map((s) => {
              const on = s.id === active.id;
              const st = meta.sections[s.id];
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => { setActiveId(s.id); setSearch(""); setSelectedMonthlyRowId(null); }}
                  className={`rounded-md border px-3 py-2 text-left transition-colors ${
                    on ? "border-teal-500 bg-teal-500/10 text-teal-100" : "border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200"
                  }`}
                >
                  <div className="truncate text-xs font-semibold">{st?.title ?? s.id}</div>
                  <div className="mt-0.5 truncate text-[10px] opacity-80">{st?.powertrain ?? "Model report"}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Active sheet */}
        <section className="rounded-md border border-slate-800 bg-slate-900">
          <div className="flex flex-col gap-3 border-b border-slate-800 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">{section?.title ?? active.id}</h2>
              <p className="mt-1 text-[10px] text-slate-500">
                Source: <span className="font-mono text-slate-400">{section?.source}</span> · {section?.filter}
                {section?.powertrain ? ` · Powertrain = ${section.powertrain}` : section?.model_report_filter ? ` · ${section.model_report_filter}` : ""}
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center">
              <div className="flex rounded-md border border-slate-800 bg-slate-950 p-0.5">
                <button
                  type="button"
                  onClick={() => setCompareFocus(true)}
                  disabled={!supportsCompareFocus}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:text-slate-600 ${
                    showCompareFocus ? "bg-teal-600 text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Comparison focus
                </button>
                <button
                  type="button"
                  onClick={() => setCompareFocus(false)}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                    !showCompareFocus ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Full sheet
                </button>
              </div>
              {active.kind === "model_rank" && (
                <button
                  type="button"
                  onClick={() => setShowModelRankMonth((v) => !v)}
                  aria-pressed={showModelRankMonth}
                  className={`rounded-md border px-3 py-2 text-xs font-semibold transition-colors ${
                    showModelRankMonth
                      ? "border-teal-500 bg-teal-600 text-white"
                      : "border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200"
                  }`}
                >
                  {showModelRankMonth ? `Hide ${labels.currMonth}'${String(meta.latest_year).slice(-2)}` : `Show ${labels.currMonth}'${String(meta.latest_year).slice(-2)}`}
                </button>
              )}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${active.rowLabel.toLowerCase()}...`}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-teal-500 md:w-64"
              />
            </div>
          </div>

          {knownWarning && (
            <div className="flex items-start gap-2 border-b border-amber-900/40 bg-amber-950/20 px-4 py-2.5 text-[11px] text-amber-200/90">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span><span className="font-semibold">Known markdown mismatch ({knownWarning.row}):</span> {knownWarning.note}</span>
            </div>
          )}

          {selectedMonthlyRow && (
            <MonthlyDetailPanel
              row={selectedMonthlyRow}
              meta={meta}
              onClose={() => setSelectedMonthlyRowId(null)}
            />
          )}

          <div className="max-h-[72vh] overflow-auto custom-scrollbar">
            <table className="w-full border-separate border-spacing-0 text-left text-xs">
              {active.kind === "powertrain" && (
                showCompareFocus ? (
                  <>
                    <thead className="sticky top-0 z-20 bg-slate-800 text-slate-300">
                      <tr>
                        <th className="sticky left-0 z-30 min-w-48 border-r border-slate-700 bg-slate-800 p-3 text-left">{active.rowLabel}</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">{labels.currMonthPeriod}</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">{labels.prevMonth} {meta.latest_year}</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">{labels.currMonth} {meta.prev_year}</th>
                        <th className="min-w-24 border-l-2 border-slate-600 p-2 text-center">MoM Growth</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">YoY Growth</th>
                        <th className="min-w-24 border-l-2 border-slate-600 p-2 text-center">{labels.currYtdPeriod}</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">{labels.prevYtdPeriod}</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">YTD Growth</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => {
                        const { rowClass, labelBg } = rowVisual(row, i, active.kind);
                        const expandId = rowExpandId(row, i);
                        const selected = selectedMonthlyRowId === expandId;
                        return (
                          <tr key={`${row.key}-${i}`} className={`border-b border-slate-800 ${selected ? "outline outline-1 outline-teal-600/70" : ""} ${rowClass}`}>
                            <td className={`sticky left-0 z-10 border-r border-slate-800 p-2.5 ${labelBg}`}>
                              <button
                                type="button"
                                onClick={() => setSelectedMonthlyRowId(selected ? null : expandId)}
                                aria-expanded={selected}
                                className="flex w-full items-center gap-2 text-left"
                              >
                                {selected ? <ChevronDown className="h-3.5 w-3.5 text-teal-300" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
                                <span>{row.label}</span>
                              </button>
                            </td>
                            <td className="border-l border-slate-800/70 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_month_units ?? row.curr_months[meta.latest_month_num - 1])}</td>
                            <td className="border-l border-slate-800/70 p-2 text-center font-mono">{num(row.curr_months[meta.latest_month_num - 2])}</td>
                            <td className="border-l border-slate-800/70 p-2 text-center font-mono">{num(row.prev_month_units ?? row.prev_months[meta.latest_month_num - 1])}</td>
                            <td className={`border-l-2 border-slate-700 p-2 text-center font-mono ${growthClass(row.growth_vs_prev_month)}`}>{signed(row.growth_vs_prev_month)}</td>
                            <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_same_month_prev_year)}`}>{signed(row.growth_vs_same_month_prev_year)}</td>
                            <td className="border-l-2 border-slate-700 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_ytd)}</td>
                            <td className="border-l border-slate-800/70 p-2 text-center font-mono">{num(row.prev_ytd)}</td>
                            <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_prev_ytd)}`}>{signed(row.growth_vs_prev_ytd)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </>
                ) : (
                <>
                  <thead className="sticky top-0 z-20 bg-slate-800 text-slate-300">
                    <tr>
                      <th rowSpan={2} className="sticky left-0 z-30 min-w-48 border-r border-slate-700 bg-slate-800 p-3">{active.rowLabel}</th>
                      <th colSpan={2} className="border-r border-slate-700 p-2 text-center">{labels.prevYtdPeriod}</th>
                      <th colSpan={2} className="border-r border-slate-700 p-2 text-center">{meta.prev_year} Total</th>
                      <th colSpan={4} className="border-r border-slate-700 p-2 text-center">{labels.currMonthPeriod}</th>
                      <th colSpan={3} className="p-2 text-center">{labels.currYtdPeriod} Total</th>
                    </tr>
                    <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="min-w-20 border-l border-slate-700 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-20 border-l-2 border-slate-600 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-20 border-l-2 border-slate-600 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-28 border-l border-slate-700 p-2 text-center">Growth vs {labels.prevMonth} {meta.latest_year}</th>
                      <th className="min-w-28 border-l border-slate-700 p-2 text-center">Growth vs {labels.currMonth} {meta.prev_year}</th>
                      <th className="min-w-20 border-l-2 border-slate-600 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-32 border-l border-slate-700 p-2 text-center">Growth vs {labels.prevYtdPeriod}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const { rowClass, labelBg } = rowVisual(row, i, active.kind);
                      return (
                        <tr key={`${row.key}-${i}`} className={`border-b border-slate-800 ${rowClass}`}>
                          <td className={`sticky left-0 z-10 border-r border-slate-800 p-2.5 ${labelBg}`}>{row.label}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono">{num(row.prev_ytd)}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.prev_ytd_share)}</td>
                          <td className="border-l-2 border-slate-700 p-2 text-center font-mono">{num(row.prev_total)}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.prev_total_share)}</td>
                          <td className="border-l-2 border-slate-700 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_month_units ?? row.curr_months[meta.latest_month_num - 1])}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.curr_month_share)}</td>
                          <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_prev_month)}`}>{signed(row.growth_vs_prev_month)}</td>
                          <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_same_month_prev_year)}`}>{signed(row.growth_vs_same_month_prev_year)}</td>
                          <td className="border-l-2 border-slate-700 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_ytd)}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.curr_ytd_share)}</td>
                          <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_prev_ytd)}`}>{signed(row.growth_vs_prev_ytd)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </>
                )
              )}

              {active.kind === "brand" && (
                showCompareFocus ? (
                  <>
                    <thead className="sticky top-0 z-20 bg-slate-800 text-slate-300">
                      <tr>
                        <th className="sticky left-0 z-30 min-w-48 border-r border-slate-700 bg-slate-800 p-3 text-left">{active.rowLabel}</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">{labels.currMonthPeriod}</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">{labels.prevMonth} {meta.latest_year}</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">{labels.currMonth} {meta.prev_year}</th>
                        <th className="min-w-20 border-l border-slate-700 p-2 text-center">Share Diff</th>
                        <th className="min-w-24 border-l-2 border-slate-600 p-2 text-center">MoM Growth</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">YoY Growth</th>
                        <th className="min-w-24 border-l-2 border-slate-600 p-2 text-center">{labels.currYtdPeriod}</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">{labels.prevYtdPeriod}</th>
                        <th className="min-w-20 border-l border-slate-700 p-2 text-center">YTD Diff</th>
                        <th className="min-w-24 border-l border-slate-700 p-2 text-center">YTD Growth</th>
                        <th className="min-w-20 border-l-2 border-slate-600 p-2 text-center">Rank Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => {
                        const { rowClass, labelBg } = rowVisual(row, i, active.kind);
                        const expandId = rowExpandId(row, i);
                        const selected = selectedMonthlyRowId === expandId;
                        return (
                          <tr key={`${row.key}-${i}`} className={`border-b border-slate-800 ${selected ? "outline outline-1 outline-teal-600/70" : ""} ${rowClass}`}>
                            <td className={`sticky left-0 z-10 border-r border-slate-800 p-2.5 ${labelBg}`}>
                              <button
                                type="button"
                                onClick={() => setSelectedMonthlyRowId(selected ? null : expandId)}
                                aria-expanded={selected}
                                className="flex w-full items-center gap-2 text-left"
                              >
                                {selected ? <ChevronDown className="h-3.5 w-3.5 text-teal-300" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
                                <span>{row.label}</span>
                              </button>
                            </td>
                            <td className="border-l border-slate-800/70 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_month_units ?? row.curr_months[meta.latest_month_num - 1])}</td>
                            <td className="border-l border-slate-800/70 p-2 text-center font-mono">{num(row.curr_months[meta.latest_month_num - 2])}</td>
                            <td className="border-l border-slate-800/70 p-2 text-center font-mono">{num(row.prev_month_units ?? row.prev_months[meta.latest_month_num - 1])}</td>
                            <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.curr_month_diff)}`}>{points(row.curr_month_diff)}</td>
                            <td className={`border-l-2 border-slate-700 p-2 text-center font-mono ${growthClass(row.growth_vs_prev_month)}`}>{signed(row.growth_vs_prev_month)}</td>
                            <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_same_month_prev_year)}`}>{signed(row.growth_vs_same_month_prev_year)}</td>
                            <td className="border-l-2 border-slate-700 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_ytd)}</td>
                            <td className="border-l border-slate-800/70 p-2 text-center font-mono">{num(row.prev_ytd)}</td>
                            <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.curr_ytd_diff)}`}>{points(row.curr_ytd_diff)}</td>
                            <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_prev_ytd)}`}>{signed(row.growth_vs_prev_ytd)}</td>
                            <td className="border-l-2 border-slate-700 p-2 text-center font-mono text-slate-400">{rankChange(row.rank_diff)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </>
                ) : (
                <>
                  <thead className="sticky top-0 z-20 bg-slate-800 text-slate-300">
                    <tr>
                      <th rowSpan={2} className="sticky left-0 z-30 min-w-48 border-r border-slate-700 bg-slate-800 p-3">{active.rowLabel}</th>
                      <th colSpan={2} className="border-r border-slate-700 p-2 text-center">{labels.currMonth} {meta.prev_year}</th>
                      <th colSpan={2} className="border-r border-slate-700 p-2 text-center">{labels.prevYtdPeriod}</th>
                      <th colSpan={2} className="border-r border-slate-700 p-2 text-center">{meta.prev_year} Total</th>
                      <th colSpan={5} className="border-r border-slate-700 p-2 text-center">{labels.currMonthPeriod}</th>
                      <th colSpan={4} className="border-r border-slate-700 p-2 text-center">{labels.currYtdPeriod}</th>
                      <th colSpan={3} className="p-2 text-center">Rank</th>
                    </tr>
                    <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="min-w-20 border-l border-slate-700 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-20 border-l-2 border-slate-600 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-20 border-l-2 border-slate-600 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-20 border-l-2 border-slate-600 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Diff</th>
                      <th className="min-w-28 border-l border-slate-700 p-2 text-center">Growth vs {labels.prevMonth} {meta.latest_year}</th>
                      <th className="min-w-28 border-l border-slate-700 p-2 text-center">Growth vs {labels.currMonth} {meta.prev_year}</th>
                      <th className="min-w-20 border-l-2 border-slate-600 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Diff</th>
                      <th className="min-w-32 border-l border-slate-700 p-2 text-center">Growth vs {labels.prevYtdPeriod}</th>
                      <th className="min-w-14 border-l-2 border-slate-600 p-2 text-center">{meta.prev_year}</th>
                      <th className="min-w-14 border-l border-slate-700 p-2 text-center">{meta.latest_year}</th>
                      <th className="min-w-14 border-l border-slate-700 p-2 text-center">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const { rowClass, labelBg } = rowVisual(row, i, active.kind);
                      return (
                        <tr key={`${row.key}-${i}`} className={`border-b border-slate-800 ${rowClass}`}>
                          <td className={`sticky left-0 z-10 border-r border-slate-800 p-2.5 ${labelBg}`}>{row.label}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono">{num(row.prev_month_units ?? row.prev_months[meta.latest_month_num - 1])}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.prev_month_share)}</td>
                          <td className="border-l-2 border-slate-700 p-2 text-center font-mono">{num(row.prev_ytd)}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.prev_ytd_share)}</td>
                          <td className="border-l-2 border-slate-700 p-2 text-center font-mono">{num(row.prev_total)}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.prev_total_share)}</td>
                          <td className="border-l-2 border-slate-700 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_month_units ?? row.curr_months[meta.latest_month_num - 1])}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.curr_month_share)}</td>
                          <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.curr_month_diff)}`}>{points(row.curr_month_diff)}</td>
                          <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_prev_month)}`}>{signed(row.growth_vs_prev_month)}</td>
                          <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_same_month_prev_year)}`}>{signed(row.growth_vs_same_month_prev_year)}</td>
                          <td className="border-l-2 border-slate-700 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_ytd)}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.curr_ytd_share)}</td>
                          <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.curr_ytd_diff)}`}>{points(row.curr_ytd_diff)}</td>
                          <td className={`border-l border-slate-800/70 p-2 text-center font-mono ${growthClass(row.growth_vs_prev_ytd)}`}>{signed(row.growth_vs_prev_ytd)}</td>
                          <td className="border-l-2 border-slate-700 p-2 text-center font-mono text-slate-400">{row.prev_rank ?? "—"}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{row.curr_rank ?? "—"}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{row.rank_diff === null || row.rank_diff === undefined ? "—" : row.rank_diff > 0 ? `+${row.rank_diff}` : row.rank_diff}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </>
                )
              )}

              {active.kind === "model_tree" && (
                <>
                  <thead className="sticky top-0 z-20 bg-slate-800 text-slate-300">
                    <tr>
                      <th rowSpan={2} className="sticky left-0 z-30 min-w-48 border-r border-slate-700 bg-slate-800 p-3">{active.rowLabel}</th>
                      <th colSpan={2} className="border-r border-slate-700 p-2 text-center">{meta.prev_year} Total</th>
                      {meta.months.slice(0, meta.latest_month_num).map((m) => (
                        <th key={m} rowSpan={2} className="min-w-16 border-l-2 border-slate-600 p-2 text-center align-bottom">{m}</th>
                      ))}
                      <th colSpan={2} className="border-l-2 border-slate-600 p-2 text-center">{labels.currYtdPeriod} Total</th>
                    </tr>
                    <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="min-w-20 border-l border-slate-700 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                      <th className="min-w-20 border-l-2 border-slate-600 p-2 text-center">Units</th>
                      <th className="min-w-16 border-l border-slate-700 p-2 text-center">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const { isChild, rowClass, labelBg } = rowVisual(row, i, active.kind);
                      return (
                        <tr key={`${row.key}-${i}`} className={`border-b border-slate-800 ${rowClass}`}>
                          <td className={`sticky left-0 z-10 border-r border-slate-800 p-2.5 ${labelBg} ${isChild ? "pl-7 font-normal text-slate-400" : ""}`}>{row.label}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono">{num(row.prev_total)}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.prev_total_share)}</td>
                          {meta.months.slice(0, meta.latest_month_num).map((m, mi) => (
                            <td key={m} className="border-l-2 border-slate-600 p-2 text-center font-mono">{num(row.curr_months[mi])}</td>
                          ))}
                          <td className="border-l-2 border-slate-700 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_ytd)}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{pct(row.curr_ytd_share)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </>
              )}

              {active.kind === "model_rank" && (
                <>
                  <thead className="sticky top-0 z-20 bg-slate-800 text-slate-300">
                    <tr>
                      <th rowSpan={2} className="sticky left-0 z-30 min-w-40 border-r border-slate-700 bg-slate-800 p-3">{active.rowLabel}</th>
                      <th rowSpan={2} className="min-w-32 border-r border-slate-700 p-3 text-center align-bottom">Brand</th>
                      <th rowSpan={2} className="min-w-24 border-r border-slate-700 p-2 text-center align-bottom">{meta.prev_year} Total</th>
                      <th rowSpan={2} className="min-w-24 border-r border-slate-700 p-2 text-center align-bottom">{meta.latest_year} Total</th>
                      <th colSpan={3} className="border-r border-slate-700 p-2 text-center">Rank</th>
                      {showModelRankMonth && (
                        <th rowSpan={2} className="min-w-20 p-2 text-center align-bottom">{labels.currMonth}&apos;{String(meta.latest_year).slice(-2)}</th>
                      )}
                    </tr>
                    <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="min-w-14 border-l-2 border-slate-600 p-2 text-center">{meta.prev_year}</th>
                      <th className="min-w-14 border-l border-slate-700 p-2 text-center">{meta.latest_year}</th>
                      <th className="min-w-14 border-l border-slate-700 p-2 text-center">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const { rowClass, labelBg } = rowVisual(row, i, active.kind);
                      return (
                        <tr key={`${row.key}-${i}`} className={`border-b border-slate-800 ${rowClass}`}>
                          <td className={`sticky left-0 z-10 border-r border-slate-800 p-2.5 ${labelBg}`}>{row.model ?? row.label}</td>
                          <td className="border-r border-slate-800/70 p-2 text-center text-slate-400">{row.brand ?? "—"}</td>
                          <td className="border-r border-slate-800/70 p-2 text-center font-mono">{num(row.prev_total)}</td>
                          <td className="border-r border-slate-800/70 p-2 text-center font-mono font-semibold">{num(row.curr_ytd)}</td>
                          <td className="border-l-2 border-slate-600 p-2 text-center font-mono text-slate-400">{row.prev_rank ?? "—"}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{row.curr_rank ?? "—"}</td>
                          <td className="border-l border-slate-800/70 p-2 text-center font-mono text-slate-400">{row.rank_diff === null || row.rank_diff === undefined ? "—" : row.rank_diff > 0 ? `+${row.rank_diff}` : row.rank_diff}</td>
                          {showModelRankMonth && (
                            <td className="p-2 text-center font-mono font-semibold">{num(row.curr_month_units ?? row.curr_months[meta.latest_month_num - 1])}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </>
              )}

              {active.kind === "province_tree" && (
                <>
                  <thead className="sticky top-0 z-20 bg-slate-800 text-slate-300">
                    <tr>
                      <th rowSpan={2} className="sticky left-0 z-30 min-w-32 border-r border-slate-700 bg-slate-800 p-3">จังหวัด</th>
                      <th rowSpan={2} className="min-w-32 border-r border-slate-700 p-3 align-bottom">ยี่ห้อรถ2</th>
                      <th colSpan={13} className="border-r border-slate-700 p-2 text-center">{meta.prev_year}</th>
                      <th colSpan={meta.latest_month_num + 1} className="p-2 text-center">{meta.latest_year}</th>
                    </tr>
                    <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                      {meta.months.map((m) => (
                        <th key={`p-${m}`} className="min-w-14 border-l border-slate-700 p-2 text-center">{m}</th>
                      ))}
                      <th className="min-w-16 border-l-2 border-slate-600 p-2 text-center">Total</th>
                      {meta.months.slice(0, meta.latest_month_num).map((m) => (
                        <th key={`c-${m}`} className="min-w-14 border-l border-slate-700 p-2 text-center">{m}</th>
                      ))}
                      <th className="min-w-16 border-l-2 border-slate-600 p-2 text-center">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const { isChild, rowClass, labelBg } = rowVisual(row, i, active.kind);
                      const jangwat = row.level === "brand" ? "" : row.group ?? row.label;
                      const brand = row.level === "brand" ? row.label : "";
                      return (
                        <tr key={`${row.key}-${i}`} className={`border-b border-slate-800 ${rowClass}`}>
                          <td className={`sticky left-0 z-10 border-r border-slate-800 p-2.5 ${labelBg}`}>{jangwat}</td>
                          <td className={`border-r border-slate-800/70 p-2.5 ${isChild ? "pl-5 font-normal text-slate-400" : ""}`}>{brand}</td>
                          {row.prev_months.map((v, mi) => (
                            <td key={`p-${mi}`} className="border-l border-slate-800/70 p-2 text-center font-mono">{num(v)}</td>
                          ))}
                          <td className="border-l-2 border-slate-700 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.prev_total)}</td>
                          {row.curr_months.slice(0, meta.latest_month_num).map((v, mi) => (
                            <td key={`c-${mi}`} className="border-l border-slate-800/70 p-2 text-center font-mono">{num(v)}</td>
                          ))}
                          <td className="border-l-2 border-slate-700 bg-slate-950/50 p-2 text-center font-mono font-semibold">{num(row.curr_ytd)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </>
              )}
            </table>
          </div>
          <SheetChart kind={active.kind} rows={rows} meta={meta} labels={labels} />
          <div className="border-t border-slate-800 p-2 text-right text-[10px] text-slate-600">
            {rows.length.toLocaleString()} rows · generated {new Date(meta.generated_at).toLocaleString()}
          </div>
        </section>
      </div>
    </main>
  );
}
