// Pixi v8 Text renders through the browser font system and won't re-layout when a
// face loads later, so decode every UI face before the first Text is built — fonts.css
// only declares them. Callers treat a rejection as non-fatal: the fontFamily fallbacks
// still render. Playpen Sans is a single variable file (wght 100–800), so one load
// covers every weight.
export async function preloadUiFonts(): Promise<void> {
  await Promise.all([
    document.fonts.load('16px "Coming Soon"'),
    document.fonts.load('16px "Caveat Brush"'),
    document.fonts.load('16px "Playpen Sans"'),
  ]);
}
