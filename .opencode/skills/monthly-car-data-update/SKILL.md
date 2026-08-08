---
name: monthly-car-data-update
description: Update the Thai DLT car-registration dashboard for a new month. Use ONLY when the user drops new DLT raw data files (…ชนิดเชื้อเพลิง… / …รุ่นรถ… …2569….xlsx) into the raw data folder and wants the pipeline rebuilt, JSONs regenerated, and results committed+pushed to git ("monthly update", "run pipeline for the new month", "อัพเดทข้อมูลรายเดือน", "run เดือนใหม่", "update the data and push"). Runs monthly_update.py, verifies fresh outputs, then git add/commit/push.
---

# monthly-car-data-update

Rebuild the car-registration dashboard for a new reporting month and publish it.

## When to use

The user has two **new cumulative** DLT `.xlsx` files in
`backend/raw data/` (the DLT fuel file `…ยี่ห้อรถ-ชนิดเชื้อเพลิง… .xlsx` and the
DLT model file `…ยี่ห้อรถ-รุ่นรถ… .xlsx`, e.g. the `กรกฎาคม 2569` files) and wants
the whole pipeline re-run and published. Trigger keywords: "monthly update",
"run for the new month", "อัพเดทเดือนใหม่", "update data and git push".

## Repository context

- Repo root: the current working directory (the `car_dlt` project).
- `CLAUDE.md` is the primary agent instructions file — read it first.
- Raw files are **cumulative** (full history); each new month's file replaces the
  previous month's as the master. Pipeline auto-detects the newest file.
- Current reporting period is auto-detected from the parquet — never hardcode a
  month/year.

## End-to-end workflow (do these in order)

1. **Confirm inputs.** List `backend/raw data/`. Verify the two DLT files for the
   new month are actually present (e.g. the `กรกฎาคม 2569` / `July` files) and are
   the newest. If the wrong/old month is there, tell the user and locate the real
   files before continuing.

2. **Check Python.** Ensure `python` (3.12) with `pandas` and `openpyxl` is
   available before running anything.

3. **Run the pipeline.** From the repo root, run the authoritative operator flow
   (this is what `MONTHLY_UPDATE.bat` calls — a staged, validated, atomic publish
   that regenerates every JSON and the master workbook in one pass):
   ```bash
   $env:PYTHONUTF8="1"; python -X utf8 backend\monthly_update.py
   ```
   Do NOT call `build_analyst.py` directly unless the user explicitly insists —
   it requires a `*cal*.xlsx` calculation template that is not present in the
   repo, and it is not the path used for the published `manual_report.json`.

4. **Check the result.** The script prints one of:
   - `สำเร็จ: เผยแพร่ข้อมูลใหม่แล้ว` → OK (record `RESULT_OK`)
   - `ต้องตรวจเพิ่ม: …แต่ Sheets 7-8…` → published fine but new BEV models await
     review in `backend/config/model_powertrain_review.csv` (record `RESULT_REVIEW`)
   - `ไม่สำเร็จ: …` → FAILED, public data untouched; stop and fix.

5. **Verify published data.** Confirm every JSON in `frontend/public/data/` was
   regenerated on this run:
   `dashboard_summary.json`, `dashboard_models.json`, `analyst_data.json`,
   `analyst_province_data.json`, `manual_report.json`,
   `new_bev_candidates.json`, `cleaned_data_manifest.json`, `operator_status.json`
   (check LastWriteTime ≥ run start), plus `backend/output/test_9_masterModel.xlsx`
   and `backend/pipeline_state.json`. Report the new period and row counts from
   `reports/monthly_operator_summary.txt`.

6. **Update repo (`git add`/`commit`).** Stage ONLY files produced by this pipeline
   run. Do NOT stage unrelated ambient changes (e.g. stray `*.pptx` renames).

   ```bash
   git add backend/config/known_models.txt backend/config/model_powertrain_review.csv backend/output/test_9_masterModel.xlsx backend/pipeline_state.json frontend/public/data/
   git status --short    # confirm staged set
   git diff --cached --stat
   ```
   Commit with a clear month message:
   ```bash
   git commit -m "Update dashboard data to July 2569 (run $(Get-Date -Format yyyy-MM-dd))"
   ```

7. **Push.** If the remote has new commits (`git push` rejected:
   "fetch first"), first sweep the remote baseline onto the branch and re-apply,
   because the pipeline outputs are large and collisions are painful:
   ```bash
   git fetch origin
   # if diverged: consult user; recommended clean path is
   # git reset --hard origin/main   (July raw files are untracked, so they survive)
   # then re-run steps 3–6, then push
   git push origin main
   ```
   After push, confirm `git rev-list --left-right --count HEAD...origin/main`
   reports `0 0`.

## Manual review reminders

When result = `RESULT_REVIEW` (or pending>0), remind the user that new BEV models
stay out of Sheets 7–8 until they are approved in
`backend/config/model_powertrain_review.csv` — this is normal and safe, not an
error. Try not to over-persuade on BEV candidates.

## Rules / guardrails

- Always run with `$env:PYTHONUTF8=1` (Thai filenames/encoding).
- Never hardcode the current month/year; read it from the pipeline output.
- Never run `MONTHLY_UPDATE.bat`/`monthly_update.py` without this being the task.
- Never stage unrelated files (candidate/pptx/deleted handbook decks) into the data
  commit. Keep them separate or leave them alone.
- If any pipeline step fails, stop and report the Thai failure line; do not skip
  forward.
- Verable confirm fresh outputs and a successful push before declaring done.

## Verification checklist

- [ ] Both new DLT files for the month exist in `backend/raw/`
- [ ] `backend/monthly_update.py` completed without `ไม่สำเร็จ`
- [ ] All 8 JSONs in `frontend/public/data/` refreshed this run
- [ ] `pipeline_state.json` shows the new month / `run_date` = today
- [ ] Commit created and pushed (`HEAD...origin/main` = `0 0`)
- [ ] Reported new period + row counts to the user