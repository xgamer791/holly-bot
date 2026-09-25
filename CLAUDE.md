# Working on Holly Bot

- When a change is done, commit it and push it to `main`. GitHub Pages serves the live app from `main`. If you work on a feature branch, push it, then fast-forward `main` to it. If `main` has moved on, merge it in first; never force-push `main`.
- Don't test: no unit tests, e2e runs, screenshots or checks of the live site. The owner tests on their phone.
- The app is in English, Spanish and Chinese. New or changed text a person sees goes in `tr('…')` (src/ui/i18n.js), and its Spanish and Chinese go in `src/ui/i18n/es.js` and `zh.js` in the same change. `node scripts/i18n.mjs` lists what's missing.
- `computer/holly-computer.mjs` embeds the web app. When you change `src/`, `styles.css`, `index.html`, `manifest.webmanifest`, `sw.js`, `icons/`, `vendor/` or `computer/src/`, run `npm ci` (first time) and `npm run build:computer`, and commit the rebuilt file. That's a build step, not a test.
