/** Verifica del motore di previsione sui dati reali, senza rete. */
import { readFileSync } from "node:fs";
import { scheduledTrains } from "../js/trains.js";
import { closuresFor, stateAt, STATE } from "../js/predict.js";

const geo = JSON.parse(readFileSync("data/linea.json", "utf8"));
const tt = JSON.parse(readFileSync("data/timetable.json", "utf8"));
const chain = new Map(geo.stations.map((s) => [s.code, s.chainage]));

// domani (martedi'): e' il giorno gia' coperto dall'orario statico
const day = new Date();
day.setDate(day.getDate() + 1);
day.setHours(6, 0, 0, 0);

const { trains, exact } = scheduledTrains(tt, day);
console.log(`${trains.length} treni per ${day.toLocaleDateString("it-IT",{weekday:"long"})}` +
            ` (giorno coperto dall'orario: ${exact})\n`);

const hhmm = (t) => new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
const siderno = geo.crossings.filter((c) => c.between.includes("S11850"));
console.log(`linea: ${geo.crossings.length} PL su ${geo.stations.length} stazioni\n`);

for (const pl of siderno) {
  const w = closuresFor(pl, trains, chain, geo.model, null);
  const dist = Math.round(Math.abs(pl.chainage - chain.get("S11850")));
  console.log(`\n=== ${pl.name}  (${dist} m dalla stazione)  ${w.length} chiusure previste`);
  let totale = 0;
  for (const x of w) totale += (x.open - x.close) / 1000;
  for (const x of w.slice(0, 5)) {
    const secs = Math.round((x.open - x.close) / 1000);
    const who = x.trains.map((t) => `${t.label}→${t.destination ?? "?"}`).join(" + ");
    console.log(`   ${hhmm(x.close)} - ${hhmm(x.open)}  (${secs}s)  ` +
                `transito ${hhmm(x.pass)} a ${(x.speed * 3.6).toFixed(0)} km/h  ${x.merged ? "[FUSA] " : ""}${who}`);
  }
  console.log(`   ... totale giornata: ${(totale / 60).toFixed(0)} minuti di sbarre chiuse`);
}

// stato a un istante scelto
const pl = siderno.find((c) => c.name === "Via Genova");
const w = closuresFor(pl, trains, chain, geo.model, null);
console.log(`\n\n=== Stato di ${pl.name} in vari momenti della giornata`);
for (const h of [6, 7, 9, 13, 18]) {
  for (const m of [22, 40]) {
    const t = new Date(day); t.setHours(h, m, 0, 0);
    const s = stateAt(w, t.getTime());
    const etichetta = { [STATE.CLOSED]: "CHIUSO", [STATE.CLOSING]: "IN CHIUSURA",
                        [STATE.OPEN]: "APERTO", [STATE.UNKNOWN]: "IGNOTO" }[s.state];
    const det = s.seconds == null ? "" :
      s.state === STATE.CLOSED ? `riapre fra ${Math.ceil(s.seconds / 60)} min`
                               : `prossima chiusura fra ${Math.ceil(s.seconds / 60)} min (${hhmm(s.window.close)})`;
    console.log(`   ${String(h).padStart(2,"0")}:${m}  ${etichetta.padEnd(12)} ${det}`);
  }
}
