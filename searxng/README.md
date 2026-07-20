# SearXNG (Render deployment, second service in this repo)

Self-hosted SearXNG instance for the AI chat's web-search grounding, replacing the dead
Railway deployment (`searxng-production-bdc5.up.railway.app` was 404ing on every request -
confirmed gone, not just sleeping/rate-limited).

Lives as a subfolder of the same `ineuu-cloud` repo as the MDM backend so there's only one
GitHub repo to manage - it deploys as its own separate Render service by pointing that
service's **Root Directory** at this folder (see step 3 below), not as part of
`ineuu-cloud-server` itself.

## Deploy steps (Render dashboard)

1. Commit and push this folder (already committed locally in this repo - just needs `git push`
   to `origin/main`, same remote `ineuu-cloud-server` already deploys from).

2. In the Render dashboard: **New +** → **Web Service** → connect the same `ineuu-cloud`
   GitHub repo you already used for `ineuu-cloud-server` (do NOT reuse that existing service -
   create a second, separate one).

3. Configure:
   - **Root Directory**: `searxng` (this is what makes Render build only this subfolder as
     its own independent service, instead of the Node.js server at the repo root)
   - **Environment**: `Docker` (Render will build the `Dockerfile` in this folder)
   - **Instance Type**: Free is enough to start - see the free-tier caveat below
   - **Port**: `8080` (what the Dockerfile `EXPOSE`s)
   - No environment variables are required - everything's in `settings.yml`.

4. Deploy. Render will give you a URL like `https://ineuu-searxng.onrender.com` (pick whatever
   service name you like when creating it - that becomes the subdomain).

5. Verify it actually works before wiring the app to it:
   ```
   curl "https://ineuu-searxng.onrender.com/search?q=test&format=json"
   ```
   Should return JSON with a `"results"` array, not a 403/404/empty body.

6. Send me that URL and I'll update `AiController.kt`'s `searchSearxng()` (currently pointing
   at the dead Railway URL) to call it instead, rebuild, and reinstall for testing.

## What's actually in settings.yml

Two changes from SearXNG's stock defaults, both required for this app to work at all:
- `search.formats` includes `json` (disabled by default - stock SearXNG is HTML-only, and
  `AiController.kt`'s `searchSearxng()` requests `&format=json` and parses a `"results"`
  array)
- `server.limiter: false` - SearXNG's default limiter is tuned to block scraping-style
  traffic from the public internet, which a server-to-server JSON fetch like this app's looks
  exactly like. Safe here since this instance isn't public-facing/discoverable, only this
  app's fleet calls it.

## Free-tier caveat

Same caveat the original audit raised about `ineuu-cloud-server` on Render: a free-tier
instance sleeps after 15 minutes idle and takes a cold-start delay to wake back up - the
first AI search after any idle gap would hang for several seconds waiting for it to spin up.
Fine for testing/demo; for the actual 12,000-panel fleet in production, this needs to be on a
paid tier that stays warm, same as the MDM backend does.
