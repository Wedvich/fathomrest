import { createContext, useContext, useEffect, useState } from "react";

import { createSimSession, type SimSession } from "../sim/session.ts";

const SimSessionContext = createContext<SimSession | null>(null);

// Creates the session once on mount (null until the async load resolves) and disposes
// it on unmount. StrictMode's double effect creates a throwaway first session; it is
// disposed before it ever saves, and the epoch guard in persistence.ts protects the
// store regardless.
export function SimSessionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [session, setSession] = useState<SimSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: SimSession | null = null;
    createSimSession().then(
      (s) => {
        if (cancelled) {
          s.dispose();
          return;
        }
        created = s;
        setSession(s);
      },
      (e: unknown) => {
        if (!cancelled) setError(String(e));
      },
    );
    return () => {
      cancelled = true;
      created?.dispose();
      setSession(null);
    };
  }, []);

  if (error !== null) return <p>Failed to start the sim: {error}</p>;
  return <SimSessionContext.Provider value={session}>{children}</SimSessionContext.Provider>;
}

export function useSimSession(): SimSession | null {
  return useContext(SimSessionContext);
}

// Coarse re-render driver for React readouts: bumps on every acted command
// (event-driven) and on a ≥250 ms interval for drifting live numbers — never per
// frame (docs/browser-performance.md). Returns a counter purely to invalidate the
// caller; read values from the session inside render.
export function useSimTick(intervalMs = 250): number {
  const session = useSimSession();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (session === null) return;
    const bump = (): void => setTick((v) => v + 1);
    const unsubscribe = session.subscribe(bump);
    const id = window.setInterval(bump, Math.max(250, intervalMs));
    return () => {
      unsubscribe();
      window.clearInterval(id);
    };
  }, [session, intervalMs]);

  return tick;
}
