/**
 * Calibrazione sul campo.
 *
 * Il preavviso di chiusura di partenza — circa 2 minuti e mezzo — e' un valore
 * di targa RFI, valido in generale ma non necessariamente per un singolo PL:
 * dipende da dove sta il circuito di binario che comanda la chiusura, e ogni
 * impianto ha il suo. L'unico modo di saperlo davvero e' misurarlo.
 *
 * Da qui i due tasti: quando si e' fermi davanti alle sbarre si segnala il
 * momento in cui sono scese e quello in cui sono risalite. L'app confronta con
 * il transito previsto e ricava il preavviso reale di quel PL, che sostituisce
 * il valore di targa nelle previsioni successive.
 *
 * Tutto resta nel browser, in localStorage: non c'e' nessun database e nessun
 * dato lascia il telefono. Il rovescio della medaglia e' che la calibrazione
 * e' personale; `exportAll` serve a passarla al repo per condividerla.
 */

const KEY = "itrain.calibration";

/** Confini di plausibilita': fuori di qui la segnalazione e' un errore di tocco. */
const BOUNDS = {
  close: [20, 600],   // il preavviso reale sta fra 20 s e 10 minuti
  open: [0, 300],     // la riapertura arriva entro pochi minuti dal transito
};

/** Sotto questo numero di osservazioni si continua a usare il valore di targa. */
const MIN_SAMPLES = 2;

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

function writeAll(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;   // navigazione privata o storage pieno
  }
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Registra un'osservazione.
 *
 * @param {string} crossingId
 * @param {"close"|"open"} kind
 * @param {object} window la finestra prevista a cui si riferisce
 * @param {number} at istante osservato
 * @returns {{ok:boolean, reason?:string, lead?:number, samples?:number}}
 */
export function record(crossingId, kind, window, at = Date.now()) {
  if (!window?.pass) return { ok: false, reason: "nessuna previsione a cui riferirsi" };

  // il preavviso e' la distanza fra l'evento osservato e il transito previsto
  const lead = kind === "close"
    ? (window.pass - at) / 1000
    : (at - window.pass) / 1000;

  const [lo, hi] = BOUNDS[kind];
  if (!(lead >= lo && lead <= hi)) {
    return {
      ok: false,
      reason: kind === "close"
        ? "il transito previsto e' troppo lontano: probabilmente si riferisce a un altro treno"
        : "la riapertura non sembra legata al transito previsto",
      lead: Math.round(lead),
    };
  }

  const all = readAll();
  const entry = all[crossingId] ?? { close: [], open: [] };
  entry[kind].push(Math.round(lead));
  // si tengono le venti piu' recenti: se l'impianto cambia, il modello segue
  entry[kind] = entry[kind].slice(-20);
  all[crossingId] = entry;

  if (!writeAll(all)) return { ok: false, reason: "memoria del browser non disponibile" };
  return { ok: true, lead: Math.round(lead), samples: entry[kind].length };
}

/**
 * Correzioni da applicare a un PL, oppure null se le osservazioni non bastano.
 *
 * Si usa la mediana e non la media: un solo tocco sbagliato, o un treno
 * merci non in orario, sposterebbe la media e non la mediana.
 */
export function forCrossing(crossingId) {
  const entry = readAll()[crossingId];
  if (!entry) return null;

  const out = { samples: { close: entry.close.length, open: entry.open.length } };
  if (entry.close.length >= MIN_SAMPLES) out.leadClose = median(entry.close);
  if (entry.open.length >= MIN_SAMPLES) out.leadOpen = median(entry.open);
  return out.leadClose == null && out.leadOpen == null ? out : out;
}

/** Quante osservazioni servono ancora prima che la calibrazione entri in gioco. */
export function progress(crossingId) {
  const c = forCrossing(crossingId);
  const close = c?.samples?.close ?? 0;
  const open = c?.samples?.open ?? 0;
  return {
    close, open,
    missing: Math.max(0, MIN_SAMPLES - close),
    active: close >= MIN_SAMPLES || open >= MIN_SAMPLES,
    leadClose: c?.leadClose ?? null,
    leadOpen: c?.leadOpen ?? null,
  };
}

/** Annulla l'ultima osservazione: serve subito dopo un tocco per sbaglio. */
export function undo(crossingId, kind) {
  const all = readAll();
  const entry = all[crossingId];
  if (!entry?.[kind]?.length) return false;
  entry[kind].pop();
  return writeAll(all);
}

export function reset(crossingId) {
  const all = readAll();
  if (crossingId) delete all[crossingId];
  else return writeAll({});
  return writeAll(all);
}

/** Tutte le osservazioni, per condividerle o metterle nel repo. */
export function exportAll() {
  return JSON.stringify(
    { exported: new Date().toISOString(), version: 1, calibration: readAll() },
    null, 2);
}

export function importAll(json) {
  try {
    const parsed = JSON.parse(json);
    const data = parsed.calibration ?? parsed;
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("formato non valido");
    return writeAll({ ...readAll(), ...data });
  } catch {
    return false;
  }
}
