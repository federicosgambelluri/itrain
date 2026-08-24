/**
 * iTrain — interfaccia.
 *
 * Tiene insieme i pezzi: dati statici dal repo, ritardi da ViaggiaTreno,
 * previsione, posizione dell'utente, avvisi e calibrazione.
 */

import { closuresFor, stateAt, trainPosition, STATE, CLOSING_HORIZON_S } from "./predict.js";
import { scheduledTrains, applyLiveDelays, refineImminent } from "./trains.js";
import { haversine, formatDistance, watchPosition } from "./geo.js";
import * as rfi from "./rfi.js";
import * as calib from "./calibration.js";
import * as notify from "./notify.js";
import * as theme from "./theme.js";

/** Se la posizione non è disponibile si parte dalla stazione di Siderno. */
const FALLBACK = { lat: 38.27079, lon: 16.30201, label: "stazione di Siderno" };

const REFRESH_MS = 60 * 1000;
const STALE_MS = 5 * 60 * 1000;

const state = {
  geo: null,          // data/linea.json
  timetable: null,    // data/timetable.json
  chainByCode: new Map(),
  trains: [],
  exactDay: true,
  coverage: null,
  position: null,
  usingFallback: true,
  crossings: [],      // arricchiti con distanza, finestre, stato
  selectedId: null,
  lastRefresh: null,
  refreshing: false,
  liveCount: 0,
  proxyOk: false,
  notifyArmed: 0,
  message: null,      // esito dell'ultima calibrazione
  listLimit: 8,       // la linea ha decine di PL: si mostrano i piu' vicini
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * Formattazione
 * ------------------------------------------------------------------ */

const clock = (t) =>
  new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

/** Conto alla rovescia: al secondo sotto i due minuti, al minuto sopra. */
function countdown(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}`;
}

function delayText(min) {
  if (min == null) return "";
  if (min > 0) return `${min} min di ritardo`;
  if (min < 0) return `${-min} min di anticipo`;
  return "in orario";
}

function delayClass(min) {
  if (min == null) return "";
  return min > 0 ? "late" : min < 0 ? "early" : "ontime";
}

/**
 * Sbarra animata: e' l'icona di stato, ma disegnata come l'oggetto vero.
 *
 * Il braccio ruota attorno al perno e la rotazione e' animata dal CSS, quindi
 * passando da aperto a chiuso la sbarra si abbassa davvero invece di saltare
 * da un'icona all'altra. Le due luci lampeggiano in controfase, come quelle
 * vere, quando la chiusura e' in corso.
 */
function barrier(stateName) {
  return `
    <svg class="barrier ${stateName}" viewBox="0 2 60 60" aria-hidden="true">
      <line class="ground" x1="1" y1="61" x2="58" y2="61"/>
      <rect class="post" x="8.5" y="44" width="5" height="17" rx="2.5"/>
      <circle class="lamp lamp-a" cx="5" cy="54" r="3.2"/>
      <circle class="lamp lamp-b" cx="17" cy="54" r="3.2"/>
      <g class="boom">
        <rect class="boom-bar" x="11" y="43" width="42" height="6" rx="3"/>
        <g class="boom-stripes">
          <rect x="19" y="43" width="7" height="6"/>
          <rect x="31" y="43" width="7" height="6"/>
          <rect x="43" y="43" width="7" height="6"/>
        </g>
      </g>
      <circle class="pivot" cx="11" cy="46" r="3"/>
    </svg>`;
}

const WORDS = {
  [STATE.OPEN]: "APERTO",
  [STATE.CLOSING]: "STA PER CHIUDERSI",
  [STATE.CLOSED]: "CHIUSO",
  [STATE.UNKNOWN]: "NESSUN TRENO",
};

/* ------------------------------------------------------------------ *
 * Avvio
 * ------------------------------------------------------------------ */

async function boot() {
  try {
    const [geo, timetable] = await Promise.all([
      fetch("data/linea.json").then((r) => r.json()),
      fetch("data/timetable.json").then((r) => r.json()),
    ]);
    state.geo = geo;
    state.timetable = timetable;
    state.chainByCode = new Map(geo.stations.map((s) => [s.code, s.chainage]));
  } catch (err) {
    fatal("Non riesco a caricare i dati della linea. Se stai aprendo il file " +
          "direttamente dal disco, serve un piccolo server web: " +
          "<code>python3 -m http.server</code> nella cartella del progetto.");
    return;
  }

  state.position = FALLBACK;
  recompute();
  render();

  theme.init(() => render());
  startGeolocation();
  wireControls();
  registerServiceWorker();

  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(tick, 1000);
}

function fatal(html) {
  $("hero").innerHTML = `<div class="banner error"><div><b>Qualcosa non va</b>${html}</div></div>`;
}

/* ------------------------------------------------------------------ *
 * Posizione
 * ------------------------------------------------------------------ */

function startGeolocation() {
  watchPosition(
    (pos) => {
      state.position = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      state.usingFallback = false;
      // la prima volta si seleziona il PL più vicino, poi si rispetta la scelta
      const auto = !state.selectedId;
      recompute();
      if (auto) state.selectedId = state.crossings[0]?.id ?? null;
      render();
    },
    () => {
      state.usingFallback = true;
      render();
    },
  );
}

/* ------------------------------------------------------------------ *
 * Dati in tempo reale
 * ------------------------------------------------------------------ */

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  $("refresh")?.classList.add("spinning");
  render();

  try {
    const now = new Date();
    const { trains, exact, coverage } = scheduledTrains(state.timetable, now);
    state.trains = trains;
    state.exactDay = exact;
    state.coverage = coverage;

    state.liveCount = await applyLiveDelays(trains, now);
    // Distinzione necessaria: zero treni con ritardo puo' voler dire che i
    // proxy sono caduti, oppure semplicemente che a quest'ora non ne circola
    // nessuno. Sono due situazioni molto diverse da comunicare.
    state.proxyOk = rfi.status.ok;
    if (state.liveCount) {
      const codes = new Set(state.geo.stations.map((s) => s.code));
      await refineImminent(trains, codes, now);
    }
    state.lastRefresh = Date.now();
  } catch {
    // la catena di proxy ha fallito: si resta sull'orario statico, che è già
    // caricato. render() lo dichiara nella barra in alto.
    state.liveCount = 0;
  } finally {
    state.refreshing = false;
    $("refresh")?.classList.remove("spinning");
    recompute();
    rearmNotifications();
    render();
  }
}

/* ------------------------------------------------------------------ *
 * Calcolo
 * ------------------------------------------------------------------ */

function recompute() {
  const { lat, lon } = state.position ?? FALLBACK;

  state.crossings = state.geo.crossings.map((c) => {
    const correction = calib.forCrossing(c.id);
    const windows = closuresFor(c, state.trains, state.chainByCode, state.geo.model, correction);
    return {
      ...c,
      distance: haversine(lat, lon, c.lat, c.lon),
      windows,
      calibration: calib.progress(c.id),
    };
  }).sort((a, b) => a.distance - b.distance);

  if (!state.selectedId || !state.crossings.some((c) => c.id === state.selectedId)) {
    state.selectedId = state.crossings[0]?.id ?? null;
  }
}

const selected = () => state.crossings.find((c) => c.id === state.selectedId);

/** Rivaluta solo gli stati, che cambiano ogni secondo. */
function tick() {
  const now = Date.now();
  for (const c of state.crossings) c.now = stateAt(c.windows, now);
  renderHero();
  renderList();
  renderTimeline();
  updateStripLive();
}

/* ------------------------------------------------------------------ *
 * Disegno
 * ------------------------------------------------------------------ */

function render() {
  tick();
  renderPlace();
  renderSource();
  renderBanner();
  renderStrip();
  renderCalibSummary();
  for (const el of ["stripPanel", "timelinePanel", "listPanel"]) $(el).hidden = false;
}

/** L'etichetta accanto al nome segue la zona: la linea e' lunga 200 km. */
function renderPlace() {
  const el = document.querySelector(".brand-place");
  if (!el) return;
  const c = state.crossings[0];
  el.textContent = c ? nearestStation(c) || "Jonica" : "Jonica";
}

function renderSource() {
  const dot = $("sourceDot");
  const text = $("sourceText");
  if (!dot) return;

  if (state.refreshing && !state.lastRefresh) {
    dot.className = "source-dot";
    text.textContent = "carico…";
    return;
  }

  const age = state.lastRefresh ? Date.now() - state.lastRefresh : Infinity;
  if (!state.proxyOk) {
    dot.className = "source-dot offline";
    text.textContent = "solo orario teorico";
  } else if (age >= STALE_MS) {
    dot.className = "source-dot stale";
    text.textContent = `aggiornato ${clock(state.lastRefresh)}`;
  } else if (state.liveCount) {
    dot.className = "source-dot live";
    text.textContent = `in tempo reale · ${rfi.status.proxy ?? ""}`.trim();
  } else {
    dot.className = "source-dot live";
    text.textContent = "nessun treno in corsa";
  }
}

function renderBanner() {
  const b = $("banner");
  const notes = [];

  if (state.lastRefresh && !state.proxyOk) {
    notes.push({
      kind: "warn",
      title: "Ritardi non disponibili",
      body: "Nessuno dei proxy pubblici risponde in questo momento, quindi gli " +
            "orari mostrati sono quelli teorici. Un treno in ritardo chiuderà le " +
            "sbarre più tardi di quanto scritto qui.",
    });
  } else if (state.lastRefresh && !state.liveCount) {
    notes.push({
      kind: "info",
      title: "Nessun treno in circolazione",
      body: "ViaggiaTreno risponde, ma in questo momento sulla tratta non ci sono " +
            "treni in corsa: gli orari qui sotto sono quelli previsti. " +
            "I ritardi compariranno da soli quando il servizio riprende.",
    });
  }
  if (!state.exactDay) {
    notes.push({
      kind: "warn",
      title: "Orario indicativo",
      body: `L'orario salvato copre questo giorno della settimana solo in parte ` +
            `(${state.coverage?.today ?? 0} treni contro i ${state.coverage?.best ?? 0} del giorno più completo), ` +
            "quindi sto usando tutti i treni noti e alcune chiusure potrebbero non essere reali. " +
            "Si completa da solo nei prossimi giorni.",
    });
  }
  if (state.usingFallback) {
    notes.push({
      kind: "info",
      title: "Posizione non disponibile",
      body: `Sto misurando le distanze dalla ${FALLBACK.label}. ` +
            "Concedi l'accesso alla posizione per avere il passaggio a livello più vicino a te.",
    });
  }

  if (!notes.length) { b.hidden = true; return; }
  b.hidden = false;
  b.className = `banner ${notes[0].kind}`;
  b.innerHTML = notes
    .map((n) => `<div><b>${n.title}</b>${n.body}</div>`)
    .join('</div><div class="banner-sep">');
}

function renderHero() {
  const c = selected();
  const hero = $("hero");
  if (!c) {
    hero.innerHTML = '<div class="hero-loading"><p>Nessun passaggio a livello nei dati.</p></div>';
    return;
  }

  const s = c.now ?? stateAt(c.windows, Date.now());
  const isNearest = state.crossings[0]?.id === c.id;
  const w = s.window;
  const train = w?.trains?.[0];

  // dettaglio sotto la parola di stato
  let detail = "";
  if (s.state === STATE.CLOSED) {
    detail = `riapre fra <span class="big">${countdown(s.seconds)}</span>, verso le ${clock(w.open)}`;
  } else if (s.state === STATE.CLOSING) {
    detail = `si chiude fra <span class="big">${countdown(s.seconds)}</span>, alle ${clock(w.close)}`;
  } else if (s.state === STATE.OPEN) {
    detail = `prossima chiusura alle <span class="big">${clock(w.close)}</span>, fra ${countdown(s.seconds)}`;
  } else {
    detail = "nessun treno previsto nel resto della giornata";
  }

  // avanzamento della finestra in corso
  let bar = "";
  if (w && s.state === STATE.CLOSED) {
    const pct = ((Date.now() - w.close) / (w.open - w.close)) * 100;
    bar = `<div class="state-bar"><i style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%"></i></div>`;
  } else if (w && s.state === STATE.CLOSING) {
    const pct = 100 - (s.seconds / CLOSING_HORIZON_S) * 100;
    bar = `<div class="state-bar"><i style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%"></i></div>`;
  }

  const trainLine = train ? `
    <div class="train">
      <span class="train-tag">${train.label}</span>
      <span>${(train.origin ?? "").toLowerCase()} → ${(train.destination ?? "?").toLowerCase()}</span>
      ${train.delay != null && train.live
        ? `<span class="delay ${delayClass(train.delay)}">${delayText(train.delay)}</span>` : ""}
      <span class="live-chip ${train.live ? "" : "static"}">${train.live ? "dati reali" : "orario teorico"}</span>
      ${w.merged ? `<span class="delay">più treni insieme</span>` : ""}
    </div>` : "";

  const perm = notify.permission();
  const watching = notify.watchedCrossing() === c.id;
  const notifyLabel = perm === "granted"
    ? (watching ? `avvisi attivi${state.notifyArmed ? ` (${state.notifyArmed})` : ""}` : "avvisami")
    : "avvisami";

  const cal = c.calibration;
  const calNote = cal.active
    ? `Calibrato su questo passaggio a livello: chiude ${Math.round(cal.leadClose ?? state.geo.model.lead_close_s)} secondi prima del transito` +
      (cal.leadOpen != null ? `, riapre ${Math.round(cal.leadOpen)} secondi dopo` : "") + "."
    : `Sto usando il valore generico di ${state.geo.model.lead_close_s} secondi. ` +
      `Servono ancora ${cal.missing} osservazioni perché diventi quello reale di questo passaggio a livello.`;

  hero.innerHTML = `
    <div class="hero-top">
      <div>
        <div class="hero-label">${isNearest ? "Più vicino a te" : "Selezionato"}</div>
        <h1 class="hero-name">${c.name}</h1>
        <div class="hero-sub">${describePosition(c)}</div>
      </div>
      <div class="hero-distance">
        <b>${formatDistance(c.distance)}</b>
        <span>${state.usingFallback ? "dalla stazione" : "da te"}</span>
      </div>
    </div>

    <div class="state ${s.state}">
      <div class="state-row">
        <div class="state-icon">${barrier(s.state)}</div>
        <div>
          <div class="state-word">${WORDS[s.state]}</div>
          <div class="state-detail">${detail}</div>
        </div>
      </div>
      ${bar}
      ${trainLine}
    </div>

    ${s.state !== STATE.UNKNOWN && s.state !== STATE.CLOSED && c.windows.length > 1 ? `
      <div class="next-line">poi <b>${nextFew(c, 3)}</b></div>` : ""}

    <div class="actions">
      <button class="btn ${watching && perm === "granted" ? "on" : "primary"}" id="notifyBtn">
        <svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/></svg>
        ${notifyLabel}
      </button>
      <button class="btn mark-closed" id="markClosed">
        <svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="4" rx="1.2"/></svg>
        si è chiuso ora
      </button>
      <button class="btn mark-open" id="markOpen">
        <svg viewBox="0 0 24 24"><path d="M5 12l4.5 4.5L19 7"/></svg>
        si è riaperto ora
      </button>
    </div>
    <p class="action-note ${state.message?.kind ?? ""}">${state.message?.text ?? calNote}</p>
  `;

  $("notifyBtn").onclick = onNotifyClick;
  $("markClosed").onclick = () => onMark("close");
  $("markOpen").onclick = () => onMark("open");
}

/** Dove si trova il PL rispetto alle stazioni: aiuta a riconoscerlo. */
function describePosition(c) {
  const [a, b] = c.between;
  const name = (code) => state.geo.stations.find((s) => s.code === code)?.name;
  const near = [a, b]
    .filter(Boolean)
    .map((code) => ({ code, d: Math.abs(c.chainage - state.chainByCode.get(code)) }))
    .sort((x, y) => x.d - y.d)[0];
  if (!near) return "";
  return `a ${formatDistance(near.d)} dalla stazione di ${name(near.code)}, lungo la ferrovia Jonica`;
}

function nextFew(c, n) {
  const now = Date.now();
  return c.windows.filter((w) => w.close > now).slice(1, n + 1)
    .map((w) => clock(w.close)).join(" · ") || "nessun'altra chiusura oggi";
}

function renderList() {
  const ul = $("list");
  const now = Date.now();

  // Sulla linea intera i passaggi a livello sono decine: mostrarli tutti
  // renderebbe illeggibile l'unica cosa che conta, cioe' quelli vicini.
  const all = state.crossings;
  const shown = all.slice(0, state.listLimit);

  ul.innerHTML = shown.map((c) => {
    const s = c.now ?? stateAt(c.windows, now);
    const w = s.window;
    const value = s.state === STATE.CLOSED ? countdown(s.seconds)
      : s.state === STATE.UNKNOWN ? "—"
      : s.seconds <= CLOSING_HORIZON_S ? countdown(s.seconds) : clock(w.close);
    const label = s.state === STATE.CLOSED ? "alla riapertura"
      : s.state === STATE.UNKNOWN ? "nessun treno"
      : s.seconds <= CLOSING_HORIZON_S ? "alla chiusura" : "prossima chiusura";

    return `
      <li>
        <button class="crossing ${c.id === state.selectedId ? "selected" : ""}" data-id="${c.id}">
          <span class="crossing-pill ${s.state}"></span>
          <span class="crossing-main">
            <span class="crossing-name">${c.name}${c.calibration.active ? '<span class="calib-badge">calibrato</span>' : ""}</span>
            <span class="crossing-meta">${formatDistance(c.distance)} · ${nearestStation(c)}</span>
          </span>
          <span class="crossing-state ${s.state}">
            <b>${value}</b><span>${label}</span>
          </span>
        </button>
      </li>`;
  }).join("");

  if (all.length > shown.length) {
    const li = document.createElement("li");
    li.innerHTML = `<button class="btn ghost wide" id="more">
      mostra gli altri ${all.length - shown.length} passaggi a livello</button>`;
    ul.appendChild(li);
    li.querySelector("#more").onclick = () => {
      state.listLimit = all.length;
      renderList();
    };
  } else if (all.length > 8) {
    const li = document.createElement("li");
    li.innerHTML = `<button class="btn ghost wide" id="less">mostra solo i più vicini</button>`;
    ul.appendChild(li);
    li.querySelector("#less").onclick = () => {
      state.listLimit = 8;
      renderList();
    };
  }

  for (const btn of ul.querySelectorAll(".crossing")) {
    btn.onclick = () => {
      state.selectedId = btn.dataset.id;
      state.message = null;
      rearmNotifications();
      render();
      $("hero").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }
}

/** Nome della stazione piu' vicina a un PL: serve a collocarlo sulla linea. */
function nearestStation(c) {
  const near = (c.between ?? [])
    .filter(Boolean)
    .map((code) => ({ code, d: Math.abs(c.chainage - state.chainByCode.get(code)) }))
    .sort((a, b) => a.d - b.d)[0];
  if (!near) return "";
  return state.geo.stations.find((s) => s.code === near.code)?.name ?? "";
}

function renderTimeline() {
  const c = selected();
  if (!c) return;

  const now = Date.now();
  const span = 3 * 60 * 60 * 1000;
  const end = now + span;
  const pct = (t) => ((t - now) / span) * 100;

  const blocks = c.windows
    .filter((w) => w.open > now && w.close < end)
    .map((w) => {
      const left = Math.max(0, pct(w.close));
      const right = Math.min(100, pct(w.open));
      return `<div class="tl-block" style="left:${left}%;width:${Math.max(right - left, 0.35)}%"
                   title="${clock(w.close)}–${clock(w.open)}"></div>`;
    }).join("");

  const hours = [];
  const first = new Date(now);
  first.setMinutes(0, 0, 0);
  for (let h = 1; h <= 3; h++) {
    const t = first.getTime() + h * 60 * 60 * 1000;
    if (t > now && t < end) hours.push(`<div class="tl-hour" style="left:${pct(t)}%">${clock(t)}</div>`);
  }

  $("timeline").innerHTML = blocks + hours.join("") + '<div class="tl-now" style="left:0"></div>';

  const upcoming = c.windows.filter((w) => w.open > now).slice(0, 6);
  $("timelineNote").textContent = `${c.name} · ${upcoming.length ? `${c.windows.filter((w) => w.open > now).length} chiusure ancora oggi` : "nessuna chiusura rimasta"}`;

  $("closures").innerHTML = upcoming.map((w) => {
    const running = now >= w.close && now <= w.open;
    const soon = !running && w.close - now < CLOSING_HORIZON_S * 1000;
    const mins = Math.round((w.open - w.close) / 60000);
    return `
      <li class="${running ? "now" : soon ? "imminent" : ""}">
        <span class="when">${clock(w.close)} – ${clock(w.open)}</span>
        <span class="who">${w.trains.map((t) => `${t.label} → ${(t.destination ?? "?").toLowerCase()}`).join(" + ")}</span>
        <span class="dur">${mins} min</span>
      </li>`;
  }).join("") || '<li><span class="who">Nessuna chiusura prevista nel resto della giornata.</span></li>';
}

/* ---------------------- schema della linea ------------------------ */

function renderStrip() {
  const svg = $("strip");
  const W = 1000, H = 156, PAD = 58, RAIL_Y = 104;

  // Si inquadra la zona del PL scelto invece di tutta la tratta: i quattro
  // passaggi a livello di Siderno stanno in poco piu' di un chilometro, e sui
  // trenta chilometri della linea finirebbero uno sull'altro.
  //
  // La finestra si costruisce sugli elementi effettivamente vicini, non sulle
  // due stazioni di riferimento: Locri e' a cinque chilometri e includerla
  // schiaccerebbe a un lato tutto il gruppo di Siderno.
  const sel = selected();
  const centre = sel?.chainage ?? state.geo.stations[0].chainage;
  const NEAR = 1800;

  const anchors = [centre];
  for (const c of state.geo.crossings) {
    if (Math.abs(c.chainage - centre) <= NEAR) anchors.push(c.chainage);
  }
  for (const st of state.geo.stations) {
    if (Math.abs(st.chainage - centre) <= NEAR) anchors.push(st.chainage);
  }

  let lo = Math.min(...anchors) - 450;
  let hi = Math.max(...anchors) + 450;
  const MIN_SPAN = 2200;   // sotto questa larghezza lo schema perde leggibilita'
  if (hi - lo < MIN_SPAN) {
    const pad = (MIN_SPAN - (hi - lo)) / 2;
    lo -= pad; hi += pad;
  }

  const x = (ch) => PAD + ((ch - lo) / (hi - lo)) * (W - 2 * PAD);
  const inView = (ch) => ch >= lo && ch <= hi;

  const parts = [];

  // binario con traversine, spaziate ogni 100 metri reali
  parts.push(`<line class="rail" x1="0" y1="${RAIL_Y}" x2="${W}" y2="${RAIL_Y}"/>`);
  const tieStep = 100;
  for (let ch = Math.ceil(lo / tieStep) * tieStep; ch <= hi; ch += tieStep) {
    const px = x(ch);
    const major = Math.round(ch) % 1000 === 0;
    parts.push(`<line class="tie${major ? " major" : ""}" x1="${px.toFixed(1)}" y1="${RAIL_Y - (major ? 9 : 5)}" x2="${px.toFixed(1)}" y2="${RAIL_Y + (major ? 9 : 5)}"/>`);
  }

  // verso quale stazione si va, da una parte e dall'altra
  const ends = [
    { at: lo, dir: -1, station: [...state.geo.stations].reverse().find((st) => st.chainage <= lo) },
    { at: hi, dir: 1, station: state.geo.stations.find((st) => st.chainage >= hi) },
  ];
  for (const e of ends) {
    if (!e.station) continue;
    const px = e.dir < 0 ? 8 : W - 8;
    parts.push(`<text class="edge-label" x="${px}" y="${RAIL_Y - 24}" text-anchor="${e.dir < 0 ? "start" : "end"}">${e.dir < 0 ? "\u2190 " : ""}${e.station.name}${e.dir > 0 ? " \u2192" : ""}</text>`);
  }

  // stazioni
  for (const st of state.geo.stations) {
    if (!inView(st.chainage)) continue;
    const px = x(st.chainage);
    parts.push(`<circle class="st-dot" cx="${px.toFixed(1)}" cy="${RAIL_Y}" r="6"/>`);
    parts.push(`<text class="st-label" x="${px.toFixed(1)}" y="${RAIL_Y + 24}" text-anchor="middle">${st.name}</text>`);
  }

  // passaggi a livello, con le etichette distribuite su piu' righe per non
  // sovrapporsi quando sono vicini fra loro
  const now = Date.now();
  const colors = {
    [STATE.OPEN]: "var(--open)", [STATE.CLOSING]: "var(--closing)",
    [STATE.CLOSED]: "var(--closed)", [STATE.UNKNOWN]: "var(--unknown)",
  };
  const ROWS = [26, 46, 66];
  const rowEnd = ROWS.map(() => -Infinity);

  const visible = state.geo.crossings
    .filter((c) => inView(c.chainage))
    .sort((a, b) => a.chainage - b.chainage);

  for (const c of visible) {
    const live = state.crossings.find((k) => k.id === c.id);
    const st = live?.now ?? stateAt(live?.windows ?? [], now);
    const px = x(c.chainage);
    const col = colors[st.state];
    const isSel = c.id === state.selectedId;
    const text = shortName(c.name);
    const halfW = text.length * 2.9 + 6;   // stima della larghezza a 10.5px

    let row = ROWS.findIndex((_, i) => px - halfW > rowEnd[i] + 6);
    if (row < 0) row = ROWS.length - 1;
    rowEnd[row] = px + halfW;
    const ly = ROWS[row];

    parts.push(`<line data-pl="${c.id}" x1="${px.toFixed(1)}" y1="${ly + 5}" x2="${px.toFixed(1)}" y2="${RAIL_Y - 16}" stroke="${col}" stroke-width="1" opacity=".3"/>`);
    parts.push(`<line class="pl-mark" data-pl="${c.id}" x1="${px.toFixed(1)}" y1="${RAIL_Y - 14}" x2="${px.toFixed(1)}" y2="${RAIL_Y + 14}" stroke="${col}"/>`);
    if (isSel) {
      parts.push(`<circle class="pl-halo" data-pl="${c.id}" cx="${px.toFixed(1)}" cy="${RAIL_Y}" r="13" fill="none" stroke="${col}" stroke-width="1.6" opacity=".6"/>`);
    }
    parts.push(`<text class="pl-label" data-pl="${c.id}" x="${px.toFixed(1)}" y="${ly}" text-anchor="middle" fill="${col}" font-weight="${isSel ? 800 : 600}">${text}</text>`);
  }

  // I treni stanno in un livello a parte, ridisegnato ogni secondo senza
  // ricostruire il resto: e' quello che permette di animarne lo spostamento
  // invece di farli saltare da una posizione all'altra.
  parts.push('<g id="stripTrains"></g>');

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join("");

  // la scala serve al livello dei treni, aggiornato separatamente
  state.stripScale = { lo, hi, x, railY: RAIL_Y, inView };
  updateStripLive();
}

/**
 * Aggiorna quello che cambia di secondo in secondo: il colore dei passaggi a
 * livello e la posizione dei treni.
 *
 * I nodi dei treni vengono riusati invece di essere ricreati, perche' la
 * transizione CSS sul transform ha bisogno di un elemento che resti lo stesso
 * fra un aggiornamento e l'altro: e' quello che li fa scorrere.
 */
function updateStripLive() {
  const svg = $("strip");
  const layer = svg?.querySelector("#stripTrains");
  const scale = state.stripScale;
  if (!layer || !scale) return;

  const now = Date.now();
  const colors = {
    [STATE.OPEN]: "var(--open)", [STATE.CLOSING]: "var(--closing)",
    [STATE.CLOSED]: "var(--closed)", [STATE.UNKNOWN]: "var(--unknown)",
  };

  for (const c of state.crossings) {
    const st = c.now ?? stateAt(c.windows, now);
    for (const el of svg.querySelectorAll(`[data-pl="${c.id}"]`)) {
      el.setAttribute(el.tagName === "text" ? "fill" : "stroke", colors[st.state]);
    }
  }

  const seen = new Set();
  let moving = 0;
  for (const t of state.trains) {
    const p = trainPosition(t, state.chainByCode, now, state.geo.model);
    if (!p) continue;
    moving++;
    if (!scale.inView(p.chainage)) continue;

    const key = String(t.number);
    seen.add(key);
    let g = layer.querySelector(`[data-train="${key}"]`);
    const fresh = !g;

    if (fresh) {
      g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("data-train", key);
      g.setAttribute("class", "train entering");
      g.innerHTML = `
        <rect class="train-body" x="-16" y="-10" width="32" height="20" rx="6"/>
        <path class="train-nose" d="M16 0 l8 -6 v12 z"/>
        <text class="train-label" x="0" y="3.5" text-anchor="middle">${t.number}</text>`;
      layer.appendChild(g);
    }

    g.setAttribute("transform", `translate(${scale.x(p.chainage).toFixed(1)} ${scale.railY})`);
    g.classList.toggle("dwelling", Boolean(p.dwelling));
    // il muso indica il verso di marcia; da fermo viene nascosto dal CSS
    g.querySelector(".train-nose").setAttribute(
      "transform", p.towards === "sud" ? "scale(-1 1)" : "scale(1 1)");

    if (fresh) {
      // senza questo il treno appena creato scivolerebbe dall'origine
      requestAnimationFrame(() => g.classList.remove("entering"));
    }
  }

  for (const g of layer.querySelectorAll("[data-train]")) {
    if (!seen.has(g.dataset.train)) g.remove();
  }

  const km = ((scale.hi - scale.lo) / 1000).toFixed(1).replace(".", ",");
  $("stripNote").textContent =
    (moving ? `${moving} ${moving === 1 ? "treno in transito" : "treni in transito"}` : "nessun treno in transito") +
    ` · ${km} km attorno a ${selected()?.name ?? ""}`;
}

function shortName(name) {
  return name.replace(/^Via /, "").replace(/^Viale /, "").replace(/^Strada /, "")
             .replace(/^Piazzale /, "").replace("Cristoforo Colombo", "C. Colombo")
             .replace("Torquato Tasso", "T. Tasso").replace("Telegrafo vecchio", "Telegrafo");
}

/* ------------------------------------------------------------------ *
 * Interazioni
 * ------------------------------------------------------------------ */

async function onNotifyClick() {
  const c = selected();
  if (!c) return;

  if (!notify.isSupported()) {
    flash("Questo browser non supporta le notifiche.", "bad");
    return;
  }
  if (notify.needsInstall()) {
    flash("Su iPhone le notifiche funzionano solo se aggiungi il sito alla schermata Home: " +
          "menù Condividi → «Aggiungi a Home». È una regola di Safari.", "bad");
    return;
  }

  if (notify.watchedCrossing() === c.id && notify.permission() === "granted") {
    notify.setWatchedCrossing(null);
    notify.clear();
    state.notifyArmed = 0;
    flash("Avvisi disattivati.", "");
    render();
    return;
  }

  const perm = await notify.requestPermission();
  if (perm !== "granted") {
    flash("Permesso negato: senza di esso non posso mandare avvisi.", "bad");
    render();
    return;
  }

  notify.setWatchedCrossing(c.id);
  rearmNotifications();
  await notify.test(c);
  flash(`Ti avviso ${notify.leadMinutes()} minuti prima di ogni chiusura di ${c.name}. ` +
        "Funziona finché l'app resta aperta, anche in secondo piano: senza un server " +
        "le notifiche a app chiusa non sono possibili.", "ok");
  render();
}

function rearmNotifications() {
  const id = notify.watchedCrossing();
  const c = state.crossings.find((k) => k.id === id);
  if (!c || notify.permission() !== "granted") {
    notify.clear();
    state.notifyArmed = 0;
    return;
  }
  state.notifyArmed = notify.schedule(c, c.windows);
}

function onMark(kind) {
  const c = selected();
  if (!c) return;

  // ci si riferisce alla finestra più vicina nel tempo, non a quella "prossima":
  // chi preme il tasto è davanti alle sbarre proprio adesso
  const now = Date.now();
  const w = [...c.windows].sort((a, b) =>
    Math.abs((a.pass ?? a.close) - now) - Math.abs((b.pass ?? b.close) - now))[0];

  const res = calib.record(c.id, kind, w, now);
  if (!res.ok) {
    flash(res.reason, "bad");
  } else {
    const what = kind === "close" ? "chiusura" : "riapertura";
    flash(`Segnato. Su questo passaggio a livello la ${what} arriva ${Math.abs(res.lead)} secondi ` +
          `${kind === "close" ? "prima" : "dopo"} il transito. ` +
          (res.samples < 2
            ? "Ancora un'osservazione e comincio a usarla al posto del valore generico."
            : `Media su ${res.samples} osservazioni, ora è questa a guidare la previsione.`), "ok");
  }
  recompute();
  rearmNotifications();
  render();
}

function flash(text, kind) {
  state.message = { text, kind };
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { state.message = null; renderHero(); }, 12000);
}

function renderCalibSummary() {
  const active = state.crossings.filter((c) => c.calibration.close || c.calibration.open);
  $("calibSummary").textContent = active.length
    ? `Osservazioni registrate su ${active.length} ${active.length === 1 ? "passaggio a livello" : "passaggi a livello"}: ` +
      active.map((c) => `${c.name} (${c.calibration.close + c.calibration.open})`).join(", ") + "."
    : "Nessuna osservazione registrata finora.";
}

function wireControls() {
  $("refresh").onclick = () => refresh();

  $("theme").onclick = () => {
    const mode = theme.cycle();
    $("theme").title = theme.LABELS[mode];
    $("theme").setAttribute("aria-label", theme.LABELS[mode]);
    renderStrip();   // lo schema disegna i colori a mano, va ridipinto
  };

  $("exportCalib").onclick = () => {
    const blob = new Blob([calib.exportAll()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "itrain-calibrazione.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  $("importCalib").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const ok = calib.importAll(await file.text());
      flash(ok ? "Calibrazione importata." : "File non valido.", ok ? "ok" : "bad");
      recompute();
      render();
    };
    input.click();
  };

  $("resetCalib").onclick = () => {
    if (!confirm("Cancellare tutte le osservazioni registrate?")) return;
    calib.reset();
    recompute();
    render();
  };

  // tornando all'app dopo un po' i dati sono vecchi
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.lastRefresh || Date.now() - state.lastRefresh > STALE_MS) refresh();
    else tick();
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    notify.useRegistration(reg);
  } catch {
    /* l'app funziona lo stesso, solo senza cache offline */
  }
}

boot();
