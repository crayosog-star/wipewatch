# Changelog

All notable changes to Wipewatch. Dates are by month.

## 1.4.0 - November 2026
- **Friends and Clans.** Create a profile on a Wipewatch server, add friends, and form a clan. Profiles are open or private, every shared field (skin value, activity, recent servers, hours, playing now) has its own switch, and the server enforces it.
- **Zero-dependency friends/clans server** (`server/server.js`) with about 70 automated checks.
- **Solo edition**: the same app without Friends and Clans and without any of the social code (`npm run installer:solo`).
- Recent servers are now recorded from Steam so friends can see where you have been playing.
- Project page, animated banner, screenshots and a published Solo installer.

## 1.3.0 - November 2026
- **Drops page simplified**: it now just says whether any drop is live and what it is, for Kick and Twitch alike.
- **Skin cost tracking** with profit and loss after Steam's fee, per skin and in total, plus CSV columns.
- **Wipe alerts for every starred server**, with one-click join, and a "just wiped" tag on Home.
- **Update check** against the GitHub releases of a repository you choose.
- **Installer** (`npm run installer`): per-user install, shortcuts, uninstaller.

## 1.2.0 - November 2026
- **Build Ideas**: recent popular base-build videos from channels you follow, ranked by views for their age.
- **Wipe Planner**: wipe-day checklist that resets every force wipe, notes, and base pins on server maps.
- **Skin watchlist** for skins you do not own, price alerts included.
- **Streaks** on My Stats, alert sounds, an always-on-top mini overlay.
- Price lookups use Steam's market search when the price endpoint is rate limited, with a remembered back-off.
- Real server regions and tags; Servers list readable at any width.
- Launch animation.

## 1.1.0 - November 2026
- Renamed to **Wipewatch**, with a new logo, Home dashboard, command palette (`Ctrl+K`), light and dark themes, tray stats, backup and restore, and a packaged `.exe`.
- Ending-soon drop alerts and 24-hour price changes.

## 1.0.0
- First version: Kick and Twitch drop alerts, Steam inventory pricing, patch notes, server list with maps, calendar and raid calculator.
