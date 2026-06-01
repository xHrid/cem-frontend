/**
 * main.js — Application Entry Point
 * ===================================
 * dependency order using the Mediator (App.js) and wires up feature modules.
 *
 * Pattern: Immediate Function / Init-Time Branching
 *
 * Load order matters:
 *   1. Core (EventBus, Config) — no deps
 *   2. Data (StorageAdapter, MasterData) — depend on core
 *   3. Services (Auth, Drive, Sync, Analysis) — depend on data
 *   4. Features (Map, Spots, Routes, Sites) — depend on services
 *   5. UI (Toast, Modals, Dashboards) — depend on everything above
 *   6. App.initApp() — mediator kicks everything off
 */

// ── Features (map must init before spots/routes) ────────────────────────
import { initMap }    from './features/MapManager.js';
import { initSpots }  from './features/SpotManager.js';
import { initRoutes } from './features/RouteManager.js';
import { initSites }  from './features/SiteManager.js';

// ── UI ──────────────────────────────────────────────────────────────────
import { initToast }          from './ui/Toast.js';
import { initModals }         from './ui/ModalManager.js';
import { initProjectUI }      from './ui/ProjectUI.js';
import { initAnalysis }       from './ui/AnalysisUI.js';
import { initJobsDashboard }  from './ui/JobsDashboard.js';
import { initSharingUI }     from './ui/SharingUI.js';

// ── App Mediator ────────────────────────────────────────────────────────
import { initApp } from './core/App.js';

/**
 * Bootstrap sequence — runs after DOM is fully parsed.
 * Each init function registers its own EventBus listeners
 * and sets up DOM bindings. No cross-module coupling.
 */
function bootstrap() {
    // 1. Map first — other features depend on the Leaflet instance
    initMap();

    // 2. Toast early — so all subsequent inits can show messages
    initToast();

    // 3. Modal manager — centralised open/close for all popups
    initModals();

    // 4. Feature modules
    initSpots();
    initRoutes();
    initSites();

    // 5. UI controllers
    initProjectUI();
    initAnalysis();
    initJobsDashboard();
    initSharingUI();

    // 6. App mediator — renders auth panel, wires storage/login buttons
    initApp();

    console.log('[CEM] All modules initialised.');
}

// Wait for DOM, then bootstrap
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    // DOM already parsed (e.g. module deferred execution)
    bootstrap();
}
