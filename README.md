# RailSaathi 0.2 — shared live position snapshots

This source update builds on the working 0.1 demo. It implements 15-second moving-train sharing, 10-second viewer refreshes, public position snapshots, primary/backup contributors and shorter prediction. No backend has been deployed by this update. No new APK is included or locally compiled. The previous 0.1 APK still uses the old protocol and must be replaced with a 0.2 build for testing this implementation.

## Behavior

- Android collects precise GPS about every five seconds through an explicitly started foreground location service. The operating system may delay delivery.
- One primary contributor uploads approximately every 15 seconds while moving. Extra contributors report every 60 seconds as backups and corroboration. This implementation admits at most 20 contributors per journey; public automatic admission is future work.
- The backend elects the primary using an atomic database lease. Its moving lease is 45 seconds; its stationary lease is 90 seconds. A backup next attempts promotion on its heartbeat. Unexpected primary loss therefore produces a gap; failover is not immediate. A clean online Stop releases the lease immediately.
- After two good low-speed, nearby fixes the primary switches to 60-second uploads. A new measured speed above 2 m/s permits returning to 15-second uploads. This is an initial heuristic, not a railway stop detector.
- The backend validates accepted GPS, updates a bounded latest observation per contributor, increments a journey revision and publishes a small JSON snapshot immediately. Every accepted backup heartbeat also publishes a revised aggregate.
- Viewers fetch `/live/TRAIN_DATE.json` directly from the R2 custom domain when configured. These viewer requests bypass the Worker and D1. Only initial journey lookup uses the API.
- A five-second cache policy is supplied on snapshots. The app uses ordinary HTTP caching without unique query parameters. Actual CDN behavior must be verified after owner setup.
- The app continuously animates locally; it predicts at most 30 seconds beyond a GPS timestamp, then freezes. A moving report becomes stale after 45 seconds and lost after two minutes. A low-speed stationary report becomes stale after 90 seconds.
- Cached snapshots do not synchronize the device clock. Clock offset is established from the uncached journey lookup. Cached files retain their original GPS timestamp; revision rollback is ignored.
- A stale/conflicting snapshot can remove the current position. The marker never invents unknown speed or heading. Snapping uses optional organiser-supplied, correctly oriented route geometry; nationwide railway routes and a verified train catalogue are not included.
- Viewer polling pauses when the document is hidden, prevents overlapping fetches and backs off during outages. Foreground Android contribution continues separately. Browser contribution requires an open page.
- Android session expiry/revocation stops sharing. Contributions require consent, a precise-location grant and a persistent foreground notification. Force-stop ends contribution.

Typical good-network freshness target is roughly 10–30 seconds, subject to GPS sampling, upload, CDN age and viewer polling. This is not a latency guarantee. Screen-off behavior, battery use, CDN cache behavior and real train journeys remain unverified.

## Run locally

Use Node.js 22.13 or newer (tests use the built-in SQLite module; Node 24 was used here).

```sh
npm test
```

Set `ADMIN_KEY` to a new long random value in your shell, then:

```sh
npm start
node scripts/create-trip.mjs http://localhost:8787 12915 2026-10-02 "Pilot journey"
```

Open http://localhost:8787 in two tabs. Enter the actual train number and journey-start date. One tab contributes using the generated private contributor code, the other watches. Local browser geolocation works on localhost. LAN HTTP geolocation is restricted by browsers; native Android intentionally accepts HTTPS backends only.

The local backend publishes snapshots into memory, with shared five-second HTTP cache headers. This tests the protocol, not Cloudflare's CDN. Local state persists in `backend/local-data.json`, which is excluded from the distributable. Do not use the local developer server as an unattended production service.

## Owner deployment: Worker + D1 first

These commands require your own Cloudflare account, network access and Wrangler. No administrator secret belongs in the app or source repository.

```sh
npx wrangler login
npx wrangler d1 create railsaathi
```

Set the returned database ID in `wrangler.jsonc`.

```sh
npx wrangler d1 execute railsaathi --remote --file=backend/schema.sql
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

Existing 0.1 databases can run the same schema: it adds the `live_leases` table without dropping data. Old journeys without a revision are treated as revision zero. Drain old contributor sessions before switching protocols because the old APK will continue at its old cadence.

At this stage viewers use `/snapshots/TRAIN_DATE.json` on the Worker. It is a functional pilot fallback, but still consumes Worker requests and database reads. It does not provide the intended production cost reduction by itself.

## Owner deployment: direct public snapshots

1. Enable R2 in your Cloudflare account. It has monthly included usage followed by billable overage. Do not treat it as a hard free spending cap. Domain registration may also cost money.
2. Create a dedicated bucket containing ONLY public aggregate snapshots:

```sh
npx wrangler r2 bucket create railsaathi-positions
```

3. Use `wrangler.snapshots.example.jsonc` as your `wrangler.jsonc`, supplying the existing D1 database ID and your real `SNAPSHOT_BASE_URL`. Bind the bucket as `SNAPSHOTS`.
4. In the bucket settings attach a public custom domain, such as `positions.yourdomain.in`, under a zone in the same account. The URL must resolve directly to R2, with no Worker route/proxy on that hostname. Do not rely on `r2.dev` for production.
5. Set the bucket dashboard CORS policy from `r2-cors.dashboard.json`. It permits public GET/HEAD, including Android's bundled WebView origin. Never place private tokens or per-passenger histories in this bucket. Changing CORS may require purging already-cached objects.
6. Add a Cache Rule matching your snapshot hostname and `/live/` path: mark responses eligible for cache, respect the origin Cache-Control for edge TTL, and respect origin browser TTL. Avoid overriding TTL to minutes/hours or serving expired objects through stale-on-error features. The snapshot header is `public, max-age=5, s-maxage=5, must-revalidate`. JSON needs explicit cache eligibility.
7. Set an object lifecycle to delete `live/` objects one day after their last modification as a safety net for failed cleanup. The application cleanup also removes expired-journey objects.
8. Redeploy, create a pilot journey and begin sharing. For an existing journey an accepted upload triggers initial publication.
9. Verify an actual object:

```sh
node scripts/check-snapshots.mjs https://positions.yourdomain.in/live/12915_2026-10-02.json
```

Look for successful JSON, public CORS, a short cache lifetime and a subsequent `CF-Cache-Status: HIT` where the edge caches the response. Confirm in browser network tools that viewer refreshes target the snapshot hostname, with no repeated `/api/state` requests. Check account metrics to ensure viewer traffic does not invoke the Worker. Missing HIT, long-lived GPS timestamps, a Worker route on that hostname, or missing CORS blocks scaling the beta until resolved.

There is no silent fallback from a failing production CDN URL to repeated database queries. Viewers retain their last report, show its age and back off. Accepted GPS remains accepted if publication fails; the contribution response reports `snapshotPublished:false`. The next valid upload retries publication. A failed Stop publication relies on subsequent uploads/cleanup and the client's two-minute report expiry.

## No end-user connection setup

After the backend address is known, set `BACKEND_URL` in `web/config.mjs` to that HTTPS URL and build the app. A configured build hides connection settings and ignores any previously stored backend override. This requires owner setup once. The distributed app then connects automatically.

There are still no observer accounts. The controlled pilot still requires organiser-created journeys and contributor codes. Removing those codes, adding automatic journey creation and a verified train catalogue are separate roadmap phases; this update does not claim they are complete.

## Android build

Open `android` in Android Studio, or upload the complete project including `.github/workflows/android.yml` to GitHub and run **Build Android test APK**. The workflow uses JDK 17, Android SDK and Gradle 8.11.1.

```sh
gradle -p android assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`. Version code is 2 and version name is 0.2.0. Debug signing is for tests only. A newly generated debug key may require uninstalling the prior demo APK; that clears app data. Retain a stable release key before distribution. This workspace had no Android SDK/Gradle, so Java changes have not been compiled or linted here.

## Free-tier pilot budget

The faster cadence changes the previous budget. One primary sharing for six moving hours sends about 1,440 updates/day, eight times the previous two-minute cadence. One backup sharing for six hours sends about 360 updates/day.

A conservative starting pilot is FIVE trains, each with one primary and one backup sharing six hours/day:

| Metric | Approximate workload |
|---|---:|
| Accepted contributor updates | 9,000/day |
| Logical D1 row writes | At least 36,000/day plus indexes, joining, cleanup and retries |
| Snapshot PUT operations | About 270,000 per 30-day month, before retries/initial creation |
| Viewers: 10,000/day × ten minutes × ten-second refresh | About 18 million snapshot downloads/month, before extra startup/long sessions |

Each accepted update now writes a lease for the primary, a session reservation, an observation and a revision. Standby attempts that fail to acquire a lease have different write accounting. These estimates deliberately use four logical writes per update; actual D1 row/index metrics must be measured.

Current documented allowances are Workers Free 100,000 requests/day, D1 Free 100,000 rows written/day and R2 Standard monthly free usage of one million Class A operations, ten million Class B operations and 10 GB-month storage. R2 cache misses and publisher reads consume operations; CDN hits can reduce origin reads but the hit rate is not guaranteed. The 18-million-download viewer example exceeds R2's free read allowance if all downloads miss cache. Do not promise 10,000 daily viewers for free before measuring the deployed CDN. GPS alone is tiny; map tile delivery is a separate capacity concern.

Record Worker requests, CPU errors, D1 rows read/written, R2 operations, cache-hit rate, location age, publication failures and actual contributor-hours during beta. Start with five trains and grow only against measured headroom. The existing free Worker CPU allowance is tight for route parsing, many contributors and aggregation; deployment testing must verify it.

## Privacy and correctness

Only latest observations are stored. Every five minutes the deployed cleanup deletes observations older than two minutes, increments affected journey revisions and republishes their aggregate without old positions. It deletes expired sessions/leases/journeys and public objects for expired journeys. With functioning scheduled jobs, an expired observation may remain stored for about seven minutes after receipt; provider logs/backups are separate. If cleanup/publication fails, storage retention is longer even though the client marks old GPS lost. The R2 lifecycle is a secondary retention safeguard, not an immediate deletion guarantee.

A successful online Stop removes that contributor's observation and republishes the aggregate. A cached edge may retain the previous aggregate for its remaining short TTL. Offline Stop stops collection locally; its last report ages out on clients. Consensus can identify inconsistent reports but does not prove a passenger boarded the claimed train. Pilot codes remain necessary until stronger public admission controls are designed.

Map rendering still uses standard OpenStreetMap tiles with visible attribution. No bulk/offline tile downloading is added. Donation-funded public tiles are not an unlimited production map backend; select an appropriate provider or fund self-hosting before broad growth. Licensed organiser-provided routes remain optional; the demo is synthetic.

## Validation performed

24 automated checks passed under Node 24, including core GPS validation, primary/backup cadence, SQLite lease election and revocation, stationary resumption, HTTP snapshot publication, original-timestamp aging, stale-revision rejection, racing R2 conditional publications, Worker API integration with a simulated R2 bucket, SQL cleanup, and bounded curved-route prediction. The optional DOM smoke test was skipped because its `linkedom` dependency was unavailable. No real R2/CDN request, Android build, real phone GPS test, battery measurement or nationwide load test was performed in this workspace. These checks establish the protocol and SQL behavior, not deployed production capacity.

## Next milestones

1. Owner deploys Worker/D1/R2 and verifies CORS, caching, five-second TTL and quotas.
2. Set the app's fixed backend URL and build the 0.2 APK.
3. Test with two phones: screen on/off, moving/stopped, network gap, permission denial and Stop.
4. Test three contributors: primary loss, backup promotion and conflicting GPS.
5. Measure latency, battery and real operation counts on a five-train beta.
6. Build verified train discovery and anonymous contributor admission, then expand coverage.

Official references checked for the snapshot implementation:
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/r2/buckets/public-buckets/
- https://developers.cloudflare.com/r2/buckets/cors/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- https://developers.cloudflare.com/cache/how-to/cache-rules/settings/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/
- https://operations.osmfoundation.org/policies/tiles/
