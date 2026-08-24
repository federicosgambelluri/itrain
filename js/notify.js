/**
 * Avvisi di chiusura imminente.
 *
 * Un limite va detto chiaramente, perche' cambia le aspettative: senza un
 * server che le spedisca, le notifiche push a app chiusa non sono possibili.
 * Le push del web richiedono un mittente che parli con il servizio push del
 * browser, e questo progetto per scelta non ha backend.
 *
 * Quello che si puo' fare, e che copre l'uso reale, e' programmare gli avvisi
 * mentre l'app e' viva — in primo piano o in una scheda in secondo piano. Si
 * apre l'app prima di uscire di casa, si sceglie il passaggio a livello, e
 * l'avviso arriva al momento giusto.
 *
 * Su iPhone le notifiche funzionano solo se il sito e' stato aggiunto alla
 * schermata Home: e' una regola di Safari, non una scelta di questa app.
 */

const LEAD_KEY = "itrain.notify.lead";
const WATCH_KEY = "itrain.notify.watch";
const DEFAULT_LEAD_MIN = 5;

let timers = [];
let registration = null;

export function isSupported() {
  return typeof Notification !== "undefined";
}

export function permission() {
  return isSupported() ? Notification.permission : "unsupported";
}

/** Su iOS le notifiche esistono solo in modalita' app installata. */
export function needsInstall() {
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
                     window.navigator.standalone === true;
  return iOS && !standalone;
}

export async function requestPermission() {
  if (!isSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function useRegistration(reg) {
  registration = reg;
}

/* --------------------------- preferenze --------------------------- */

export function leadMinutes() {
  const v = Number(localStorage.getItem(LEAD_KEY));
  return Number.isFinite(v) && v >= 1 && v <= 30 ? v : DEFAULT_LEAD_MIN;
}

export function setLeadMinutes(n) {
  try { localStorage.setItem(LEAD_KEY, String(n)); } catch { /* ignorato */ }
}

export function watchedCrossing() {
  try { return localStorage.getItem(WATCH_KEY); } catch { return null; }
}

export function setWatchedCrossing(id) {
  try {
    if (id) localStorage.setItem(WATCH_KEY, id);
    else localStorage.removeItem(WATCH_KEY);
  } catch { /* ignorato */ }
}

/* --------------------------- consegna ----------------------------- */

async function show(title, body, tag) {
  const opts = {
    body, tag, renotify: true, lang: "it",
    icon: "icons/icon-192.png", badge: "icons/badge.png",
    vibrate: [180, 90, 180],
  };
  if (registration?.showNotification) {
    await registration.showNotification(title, opts);
  } else if (isSupported() && Notification.permission === "granted") {
    new Notification(title, opts);
  }
}

/* --------------------------- pianificazione ----------------------- */

export function clear() {
  timers.forEach(clearTimeout);
  timers = [];
}

/**
 * Programma gli avvisi per un PL.
 *
 * Si riprogramma da zero a ogni aggiornamento dei dati, cosi' un treno che
 * accumula ritardo sposta anche l'avviso invece di lasciarne uno sbagliato.
 *
 * @returns {number} quanti avvisi risultano programmati
 */
export function schedule(crossing, windows, now = Date.now()) {
  clear();
  if (permission() !== "granted") return 0;

  const lead = leadMinutes() * 60 * 1000;
  let armed = 0;

  for (const w of windows) {
    const fireAt = w.close - lead;
    const delay = fireAt - now;
    // setTimeout oltre le ~24 giorni va in overflow; qui bastano poche ore
    if (delay <= 0 || delay > 6 * 60 * 60 * 1000) continue;

    const hhmm = new Date(w.close).toLocaleTimeString("it-IT",
      { hour: "2-digit", minute: "2-digit" });
    const treni = w.trains.map((t) => t.label).join(" e ");

    timers.push(setTimeout(() => {
      show(
        `${crossing.name}: si chiude alle ${hhmm}`,
        `Fra ${leadMinutes()} minuti passa ${treni}. ` +
        `Riapre verso le ${new Date(w.open).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.`,
        `pl-${crossing.id}-${w.close}`,
      );
    }, delay));
    armed++;

    if (armed >= 4) break;   // oltre e' rumore
  }

  return armed;
}

/** Notifica di prova, per verificare che i permessi funzionino davvero. */
export async function test(crossing) {
  await show(
    crossing ? `${crossing.name}: avvisi attivi` : "Avvisi attivi",
    `Riceverai un avviso ${leadMinutes()} minuti prima di ogni chiusura, ` +
    "finche' l'app resta aperta.",
    "itrain-test",
  );
}
