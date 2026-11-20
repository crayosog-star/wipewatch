# Contributing to Wipewatch

Thanks for helping. Bug reports, ideas and pull requests are welcome.

## Run it
```powershell
npm install
npm start                    # run from source
npm run smoke                # headless self-test of the whole UI (run this before opening a pull request)
npm run test:social          # friends / clans server tests
```
`RDT_REAL=1` uses real Steam data, `RDT_SHOTS=<dir>` renders every page to PNG off-screen, `RDT_DEMO=1` fills the app with sample data and captures the README screenshots.

## Ground rules
- **Official or public data only.** Wipewatch does not use private or reverse-engineered endpoints, and it does not work around rate limits, blocks or captchas. If a source refuses scripted access, the feature should say so, not evade it.
- **Privacy first.** Keys, webhooks and account tokens stay on the user's PC and never go into backups, logs, Discord messages or the friends server. New things that leave the PC must be opt-in and visible in Settings.
- **Render untrusted text as text.** Anything from a server, a feed or another user goes through `h()` / `textContent`, never `innerHTML`.
- **Keep the Solo edition clean.** Friends and Clans live in `src/social*.js`, `src/social-ui.js` and `server/`; the Solo build strips them, so nothing else may depend on them.

## Project layout
```
src/            Electron app (main process, preload, renderer pages)
server/         friends and clans server (zero dependencies)
tools/          packaging, installer and release scripts
tests/          server tests
assets/         icons, banner, screenshots and the demo animation
docs/           project site
```

## Pull requests
Keep them small and focused, describe what you changed and how you tested it, and add a line to `CHANGELOG.md`.
