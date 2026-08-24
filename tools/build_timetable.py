#!/usr/bin/env python3
"""
Costruisce data/timetable.json: l'orario teorico dei treni della Jonica, con
l'ora di transito a ogni stazione della tratta.

E' la rete di sicurezza dell'app. Avendo scelto solo proxy pubblici, quando
nessuno risponde l'app deve poter mostrare comunque le chiusure previste: in
quel caso usa questo file e dichiara che i ritardi reali non sono disponibili.

Perche' va eseguito di notte
----------------------------
ViaggiaTreno ha due limiti che insieme decidono la forma dello script:

  - partenze/arrivi non restituiscono i treni gia' passati;
  - andamentoTreno risponde solo per i treni con data di partenza odierna,
    quindi non si puo' guardare avanti di un giorno.

Eseguito a notte fonda entrambi i limiti spariscono: la giornata e' tutta
davanti, e andamentoTreno da' l'intero elenco delle fermate di ogni treno in
una sola chiamata. E' cio' che rende il costo indipendente dal numero di
stazioni: interrogarle tutte una per una ne richiederebbe oltre milleseicento.

Il file si costruisce per accumulo, annotando in quali giorni della settimana
ciascun treno circola: dopo una settimana di esecuzioni notturne la distinzione
feriale/festivo e' completa.
"""
import argparse, json, os, subprocess, sys, time
from datetime import datetime, timedelta

VT = "http://www.viaggiatreno.it/infomobilitamobile/resteasy/viaggiatreno"
OUT = "data/timetable.json"
LINE = "data/linea.json"
GIORNI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"]

# Quante stazioni usare come punti di raccolta dei treni. Non serve
# interrogarle tutte: ne bastano alcune distribuite lungo la linea, perche'
# ogni treno ne attraversa almeno una.
HUBS = 5


def get(path, tries=3):
    for n in range(tries):
        if n:
            time.sleep(2 * n)
        r = subprocess.run(["curl", "-s", "-m", "45", VT + path],
                           capture_output=True, text=True)
        body = r.stdout.strip()
        if body.startswith(("[", "{")):
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                pass
        if body == "":
            return []      # fascia oraria senza treni: risposta legittima
    print(f"    ! {path[:70]} non risponde", file=sys.stderr)
    return []


def hhmm(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%H:%M") if ms else None


def pick_hubs(stations):
    """Stazioni di raccolta, distribuite lungo la linea."""
    if len(stations) <= HUBS:
        return stations
    step = (len(stations) - 1) / (HUBS - 1)
    return [stations[round(i * step)] for i in range(HUBS)]


def collect_trains(day, hubs):
    """Elenca i treni della giornata interrogando i soli nodi di raccolta."""
    found = {}
    for hub in hubs:
        before = len(found)
        for hour in range(24):
            t = day.replace(hour=hour, minute=0, second=0, microsecond=0)
            stamp = t.strftime("%a %b %d %Y %H:%M:%S GMT+0200").replace(" ", "%20")
            for kind in ("partenze", "arrivi"):
                for tr in get(f"/{kind}/{hub['code']}/{stamp}"):
                    num, orig = tr.get("numeroTreno"), tr.get("codOrigine")
                    dpt = tr.get("dataPartenzaTreno")
                    if num and orig and dpt:
                        found[num] = (orig, dpt, tr.get("categoria", ""))
        print(f"  {hub['name']:32s} +{len(found)-before:3d} treni "
              f"(totale {len(found)})", file=sys.stderr)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day-offset", type=int, default=0,
                    help="0 = oggi (da eseguire di notte, e' il caso normale)")
    ap.add_argument("--reset", action="store_true",
                    help="riparte da zero invece di fondere con l'orario esistente")
    args = ap.parse_args()

    line = json.load(open(LINE))
    stations = line["stations"]
    codes = {s["code"] for s in stations}
    hubs = pick_hubs(stations)

    day = datetime.now() + timedelta(days=args.day_offset)
    wd = day.weekday()
    print(f"Scansione del {day:%d/%m/%Y} ({GIORNI[wd]}) su {len(hubs)} nodi "
          f"di raccolta, {len(codes)} stazioni note", file=sys.stderr)

    found = collect_trains(day, hubs)
    print(f"\n{len(found)} treni distinti, scarico le fermate...", file=sys.stderr)

    known = {}
    if os.path.exists(OUT) and not args.reset:
        known = {t["n"]: t for t in json.load(open(OUT)).get("trains", [])}
        print(f"  (parto da {len(known)} treni gia' noti)", file=sys.stderr)

    added = updated = skipped = 0
    for i, (num, (orig, dpt, cat)) in enumerate(sorted(found.items()), 1):
        d = get(f"/andamentoTreno/{orig}/{num}/{dpt}")
        if not d or not d.get("fermate"):
            skipped += 1
            continue
        stops = [{"s": f["id"],
                  "a": hhmm(f.get("arrivo_teorico")),
                  "d": hhmm(f.get("partenza_teorica"))}
                 for f in d["fermate"] if f.get("id") in codes]
        if len(stops) < 2:
            skipped += 1      # tocca al massimo una stazione nostra
            continue

        rec = known.get(num, {})
        days = rec.get("days", [])
        if wd not in days:
            days.append(wd)
            days.sort()
        known[num] = {"n": num, "cat": cat or d.get("categoria", ""),
                      "orig": d.get("origine"), "dest": d.get("destinazione"),
                      "days": days, "stops": stops}
        if rec:
            updated += 1
        else:
            added += 1
        if i % 10 == 0 or i == len(found):
            print(f"  [{i}/{len(found)}] ...", file=sys.stderr)

    trains = sorted(known.values(),
                    key=lambda t: (t["stops"][0]["d"] or t["stops"][0]["a"] or "99:99"))
    json.dump({
        "generated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "last_scan_day": day.strftime("%Y-%m-%d"),
        "stations": len(codes),
        "note": ("Orari teorici di riferimento, accumulati su piu' giorni. "
                 "I ritardi reali arrivano da ViaggiaTreno quando un proxy risponde."),
        "trains": trains,
    }, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))

    cov = {g: sum(1 for t in trains if i in t["days"]) for i, g in enumerate(GIORNI)}
    fermate = sum(len(t["stops"]) for t in trains) / max(len(trains), 1)
    print(f"\n{OUT}: {len(trains)} treni (+{added} nuovi, {updated} aggiornati, "
          f"{skipped} fuori tratta), {fermate:.1f} fermate medie, "
          f"{os.path.getsize(OUT)/1024:.0f} KB", file=sys.stderr)
    print(f"copertura per giorno: {cov}", file=sys.stderr)


if __name__ == "__main__":
    main()
