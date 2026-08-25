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
  resetStates(crossingId);
  const all = readAll();
  if (crossingId) delete all[crossingId];
  else return writeAll({});
  return writeAll(all);
}

/* ------------------------------------------------------------------ *
 * Conferme di stato
 * ------------------------------------------------------------------ *
 *
 * Diverse dalle osservazioni di transizione qui sopra, e utili per un'altra
 * ragione. Segnare l'istante in cui le sbarre scendono misura il preavviso,
 * ma richiede di trovarsi li' nel momento esatto. Dire "adesso e' chiuso"
 * invece si puo' sempre: basta guardare.
 *
 * Non alimentano il modello, e non e' una dimenticanza. Una conferma dice
 * che a un certo istante la sbarra era giu', non quando e' scesa: e' un
 * limite, non una misura, e mescolarlo alle misure vere sposterebbe la
 * mediana in modo scorretto. Servono invece a dire quanto la previsione ci
 * azzecca, e a segnalare uno scarto sistematico quando c'e'.
 */

const STATE_KEY = "itrain.confirmations";

/** Oltre questo numero le piu' vecchie si scartano. */
const MAX_CONFIRMATIONS = 40;

/** Sotto questo numero di conferme non si parla di scarto sistematico. */
const MIN_FOR_BIAS = 3;

function readStates() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
  } catch {
    return {};
  }
}

/** L'app, in questo istante, sta dicendo che e' chiuso? */
function saysClosed(predicted) {
  return predicted === "closed";
}

/**
 * Registra una conferma di stato.
 *
 * @param {string} crossingId
 * @param {"closed"|"open"} actual  quello che l'utente vede
 * @param {string} predicted        lo stato che l'app stava mostrando
 */
export function recordState(crossingId, actual, predicted, at = Date.now()) {
  const all = readStates();
  const list = all[crossingId] ?? [];
  list.push({ t: at, a: actual, p: predicted });
  all[crossingId] = list.slice(-MAX_CONFIRMATIONS);
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(all));
  } catch {
    return { ok: false, reason: "memoria del browser non disponibile" };
  }
  return { ok: true, ...accuracy(crossingId), agreed: saysClosed(predicted) === (actual === "closed") };
}

/**
 * Quanto la previsione ci azzecca su questo passaggio a livello.
 *
 * `chiusoInAnticipo` conta le volte in cui era gia' chiuso mentre l'app lo
 * dava aperto: se capita spesso, il preavviso reale e' piu' lungo di quello
 * che stiamo usando. `apertoInRitardo` e' il caso opposto.
 */
export function accuracy(crossingId) {
  const list = readStates()[crossingId] ?? [];
  let hits = 0;
  let chiusoInAnticipo = 0;
  let apertoInRitardo = 0;
  for (const r of list) {
    const detto = saysClosed(r.p);
    const visto = r.a === "closed";
    if (detto === visto) hits++;
    else if (visto) chiusoInAnticipo++;
    else apertoInRitardo++;
  }
  const n = list.length;
  const bias = n >= MIN_FOR_BIAS && chiusoInAnticipo >= Math.max(2, n * 0.6)
    ? "anticipo"
    : n >= MIN_FOR_BIAS && apertoInRitardo >= Math.max(2, n * 0.6)
      ? "ritardo"
      : null;
  return { n, hits, chiusoInAnticipo, apertoInRitardo, bias };
}

/** Annulla l'ultima conferma: serve subito dopo un tocco per sbaglio. */
export function undoState(crossingId) {
  const all = readStates();
  if (!all[crossingId]?.length) return false;
  all[crossingId].pop();
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function resetStates(crossingId) {
  const all = readStates();
  if (crossingId) delete all[crossingId];
  try {
    localStorage.setItem(STATE_KEY, crossingId ? JSON.stringify(all) : "{}");
  } catch { /* ignorato */ }
}

export function exportStates() {
  return readStates();
}

/** Tutte le osservazioni, per condividerle o metterle nel repo. */
export function exportAll() {
  return JSON.stringify({
    exported: new Date().toISOString(),
    version: 2,
    calibration: readAll(),      // transizioni: misurano il preavviso
    confirmations: readStates(), // conferme di stato: misurano la precisione
  }, null, 2);
}

export function importAll(json) {
  try {
    const parsed = JSON.parse(json);
    const data = parsed.calibration ?? parsed;
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("formato non valido");
    const ok = writeAll({ ...readAll(), ...data });
    if (parsed.confirmations && typeof parsed.confirmations === "object") {
      try {
        localStorage.setItem(STATE_KEY,
          JSON.stringify({ ...readStates(), ...parsed.confirmations }));
      } catch { /* ignorato */ }
    }
    return ok;
  } catch {
    return false;
  }
}

