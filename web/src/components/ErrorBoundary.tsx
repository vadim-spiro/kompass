import { Component, type ReactNode } from "react";
import { reportIssue } from "../api/client";

/**
 * A screen that fails to render shows this note instead of blanking the whole app (navigation and the
 * bubble keep working). The error goes to the server log as scope "web:render".
 */
export class ErrorBoundary extends Component<{ children: ReactNode; full?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportIssue("error", "web:render", error.message, { page: location.pathname, stack: (error.stack ?? "").slice(0, 1500), component: (info.componentStack ?? "").slice(0, 800) });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.full ? "grid min-h-screen place-items-center bg-[#f4f5f7] p-6" : "grid flex-1 place-items-center p-6"}>
        <div className="max-w-md rounded-2xl border border-ink-200 bg-white p-6 text-center shadow-sm">
          <div className="text-[15px] font-semibold text-ink-900">This screen ran into a problem</div>
          <p className="mt-1.5 text-[13px] text-ink-500">The rest of Kompass still works. Try again, or open another page from the left.</p>
          <div className="mt-4 flex justify-center gap-2">
            <button onClick={() => this.setState({ error: null })} className="rounded-lg bg-navy-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-navy-800">
              Try again
            </button>
            <button onClick={() => location.reload()} className="rounded-lg px-3.5 py-2 text-[13px] font-medium text-ink-700 ring-1 ring-ink-200 hover:bg-ink-50">
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
