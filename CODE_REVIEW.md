# CEM Frontend — Code Review

Vanilla-JS SPA (~15k LOC, no framework/build step). Architecture is clean: EventBus + Module pattern, clear core/data/services/features/ui layering, good doc comments. Findings below, worst first. Severity: 🔴 bug / data-loss · 🟠 race · 🟡 edge case · 🔵 perf/optimality · ⚪ dead/inconsistent.

## 🔴 Critical — data correctness

**1. Three divergent merge functions → lost edits.**
`SyncService.mergeDatasets._mergeArray` versions items by `max(timestamp, updated_at)`. But `SharingService._mergeArray` and `Repository._mergeItemArray` (shared/imported project sync + push) version by **`timestamp` only**. `updateSpot()` records an edit by bumping `updated_at` (deliberately *not* `timestamp`). Result: on a shared/imported project, editing a spot's notes/photos is **silently dropped** on the next merge, because the merge can't see `updated_at`. Fix: one shared merge helper using `max(timestamp, updated_at)` everywhere.

**2. Observation dates get corrupted.**
Because of #1, `SharedMediaSync._recordDriveId` and `SharingService._setMediaDriveId` deliberately bump `spot.timestamp = now` to force the drive_id to survive a merge. `timestamp` is the *displayed observation date*. So syncing media silently rewrites when the observation "happened". Root cause is #1; fixing the merges to honor `updated_at` lets these stamp `updated_at` instead and stop corrupting the date.

**3. Deletions don't propagate (no tombstones).**
All merges are id-keyed unions, so an item deleted on one device/collaborator is resurrected from the other side on the next sync (`mergeDatasets`, all `SharingService` merges, `Repository._mergeItemArray`). Delete a spot → collaborator still has it → it comes back. Needs soft-delete tombstones (e.g. `deleted_at`) honored by the merges. (The interactive `SyncDiffUI` lets you discard manually, but automatic shared-project sync still resurrects.)

**4. COG proxy host allowlist mismatch → stratification breaks via proxy.**
`StratificationService` fetches from host `data.source.coop` (`SOURCE_COOP_BASE`). The Worker's `ALLOWED_HOSTS` lists `us-west-2.opendata.source.coop` and `storage.googleapis.com` but **not** `data.source.coop`. With `Config.proxy.workerUrl` set, every `/cog?url=…` returns 403 and stratification fails. Add `data.source.coop` to the allowlist (or align the base URL).

**5. Stored XSS in Jobs CSV preview.**
`JobsDashboard._previewFile` escapes the text/log/JSON path via `_escapeHtml`, but the CSV branch injects each cell raw: `` `<${tag} …>${col}</${tag}>` ``. A result CSV from the analysis server or a collaborator's shared job can carry HTML/script. Escape `col` (and ideally use textContent).

## 🟠 Race conditions

**6. `StorageAdapter._openDB` not in-flight-guarded.** It caches the resolved `_dbInstance` but not the pending promise. Two concurrent first calls each run `indexedDB.open`; the second overwrites `_dbInstance`, leaking the first connection. Cache the promise, not just the result (the pattern `DriveService.findOrCreateRootFolder` already uses correctly).

**7. `AuthService.ensureValidToken` concurrent refresh.** Two simultaneous expired-token callers each wrap `tokenClient.callback` and each call `requestAccessToken`. The chained callback-restore happens to work but is fragile and fires two token requests. Dedupe with a single shared in-flight refresh promise.

## 🟡 Edge cases

**8. Spots saved at (0, 0).** `SpotManager._handleSpotFormSubmit` takes `getCurrentPosition()` which returns `{0,0}` before any GPS fix, with no guard. With "use current location" checked and no fix, you save a "null island" spot. Validate for a real fix (or 0,0).

**9. Route recording survives a project switch.** `RouteManager._isTracking` stays true across `PROJECT_CHANGED`; `_onLocationFound` keeps appending, so a walk started in project A can be saved into project B with mixed points.

**10. `StorageAdapter.deleteFile` (IDB branch) contract break.** On error it `reject`s the inner promise (uncatchable by the surrounding `try`) instead of resolving `false` like the native-FS branch and the documented `Promise<boolean>`.

**11. `ServerUploadService.uploadAudioFiles` overcounts.** Files that fail `getFileBlob` are `continue`d (not appended to FormData) but still counted in `uploaded += batch.length`.

**12. SiteManager stratification not persisted / wrong field.** Header says overlays are "saved to the site record for persistence" but they live only in the in-memory `_overlays` Map (lost on reload). Also the form passes the cluster *count* (a number) into `Repository.saveSite(…, clusters)`, which stores it as the site's `clusters` data field.

## 🔵 Optimality

**13. Full Leaflet layer rebuilds on every `DATA_UPDATED`.** `displaySpots`/`displayRoutes` tear down and recreate all markers. `DATA_UPDATED` fires very frequently during sync (each drive_id stamp re-emits it). Diff/update in place, or debounce.

**14. `StorageAdapter.revokeObjectUrls()` is global.** It revokes *every* tracked object URL app-wide. Closing the spot panel can invalidate media still shown elsewhere; conversely, on repeated `_showSpotDetails` re-renders, URLs accumulate until the next global revoke. Track/revoke per view.

**15. `listAllDriveFiles` per-file in `syncUp`.** Each `syncUp` does a full recursive Drive scan; `syncBatch` loops it → O(n) full listings. (Only reachable via the dead `SyncDashboard` — see #16 — so currently latent.)

## ⚪ Dead code / inconsistencies

- **`SyncDashboard.js` (516 lines) is never imported** — `main.js` doesn't wire it. It's the sole consumer of `SyncService.generateSyncReport`, `getAllProjectsSyncStatus`, `syncBatch`, `syncUp`, `syncDown`, so that whole API is effectively dead (SyncEngine + SharedMediaSync replaced it). Either delete or re-wire.
- **`MediaSlot.js` is empty** (one blank line), not imported.
- **`ProjectUI._initConflictModal/_openConflictModal`** legacy, superseded by `SyncDiffUI`; kept but never opened.
- **Duplication:** `_fmtBytes` in both `App.js` and `StorageGC.js`; `_mergeArray`/`_mergeItemArray`/`_ver` reimplemented 3×.
- **`StratificationService` imports `showToast` but never uses it.**
- **`share-project-dialog` / `import-project-dialog` not in `ModalManager._knownModalIds`** → no backdrop-click-to-close wiring (ESC still works via native `<dialog>`).
- **Doc/impl drift:** `MapManager._startGeolocation` describes a one-shot high-accuracy seed it doesn't do; `StratificationService.findCog` JSDoc says it returns `utmBbox` but returns `zone`.
- **Brittle checks:** `ServerUploadService.checkProjectFiles` detects 404 via `e.message.includes('404')`; `calculateCacheOverlap` lets files without a `_YYYYMMDD_` name bypass the date filter; `kMeans` seeding uses unseeded `Math.random()` (nondeterministic results per run).

## Notable good practices
Idempotent Drive upserts with pending-promise guards (`upsertFile`, `findOrCreateRootFolder`, `ensureDrivePath`); `EventBus` isolates subscriber errors; quota errors mapped to friendly messages; most user content rendered via `textContent`; sync mutex uses try/finally; `SyncDiffUI` deterministic stable-stringify diff. The cross-account `drive.file` sharing model is genuinely tricky and the comments document the constraints well.
