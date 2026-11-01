import { renderToString } from 'react-dom/server';
import { Scenario } from './locale-seam.tsx';
import type { PublicBootstrap } from '../../web/src/public/bootstrap.ts';
export function render(initialPublicPage: PublicBootstrap) { return renderToString(<Scenario initialPublicPage={initialPublicPage} />); }
