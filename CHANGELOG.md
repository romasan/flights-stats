# Changelog

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