import { Application, type ApplicationOptions } from "pixi.js";
import { useEffect, type DependencyList, type RefObject } from "react";

// Generic Pixi canvas host: owns the Application's create/init/mount/destroy
// lifecycle (including the StrictMode double-effect guard) so callers only
// supply what to draw. Extracted from PixiReadout, which used to inline this
// alongside its readout content — the seam phase 1's real island scene reuses.
//
// `init` computes this mount's ApplicationOptions (may be async — e.g. to
// await font preloading, or to size the canvas off loaded world data) and
// runs before the canvas exists. `build` runs once the canvas is mounted and
// owns everything live after that (drawing, the ticker); its behavior is
// unconstrained by this hook.
export function useIslandScene(
  hostRef: RefObject<HTMLDivElement | null>,
  init: () => Promise<Partial<ApplicationOptions>>,
  build: (app: Application) => void,
  deps: DependencyList,
): void {
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let disposed = false;
    const app = new Application();
    // Set only once init resolves — the destroy gate. app.renderer is `undefined` (not
    // null) pre-init, so destroying on it would tear down a half-built app and then
    // Pixi's second destroy() throws on the double free.
    let live: Application | null = null;

    void (async () => {
      const options = await init();
      if (disposed) return;

      await app.init(options);
      // StrictMode runs the effect twice in dev; the first pass may have been torn down
      // before init resolved. Bail without touching the DOM.
      if (disposed) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);
      live = app;

      build(app);
    })().catch((error: unknown) => {
      if (disposed) return;
      host.textContent = `Pixi init failed: ${String(error)}`;
    });

    return () => {
      disposed = true;
      // ticker.remove is unnecessary — destroy() tears down the app's own ticker
      // (sharedTicker: false by default).
      if (live !== null) live.destroy(true);
    };
  }, deps);
}
