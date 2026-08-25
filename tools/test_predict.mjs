/**
 * Prova del motore di previsione sui dati di un'area, senza rete.
 *   node tools/test_predict.mjs [slug]
 */
import { readFileSync } from "node:fs";
import { scheduledTrains } from "../js/trains.js";
import { closuresFor, stateAt, STATE } from "../js/predict.js";

const slug = process.argv[2] ?? "jonica";
const area = JSON.parse(readFileSync(`data/aree/${slug}.json`, "utf8"));
const day = new Date();
day.setHours(6, 0, 0, 0);
const { trains } = scheduledTrains(area, day);
const hhmm = (t) => new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

const covered = area.crossings.filter((c) => c.covered !== false);
console.log(`${area.name}: ${trains.length} treni, ${area.crossings.length} PL ` +
            `(${covered.length} con previsione), ${Object.keys(area.segments).length} tratte\n`);

let zero = 0, sospette = 0, tot = 0;
const rows = [];
area.crossings.forEach((c, i) => {
  if (c.covered === false) return;
  const w = closuresFor(i, trains, area.segments, area.model, null);
  const mins = w.reduce((a, x) => a + (x.open - x.close) / 60000, 0);
  const worst = Math.max(0, ...w.map((x) => (x.open - x.close) / 60000));
  if (!w.length) zero++;
  if (worst > 25) sospette++;
  tot += w.length;
  rows.push({ n: c.name, w: w.length, mins: Math.round(mins), worst: Math.round(worst) });
});

rows.sort((a, b) => b.w - a.w);
for (const r of rows.slice(0, 6)) {
  console.log(`  ${r.n.slice(0, 30).padEnd(31)} ${String(r.w).padStart(3)} chiusure  ` +
              `${String(r.mins).padStart(3)} min/giorno  finestra max ${r.worst} min`);
}
console.log(`\nPL coperti senza alcuna chiusura: ${zero}`);
console.log(`finestre sospette (>25 min): ${sospette}`);
console.log(`media chiusure per PL coperto: ${(tot / Math.max(covered.length, 1)).toFixed(1)}`);

const c0 = area.crossings.findIndex((c) => c.covered !== false);
const w0 = closuresFor(c0, trains, area.segments, area.model, null);
console.log(`\nStato di "${area.crossings[c0].name}" durante la giornata:`);
for (const h of [6, 8, 13, 18, 21]) {
  const t = new Date(day); t.setHours(h, 25, 0, 0);
  const s = stateAt(w0, t.getTime());
  const et = { [STATE.CLOSED]: "CHIUSO", [STATE.CLOSING]: "IN CHIUSURA",
               [STATE.OPEN]: "APERTO", [STATE.UNKNOWN]: "IGNOTO" }[s.state];
  console.log(`  ${String(h).padStart(2, "0")}:25  ${et.padEnd(12)}` +
              (s.window ? ` prossima finestra ${hhmm(s.window.close)}–${hhmm(s.window.open)}` : ""));
}
