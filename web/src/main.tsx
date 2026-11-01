import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { ErrorBoundary } from './app/ErrorBoundary.tsx';
import { InterfacePresentation } from './public/InterfacePresentation.tsx';
import type { PublicBootstrap } from './public/bootstrap.ts';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
const serialized = document.getElementById('public-bootstrap')?.getAttribute('data-public');
const initialPublicPage: PublicBootstrap | undefined = serialized ? JSON.parse(serialized) as PublicBootstrap : undefined;
const app = <StrictMode><InterfacePresentation initialPublicPage={initialPublicPage}><ErrorBoundary>
  <App initialPublicPage={initialPublicPage} />
</ErrorBoundary></InterfacePresentation></StrictMode>;
if (initialPublicPage) hydrateRoot(root, app);
else createRoot(root).render(app);
