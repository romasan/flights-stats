# Changelog

## 2026-09-09 — Added Sheremetyevo (SVO): daily "yesterday" collection via public svo.aero /bitrix/timetable JSON API (full day per date); canonical statuses derived from actual times.
## 2026-09-09 — On server start, daily "yesterday" units (LED, OVB) now immediately fetch missing data for yesterday instead of waiting for FETCH_HOUR, avoiding a lost day after overnight downtime.
## 2026-09-08 — Added Tolmachevo (OVB) airport: daily "yesterday" collection through headless Chromium (playwright-core) to bypass the site's JS cookie challenge; parses mixed arrival/departure HTML cards and treats "yesterday" in Asia/Novosibirsk; fetcher now supports units that fetch via a browser (fetchRawHtml) and archive can store raw HTML as text.
## 2026-09-08 — Store original airport status in a new DB column status_raw and added scripts/migrate-ufa-status.js to backfill existing UFA rows; the flight popup shows the original status.
## 2026-09-08 — Normalized UFA flight statuses at parse time to the canonical LED set (Отправлен/Прибыл, Задержан, Отмена, Без статуса).

## 2026-08-25 — Added .env support via dotenv for PORT; added .env/.env.example and added .env to .gitignore.
## 2026-08-24 — Reworked npm scripts: renamed start to dev, added pm2-based start/stop/logs (pm2 as devDependency) and updated README accordingly.

## 2026-08-23 — Added UFA airport (Ufa) with hourly schedule fetching current-day flights via POST and HTML parsing, accumulating by external ID; scheduler now runs per unit with per-unit retry settings.

## 2026-08-23 — Rewrote project as a Node.js server (Express + better-sqlite3): built-in daily scheduler with retries replaces cron, added REST API serving only display-ready data, SQLite storage with raw JSON archived on disk, unit-based airport config for future multi-airport support, and an airport dropdown on the frontend; removed fetch_flights.sh and legacy JSON/log files in favor of a one-time migration script.

## 2026-08-23 — Fixed fetch_flights.sh saving JSON files to the script directory regardless of the working directory when run from cron.


## 2026-08-22 — Added summary cards showing total canceled/delayed departures and arrivals with percentages, computed using the selected delay threshold.

## 2026-08-22 — Heatmaps for delay/cancellation now group flights by planned time (STD/STA) instead of actual time; fallback to actual time is counted in warnings.

## 2026-08-22 — Fixed flight delay calculation to use full plan/actual dates instead of time only; flights arriving earlier than planned are no longer marked as delayed.

## 2026-08-22 — In the departure/arrival popup, show the date before plan/actual time in gray when the plan and actual dates differ.

## 2026-08-22 — Added a dropdown switch between cancellation and delay metrics for the departure/arrival heatmaps, with the selected delay threshold.

## 2026-08-22 — Formatted delays over 60 minutes in popups as h/d format; added a selectable delay threshold (default 1 hour) that reclassifies delayed flights.

## 2026-08-22 — Fixed departure/arrival tables overflowing the page layout: added min-width: 0 to table grid cards so wide tables scroll inside their own container.

## 2026-08-20 — Fixed modal popup layout on mobile: switched to dvh units with vh/percentage fallback and added compact padding for screens under 640px so the popup stays within the visible area.

## 2026-08-20 — Added clickable dates in departure/arrival tables opening a modal with all flights for the selected day, plus column sorting in tables and modal.

## 2026-08-20 — Removed the "Обновить" button and the "лог: ошибки" fragment from the status bar in flights-stats.html.

## 2026-08-16 — Added project documentation: README.md (app structure and behavior), CLAUDE.md (Cline instructions), and CHANGELOG.md.