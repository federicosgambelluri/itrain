#!/usr/bin/env python3
"""
Costruisce data/timetable.json: l'orario teorico dei treni che passano per le
stazioni note, con l'ora di transito a ciascuna.

Serve come rete di sicurezza. Avendo scelto solo proxy pubblici, l'app deve
poter mostrare le chiusure previste anche quando nessun proxy risponde: in quel
caso usa questo file e avvisa che i ritardi reali non sono disponibili.

ViaggiaTreno non restituisce i treni gia' passati, quindi la giornata va
scansionata quando e' ancora tutta davanti: di default si guarda a domani.

Gli orari non arrivano da andamentoTreno (che risponde solo per i treni con
data di partenza odierna, e quindi non permette di guardare avanti) ma da
partenze/arrivi interrogati su ogni stazione della tratta: l'unione dei due
elenchi da', per ogni treno, l'ora di transito a ciascuna stazione. Sono le
due ancore fra cui l'app interpola il passaggio sul singolo PL.

Il file si costruisce per accumulo: ogni esecuzione fonde i treni visti con
quelli gia' noti e annota in quali giorni della settimana ciascuno circola,
cosi' dopo una settimana la distinzione feriale/festivo e' completa.
"""
import argparse, json, os, subprocess, sys, time
from datetime import datetime, timedelta

VT = "http://www.viaggiatreno.it/infomobilitamobile/resteasy/viaggiatreno"
OUT = "data/timetable.json"
GIORNI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"]


def get(path, tries=3):
    for n in range(tries):
        if n:
            time.sleep(2 * n)
        r = subprocess.run(["curl", "-s", "-m", "40", VT + path],
                           capture_output=True, text=True)
        body = r.stdout.strip()
        if body.startswith(("[", "{")):
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                pass
        if body == "":
            return []     # fascia oraria senza treni: risposta legittima, non un errore
    print(f"    ! {path[:60]} non risponde", file=sys.stderr)
    return []


def scan_day(day, stations):
    """Orari di transito di ogni treno a ogni stazione, ora per ora.

    partenze da' l'ora di partenza, arrivi quella di arrivo: per le stazioni
    intermedie servono entrambe, per i capolinea ne esiste una sola.
    """
    trains = {}
    calls = 0
    for code in stations:
        for hour in range(24):
            t = day.replace(hour=hour, minute=0, second=0, microsecond=0)
            stamp = t.strftime("%a %b %d %Y %H:%M:%S GMT+0200").replace(" ", "%20")
            for kind, field in (("partenze", "compOrarioPartenza"),
                                ("arrivi", "compOrarioArrivo")):
                calls += 1
                for tr in get(f"/{kind}/{code}/{stamp}"):
                    num = tr.get("numeroTreno")
                    when = tr.get(field)
                    if not num or not when:
                        continue
                    rec = trains.setdefault(num, {
                        "n": num, "cat": tr.get("categoria", ""),
                        "orig": tr.get("origine"), "dest": tr.get("destinazione"),
                        "stops": {},
                    })
                    # arrivi non porta la destinazione, partenze non porta l'origine
                    rec["orig"] = rec["orig"] or tr.get("origine")
                    rec["dest"] = rec["dest"] or tr.get("destinazione")
                    st = rec["stops"].setdefault(code, {"s": code, "a": None, "d": None})
                    st["d" if kind == "partenze" else "a"] = when
        print(f"  {stations[code]:18s} -> {len(trains)} treni noti "
              f"({calls} chiamate)", file=sys.stderr)
    return trains


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day-offset", type=int, default=1,
                    help="giorni nel futuro da scansionare (default: domani)")
    args = ap.parse_args()

    stations = {s["code"]: s["name"]
                for s in json.load(open("data/siderno.json"))["stations"]}
    day = datetime.now() + timedelta(days=args.day_offset)
    wd = day.weekday()
    print(f"Scansione del {day:%d/%m/%Y} ({GIORNI[wd]})...", file=sys.stderr)

    found = scan_day(day, stations)
    print(f"\n{len(found)} treni distinti sulla tratta", file=sys.stderr)

    known = {}
    if os.path.exists(OUT):
        known = {t["n"]: t for t in json.load(open(OUT)).get("trains", [])}
        print(f"  (parto da {len(known)} treni gia' noti)", file=sys.stderr)

    added = updated = skipped = 0
    for num, rec in found.items():
        stops = sorted(rec["stops"].values(), key=lambda x: x["d"] or x["a"] or "99:99")
        if len(stops) < 2:
            skipped += 1     # tocca una sola delle nostre stazioni: non interpolabile
            continue
        rec["stops"] = stops
        old_rec = known.get(num)
        if old_rec:
            days = old_rec.get("days", [])
            if wd not in days:
                days.append(wd)
                days.sort()
            rec["days"] = days
            updated += 1
        else:
            rec["days"] = [wd]
            added += 1
        known[num] = rec

    trains = sorted(known.values(),
                    key=lambda t: (t["stops"][0]["d"] or t["stops"][0]["a"] or "99:99"))
    payload = {
        "generated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "last_scan_day": day.strftime("%Y-%m-%d"),
        "note": ("Orari teorici di riferimento, accumulati su piu' giorni. "
                 "I ritardi reali arrivano da ViaggiaTreno quando un proxy risponde."),
        "trains": trains,
    }
    with open(OUT, "w") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    cov = {g: sum(1 for t in trains if i in t["days"]) for i, g in enumerate(GIORNI)}
    print(f"\n{OUT}: {len(trains)} treni totali "
          f"(+{added} nuovi, {updated} aggiornati, {skipped} fuori tratta), "
          f"{os.path.getsize(OUT)/1024:.0f} KB", file=sys.stderr)
    print(f"copertura per giorno: {cov}", file=sys.stderr)


if __name__ == "__main__":
    main()
