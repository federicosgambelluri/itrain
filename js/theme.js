/**
 * Tema chiaro, scuro o automatico.
 *
 * Tre stati e non due: "automatico" segue l'impostazione del sistema, ed e'
 * il default perche' chi tiene il telefono in chiaro di giorno e scuro di
 * sera non deve toccare nulla. Gli altri due forzano la scelta.
 *
 * L'attributo finisce su <html> e non su <body> perche' le variabili sono
 * definite su :root, e perche' cosi' vale anche per lo sfondo della pagina.
 */

const KEY = "itrain.theme";
export const MODES = ["auto", "light", "dark"];

export const LABELS = {
  auto: "tema automatico",
  light: "tema chiaro",
  dark: "tema scuro",
};

/** Colore della barra del browser, per stato del tema. */
const BAR = { light: "#f4f6fb", dark: "#0b1020" };

export function current() {
  try {
    const v = localStorage.getItem(KEY);
    return MODES.includes(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Quale dei due temi e' effettivamente in vigore adesso. */
export function resolved(mode = current()) {
  if (mode !== "auto") return mode;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function apply(mode = current()) {
  const root = document.documentElement;
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", BAR[resolved(mode)]);
  return mode;
}

export function set(mode) {
  try { localStorage.setItem(KEY, mode); } catch { /* ignorato */ }
  return apply(mode);
}

/** Passa allo stato successivo del ciclo automatico → chiaro → scuro. */
export function cycle() {
  const next = MODES[(MODES.indexOf(current()) + 1) % MODES.length];
  return set(next);
}

/**
 * Va applicato prima che la pagina si disegni, altrimenti si vede il tema
 * sbagliato per un istante.
 */
export function init(onSystemChange) {
  apply();
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (current() === "auto") {
      apply();
      onSystemChange?.();
    }
  });
}
