# Operator Admin Manual

This manual explains how to use and maintain the Thailand car registration dashboard.
It is written for the project administrator, not for developers.

## Current Setup

The current shipped workflow is a local Windows workflow plus GitHub Pages publishing.

- Use `START.bat` to open the dashboard.
- Use `MONTHLY_UPDATE.bat` when new monthly DLT Excel files arrive.
- Use GitHub Actions `Deploy dashboard to GitHub Pages` to publish the static website.

There is no separate app login. GitHub permissions are the admin permission system for
publishing and repository changes.

The browser-only monthly upload workflow discussed in planning is not installed in this
repository yet. Do not look for an Admin Console upload page unless that workflow is added
later.

## Normal Dashboard Use

1. Open the project folder.
2. Double-click `START.bat`.
3. Wait for the dashboard to open.
4. If it does not open automatically, visit:

```text
http://localhost:3001
```

The dashboard can run from the already-generated public JSON files. A viewer does not need
the private raw Excel files.

## Monthly Update Workflow

Use this only when the two new DLT Excel files are ready.

1. Close all Excel windows.
2. Delete or move out the old Excel files from:

```text
backend/raw data/
```

3. Put only the two new DLT workbooks into:

```text
backend/raw data/
```

4. Double-click:

```text
MONTHLY_UPDATE.bat
```

5. Wait until the window finishes. Do not close it halfway.
6. Read:

```text
reports/monthly_operator_summary.txt
```

7. Open the dashboard and check these pages:

```text
/
/models
/analyst
/report
```

The monthly update is designed to be safe. It builds new dashboard data in a staging
folder first, validates it, and only then replaces the public JSON. If the update fails,
the dashboard should keep showing the last good data.

## Model Review Workflow

New model rows are automatically added as `pending` in:

```text
backend/config/model_powertrain_review.csv
```

Pending rows are safe. They do not enter BEV report Sheets 7-8.

Only approve a model as BEV when there is reliable evidence.

For an approved BEV row, fill:

```text
candidate_powertrain = BEV
review_status = approved
evidence = source link or clear evidence note
reviewer = reviewer name
reviewed_at = YYYY-MM-DD
```

Allowed `review_status` values:

```text
pending
approved
rejected
ambiguous
```

Allowed `candidate_powertrain` values:

```text
BEV
HEV
PHEV
ICE
ambiguous
unknown
```

Do not use `EV`. Use `BEV`.

After editing `model_powertrain_review.csv`, run `MONTHLY_UPDATE.bat` again so Sheets 7-8
are regenerated from the approved review rows.

## Publishing To GitHub Pages

Publishing the dashboard to the live website is done through GitHub Actions — no local
build is needed:

1. Go to the repository on GitHub.
2. Open the `Actions` tab.
3. Select `Deploy dashboard to GitHub Pages`.
4. Click `Run workflow`.
5. Wait for the workflow to complete successfully.

The live GitHub Pages site is static. It publishes built files only; it does not store
private admin credentials and does not accept dashboard writes from visitors.

## What Each Important File Does

| Path | Purpose |
|---|---|
| `START.bat` | Opens the dashboard for normal viewing. |
| `MONTHLY_UPDATE.bat` | Runs the guided monthly data update. |
| `TAKEOVER.bat` | Menu for handoff/setup/start/update guide actions. |
| `backend/raw data/` | Local folder for the two monthly raw DLT Excel files. |
| `backend/config/brand_map.csv` | Maps raw brand names to canonical brand names. |
| `backend/config/model_map.csv` | Maps raw model names to canonical model names. |
| `backend/config/model_powertrain_review.csv` | Human review authority for model powertrain decisions. |
| `backend/config/powertrain_map.csv` | Maps raw fuel types to ICE/HEV/PHEV/BEV. |
| `backend/output/test_9_masterModel.xlsx` | Required tracked master workbook for clean setup. |
| `frontend/public/data/*.json` | Public dashboard data payloads. |
| `frontend/public/data/operator_status.json` | Current dashboard data health/status. |
| `frontend/public/data/new_bev_candidates.json` | Read-only watchlist of possible new BEV models. |
| `reports/monthly_operator_summary.txt` | Human-readable monthly update result. |
| `logs/` | Detailed monthly update logs. |

## Safe To Delete

These files/folders are generated locally and can be deleted if you need to clean the
workspace. They will be recreated when needed.

| Path | Safe? | Notes |
|---|---:|---|
| `logs/` | Yes | Monthly update logs. Keep the latest one if debugging a failure. |
| `reports/` | Yes | Monthly summary reports. Keep the latest summary if debugging. |
| `frontend/.next/` | Yes | Next.js build cache. |
| `frontend/out/` | Yes | Static export output; recreated by `npm run build` or deploy workflow. |
| `frontend/public/data.staging/` | Yes | Temporary monthly update staging folder. |
| `frontend/public/data.bak/` | Yes | Temporary backup during safe publish. |
| `.pytest_cache/` | Yes | Python test cache. |
| `backend/.pytest_cache/` | Yes | Python test cache. |
| `__pycache__/` folders | Yes | Python bytecode cache. |
| `frontend/node_modules/` | Yes | Recreated by `SETUP.bat` or `npm ci`; deleting makes next setup slower. |
| `.tmp/` | Yes | Local scratch output. |

## Do Not Delete

Do not delete these unless a developer explicitly tells you to.

| Path | Why it must stay |
|---|---|
| `backend/config/brand_map.csv` | Required brand mapping. |
| `backend/config/model_map.csv` | Required model mapping. |
| `backend/config/model_powertrain_review.csv` | Human review history and BEV approval authority. |
| `backend/config/powertrain_map.csv` | Required fuel-to-powertrain mapping. |
| `backend/output/test_9_masterModel.xlsx` | Required master workbook tracked for clean setup. |
| `frontend/public/data/*.json` | The dashboard's public data. Deleting breaks the dashboard until rebuilt. |
| `frontend/public/logo.png` | Dashboard logo. |
| `.github/workflows/ci.yml` | GitHub test workflow. |
| `.github/workflows/deploy-pages.yml` | GitHub Pages publish workflow. |
| `package-lock.json` files | Dependency lock files for repeatable installs. |
| `backend/requirements.txt` | Python dependency list. |
| `README.md`, `docs/`, `handoffs/` | User and maintainer documentation. |

## Raw Excel File Rule

The two raw DLT Excel files in `backend/raw data/` are local input files. They are ignored
by Git and are not needed by normal dashboard viewers.

For each monthly update, `backend/raw data/` should contain only the newest two DLT Excel
files. Old Excel files can mislead the update, so remove them before adding the new files.

Keep only:

1. newest fuel file: brand + fuel type + province;
2. newest model file: brand + model + province.

If you may need old files later, archive them outside the repo instead of keeping them in
`backend/raw data/`.

## If Something Fails

1. Do not delete config files.
2. Do not edit JSON files by hand.
3. Read:

```text
reports/monthly_operator_summary.txt
```

4. Check the latest file in:

```text
logs/
```

5. Fix the problem named in the summary or log.
6. Run `MONTHLY_UPDATE.bat` again.

Common causes:

- one of the two raw Excel files is missing;
- an Excel file is still open;
- `model_powertrain_review.csv` has a typo;
- an approved row is missing evidence, reviewer, or review date;
- the wrong word `EV` was used instead of `BEV`.

## Golden Rules

- Do not approve BEV models from the name alone.
- Do not use `EV`; use `BEV`.
- Do not edit generated JSON files by hand.
- Do not delete files under `backend/config/`.
- Do not publish if `MONTHLY_UPDATE.bat` fails.
- Pending review rows are safe; they can wait.
- GitHub publishing is controlled by GitHub repository permissions.
