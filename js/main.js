import { initMap }    from './features/MapManager.js';
import { initSpots }  from './features/SpotManager.js';
import { initRoutes } from './features/RouteManager.js';
import { initSites }  from './features/SiteManager.js';

import { initToast }          from './ui/Toast.js';
import { initModals }         from './ui/ModalManager.js';
import { initProjectUI }      from './ui/ProjectUI.js';
import { initAnalysis }       from './ui/AnalysisUI.js';
import { initJobsDashboard }  from './ui/JobsDashboard.js';
import { initSharingUI }     from './ui/SharingUI.js';

import { initApp } from './core/App.js';

function bootstrap() {
    initMap();
    initToast();
    initModals();

    initSpots();
    initRoutes();
    initSites();

    initProjectUI();
    initAnalysis();
    initJobsDashboard();
    initSharingUI();

    initApp();

}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
