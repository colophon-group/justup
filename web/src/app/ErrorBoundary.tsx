import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Error details stay out of the public view and provider logs. */
  }
  render() {
    return this.state.failed ? (
      <main className="paper">
        <h1>This page could not load.</h1>
        <p>Your saved data remains with the service.</p>
        <button className="button dark" onClick={() => location.reload()}>
          Reload Justup
        </button>
        <p>
          <a href="/privacy.html">Privacy</a> · <a href="/usage.html">Usage</a>
        </p>
      </main>
    ) : (
      this.props.children
    );
  }
}
