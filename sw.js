/**
 * Service worker: cache offline e supporto alle notifiche.
 *
 * I file dell'app si servono dalla cache e si aggiornano in sottofondo, cosi'
 * l'app si apre anche senza rete. Le chiamate ai proxy non si mettono mai in
 * cache: un ritardo di dieci minuti fa non serve a nessuno.
 */

const VERSION = "itrain-v1";
const SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/app.js",
  "js/predict.js",
  "js/trains.js",
  "js/rfi.js",
  "js/geo.js",
  "js/calibration.js",
  "js/notify.js",
  "js/theme.js",
  "data/siderno.json",
  "data/timetable.json",
  "manifest.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable.png",
  "icons/badge.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // proxy: sempre dalla rete

  // Rete per prima, cache come riserva: i dati statici vengono rigenerati
  // ogni notte e vale la pena prendere la versione fresca quando c'e' rete.
  e.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match("index.html"))),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("./");
    }),
  );
});
