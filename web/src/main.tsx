import { InterfaceLocaleProvider } from "./i18n/LocaleProvider.tsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { ErrorBoundary } from "./app/ErrorBoundary.tsx";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
createRoot(root).render(
  <StrictMode>
    <InterfaceLocaleProvider><ErrorBoundary>
      <App />
    </ErrorBoundary></InterfaceLocaleProvider>
  </StrictMode>,
);
