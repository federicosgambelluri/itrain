/**
 * iTrain — interfaccia.
 *
 * Tiene insieme i pezzi: l'elenco delle zone, i dati della zona scelta, i
 * ritardi da ViaggiaTreno, la previsione, la posizione dell'utente, la mappa,
 * gli avvisi e la calibrazione.
 *
 * I dati sono divisi per zona e si scaricano una alla volta: chi sta a Siderno
 * non ha motivo di scaricare i settanta passaggi a livello di Bologna.
 */

import { closuresFor, stateAt, trainPosition, STATE, CLOSING_HORIZON_S } from "./predict.js";
import { scheduledTrains, applyLiveDelays, refineImminent, pickHubs } from "./trains.js";
import { haversine, formatDistance, watchPosition } from "./geo.js";
import * as rfi from "./rfi.js";
import * as calib from "./calibration.js";
import * as notify from "./notify.js";
import * as theme from "./theme.js";
import * as gmap from "./map.js";

const AREA_KEY = "itrain.area";
const REFRESH_MS = 60 * 1000;
const STALE_MS = 5 * 60 * 1000;

const state = {
  index: null,        // data/aree.json
  area: null,         // zona caricata
  segments: {},
  hubs: [],
  trains: [],
  exactDay: true,
  position: null,
  usingFallback: true,
  crossings: [],
  selectedId: null,
  listLimit: 8,
  lastRefresh: null,
  refreshing: false,
  liveCount: 0,
  proxyOk: false,
  notifyArmed: 0,
  message: null,
  loadingArea: false,
  mapFitted: false,
  showAll: false,
  allPoints: null,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * Formattazione
 * ------------------------------------------------------------------ */

const clock = (t) =>
  new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

function countdown(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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

const delayClass = (m) => (m == null ? "" : m > 0 ? "late" : m < 0 ? "early" : "ontime");

const WORDS = {
  [STATE.OPEN]: "APERTO",
  [STATE.CLOSING]: "STA PER CHIUDERSI",
  [STATE.CLOSED]: "CHIUSO",
  [STATE.UNKNOWN]: "NESSUN TRENO",
  [STATE.NODATA]: "NON LO SO",
};

/**
 * Sbarra animata: e' l'icona di stato, ma disegnata come l'oggetto vero.
 * Il braccio ruota attorno al perno e la rotazione e' animata dal CSS, quindi
 * passando da aperto a chiuso la sbarra si abbassa davvero. Le due luci
 * lampeggiano in controfase, come quelle vere.
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

/* ------------------------------------------------------------------ *
 * Avvio
 * ------------------------------------------------------------------ */

async function boot() {
  theme.init(() => render());
  wireControls();
  registerServiceWorker();

  try {
    state.index = await fetch("data/aree.json").then((r) => r.json());
  } catch {
    fatal("Non riesco a caricare l'elenco delle zone. Se stai aprendo il file " +
          "direttamente dal disco, serve un piccolo server web: " +
          "<code>python3 -m http.server</code> nella cartella del progetto.");
    return;
  }

  let slug = null;
  try { slug = localStorage.getItem(AREA_KEY); } catch { /* ignorato */ }
  const known = state.index.areas.some((a) => a.slug === slug);

  // Senza scelta salvata e senza posizione si parte dalla zona dichiarata
  // predefinita: con due dozzine di zone, aprire sulla prima in ordine
  // alfabetico sarebbe una scelta a caso.
  const fallbackArea = state.index.areas.find((a) => a.default)
                    ?? state.index.areas[0];
  await loadArea(known ? slug : fallbackArea.slug, { remember: known });

  startGeolocation();
  setInterval(refresh, REFRESH_MS);
  setInterval(tick, 1000);
}

function fatal(html) {
  $("hero").innerHTML = `<div class="banner error"><div><b>Qualcosa non va</b>${html}</div></div>`;
}

/** Centro di una zona, usato quando la posizione non e' disponibile. */
function areaCentre(meta) {
  const [s, w, n, e] = meta.bbox;
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}

async function loadArea(slug, { remember = true, select = null } = {}) {
  const meta = state.index.areas.find((a) => a.slug === slug);
  if (!meta) return;

  state.loadingArea = true;
  $("areaName").textContent = meta.name;
  render();

  try {
    const area = await fetch(`data/aree/${slug}.json`).then((r) => r.json());
    state.area = area;
    state.segments = area.segments;
    state.hubs = pickHubs(area, 2);
    state.selectedId = select;
    state.listLimit = 8;
    state.message = null;
    if (remember) {
      try { localStorage.setItem(AREA_KEY, slug); } catch { /* ignorato */ }
    }
    if (state.usingFallback) state.position = areaCentre(meta);
    gmap.clear();
    state.mapFitted = !select;   // scegliendo un PL preciso si va li', non sul riquadro
    recompute();
    if (select) {
      const c = state.crossings.find((k) => k.id === select);
      if (c) gmap.focusOn(c.lat, c.lon, 15);
    }
  } catch {
    fatal(`Non riesco a caricare i dati di ${meta.name}.`);
    return;
  } finally {
    state.loadingArea = false;
  }

  applyOthers();
  render();
  refresh();
}

/* ------------------------------------------------------------------ *
 * Posizione
 * ------------------------------------------------------------------ */

function startGeolocation() {
  watchPosition(
    (pos) => {
      const first = state.usingFallback;
      state.position = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.usingFallback = false;
      gmap.setUser(state.position.lat, state.position.lon);

      // Alla prima lettura, se l'utente non ha mai scelto una zona a mano,
      // si passa a quella che lo contiene: e' quasi sempre cio' che vuole.
      let stored = null;
      try { stored = localStorage.getItem(AREA_KEY); } catch { /* ignorato */ }
      if (first && !stored) {
        const near = nearestArea(state.position);
        if (near && near.slug !== state.area?.slug) {
          loadArea(near.slug, { remember: false });
          return;
        }
      }
      const auto = !state.selectedId;
      recompute();
      if (auto) state.selectedId = state.crossings[0]?.id ?? null;
      render();
    },
    () => { state.usingFallback = true; render(); },
  );
}

/** Distanza dal riquadro di una zona: zero se ci si trova dentro. */
function areaDistance(meta, p) {
  const [s, w, n, e] = meta.bbox;
  const lat = Math.min(Math.max(p.lat, s), n);
  const lon = Math.min(Math.max(p.lon, w), e);
  return haversine(p.lat, p.lon, lat, lon);
}

function nearestArea(p) {
  return [...state.index.areas]
    .map((a) => ({ ...a, d: areaDistance(a, p) }))
    .sort((x, y) => x.d - y.d)[0];
}

/* ------------------------------------------------------------------ *
 * Dati in tempo reale
 * ------------------------------------------------------------------ */

async function refresh() {
  if (state.refreshing || !state.area) return;
  state.refreshing = true;
  $("refresh")?.classList.add("spinning");
  renderSource();

  try {
    const now = new Date();
    const { trains, exact } = scheduledTrains(state.area, now);
    state.trains = trains;
    state.exactDay = exact;

    state.liveCount = await applyLiveDelays(trains, state.hubs, now);
    state.proxyOk = rfi.status.ok;
    if (state.liveCount) {
      const codes = new Set(state.area.stations.map((s) => s.code));
      await refineImminent(trains, codes, now);
    }
    state.lastRefresh = Date.now();
  } catch {
    state.liveCount = 0;
    state.proxyOk = false;
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
  if (!state.area) return;
  const { lat, lon } = state.position ?? { lat: 0, lon: 0 };

  state.crossings = state.area.crossings.map((c, index) => {
    const correction = calib.forCrossing(`${state.area.slug}:${c.id}`);
    return {
      ...c,
      index,
      distance: haversine(lat, lon, c.lat, c.lon),
      windows: closuresFor(index, state.trains, state.segments, state.area.model, correction),
      calibration: calib.progress(`${state.area.slug}:${c.id}`),
    };
  }).sort((a, b) => a.distance - b.distance);

  if (!state.selectedId || !state.crossings.some((c) => c.id === state.selectedId)) {
    state.selectedId = state.crossings[0]?.id ?? null;
  }
}

const selected = () => state.crossings.find((c) => c.id === state.selectedId);

function tick() {
  if (!state.crossings.length) return;
  const now = Date.now();
  for (const c of state.crossings) {
    c.now = c.covered === false
      ? { state: STATE.NODATA, window: null, seconds: null }
      : stateAt(c.windows, now);
  }
  renderHero();
  renderList();
  renderTimeline();
  renderMap();
}

/* ------------------------------------------------------------------ *
 * Disegno
 * ------------------------------------------------------------------ */

function render() {
  if (!state.area) return;
  tick();
  renderSource();
  renderBanner();
  renderCalibSummary();
  for (const el of ["mapPanel", "timelinePanel", "listPanel"]) $(el).hidden = false;

  // La mappa va inquadrata dopo che il pannello e' visibile: finche' e'
  // nascosto il contenitore ha altezza zero e Leaflet calcola male.
  gmap.invalidate();
  if (!state.mapFitted && gmap.isReady() && state.area) {
    gmap.fitBbox(state.area.bbox, { animate: false });
    state.mapFitted = true;
  }
}

function renderSource() {
  const dot = $("sourceDot");
  const text = $("sourceText");
  if (!dot) return;

  if (state.loadingArea) {
    dot.className = "source-dot";
    text.textContent = "carico la zona…";
    return;
  }
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
      kind: "warn", title: "Ritardi non disponibili",
      body: "Nessuno dei proxy pubblici risponde in questo momento, quindi gli " +
            "orari mostrati sono quelli teorici. Un treno in ritardo chiuderà le " +
            "sbarre più tardi di quanto scritto qui.",
    });
  } else if (state.lastRefresh && !state.liveCount) {
    notes.push({
      kind: "info", title: "Nessun treno in circolazione",
      body: "ViaggiaTreno risponde, ma in questo momento sulla rete non ci sono " +
            "treni in corsa: gli orari qui sotto sono quelli previsti.",
    });
  }
  if (!state.exactDay) {
    const g = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];
    notes.push({
      kind: "warn", title: "Orario di un altro giorno",
      body: `L'orario salvato è quello di ${g[state.area.weekday] ?? "un altro giorno"} ` +
            `(${state.area.day}), non di oggi: alcune corse potrebbero non essere reali ` +
            "e altre mancare. Si aggiorna da solo ogni notte.",
    });
  }
  if (state.usingFallback) {
    notes.push({
      kind: "info", title: "Posizione non disponibile",
      body: `Sto misurando le distanze dal centro di ${state.area.name}. ` +
            "Concedi l'accesso alla posizione per avere il passaggio a livello più vicino a te.",
    });
  }

  if (!notes.length) { b.hidden = true; return; }
  b.hidden = false;
  b.className = `banner ${notes[0].kind}`;
  b.innerHTML = notes.map((n) => `<div><b>${n.title}</b>${n.body}</div>`).join("");
}

/** Stazione piu' vicina a un passaggio a livello, in linea d'aria. */
function nearestStation(c) {
  let best = null;
  for (const s of state.area.stations) {
    const d = haversine(c.lat, c.lon, s.lat, s.lon);
    if (!best || d < best.d) best = { ...s, d };
  }
  return best;
}

function renderHero() {
  const c = selected();
  const hero = $("hero");
  if (!c) {
    hero.innerHTML = '<div class="hero-loading"><div class="spinner"></div><p>Carico la zona…</p></div>';
    return;
  }

  const s = c.now ?? stateAt(c.windows, Date.now());
  const isNearest = state.crossings[0]?.id === c.id;
  const noData = s.state === STATE.NODATA;
  const w = s.window;
  const train = w?.trains?.[0];

  let detail;
  if (s.state === STATE.CLOSED) {
    detail = `riapre fra <span class="big">${countdown(s.seconds)}</span>, verso le ${clock(w.open)}`;
  } else if (s.state === STATE.CLOSING) {
    detail = `si chiude fra <span class="big">${countdown(s.seconds)}</span>, alle ${clock(w.close)}`;
  } else if (s.state === STATE.OPEN) {
    detail = `prossima chiusura alle <span class="big">${clock(w.close)}</span>, fra ${countdown(s.seconds)}`;
  } else if (noData) {
    detail = "i treni di questa linea non sono pubblicati da nessuna parte";
  } else {
    detail = "nessun treno previsto nel resto della giornata";
  }

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
      ${w.merged ? '<span class="delay">più treni insieme</span>' : ""}
    </div>` : "";

  const perm = notify.permission();
  const watching = notify.watchedCrossing() === `${state.area.slug}:${c.id}`;
  const notifyLabel = perm === "granted" && watching
    ? `avvisi attivi${state.notifyArmed ? ` (${state.notifyArmed})` : ""}` : "avvisami";

  const cal = c.calibration;
  const calNote = cal.active
    ? `Calibrato su questo passaggio a livello: chiude ${Math.round(cal.leadClose ?? state.area.model.lead_close_s)} secondi prima del transito` +
      (cal.leadOpen != null ? `, riapre ${Math.round(cal.leadOpen)} secondi dopo` : "") + "."
    : `Sto usando il valore generico di ${state.area.model.lead_close_s} secondi. ` +
      `Servono ancora ${cal.missing} osservazioni perché diventi quello reale di questo passaggio a livello.`;

  const st = nearestStation(c);
  hero.innerHTML = `
    <div class="hero-top">
      <div>
        <div class="hero-label">${isNearest ? "Più vicino a te" : "Selezionato"}</div>
        <h1 class="hero-name">${c.name}</h1>
        <div class="hero-sub">${st ? `a ${formatDistance(st.d)} dalla stazione di ${st.name}` : ""}</div>
      </div>
      <div class="hero-distance">
        <b>${formatDistance(c.distance)}</b>
        <span>${state.usingFallback ? "dal centro" : "da te"}</span>
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
      ${noData ? "" : trainLine}
    </div>

    ${s.state !== STATE.UNKNOWN && s.state !== STATE.CLOSED && c.windows.length > 1 ? `
      <div class="next-line">poi <b>${nextFew(c, 3)}</b></div>` : ""}

    ${noData ? `
      <div class="nodata-note">
        <p><strong>Su questo passaggio a livello non posso dire nulla</strong>, e preferisco
        dirtelo invece di mostrarti una previsione inventata.</p>
        <p>Gli orari dei treni vengono da ViaggiaTreno, il servizio di RFI. Qui non
        arrivano: o la linea è esercita da un altro gestore e i suoi treni non sono
        pubblicati, oppure in questo periodo su questa tratta non ne circolano —
        succede durante i lavori, quando il servizio è sostituito da autobus.</p>
        <p class="fineprint">Il passaggio a livello resta in elenco perché esiste. Se i
        dati compaiono, si accende da solo alla prossima notte.</p>
      </div>` : ""}

    ${noData ? "" : `
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
    </div>`}
    ${noData ? "" : `<p class="action-note ${state.message?.kind ?? ""}">${state.message?.text ?? calNote}</p>`}
  `;

  if (!noData) {
    $("notifyBtn").onclick = onNotifyClick;
    $("markClosed").onclick = () => onMark("close");
    $("markOpen").onclick = () => onMark("open");
  }
}

function nextFew(c, n) {
  const now = Date.now();
  return c.windows.filter((w) => w.close > now).slice(1, n + 1)
    .map((w) => clock(w.close)).join(" · ") || "nessun'altra chiusura oggi";
}

function shortState(c) {
  const s = c.now ?? stateAt(c.windows, Date.now());
  const w = s.window;
  if (s.state === STATE.NODATA) return "dati non disponibili";
  if (s.state === STATE.CLOSED) return `chiuso, riapre fra ${countdown(s.seconds)}`;
  if (s.state === STATE.UNKNOWN) return "nessun treno previsto";
  if (s.seconds <= CLOSING_HORIZON_S) return `chiude fra ${countdown(s.seconds)}`;
  return `aperto fino alle ${clock(w.close)}`;
}

function renderList() {
  const ul = $("list");
  const now = Date.now();
  const all = state.crossings;
  const shown = all.slice(0, state.listLimit);

  ul.innerHTML = shown.map((c) => {
    const s = c.now ?? stateAt(c.windows, now);
    const w = s.window;
    const value = s.state === STATE.CLOSED ? countdown(s.seconds)
      : s.state === STATE.NODATA || s.state === STATE.UNKNOWN ? "—"
      : s.seconds <= CLOSING_HORIZON_S ? countdown(s.seconds) : clock(w.close);
    const label = s.state === STATE.CLOSED ? "alla riapertura"
      : s.state === STATE.NODATA ? "dati non disponibili"
      : s.state === STATE.UNKNOWN ? "nessun treno"
      : s.seconds <= CLOSING_HORIZON_S ? "alla chiusura" : "prossima chiusura";
    const st = nearestStation(c);

    return `
      <li>
        <button class="crossing ${c.id === state.selectedId ? "selected" : ""}" data-id="${c.id}">
          <span class="crossing-pill ${s.state}"></span>
          <span class="crossing-main">
            <span class="crossing-name">${c.name}${c.calibration.active ? '<span class="calib-badge">calibrato</span>' : ""}</span>
            <span class="crossing-meta">${formatDistance(c.distance)}${st ? ` · ${st.name}` : ""}</span>
          </span>
          <span class="crossing-state ${s.state}">
            <b>${value}</b><span>${label}</span>
          </span>
        </button>
      </li>`;
  }).join("");

  if (all.length > shown.length) {
    const li = document.createElement("li");
    li.innerHTML = `<button class="btn ghost wide" id="more">mostra gli altri ${all.length - shown.length}</button>`;
    ul.appendChild(li);
    li.querySelector("#more").onclick = () => { state.listLimit = all.length; renderList(); };
  } else if (all.length > 8) {
    const li = document.createElement("li");
    li.innerHTML = '<button class="btn ghost wide" id="less">mostra solo i più vicini</button>';
    ul.appendChild(li);
    li.querySelector("#less").onclick = () => { state.listLimit = 8; renderList(); };
  }

  for (const btn of ul.querySelectorAll(".crossing")) {
    btn.onclick = () => selectCrossing(btn.dataset.id, { scroll: true });
  }
}

function selectCrossing(id, { scroll = false, focus = false } = {}) {
  state.selectedId = id;
  state.message = null;
  rearmNotifications();
  render();
  const c = selected();
  if (focus && c) gmap.focusOn(c.lat, c.lon);
  if (scroll) $("hero").scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Accende la vista d'insieme: tutti i passaggi a livello di tutte le zone.
 *
 * L'indice si scarica una volta sola e pesa una settantina di chilobyte,
 * perche' contiene solo dove sono e come si chiamano. Lo stato no: quello
 * richiederebbe l'orario dei treni di ogni zona, quasi un megabyte, e questa
 * e' un'app che si apre in strada.
 */
async function toggleAllAreas() {
  const btn = $("allAreas");
  if (state.showAll) {
    state.showAll = false;
    gmap.clearOthers();
    btn.classList.remove("on");
    btn.setAttribute("aria-pressed", "false");
    $("allAreasLabel").textContent = "mostra tutte le zone";
    $("othersLegend").hidden = true;
    renderMap();
    return;
  }

  if (!state.allPoints) {
    $("allAreasLabel").textContent = "carico…";
    try {
      const d = await fetch("data/mappa.json").then((r) => r.json());
      state.allPoints = d.punti;
    } catch {
      $("allAreasLabel").textContent = "mostra tutte le zone";
      flash("Non riesco a caricare la mappa d'insieme.", "bad");
      return;
    }
  }

  state.showAll = true;
  btn.classList.add("on");
  btn.setAttribute("aria-pressed", "true");
  $("allAreasLabel").textContent = "mostra solo questa zona";
  $("othersLegend").hidden = false;
  gmap.fitBbox([35.4, 6.5, 47.2, 18.6], { animate: false });  // l'Italia intera
  applyOthers();
  renderMap();
}

/** I punti delle altre zone: quelli della zona caricata li disegna gia' lo stato. */
function applyOthers() {
  if (!state.showAll || !state.allPoints) return;
  const mine = state.area?.slug;
  gmap.setOthers(
    state.allPoints.filter((p) => p[3] !== mine),
    (zona, id) => loadArea(zona, { select: id }),
  );
}

function renderMap() {
  if (!gmap.isReady() || !state.area) return;
  const now = Date.now();
  gmap.setCrossings(
    state.crossings.map((c) => {
      const s = c.now ?? stateAt(c.windows, now);
      return { id: c.id, name: c.name, lat: c.lat, lon: c.lon,
               state: s.state, label: shortState(c) };
    }),
    state.selectedId,
  );

  const moving = state.trains.filter(
    (t) => trainPosition(t, state.segments, now, state.area.model)).length;
  const senza = state.crossings.filter((c) => c.covered === false).length;
  $("mapNote").textContent = state.showAll
    ? `${state.allPoints.length} passaggi a livello in ${state.index.areas.length} zone · ` +
      "tocca un puntino grigio per aprirne la zona"
    : `${state.area.crossings.length} passaggi a livello` +
    (senza ? `, ${senza} senza dati treno` : "") + " · " +
    (moving ? `${moving} ${moving === 1 ? "treno in corsa" : "treni in corsa"}`
            : "nessun treno in corsa");
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

  const rest = c.windows.filter((w) => w.open > now);
  $("timelineNote").textContent =
    `${c.name} · ${rest.length ? `${rest.length} chiusure ancora oggi` : "nessuna chiusura rimasta"}`;

  $("closures").innerHTML = rest.slice(0, 6).map((w) => {
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

/* ------------------------------------------------------------------ *
 * Selettore di zona
 * ------------------------------------------------------------------ */

function renderPicker(filtro = "") {
  const list = $("pickerList");
  const q = filtro.trim().toLowerCase();
  const match = (a) => !q || a.name.toLowerCase().includes(q) ||
                       a.region.toLowerCase().includes(q);

  const scheda = (a, mostraDistanza) => {
    const far = mostraDistanza && !state.usingFallback
      ? `<span class="far">${formatDistance(areaDistance(a, state.position))}</span>` : "";
    const cop = a.covered === a.crossings
      ? `${a.crossings} passaggi a livello`
      : `${a.covered} di ${a.crossings} con previsione`;
    return `
      <button class="picker-area ${a.slug === state.area?.slug ? "current" : ""}" data-slug="${a.slug}">
        <span>
          <b>${a.name}</b>
          <span>${cop} · ${a.trains} treni · ${a.size_kb} KB</span>
        </span>
        ${far}
      </button>`;
  };

  const blocchi = [];

  // Con due dozzine di zone, quelle vicine vanno messe davanti: e' quasi
  // sempre una di loro quella che si cerca.
  if (!state.usingFallback && !q) {
    const vicine = [...state.index.areas]
      .map((a) => ({ ...a, d: areaDistance(a, state.position) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 3);
    blocchi.push(`<div><div class="picker-region">Vicino a te</div>
      ${vicine.map((a) => scheda(a, true)).join("")}</div>`);
  }

  const perRegione = new Map();
  for (const a of state.index.areas) {
    if (!match(a)) continue;
    if (!perRegione.has(a.region)) perRegione.set(a.region, []);
    perRegione.get(a.region).push(a);
  }
  for (const [region, areas] of perRegione) {
    blocchi.push(`<div><div class="picker-region">${region}</div>
      ${areas.map((a) => scheda(a, true)).join("")}</div>`);
  }

  list.innerHTML = blocchi.join("");
  $("pickerEmpty").hidden = perRegione.size > 0;

  for (const btn of list.querySelectorAll(".picker-area")) {
    btn.onclick = () => {
      $("picker").close();
      loadArea(btn.dataset.slug);
    };
  }
}

/* ------------------------------------------------------------------ *
 * Interazioni
 * ------------------------------------------------------------------ */

async function onNotifyClick() {
  const c = selected();
  if (!c) return;
  const key = `${state.area.slug}:${c.id}`;

  if (!notify.isSupported()) return flash("Questo browser non supporta le notifiche.", "bad");
  if (notify.needsInstall()) {
    return flash("Su iPhone le notifiche funzionano solo se aggiungi il sito alla schermata " +
                 "Home: menù Condividi → «Aggiungi a Home». È una regola di Safari.", "bad");
  }

  if (notify.watchedCrossing() === key && notify.permission() === "granted") {
    notify.setWatchedCrossing(null);
    notify.clear();
    state.notifyArmed = 0;
    flash("Avvisi disattivati.", "");
    return render();
  }

  const perm = await notify.requestPermission();
  if (perm !== "granted") {
    flash("Permesso negato: senza di esso non posso mandare avvisi.", "bad");
    return render();
  }

  notify.setWatchedCrossing(key);
  rearmNotifications();
  await notify.test(c);
  flash(`Ti avviso ${notify.leadMinutes()} minuti prima di ogni chiusura di ${c.name}. ` +
        "Funziona finché l'app resta aperta, anche in secondo piano: senza un server " +
        "le notifiche a app chiusa non sono possibili.", "ok");
  render();
}

function rearmNotifications() {
  const key = notify.watchedCrossing();
  const c = state.crossings.find((k) => `${state.area?.slug}:${k.id}` === key);
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

  // ci si riferisce alla finestra piu' vicina nel tempo, non alla "prossima":
  // chi preme il tasto e' davanti alle sbarre proprio adesso
  const now = Date.now();
  const w = [...c.windows].sort((a, b) =>
    Math.abs((a.pass ?? a.close) - now) - Math.abs((b.pass ?? b.close) - now))[0];

  const res = calib.record(`${state.area.slug}:${c.id}`, kind, w, now);
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

function wireControls() {
  $("refresh").onclick = () => refresh();

  $("theme").onclick = () => {
    const mode = theme.cycle();
    $("theme").title = theme.LABELS[mode];
    $("theme").setAttribute("aria-label", theme.LABELS[mode]);
  };

  $("allAreas").onclick = () => toggleAllAreas();

  $("areaBtn").onclick = () => {
    $("pickerSearch").value = "";
    renderPicker();
    $("picker").showModal();
  };

  $("pickerSearch").oninput = (e) => renderPicker(e.target.value);

  $("useLocation").onclick = () => {
    $("picker").close();
    if (state.usingFallback) {
      flash("Sto ancora cercando la posizione. Concedi il permesso al browser.", "bad");
      return;
    }
    const near = nearestArea(state.position);
    if (near) {
      try { localStorage.removeItem(AREA_KEY); } catch { /* ignorato */ }
      loadArea(near.slug, { remember: false });
    }
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

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.lastRefresh || Date.now() - state.lastRefresh > STALE_MS) refresh();
    else tick();
  });

  // la mappa va creata quando il suo contenitore ha gia' una dimensione
  if (gmap.init($("map"), { onSelect: (id) => selectCrossing(id, { scroll: true }) })) {
    window.addEventListener("resize", () => gmap.invalidate());
  }
}

function renderCalibSummary() {
  const active = state.crossings.filter((c) => c.calibration.close || c.calibration.open);
  $("calibSummary").textContent = active.length
    ? `Osservazioni registrate su ${active.length} ${active.length === 1 ? "passaggio a livello" : "passaggi a livello"} in questa zona.`
    : "Nessuna osservazione registrata in questa zona.";
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
