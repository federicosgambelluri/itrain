/**
 * Costruzione dell'elenco treni su cui lavora il motore di previsione.
 *
 * La strategia e' pensata attorno all'inaffidabilita' dei proxy pubblici:
 * meno richieste si fanno, piu' spesso l'app funziona. Si procede quindi a
 * strati, ognuno utile da solo e ognuno migliore del precedente.
 *
 *   strato 0  orario statico dal repo             zero rete, funziona sempre
 *   strato 1  partenze + arrivi a Siderno          2 richieste, da' i ritardi
 *   strato 2  andamentoTreno sui treni imminenti   1-2 richieste, orari reali
 *
 * Bastano due richieste per avere i ritardi di tutti i treni della tratta,
 * perche' la Jonica e' a binario unico e da Siderno passano tutti: il ritardo
 * letto li' vale per i tratti adiacenti, che sono quelli dei nostri PL.
 */

import { partenze, arrivi, andamentoTreno } from "./rfi.js";

export const HUB = "S11850"; // Siderno

/** "HH:MM" -> istante di oggi. `ref` serve a gestire il cambio di giornata. */
function atTime(hhmm, ref) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(ref);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * Treni previsti oggi secondo l'orario statico.
 *
 * L'orario si costruisce per accumulo su piu' giorni, quindi puo' capitare che
 * un giorno della settimana sia coperto solo in parte. Filtrare comunque su
 * quel giorno sarebbe il caso peggiore: l'app mostrerebbe pochi treni senza
 * dirlo, e chi la usa concluderebbe che le sbarre restano alzate. Meglio
 * accorgersene, allargare a tutti i treni noti e dichiararlo.
 *
 * Il confronto e' con il giorno meglio coperto: se oggi ha meno del 60% dei
 * suoi treni, la copertura si considera parziale.
 */
export function scheduledTrains(timetable, now = new Date()) {
  const weekday = now.getDay() === 0 ? 6 : now.getDay() - 1; // JS: 0=dom -> orario: 0=lun

  const perDay = new Array(7).fill(0);
  for (const t of timetable.trains) {
    for (const d of t.days ?? []) perDay[d]++;
  }
  const best = Math.max(...perDay, 0);
  const today = perDay[weekday];

  const complete = today > 0 && today >= best * 0.6;
  const source = complete
    ? timetable.trains.filter((t) => t.days?.includes(weekday))
    : timetable.trains;

  const trains = source.map((t) => ({
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

  return { trains, exact: complete, coverage: { today, best } };
}

/**
 * Strato 1: ritardi in tempo reale.
 * Ritorna il numero di treni a cui e' stato applicato un ritardo.
 */
export async function applyLiveDelays(trains, now = new Date()) {
  const byNumber = new Map(trains.map((t) => [t.number, t]));

  // Una finestra all'indietro serve a intercettare i treni gia' in transito,
  // che sono proprio quelli che stanno per chiudere un passaggio a livello.
  const back = new Date(now.getTime() - 30 * 60 * 1000);
  const [dep, arr] = await Promise.all([
    partenze(HUB, back).catch(() => []),
    arrivi(HUB, back).catch(() => []),
  ]);

  let touched = 0;
  for (const entry of [...dep, ...arr]) {
    const train = byNumber.get(entry.numeroTreno);
    if (!train) continue;
    if (typeof entry.ritardo === "number") {
      train.delay = entry.ritardo;
      train.live = true;
      touched++;
    }
    // serve per lo strato 2
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
 * Piu' preciso del ritardo unico: il ritardo puo' cambiare da una stazione
 * all'altra, e qui si legge l'orario effettivo di ciascuna. Si applica solo a
 * pochi treni per non moltiplicare le richieste.
 */
export async function refineImminent(trains, stationCodes, now = new Date(), limit = 2) {
  const soon = trains
    .filter((t) => t.origin_code && t.departure_date)
    .map((t) => {
      const times = t.stops.map((s) => s.arrive ?? s.depart).filter(Boolean);
      return { t, at: Math.min(...times.map((x) => Math.abs(x - now.getTime()))) };
    })
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
        // l'orario reale quando esiste, altrimenti il teorico piu' il ritardo
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
