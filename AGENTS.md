# AGENTS.md

## Cursor Cloud specific instructions

This is the **Fixera backend** — an Express 5 + TypeScript REST API (run via `tsx`) backed by MongoDB (Mongoose). It pairs with the `fixera` frontend repo. Standard commands live in `package.json`; setup details are in `README.md` / `SETUP.md`.

### Services & how to run
- **MongoDB is required.** The process calls `process.exit(1)` at startup if it cannot connect. In this environment a local `mongod` is used at `mongodb://127.0.0.1:27017/fixera` (start with `mongod --dbpath /data/db --bind_ip 127.0.0.1 --port 27017`). Set `MONGODB_URI` accordingly in `.env` (copy from `.env.example`; `MONGODB_URI` + `JWT_SECRET` are the only vars needed to boot).
- **Run dev:** `npm run dev` (nodemon + `tsx`) listens on port `4000` (`/health` returns `{"status":"UP"}`).

### Non-obvious caveats
- `npm run dev` uses `tsx`, which transpiles **without type-checking**, so it runs fine. `npm run build` (`tsc`) currently **fails** on pre-existing type errors (e.g. `models/platformSettings.ts`, `models/siteSettings.ts`, `handlers/WarrantyClaim/index.ts`); this does not affect dev mode.
- There is **no test suite** — `npm test` is a placeholder that exits 1.
- Third-party integrations (Twilio, Brevo, AWS S3, Stripe, Google Maps, FCM) are **optional**. Signup wraps OTP/email/SMS sends in try/catch, so account creation and login work without them. The email OTP is printed to the server console (`🔐 Generated EMAIL OTP for signup: ...`), which is handy for verifying accounts without a mail provider.
