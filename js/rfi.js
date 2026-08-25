/**
 * Client ViaggiaTreno.
 *
 * ViaggiaTreno non manda l'header Access-Control-Allow-Origin, quindi il
 * browser rifiuta di consegnare la risposta al codice della pagina, anche se
 * i dati sono arrivati. Non e' un blocco di RFI: e' una regola del browser,
 * uguale per tutti i siti, e dalla pagina non e' aggirabile in alcun modo.
 * Serve percio' un intermediario che rifaccia la richiesta e riaggiunga
 * l'header mancante.
 *
 * Qui si usano solo proxy pubblici, per scelta: niente da configurare, niente
 * account. Il prezzo e' che nessuno di essi e' affidabile da solo. Misurato sul
 * campo, allorigins risponde circa una volta su tre. La contromisura e' una
 * catena: si prova un proxy dopo l'altro, si ricorda quale ha funzionato per
 * partire da quello la volta dopo, e se cadono tutti l'app ripiega
 * sull'orario statico avvisando l'utente.
 */

const BASE = "http://www.viaggiatreno.it/infomobilitamobile/resteasy/viaggiatreno";
const PREF_KEY = "itrain.proxy";
const TIMEOUT_MS = 9000;

/**
 * Per quanto tempo si evita un proxy che ha appena fallito.
 *
 * Senza questa memoria ogni richiesta ripercorre la catena da capo: con
 * quattro richieste lanciate insieme, e due proxy su quattro fuori servizio,
 * si arrivava a superare i due minuti prima di mostrare qualcosa. Bastano
 * pochi secondi di quarantena perche' le richieste parallele convergano
 * subito su quello che funziona.
 */
const COOLDOWN_MS = 60000;
const failedUntil = new Map();

/**
 * I proxy in ordine di preferenza iniziale.
 * `wrap` costruisce l'URL, `unwrap` riporta la risposta a JSON.
 */
const PROXIES = [
  {
    id: "jina",
    label: "r.jina.ai",
    wrap: (url) => "https://r.jina.ai/" + url,
    // Restituisce testo con un'intestazione ("Title:", "URL Source:",
    // "Markdown Content:") prima del corpo: si riparte dalla prima parentesi.
    unwrap: (text) => {
      const starts = [text.indexOf("["), text.indexOf("{")].filter((i) => i >= 0);
      if (!starts.length) throw new Error("nessun JSON nella risposta");
      return JSON.parse(text.slice(Math.min(...starts)).trim());
    },
  },
  {
    id: "allorigins-raw",
    label: "allorigins",
    wrap: (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
    unwrap: (text) => JSON.parse(text),
  },
  {
    id: "allorigins-get",
    label: "allorigins (get)",
    wrap: (url) => "https://api.allorigins.win/get?url=" + encodeURIComponent(url),
    unwrap: (text) => JSON.parse(JSON.parse(text).contents),
  },
  {
    id: "codetabs",
    label: "codetabs",
    wrap: (url) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url),
    unwrap: (text) => JSON.parse(text),
  },
];

/**
 * Ordine di tentativo: prima l'ultimo proxy che ha funzionato, poi gli altri,
 * saltando quelli in quarantena. Se sono tutti in quarantena si riprova
 * comunque: meglio un tentativo lento che nessun dato.
 */
function order() {
  let preferred = null;
  try {
    preferred = localStorage.getItem(PREF_KEY);
  } catch {
    /* storage non disponibile: si usa l'ordine di default */
  }
  const now = Date.now();
  const sorted = [...PROXIES.filter((p) => p.id === preferred),
                  ...PROXIES.filter((p) => p.id !== preferred)];
  const fresh = sorted.filter((p) => (failedUntil.get(p.id) ?? 0) < now);
  return fresh.length ? fresh : sorted;
}

function remember(id) {
  try {
    localStorage.setItem(PREF_KEY, id);
  } catch {
    /* ignorato */
  }
}

/** Stato dell'ultimo tentativo, mostrato in interfaccia. */
export const status = {
  proxy: null,
  ok: false,
  lastSuccess: null,
  lastError: null,
};

async function fetchThrough(proxy, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(proxy.wrap(url), {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { Accept: "*/*" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    if (!text.trim()) return [];        // fascia oraria senza treni: risposta valida
    return proxy.unwrap(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scarica un percorso dell'API provando i proxy in sequenza.
 * @throws se nessun proxy risponde
 */
export async function api(path) {
  const url = BASE + path;
  const errors = [];

  for (const proxy of order()) {
    try {
      const data = await fetchThrough(proxy, url);
      failedUntil.delete(proxy.id);
      remember(proxy.id);
      Object.assign(status, {
        proxy: proxy.label, ok: true,
        lastSuccess: Date.now(), lastError: null,
      });
      return data;
    } catch (err) {
      failedUntil.set(proxy.id, Date.now() + COOLDOWN_MS);
      errors.push(`${proxy.label}: ${err.message}`);
    }
  }

  Object.assign(status, { ok: false, lastError: errors.join(" · ") });
  throw new Error("nessun proxy raggiungibile — " + errors.join(" · "));
}

/* ------------------------------------------------------------------ *
 * Endpoint
 * ------------------------------------------------------------------ */

/** ViaggiaTreno vuole la data in formato JavaScript classico, non ISO. */
function stamp(date = new Date()) {
  const g = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
  const p = (n) => String(n).padStart(2, "0");
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const tz = `GMT${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
  return `${g} ${m} ${p(date.getDate())} ${date.getFullYear()} ` +
         `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} ${tz}`;
}

export function partenze(station, when = new Date()) {
  return api(`/partenze/${station}/${encodeURIComponent(stamp(when))}`);
}

export function arrivi(station, when = new Date()) {
  return api(`/arrivi/${station}/${encodeURIComponent(stamp(when))}`);
}

/** Dettaglio con tutte le fermate del treno, orari teorici e reali. */
export function andamentoTreno(origin, number, departureDate) {
  return api(`/andamentoTreno/${origin}/${number}/${departureDate}`);
}
