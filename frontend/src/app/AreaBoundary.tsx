import { ArrowClockwise, WarningCircle } from "@phosphor-icons/react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui";

const RELOAD_KEY = "spa:chunk-reload";

/** A stale or failed code-split chunk (e.g. after a redeploy, or a dev re-optimise). */
function isChunkError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically/i.test(msg);
}

/** Catches render errors in a role area so one failure never blanks the whole app. Chunk-load errors reload once. */
export class AreaBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isChunkError(error)) {
      // Reload at most once per 10 s, so a chunk that keeps failing shows the fallback instead of looping.
      let recent = true;
      try {
        recent = Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) ?? 0) < 10_000;
        if (!recent) sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        /* storage unavailable: show the fallback */
      }
      if (!recent) window.location.reload();
      return;
    }
    console.error("Unhandled UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunk = isChunkError(this.state.error);
    return (
      <div role="alert" className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-surface p-6 text-center shadow-card">
        <span aria-hidden className="mx-auto mb-3 inline-flex size-12 items-center justify-center rounded-full bg-danger-bg text-danger">
          <WarningCircle size={24} />
        </span>
        <p className="font-heading text-base font-semibold">{chunk ? "A new version is available" : "Something went wrong on this page"}</p>
        <p className="mt-1 text-sm text-muted">
          {chunk ? "Reload to get the latest version of the app." : "Your data is safe. Reload the page to try again."}
        </p>
        <Button className="mt-5" icon={<ArrowClockwise />} onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </div>
    );
  }
}
