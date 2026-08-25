/**
 * Mappa dei passaggi a livello.
 *
 * Ha sostituito lo schema lineare della linea. Finche' l'app copriva una sola
 * ferrovia, una striscia orizzontale con le stazioni in fila la descriveva
 * bene; su un nodo come Bologna, dove convergono otto linee, quella
 * rappresentazione non significa piu' nulla. La mappa inoltre risponde a una
 * richiesta precisa: guardare una zona anche stando lontani.
 *
 * Leaflet e' incluso nel repository invece di essere preso da un CDN, cosi'
 * l'app non dipende da un servizio esterno per funzionare. Le piastrelle
 * arrivano da OpenStreetMap e quelle si', richiedono rete: senza, restano
 * i cerchi colorati su fondo neutro, che e' comunque leggibile.
 */

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const COLOUR = {
  open: "#22c55e",
  closing: "#f59e0b",
  closed: "#ef4444",
  unknown: "#64748b",
  nodata: "#64748b",
};

let map = null;
let layer = null;         // passaggi a livello della zona caricata, con lo stato
let others = null;        // tutti gli altri, senza stato
let userMark = null;
let markers = new Map();
let onSelect = null;
let onPickOther = null;
let otherPoints = null;   // [lat, lon, nome, zona, id, coperto]
let hasView = false;      // Leaflet non sa dare i confini finche' non ha un centro

export function isReady() {
  return Boolean(map);
}

/** Crea la mappa. Ritorna false se Leaflet non e' disponibile. */
export function init(el, { onSelect: cb } = {}) {
  if (map) return true;
  if (typeof L === "undefined") return false;

  onSelect = cb;
  map = L.map(el, {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: false,   // sulla pagina lo scroll deve scorrere, non zoomare
    tap: true,
  });
  map.on("click", () => {});
  L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIB }).addTo(map);
  others = L.layerGroup().addTo(map);   // sotto: sono di contorno
  layer = L.layerGroup().addTo(map);

  // Con quasi mille punti conviene disegnare solo quelli inquadrati:
  // ridisegnarli tutti a ogni spostamento renderebbe la mappa legnosa.
  map.on("moveend zoomend", () => drawOthers());

  // lo scroll zooma solo dopo un clic sulla mappa: e' il compromesso che
  // evita di intrappolare la pagina mentre si scorre col dito o la rotella
  map.on("focus", () => map.scrollWheelZoom.enable());
  map.on("blur", () => map.scrollWheelZoom.disable());
  return true;
}

export function invalidate() {
  map?.invalidateSize();
}

/** Inquadra un riquadro [sud, ovest, nord, est]. */
export function fitBbox(bbox, options = {}) {
  if (!map || !bbox) return;
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: [24, 24], ...options });
  hasView = true;
}

export function focusOn(lat, lon, zoom = 15) {
  if (!map) return;
  map.setView([lat, lon], zoom, { animate: true });
  hasView = true;
}

/**
 * Ridisegna i passaggi a livello.
 *
 * I cerchi si ricolorano al volo invece di essere ricreati: la mappa si
 * aggiorna ogni secondo e ricostruire i marcatori farebbe sfarfallare tutto.
 */
export function setCrossings(crossings, selectedId) {
  if (!map) return;

  const seen = new Set();
  for (const c of crossings) {
    seen.add(c.id);
    const colour = COLOUR[c.state] ?? COLOUR.unknown;
    const selected = c.id === selectedId;
    let m = markers.get(c.id);

    if (!m) {
      m = L.circleMarker([c.lat, c.lon], {
        radius: selected ? 11 : 8,
        weight: selected ? 3 : 2,
        color: "#ffffff",
        fillColor: colour,
        // i passaggi a livello senza dati restano visibili ma smorzati:
        // ci sono, semplicemente non se ne sa lo stato
        fillOpacity: c.state === "nodata" ? 0.45 : 0.95,
        className: "pl-marker",
      }).addTo(layer);
      m.on("click", () => onSelect?.(c.id));
      markers.set(c.id, m);
    }

    m.setStyle({ fillColor: colour, weight: selected ? 3 : 2,
                 fillOpacity: c.state === "nodata" ? 0.45 : 0.95 });
    m.setRadius(selected ? 11 : 8);
    m.bindTooltip(`${c.name} — ${c.label}`, { direction: "top", offset: [0, -6] });
    if (selected) m.bringToFront();
  }

  for (const [id, m] of markers) {
    if (!seen.has(id)) {
      layer.removeLayer(m);
      markers.delete(id);
    }
  }
}

/**
 * Accende o spegne la vista d'insieme.
 *
 * I passaggi a livello delle altre zone si mostrano senza stato: per sapere se
 * sono aperti servirebbe l'orario dei treni della loro zona, che si scarica
 * solo quando se ne tocca uno. Meglio un puntino grigio onesto che un colore
 * inventato.
 */
export function setOthers(points, onPick) {
  otherPoints = points;
  onPickOther = onPick;
  drawOthers();
}

export function clearOthers() {
  otherPoints = null;
  others?.clearLayers();
}

/** Quanti punti al massimo disegnare insieme, per non impastare la mappa. */
const MAX_OTHERS = 600;

function drawOthers() {
  // senza un centro impostato Leaflet non puo' dire cosa e' inquadrato
  if (!map || !others || !hasView) return;
  others.clearLayers();
  if (!otherPoints) return;

  const b = map.getBounds();
  const z = map.getZoom();
  const r = z >= 13 ? 6 : z >= 10 ? 4.5 : 3.5;

  let n = 0;
  for (const [lat, lon, nome, zona, id, coperto] of otherPoints) {
    if (!b.contains([lat, lon])) continue;
    if (++n > MAX_OTHERS) break;
    const m = L.circleMarker([lat, lon], {
      radius: r,
      weight: 1,
      color: "#ffffff",
      opacity: 0.55,
      fillColor: coperto ? "#94a3bd" : "#475569",
      fillOpacity: coperto ? 0.75 : 0.4,
      className: "other-marker",
    }).addTo(others);
    m.bindTooltip(`${nome} — tocca per aprire questa zona`,
                  { direction: "top", offset: [0, -4] });
    m.on("click", () => onPickOther?.(zona, id));
  }
  return n;
}

/** Quanti punti d'insieme sono attualmente inquadrati. */
export function othersInView() {
  if (!map || !otherPoints || !hasView) return 0;
  const b = map.getBounds();
  return otherPoints.reduce((k, p) => k + (b.contains([p[0], p[1]]) ? 1 : 0), 0);
}

export function setUser(lat, lon) {
  if (!map) return;
  if (!userMark) {
    userMark = L.circleMarker([lat, lon], {
      radius: 7, weight: 3, color: "#38bdf8",
      fillColor: "#38bdf8", fillOpacity: 0.35, className: "user-marker",
    }).addTo(map);
    userMark.bindTooltip("Sei qui", { direction: "top", offset: [0, -6] });
  } else {
    userMark.setLatLng([lat, lon]);
  }
}

/** Svuota i marcatori: serve quando si cambia area. */
export function clear() {
  layer?.clearLayers();
  markers.clear();
}
