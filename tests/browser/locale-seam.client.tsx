import { createRoot, hydrateRoot } from 'react-dom/client';
import { Scenario } from './locale-seam.tsx';
const root = document.getElementById('root')!;
const data = document.getElementById('fixture-bootstrap')?.getAttribute('data-public');
const initialPublicPage = data ? JSON.parse(data) : undefined;
if (initialPublicPage) hydrateRoot(root, <Scenario initialPublicPage={initialPublicPage} />);
else createRoot(root).render(<Scenario />);
