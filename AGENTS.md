# AGENTS.md

## Cursor Cloud specific instructions

### What this is
Single service: **Fixera Server** — an Express 5 + TypeScript REST API (backend only, no frontend/UI). Data store is **MongoDB** via Mongoose. Routes are mounted under `/api` (see `src/index.ts`); `GET /` and `GET /health` are unauthenticated health checks. Standard commands live in `package.json` `scripts` and `README.md`.

### Prerequisites that must be running
- **MongoDB** must be reachable at the `MONGODB_URI` in `.env`. MongoDB Community 8.0 (`mongod`) is installed in the VM image but is NOT auto-started. Start it before running the server, e.g.:
  ```bash
  mkdir -p /data/db
  mongod --dbpath /data/db --bind_ip 127.0.0.1 --port 27017   # run in a tmux/background session
  ```
  A local URI works: `mongodb://127.0.0.1:27017/fixera`.

### `.env` is required (and git-ignored)
The server reads `.env` from the repo root (`src/index.ts` → `dotenv`). It is git-ignored, so it may not exist on a fresh checkout — recreate it if missing. Minimum for local dev:
```env
MONGODB_URI=mongodb://127.0.0.1:27017/fixera
PORT=4000
JWT_SECRET=local_dev_jwt_secret_change_me
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
# Required or the app crashes at import time (see note below); any value is fine locally.
STRIPE_SECRET_KEY=sk_test_placeholder_local_dev
```

### Non-obvious gotchas
- **`STRIPE_SECRET_KEY` is mandatory to boot.** `src/services/stripe.ts` throws `"STRIPE_SECRET_KEY not configured"` at module import time (not lazily). Without it the whole process crashes on startup even for non-Stripe flows. A placeholder value is fine — the Stripe SDK constructor makes no network calls.
- **Run in dev mode with `npm run dev`** (nodemon + `tsx`). This transpiles without type-checking, so the app runs even though `tsc` reports errors.
- **`npm run build` (`tsc`) currently FAILS** with ~96 pre-existing type errors across `src/handlers/**` and `src/models/{platformSettings,siteSettings}.ts`. This is a pre-existing repo state, not an environment problem. Use `npm run dev` for local development; do not expect `npm start` (which runs `dist/`) to work until the type errors are fixed.
- **No lint and no tests are configured.** There is no ESLint config, and `npm test` is a placeholder that exits 1.
- **Third-party integrations degrade gracefully** (except Stripe import above). Signup/login work with only MongoDB + `JWT_SECRET`; email OTP (Brevo), SMS OTP (Twilio), AWS S3 uploads, Google Maps, and FCM simply no-op/log warnings when their env vars are absent. Set the corresponding vars from `.env.example` only when you need those specific flows.
- Auth is cookie-based (`auth-token`, httpOnly). In dev (`NODE_ENV != production`) the cookie is `SameSite=lax`, not `secure`, so plain HTTP localhost works.
