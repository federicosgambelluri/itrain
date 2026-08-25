/**
 * Costruzione dell'elenco treni su cui lavora il motore di previsione.
 *
 * La strategia e' pensata attorno all'inaffidabilita' dei proxy pubblici:
 * meno richieste si fanno, piu' spesso l'app funziona. Si procede a strati,
 * ognuno utile da solo e ognuno migliore del precedente.
 *
 *   strato 0  orario statico dell'area          zero rete, funziona sempre
 *   strato 1  partenze + arrivi sui nodi         2-4 richieste, da' i ritardi
 *   strato 2  andamentoTreno sui treni vicini    1-2 richieste, orari reali
 */

import { partenze, arrivi, andamentoTreno } from "./rfi.js";

/** "HH:MM" -> istante di oggi. */
function atTime(hhmm, ref) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(ref);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * Stazioni da cui leggere i ritardi.
 *
 * Non serve interrogarle tutte: bastano quelle da cui passa piu' traffico,
 * perche' il ritardo letto li' vale per i tratti adiacenti. Si ricavano
 * dall'orario stesso contando quante volte ogni stazione compare, cosi'
 * l'elenco si adatta da solo all'area caricata.
 */
export function pickHubs(area, n = 2) {
  const count = new Map();
  for (const t of area.trains) {
    for (const s of t.stops) count.set(s.s, (count.get(s.s) ?? 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([code]) => code);
}

/**
 * Treni previsti oggi secondo l'orario statico dell'area.
 *
 * L'orario viene rigenerato ogni notte per il giorno corrente. Se il file e'
 * piu' vecchio, i treni restano quelli dell'ultima scansione: si continua a
 * usarli, dichiarando che il giorno non corrisponde. Meglio una previsione
 * dichiarata approssimativa che nessuna previsione.
 */
export function scheduledTrains(area, now = new Date()) {
  const weekday = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const exact = area.weekday === weekday;

  const trains = area.trains.map((t) => ({
    id: String(t.n),
    number: t.n,
    label: `${t.cat || "REG"} ${t.n}`,
    category: t.cat || "REG",
    origin: t.orig,
    destination: t.dest,
    delay: 0,
    live: false,
    stops: t.stops.map((s) => ({
      code: s.s,
      arrive: atTime(s.a, now),
      depart: atTime(s.d, now),
    })),
  }));

  return { trains, exact, scannedDay: area.weekday };
}

/**
 * Strato 1: ritardi in tempo reale.
 * Ritorna il numero di treni a cui e' stato applicato un ritardo.
 */
export async function applyLiveDelays(trains, hubs, now = new Date()) {
  const byNumber = new Map(trains.map((t) => [t.number, t]));

  // Una finestra all'indietro intercetta i treni gia' in transito, che sono
  // proprio quelli che stanno per chiudere un passaggio a livello.
  const back = new Date(now.getTime() - 30 * 60 * 1000);
  const calls = [];
  for (const hub of hubs) {
    calls.push(partenze(hub, back).catch(() => []));
    calls.push(arrivi(hub, back).catch(() => []));
  }
  const results = await Promise.all(calls);

  let touched = 0;
  for (const entry of results.flat()) {
    const train = byNumber.get(entry.numeroTreno);
    if (!train) continue;
    if (typeof entry.ritardo === "number" && !train.live) {
      train.delay = entry.ritardo;
      train.live = true;
      touched++;
    }
    train.origin_code = entry.codOrigine ?? train.origin_code;
    train.departure_date = entry.dataPartenzaTreno ?? train.departure_date;
    train.destination = train.destination || entry.destinazione;
  }

  // il ritardo trasla l'intero orario del treno
  for (const t of trains) {
    if (!t.live || !t.delay) continue;
    const shift = t.delay * 60 * 1000;
    for (const s of t.stops) {
      if (s.arrive) s.arrive += shift;
      if (s.depart) s.depart += shift;
    }
  }

  return touched;
}

/**
 * Strato 2: orari reali fermata per fermata per i treni piu' imminenti.
 *
 * Piu' preciso del ritardo unico, che puo' cambiare da una stazione all'altra.
 * Si applica a pochi treni per non moltiplicare le richieste.
 */
export async function refineImminent(trains, stationCodes, now = new Date(), limit = 2) {
  const soon = trains
    .filter((t) => t.origin_code && t.departure_date)
    .map((t) => {
      const times = t.stops.map((s) => s.arrive ?? s.depart).filter(Boolean);
      if (!times.length) return null;
      return { t, at: Math.min(...times.map((x) => Math.abs(x - now.getTime()))) };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit);

  let refined = 0;
  await Promise.all(soon.map(async ({ t }) => {
    try {
      const d = await andamentoTreno(t.origin_code, t.number, t.departure_date);
      if (!d?.fermate) return;
      const stops = [];
      for (const f of d.fermate) {
        if (!stationCodes.has(f.id)) continue;
        const bump = (f.ritardo ?? d.ritardo ?? 0) * 60 * 1000;
        stops.push({
          code: f.id,
          arrive: f.arrivoReale ?? (f.arrivo_teorico ? f.arrivo_teorico + bump : null),
          depart: f.partenzaReale ?? (f.partenza_teorica ? f.partenza_teorica + bump : null),
        });
      }
      if (stops.length >= 2) {
        t.stops = stops;
        t.delay = d.ritardo ?? t.delay;
        t.live = true;
        t.precise = true;
        refined++;
      }
    } catch {
      /* il treno resta con la stima dello strato 1 */
    }
  }));

  return refined;
}
