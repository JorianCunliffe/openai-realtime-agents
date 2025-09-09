Perfect — here’s a **PR implementation plan** you can drop straight into the repo as `PR_PLAN.md`. It’s structured as a checklist, broken into steps with quality gates so you can build incrementally and catch regressions immediately.

---

# PR Plan: Front-End + Multi-User + Google Calendar + Twilio

*(for [openai-realtime-agents](https://github.com/openai/openai-realtime-agents))*

## 🔑 Goals

* Add **multi-user support** with per-user settings in DB.
* Add **Google OAuth2** flow + calendar tools.
* Add **Twilio voice route** that reuses the same agent/session path as web.
* Keep **demo scenarios untouched**.
* **Minimal disturbance** to existing code; all new work behind flags.
* **Step-by-step with QC gates** — breakages caught immediately.

---

## ✅ Step 1 — Baseline Snapshot

* [x] Tag repo: `git tag baseline-demo`.
* [x] Confirm `npm run dev` works.
* [x] Confirm `/api/session` returns ephemeral token JSON.
* QC: `curl -s http://localhost:3000/api/session | jq '.client_secret'` returns token.

---

## ✅ Step 2 — Database Bootstrap

* [x] Add `prisma/schema.prisma` with models:

  * `User`, `OAuthAccount`, `UserSettings`, `CallerMapping`, `AuditLog`.
* [x] Add `src/lib/db.ts` (Prisma client).
* [x] Run `npx prisma migrate dev`.
* QC: Run `node scripts/smoke-db.cjs` to insert/read a fake user.

---

## ✅ Step 3 — Session Cookie

* [] Add `src/lib/session.ts` (signed `sid` cookie utilities).
* [ ] On login (temporary dev route), set `sid`.
* [ ] `/api/session` continues to work **without** `sid`.
* QC:

  * `curl -I http://localhost:3000/api/session` works unchanged.
  * Visiting `/login-dev` sets `sid`; inspect cookie in browser.

---

## ✅ Step 4 — Google OAuth2

* [ ] Add routes:

  * `/api/auth/google` (redirects to Google).
  * `/api/auth/google/callback` (exchanges code → stores tokens in `OAuthAccount`).
* [ ] Add `src/lib/auth/google.ts` (client creation + token refresh).
* [ ] Store tokens encrypted at rest.
* QC:

  * Complete OAuth loop.
  * DB row in `OAuthAccount` has `accessToken`, `refreshToken`.
  * Calling `getAuthorizedGoogleClient(userId)` returns usable client.

---

## ✅ Step 5 — Calendar API Routes

* [ ] Add `/api/google/calendar/list` → lists events (requires `sid`).
* [ ] Add `/api/google/calendar/create` → creates events.
* [ ] Use `googleapis` Node SDK.
* QC:

  * `curl -b sid=... /api/google/calendar/list` returns JSON events.
  * `curl -b sid=... -X POST …/create` inserts event visible in Google Calendar.

---

## ✅ Step 6 — Runtime Tool Injection

* [ ] Add `src/lib/realtime/createSession.ts`.
* [ ] If `sid` present, attach calendar tools (list/create/freebusy).
* [ ] Else, preserve old behavior.
* [ ] Optionally, accept `userId` header for server-side (Twilio).
* QC:
---

## ✅ Step 7 — Twilio Voice & Stream

* [ ] **Add `/api/twilio/voice`** → TwiML endpoint.

  * File: `src/app/api/twilio/voice/route.ts`.
  * Returns `<Start><Stream url="wss://…/twilio-media?userId=…"/>`.
  * Lookup inbound caller (`From`) in `CallerMapping` → resolve `userId`.
* [ ] **Add WS server** for Media Streams.

  * File: `scripts/twilio-ws-server.ts`.
  * Uses `ws` + `http` to accept Twilio Media Stream events.
  * On `"start"`, call `createRealtimeSession(userCtx)` (shared with web).
  * Stub forwards audio payloads (base64) → TODO: connect to OpenAI Realtime.
  * On `"stop"`, cleanup connections.
* [ ] **Update package.json** scripts:

  ```json
  {
    "scripts": {
      "dev": "concurrently -n NEXT,WS \"next dev\" \"node -r ts-node/register/transpile-only scripts/twilio-ws-server.ts\"",
      "start": "concurrently -n NEXT,WS \"next start -p 3000\" \"node scripts/twilio-ws-server.js\""
    }
  }
  ```
* [ ] **Secrets**:

  * `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (for verification).
  * `TWILIO_WS_PORT` (default 8787).
* [ ] **QC:**

  * Place call → Twilio webhook hits `/api/twilio/voice`.
  * TwiML instructs Twilio to connect to `wss://<your-repl>/twilio-media`.
  * Logs in `twilio-ws-server` show `"start"` and `"media"` events.
  * No regressions in `/api/session` or existing demo flows.

---

## ✅ Step 8 — Front-End Pages

 Add /login → button → /api/auth/google.

 Add /settings → edit timezone, hours, feature flags.

 Gate /voice page with Auth (redirect to /login if no sid).

 Preserve existing demo “Scenario” UI.

QC:

Logging in sets cookie.

Settings update DB.

Voice/chat page still works.

---

## ✅ Step 9 — Quality Checks & Flags (expanded)

* [ ] Add `ENABLE_TWILIO` flag so `/api/twilio/*` routes + WS server only spin up when enabled.
* [ ] CI: run smoke tests with Twilio disabled and enabled.

---

Would you like me to merge all the changes (DB, Google OAuth, Calendar, Twilio) into a **fresh full PR\_PLAN.md** so you can drop it in as one file, rather than patching the previous one?


## ✅ Step 10 — Deployment (Replit)

* [ ] Store secrets in Replit Secrets:

  * `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.
* [ ] Add `APP_BASE_URL` for redirect URIs.
* [ ] Verify Google OAuth redirect matches `…/api/auth/google/callback`.
* [ ] Verify Twilio can reach public Replit URL (`https://…replit.app`).

---

## 🔒 Security Notes

* Refresh tokens encrypted with `crypto` before saving.
* Use state param in OAuth to prevent CSRF.
* Verify Twilio signatures on `/api/twilio/voice`.

---

## 🧾 Rollback Plan

* Each step tagged in git.
* If QC fails, revert to prior tag; demo remains functional.

