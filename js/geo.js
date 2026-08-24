/** Utilita' geografiche. */

const R = 6371008.8;

/** Distanza in metri fra due coordinate. */
export function haversine(aLat, aLon, bLat, bLon) {
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((bLon - aLon) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Distanza leggibile: metri sotto il chilometro, chilometri sopra. */
export function formatDistance(m) {
  if (m == null) return "—";
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`;
}

/** Posizione corrente, una lettura sola. */
export function currentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geolocalizzazione non disponibile"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 30000,
      ...options,
    });
  });
}

/** Posizione seguita nel tempo. Ritorna la funzione per smettere. */
export function watchPosition(onUpdate, onError) {
  if (!navigator.geolocation) {
    onError?.(new Error("geolocalizzazione non disponibile"));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(onUpdate, onError, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 15000,
  });
  return () => navigator.geolocation.clearWatch(id);
}
