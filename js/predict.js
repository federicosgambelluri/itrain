/**
 * Motore di previsione delle chiusure.
 *
 * RFI non pubblica lo stato delle barriere: non esiste alcuna API che dica
 * "aperto" o "chiuso". Quello che si sa e' quando i treni transitano dalle
 * stazioni, in orario e in tempo reale. Da li' si ricava tutto il resto.
 *
 * Il percorso e' in tre passi:
 *   1. dove si trova il PL lungo il binario   -> le "tratte", calcolate
 *      offline sul grafo dei binari: per ogni coppia di stazioni consecutive
 *      quanti metri le separano e quali PL ci stanno in mezzo, a che distanza;
 *   2. quando il treno ci passa sopra          -> interpolazione fra le due
 *      stazioni, con un profilo di velocita' realistico;
 *   3. quando le barriere scendono e risalgono -> scarti rispetto al transito,
 *      calibrabili sulle osservazioni reali dell'utente.
 *
 * Il modello a tratte ha sostituito quello a progressiva chilometrica. Su una
 * linea isolata bastava un numero per collocare ogni cosa lungo il binario; su
 * un nodo come Bologna, dove convergono otto linee e la stazione centrale sta
 * su tutte, quel numero non esiste. Misurare lungo il percorso che il treno fa
 * davvero descrive bene entrambi i casi.
 */

/* ------------------------------------------------------------------ *
 * 1. Profilo di velocita'
 * ------------------------------------------------------------------ */

/**
 * Tempo impiegato dal treno per percorrere `dist` metri, partendo fermo da una
 * stazione e arrivando fermo alla successiva, distanti `D` metri e separate da
 * `T` secondi di orario.
 *
 * L'interpolazione lineare qui sbaglierebbe parecchio: il treno riparte da
 * fermo e frena fino a fermarsi, quindi vicino alle stazioni e' molto piu'
 * lento della sua media. Ed e' esattamente li' che stanno i PL di Siderno,
 * tutti entro 1,2 km dalla stazione: Via Genova e' a 196 m, dove un treno in
 * partenza va ancora a poche decine di km/h.
 *
 * Si usa quindi un profilo trapezoidale: accelerazione costante `a`, tratto a
 * velocita' costante V, decelerazione costante `a`. Imponendo che la distanza
 * sia D e il tempo sia T si ricava V dalla relazione T = V/a + D/V, cioe'
 * dall'equazione di secondo grado V^2 - aTV + aD = 0.
 *
 * La V cosi' ottenuta va poi confrontata con la velocita' massima di linea:
 * dove l'orario e' molto stretto l'equazione chiede velocita' che sulla Jonica
 * nessun treno raggiunge. In quel caso si tiene ferma la velocita' al limite e
 * si ricava invece l'accelerazione necessaria a rispettare l'orario.
 */
export function speedProfile(D, T, a, vmax = Infinity) {
  if (!(D > 0) || !(T > 0)) return null;

  const disc = a * a * T * T - 4 * a * D;
  if (disc >= 0) {
    // Il treno raggiunge la velocita' di crociera. Delle due radici si prende
    // la minore: l'altra descrive un treno lanciatissimo che frena per quasi
    // tutto il tratto, soluzione matematica ma non fisica.
    let V = (a * T - Math.sqrt(disc)) / 2;
    if (V > vmax) {
      const cruiseTime = T - D / vmax;
      // con V al limite, questa e' l'accelerazione che chiude i conti
      if (cruiseTime > 0) return { V: vmax, a: vmax / cruiseTime, D, T, cruise: true };
      V = vmax;   // orario piu' stretto della fisica: si tiene il limite di linea
    }
    if (V > 0) return { V, a, D, T, cruise: true };
  }
  // Tratto troppo corto o orario troppo stretto per una fase di crociera:
  // il profilo degenera in un triangolo e l'accelerazione effettiva e'
  // quella che serve per farcela comunque.
  const aEff = (4 * D) / (T * T);
  return { V: Math.min((aEff * T) / 2, vmax), a: aEff, D, T, cruise: false };
}

/**
 * Secondi impiegati per coprire i primi `x` metri del tratto.
 * E' l'inversa della funzione posizione del profilo trapezoidale.
 */
export function timeToCover(p, x) {
  if (!p) return null;
  const { V, a, D, T } = p;
  if (x <= 0) return 0;
  if (x >= D) return T;

  const tAccel = V / a;           // istante in cui finisce l'accelerazione
  const xAccel = (V * V) / (2 * a); // metri percorsi accelerando

  if (x <= xAccel) return Math.sqrt((2 * x) / a);          // in accelerazione
  if (x <= D - xAccel) return tAccel + (x - xAccel) / V;   // a velocita' costante
  return T - Math.sqrt((2 * (D - x)) / a);                 // in frenata
}

/* ------------------------------------------------------------------ *
 * 2. Transito del treno sul passaggio a livello
 * ------------------------------------------------------------------ */

/**
 * Istante in cui un treno passa su un punto della tratta.
 *
 * @param {number} tA   partenza dalla stazione a monte
 * @param {number} tB   arrivo alla stazione a valle
 * @param {number} D    metri di binario fra le due
 * @param {number} x    metri del PL dalla stazione a monte
 * @param {object} model
 * @returns {?{time:number, speed:number, fraction:number}}
 */
export function passageOn(tA, tB, D, x, model) {
  const T = (tB - tA) / 1000;
  const p = speedProfile(D, T, model.accel, model.vmax_ms);
  if (!p) return null;
  if (x < -1 || x > D + 1) return null;

  const dt = timeToCover(p, Math.min(Math.max(x, 0), D));
  if (dt == null) return null;

  // velocita' istantanea sul PL, usata per stimare quanto ci mette a liberarlo
  const tAccel = p.V / p.a;
  let speed;
  if (dt <= tAccel) speed = p.a * dt;
  else if (dt <= T - tAccel) speed = p.V;
  else speed = p.a * (T - dt);

  return { time: tA + dt * 1000, speed: Math.max(speed, 5), fraction: D > 0 ? x / D : 0 };
}

/* ------------------------------------------------------------------ *
 * 3. Finestre di chiusura
 * ------------------------------------------------------------------ */

/**
 * Finestra di chiusura generata da un singolo transito.
 *
 * Le barriere non scendono quando il treno arriva, ma quando impegna il
 * circuito di binario a monte del PL. Da RFI il preavviso corrente e' di circa
 * 2 minuti e mezzo (prima dell'ammodernamento superava i 4 minuti). La
 * riapertura arriva quando il treno ha liberato l'attraversamento e le barriere
 * sono risalite.
 *
 * Entrambi i valori sono stime: `calib` permette di sostituirli con quanto
 * effettivamente osservato su quel singolo PL.
 */
export function windowFor(pass, model, calib) {
  const lead = calib?.leadClose ?? model.lead_close_s;
  const open = calib?.leadOpen ?? model.lead_open_s;
  return {
    close: pass.time - lead * 1000,
    open: pass.time + open * 1000,
    pass: pass.time,
    speed: pass.speed,
    calibrated: Boolean(calib?.leadClose || calib?.leadOpen),
  };
}

/**
 * Fonde le finestre che si sovrappongono.
 *
 * La Jonica e' a binario unico, quindi i treni si incrociano in stazione: a
 * Siderno capita di vederne due fermi insieme per cinque minuti. Per chi e' in
 * auto davanti alle sbarre quello e' un unico sbarramento continuo, non due
 * chiusure separate, e va mostrato come tale.
 */
export function mergeWindows(windows) {
  const sorted = [...windows].sort((x, y) => x.close - y.close);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.close <= last.open) {
      last.open = Math.max(last.open, w.open);
      last.trains.push(...w.trains);
      last.merged = true;
    } else {
      out.push({ ...w, trains: [...w.trains] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Composizione
 * ------------------------------------------------------------------ */

/**
 * Calcola tutte le chiusure previste per un passaggio a livello.
 *
 * @param {number} index  posizione del PL nell'elenco dell'area
 * @param {Array}  trains treni normalizzati, con le fermate in ordine di orario
 * @param {object} segments tratte precalcolate, chiave "CODICE_A>CODICE_B"
 * @param {object} model
 * @param {object} calib  correzioni misurate su questo PL
 */
export function closuresFor(index, trains, segments, model, calib) {
  const windows = [];

  for (const train of trains) {
    const stops = train.stops;
    for (let i = 0; i < stops.length - 1; i++) {
      const A = stops[i];
      const B = stops[i + 1];
      const seg = segments[`${A.code}>${B.code}`];
      if (!seg) continue;

      const hit = seg.x.find((e) => e[0] === index);
      if (!hit) continue;

      const tA = A.depart ?? A.arrive;
      const tB = B.arrive ?? B.depart;
      if (!tA || !tB) continue;

      const pass = passageOn(tA, tB, seg.m, hit[1], model);
      if (!pass) continue;

      windows.push({
        ...windowFor(pass, model, calib),
        trains: [{
          id: train.id, label: train.label, category: train.category,
          origin: train.origin, destination: train.destination,
          delay: train.delay, live: train.live,
          from: A.code, to: B.code,
        }],
      });
      break;   // un treno attraversa il PL una volta sola
    }
  }

  return mergeWindows(windows);
}

/* ------------------------------------------------------------------ *
 * Stato corrente
 * ------------------------------------------------------------------ */

export const STATE = {
  CLOSED: "closed",
  CLOSING: "closing",
  OPEN: "open",
  UNKNOWN: "unknown",   // nessun treno previsto nel resto della giornata
  NODATA: "nodata",     // nessun treno di questa linea e' pubblicato: non si sa
};

/**
 * Sotto questa soglia il PL passa in stato di allerta.
 *
 * Sei minuti: sono il tempo utile per decidere se conviene partire adesso o
 * aspettare. Piu' in la' quasi tutta la giornata risulterebbe "in chiusura",
 * visto che sulla tratta passano una quarantina di treni al giorno, e
 * l'avviso perderebbe ogni significato.
 */
export const CLOSING_HORIZON_S = 6 * 60;

/**
 * Traduce l'elenco delle finestre nello stato da mostrare adesso.
 */
export function stateAt(windows, now) {
  const current = windows.find((w) => now >= w.close && now <= w.open);
  if (current) {
    return {
      state: STATE.CLOSED,
      window: current,
      seconds: Math.round((current.open - now) / 1000), // quanto manca alla riapertura
    };
  }

  const next = windows.find((w) => w.close > now);
  if (!next) return { state: STATE.UNKNOWN, window: null, seconds: null };

  const seconds = Math.round((next.close - now) / 1000);
  return {
    state: seconds <= CLOSING_HORIZON_S ? STATE.CLOSING : STATE.OPEN,
    window: next,
    seconds,
  };
}

/* ------------------------------------------------------------------ *
 * Posizione del treno
 * ------------------------------------------------------------------ */

/**
 * Dove si trova il treno adesso: fermo in stazione, oppure in corsa fra due.
 *
 * Serve a raccontare la previsione ("il REG 2034 e' fra Casalecchio e
 * Borgonuovo"), non a disegnarlo su una mappa: per quello servirebbe la
 * geometria di ogni tratta, che pesa troppo per essere spedita al browser.
 *
 * @returns {?{dwelling:boolean, at?:string, from?:string, to?:string, fraction?:number}}
 */
export function trainPosition(train, segments, now, model) {
  const stops = train.stops;

  // Fermo in stazione: sulle linee a binario unico le soste per l'incrocio
  // arrivano a cinque minuti, e in quell'intervallo il treno esiste eccome.
  for (const s of stops) {
    if (s.arrive && s.depart && now >= s.arrive && now <= s.depart) {
      return { dwelling: true, at: s.code };
    }
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const A = stops[i];
    const B = stops[i + 1];
    const tA = A.depart ?? A.arrive;
    const tB = B.arrive ?? B.depart;
    if (!tA || !tB || now < tA || now > tB) continue;

    const seg = segments[`${A.code}>${B.code}`];
    const T = (tB - tA) / 1000;
    const p = seg && speedProfile(seg.m, T, model.accel, model.vmax_ms);

    let fraction = T > 0 ? (now - tA) / (tB - tA) : 0;
    if (p) {
      // con il profilo di velocita' la frazione percorsa non e' quella del
      // tempo: si inverte per bisezione, il tempo di percorrenza e' monotono
      let lo = 0;
      let hi = seg.m;
      const target = (now - tA) / 1000;
      for (let k = 0; k < 32; k++) {
        const mid = (lo + hi) / 2;
        if (timeToCover(p, mid) < target) lo = mid;
        else hi = mid;
      }
      fraction = seg.m > 0 ? ((lo + hi) / 2) / seg.m : 0;
    }

    return { dwelling: false, from: A.code, to: B.code, fraction };
  }
  return null;
}
