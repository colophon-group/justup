// Local source fixture for account/default locale transitions without adding a product test hook.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { parseInterfaceLocale } from '../../web/src/i18n/locales.ts';
import { readRoute, explicitRouteLocale } from '../../web/src/app/useRoute.ts';
const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export async function localeSeam() {
  const vite = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], resolve: { dedupe: ['react', 'react-dom'] }, optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] }, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
  return async (req, res) => {
    const url = new URL(req.url, 'http://fixture.test');
    if (url.searchParams.has('__locale_seam')) {
      const { render } = await vite.ssrLoadModule('/tests/browser/locale-seam.server.tsx');
      const explicitLocale = explicitRouteLocale(url.pathname);
      const route = readRoute(url.pathname);
      const seed = parseInterfaceLocale(url.searchParams.get('seed'));
      const bootstrap = { route: seed ? { ...route, locale: seed } : route, ...(explicitLocale ? { explicitLocale } : {}), renderedAt: '2026-11-01T00:00:00Z', outcome: 'ready' };
      const initial = url.searchParams.has('withoutBootstrap') ? undefined : bootstrap;
      const html = await vite.transformIndexHtml(req.url, `<!doctype html><html lang="${bootstrap.route.locale}"><head><title>Locale boundary fixture</title></head><body><div id="root">${initial ? render(initial) : ''}</div>${initial ? `<template id="fixture-bootstrap" data-public="${escape(JSON.stringify(initial))}"></template>` : ''}<script type="module" src="/tests/browser/locale-seam.client.tsx"></script></body></html>`);
      // This fixture has HMR disabled and is served by its outer HTTP adapter.
      // Omit Vite's injected development socket client; retain all React errors.
      const staticHtml = html.replace(/<script\b[^>]*\bsrc="\/@vite\/client"[^>]*><\/script>/u, '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(staticHtml); return true;
    }
    if (/^\/(?:@|node_modules\/|web\/src\/|tests\/browser\/locale-seam)/.test(url.pathname)) {
      await new Promise(resolve => { res.once('finish', resolve); res.once('close', resolve); vite.middlewares(req, res, () => { res.writeHead(404); res.end('Not found'); }); }); return true;
    }
    return false;
  };
}
