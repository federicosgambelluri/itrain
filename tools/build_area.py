#!/usr/bin/env python3
"""
Costruisce i dati di un'area: data/aree/<slug>.json.

Un'area contiene le stazioni, i passaggi a livello, l'orario dei treni e --
il pezzo che tiene insieme tutto -- le *tratte*: per ogni coppia di stazioni
consecutive, quanti metri di binario le separano e quali passaggi a livello ci
stanno in mezzo, a che distanza dalla prima.

Perche' le tratte e non le progressive
--------------------------------------
Sulla Jonica bastava una progressiva chilometrica, perche' la linea era una
sola. A Bologna no: ci convergono otto linee, la stazione centrale sta su
tutte, e una progressiva unica non esiste. Con le tratte il problema non si
pone: si misura lungo il percorso che il treno fa davvero, ricavato dal grafo
dei binari, e la stessa struttura descrive tanto una linea isolata quanto un
nodo complesso.

Va eseguito di notte: la scansione dell'orario usa andamentoTreno, che
risponde solo per i treni con data di partenza odierna.
"""
import argparse, json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rete import (Graph, overpass, vt, haversine, resolve_code, dedupe_by_code)

AREE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aree.json")
OUTDIR = "data/aree"
INDEX = "data/aree.json"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
GIORNI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"]

# Alcuni PL stanno su tratti stradali senza tag "name" in OpenStreetMap.
# Qui si corregge a mano il nome mostrato: e' anche il posto giusto per
# sistemare un nome sbagliato dopo una verifica sul campo.
NAME_OVERRIDES = {
    1820420755: "Via Cristoforo Colombo",   # Siderno, presso Piazza Portosalvo
}

MERGE_WITHIN = 45      # nodi PL piu' vicini di cosi' sono lo stesso attraversamento
SNAP_STATION = 400     # quanto lontano cercare il binario sotto una stazione

# Margine oltre il confine della zona per binari e stazioni.
#
# I passaggi a livello si elencano dentro il confine, ma il percorso di un
# treno che li attraversa spesso comincia o finisce fuori: ritagliando tutto
# sul confine, i PL vicino al bordo resterebbero senza tratta e verrebbero
# dichiarati "senza dati" pur essendo su linee coperte. Circa tredici
# chilometri bastano a chiudere le tratte di confine senza tirare dentro
# mezza regione.
BUFFER_DEG = 0.12

MODEL = {
    "lead_close_s": 150,
    "lead_open_s": 40,
    "accel": 0.5,
    "vmax_ms": round(160 / 3.6, 2),
    "vmax_note": "limite di sicurezza del modello, non velocita' effettiva",
}


def selector(area):
    """Frammento Overpass che delimita la zona, per confine o per riquadro."""
    if area.get("osm_area"):
        return (f'area["admin_level"="{area.get("admin_level","6")}"]'
                f'["name"="{area["osm_area"]}"]->.p;', "(area.p)")
    s, w, n, e = area["bbox"]
    return "", f"({s},{w},{n},{e})"


def wide_bbox(area):
    """Riquadro della zona allargato del margine, per binari e stazioni."""
    if area.get("bbox"):
        s, w, n, e = area["bbox"]
    else:
        r = overpass(f'[out:json][timeout:120];'
                     f'rel["admin_level"="{area.get("admin_level","6")}"]'
                     f'["boundary"="administrative"]["name"="{area["osm_area"]}"];out bb;')
        b = r["elements"][0]["bounds"]
        s, w, n, e = b["minlat"], b["minlon"], b["maxlat"], b["maxlon"]
    return (round(s - BUFFER_DEG, 4), round(w - BUFFER_DEG, 4),
            round(n + BUFFER_DEG, 4), round(e + BUFFER_DEG, 4))


# ------------------------------------------------------------------ #

def fetch_ways(area, use_cache):
    path = os.path.join(CACHE, f"{area['slug']}-ways.json")
    if use_cache and os.path.exists(path):
        print("  (uso la copia locale dei binari)", file=sys.stderr)
        return json.load(open(path))["elements"]

    s, w, n, e = wide_bbox(area)
    try:
        data = overpass(f'[out:json][timeout:280];'
                        f'way["railway"~"^(rail|light_rail|narrow_gauge)$"]'
                        f'({s},{w},{n},{e});out body geom;')
    except RuntimeError:
        # Overpass limita le richieste ravvicinate e su una serie di zone
        # capita di essere respinti. Una copia locale, anche di ieri, e'
        # meglio che interrompere l'aggiornamento di tutta la zona: i binari
        # cambiano molto piu' lentamente degli orari.
        if os.path.exists(path):
            print("  Overpass non risponde: uso la copia locale dei binari",
                  file=sys.stderr)
            return json.load(open(path))["elements"]
        raise

    os.makedirs(CACHE, exist_ok=True)
    json.dump(data, open(path, "w"))
    return data["elements"]


def fetch_nodes(area, use_cache=False):
    """PL dentro il confine; stazioni anche oltre, per chiudere le tratte."""
    path = os.path.join(CACHE, f"{area['slug']}-nodes.json")
    if use_cache and os.path.exists(path):
        print("  (uso la copia locale di stazioni e PL)", file=sys.stderr)
        return json.load(open(path))

    head, scope = selector(area)
    xs = overpass(f'[out:json][timeout:280];{head}'
                  f'node["railway"="level_crossing"]{scope};out body;')["elements"]
    time.sleep(3)
    s, w, n, e = wide_bbox(area)
    st = overpass(f'[out:json][timeout:280];'
                  f'( node["railway"="station"]({s},{w},{n},{e});'
                  f'  node["railway"="halt"]({s},{w},{n},{e}); );'
                  f'out body;')["elements"]
    out = xs + st
    os.makedirs(CACHE, exist_ok=True)
    json.dump(out, open(path, "w"))
    return out


def road_names(ids):
    """Nome della strada attraversata, dalle way stradali che passano sul nodo."""
    out = {}
    for i in range(0, len(ids), 120):
        chunk = ",".join(str(x) for x in ids[i:i + 120])
        time.sleep(4)
        try:
            rr = overpass(f'[out:json][timeout:200];node(id:{chunk})->.p;'
                          f'way(bn.p)["highway"];out body;')
            for el in rr.get("elements", []):
                nm = el.get("tags", {}).get("name") or el.get("tags", {}).get("ref")
                if el.get("type") == "way" and nm:
                    for nid in el.get("nodes", []):
                        out.setdefault(nid, nm)
        except Exception as ex:
            print(f"  (nomi strade non recuperati per un blocco: {ex})", file=sys.stderr)
    return out


def running_line_nodes(ways):
    """Nodi che stanno su una linea di corsa, non su un binario di servizio.

    Serve a scartare i passaggi a livello dei fasci merci e dei raccordi
    industriali -- attorno al porto di Gioia Tauro ce ne sono decine -- che
    nessun treno passeggeri attraversa e di cui non si sapra' mai nulla.
    Restano invece quelli delle linee vere, comprese quelle di operatori i cui
    treni non sono pubblicati: quelli vanno mostrati e dichiarati.
    """
    ok = set()
    for w in ways:
        t = w.get("tags", {})
        if t.get("railway") != "rail":
            continue
        if t.get("service"):
            continue
        if t.get("usage") == "industrial":
            continue
        ok.update(w.get("nodes", []))
    return ok


def cluster_crossings(raw, roads):
    """Fonde i nodi che descrivono lo stesso attraversamento stradale.

    OpenStreetMap mette un nodo per ogni binario attraversato: per chi guida
    sono un unico passaggio a livello. Si conservano pero' tutti gli id, perche'
    il treno puo' passare su uno qualsiasi di quei binari e il riconoscimento
    lungo il percorso deve funzionare comunque.
    """
    raw = sorted(raw, key=lambda x: (x["lat"], x["lon"]))
    used = [False] * len(raw)
    out = []
    for i, a in enumerate(raw):
        if used[i]:
            continue
        group = [a]
        used[i] = True
        for j in range(i + 1, len(raw)):
            if used[j]:
                continue
            if raw[j]["lat"] - a["lat"] > 0.001:
                break
            if haversine((a["lat"], a["lon"]), (raw[j]["lat"], raw[j]["lon"])) < MERGE_WITHIN:
                group.append(raw[j])
                used[j] = True
        name = next((NAME_OVERRIDES.get(g["id"]) for g in group
                     if NAME_OVERRIDES.get(g["id"])), None) \
            or next((roads.get(g["id"]) for g in group if roads.get(g["id"])), None)
        barrier = next((g["tags"].get("crossing:barrier") for g in group
                        if g["tags"].get("crossing:barrier") == "full"), None) \
            or next((g["tags"].get("crossing:barrier") for g in group
                     if g["tags"].get("crossing:barrier")), None)
        out.append({
            "nodes": [g["id"] for g in group],
            "lat": round(sum(g["lat"] for g in group) / len(group), 6),
            "lon": round(sum(g["lon"] for g in group) / len(group), 6),
            "road": name, "barrier": barrier,
        })
    return out


# ------------------------------------------------------------------ #

def scan_timetable(day, hubs, codes):
    """Treni della giornata e loro fermate, dai soli nodi di raccolta."""
    found = {}
    for hub in hubs:
        before = len(found)
        for hour in range(24):
            t = day.replace(hour=hour, minute=0, second=0, microsecond=0)
            stamp = t.strftime("%a %b %d %Y %H:%M:%S GMT+0200").replace(" ", "%20")
            for kind in ("partenze", "arrivi"):
                for tr in vt(f"/{kind}/{hub['code']}/{stamp}"):
                    num, orig = tr.get("numeroTreno"), tr.get("codOrigine")
                    dpt = tr.get("dataPartenzaTreno")
                    if num and orig and dpt:
                        found[num] = (orig, dpt, tr.get("categoria", ""))
        print(f"  {hub['name'][:30]:31s} +{len(found)-before:4d} (totale {len(found)})",
              file=sys.stderr)

    print(f"\n  {len(found)} treni distinti, scarico le fermate...", file=sys.stderr)
    hhmm = lambda ms: datetime.fromtimestamp(ms / 1000).strftime("%H:%M") if ms else None
    trains, skipped = [], 0
    for i, (num, (orig, dpt, cat)) in enumerate(sorted(found.items()), 1):
        d = vt(f"/andamentoTreno/{orig}/{num}/{dpt}")
        if not d or not d.get("fermate"):
            skipped += 1
            continue
        stops = [{"s": f["id"], "a": hhmm(f.get("arrivo_teorico")),
                  "d": hhmm(f.get("partenza_teorica"))}
                 for f in d["fermate"] if f.get("id") in codes]
        if len(stops) < 2:
            skipped += 1
            continue
        trains.append({"n": num, "cat": cat or d.get("categoria", ""),
                       "orig": d.get("origine"), "dest": d.get("destinazione"),
                       "stops": stops})
        if i % 50 == 0:
            print(f"    [{i}/{len(found)}]", file=sys.stderr)
    print(f"  {len(trains)} treni sulla rete, {skipped} fuori area", file=sys.stderr)
    return trains


def build_segments(trains, stations, xings, graph):
    """Per ogni coppia di stazioni consecutive: metri di binario e PL in mezzo."""
    node_of = {}
    for st in stations:
        nid, d = graph.nearest((st["lat"], st["lon"]), SNAP_STATION)
        if nid:
            node_of[st["code"]] = nid
        else:
            print(f"    ! {st['name']}: nessun binario entro {SNAP_STATION} m",
                  file=sys.stderr)

    # da id nodo OSM all'indice del passaggio a livello
    xing_of_node = {}
    for idx, x in enumerate(xings):
        for nid in x["nodes"]:
            xing_of_node[nid] = idx

    pairs = set()
    for t in trains:
        for a, b in zip(t["stops"], t["stops"][1:]):
            if a["s"] in node_of and b["s"] in node_of and a["s"] != b["s"]:
                pairs.add((a["s"], b["s"]))
    print(f"  {len(pairs)} tratte distinte da calcolare", file=sys.stderr)

    segments, failed = {}, 0
    for k, (a, b) in enumerate(sorted(pairs), 1):
        chain, metres = graph.path(node_of[a], node_of[b])
        if not chain:
            failed += 1
            continue
        found, run, seen = [], 0.0, set()
        for i, nid in enumerate(chain):
            if i:
                run += haversine(graph.pos[chain[i - 1]], graph.pos[nid])
            idx = xing_of_node.get(nid)
            if idx is not None and idx not in seen:
                seen.add(idx)
                found.append([idx, round(run, 1)])
        segments[f"{a}>{b}"] = {"m": round(metres, 1), "x": found}
        if k % 100 == 0:
            print(f"    [{k}/{len(pairs)}]", file=sys.stderr)

    covered = {i for seg in segments.values() for i, _ in seg["x"]}
    print(f"  {len(segments)} tratte calcolate ({failed} senza percorso), "
          f"{len(covered)}/{len(xings)} PL raggiunti da almeno un treno",
          file=sys.stderr)
    return segments, covered


# ------------------------------------------------------------------ #

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--day-offset", type=int, default=0)
    ap.add_argument("--cache-ways", action="store_true",
                    help="riusa i binari gia' scaricati invece di riscaricarli")
    ap.add_argument("--keep-timetable", action="store_true",
                    help="riusa l'orario del file esistente invece di riscansionare")
    args = ap.parse_args()

    aree = {a["slug"]: a for a in json.load(open(AREE))}
    if args.slug not in aree:
        sys.exit(f"area sconosciuta: {args.slug}. Disponibili: {', '.join(aree)}")
    area = aree[args.slug]
    print(f"=== {area['name']} ({area['region']}) ===", file=sys.stderr)

    print("Scarico i binari...", file=sys.stderr)
    ways = fetch_ways(area, args.cache_ways)
    graph = Graph.from_ways(ways)
    graph.index()
    print(f"  {len(ways)} way -> grafo di {len(graph.pos)} nodi", file=sys.stderr)

    print("Scarico stazioni e passaggi a livello...", file=sys.stderr)
    time.sleep(3)
    try:
        nodes = fetch_nodes(area, args.cache_ways)
    except RuntimeError:
        path = os.path.join(CACHE, f"{area['slug']}-nodes.json")
        if not os.path.exists(path):
            raise
        print("  Overpass non risponde: uso la copia locale dei nodi", file=sys.stderr)
        nodes = json.load(open(path))
    raw_x = [n for n in nodes if n["tags"].get("railway") == "level_crossing"]
    raw_s = [n for n in nodes if n["tags"].get("railway") in ("station", "halt")
             and n["tags"].get("name")]
    print(f"  {len(raw_x)} nodi PL, {len(raw_s)} stazioni", file=sys.stderr)

    running = running_line_nodes(ways)
    dropped = [x for x in raw_x if x["id"] not in running]
    raw_x = [x for x in raw_x if x["id"] in running]
    if dropped:
        print(f"  {len(dropped)} nodi PL su binari di servizio o raccordi "
              f"industriali, esclusi", file=sys.stderr)

    print("Recupero i nomi delle strade...", file=sys.stderr)
    roads = road_names([x["id"] for x in raw_x])
    xings = cluster_crossings(raw_x, roads)
    print(f"  -> {len(xings)} attraversamenti distinti", file=sys.stderr)

    print(f"Abbino {len(raw_s)} stazioni a ViaggiaTreno...", file=sys.stderr)
    memo_path = os.path.join(CACHE, f"{area['slug']}-stazioni.json")
    memo = json.load(open(memo_path)) if os.path.exists(memo_path) else {}
    cache, matched, unmatched = {}, [], []
    for i, el in enumerate(raw_s, 1):
        k = str(el["id"])
        if k not in memo:
            got = resolve_code(el["tags"]["name"], (el["lat"], el["lon"]), cache)
            memo[k] = ([got[0], round(got[1], 1) if got[1] is not None else None, got[3]]
                       if got else None)
            if i % 20 == 0:
                print(f"  [{i}/{len(raw_s)}] {len(matched)} abbinate", file=sys.stderr)
        if memo[k]:
            code, dist, verified = (memo[k] + [True])[:3]
            matched.append({"code": code, "match_m": dist, "verified": verified,
                            "name": el["tags"]["name"],
                            "lat": el["lat"], "lon": el["lon"]})
        else:
            unmatched.append(el["tags"]["name"])
    os.makedirs(CACHE, exist_ok=True)
    json.dump(memo, open(memo_path, "w"))
    stations, dropped = dedupe_by_code(matched)
    stations.sort(key=lambda x: x["name"])
    n_nome = sum(1 for s in stations if s.get("verified") is False)
    print(f"  {len(stations)} stazioni con codice "
          f"({n_nome} abbinate sul solo nome, senza coordinate pubblicate), "
          f"{len(unmatched)+len(dropped)} escluse", file=sys.stderr)

    day = datetime.now() + timedelta(days=args.day_offset)
    prev_path = f"{OUTDIR}/{area['slug']}.json"
    if args.keep_timetable and os.path.exists(prev_path):
        prev = json.load(open(prev_path))
        trains = prev["trains"]
        day = datetime.strptime(prev["day"], "%Y-%m-%d")
        print(f"\nRiuso l'orario del {prev['day']}: {len(trains)} treni",
              file=sys.stderr)
    else:
        print(f"\nOrario del {day:%d/%m/%Y} ({GIORNI[day.weekday()]}):", file=sys.stderr)
        codes = {s["code"] for s in stations}
        if args.day_offset > 0:
            trains = scan_future_day(day, stations, codes)
        else:
            trains = scan_with_coverage(day, stations, graph,
                                        area.get("hubs", 6), codes)

    print("\nCalcolo le tratte sul grafo...", file=sys.stderr)
    segments, covered = build_segments(trains, stations, xings, graph)

    # I passaggi a livello che nessun treno attraversa restano nell'elenco,
    # segnati come non coperti.
    #
    # Farli sparire sarebbe la scelta comoda e quella sbagliata: a Bologna sono
    # la maggioranza, perche' le linee Portomaggiore e Vignola e la tratta
    # Bologna-Porretta sono esercite su infrastruttura FER e i loro treni non
    # compaiono su ViaggiaTreno. Chi apre l'app davanti a uno di quei passaggi
    # deve leggere "non ho i dati", non trovare il nulla e concludere che la
    # zona sia coperta.
    # Un treno che non attraversa nessun passaggio a livello non serve a
    # niente: occupa spazio nel file che il telefono deve scaricare. Si tengono
    # solo quelli che percorrono almeno una tratta con un PL sopra.
    utili = {k for k, seg in segments.items() if seg["x"]}
    prima = len(trains)
    trains = [t for t in trains
              if any(f'{a["s"]}>{b["s"]}' in utili
                     for a, b in zip(t["stops"], t["stops"][1:]))]
    segments = {k: v for k, v in segments.items() if v["x"]}
    print(f"  treni utili: {len(trains)} su {prima}; "
          f"tratte con almeno un PL: {len(segments)}", file=sys.stderr)

    # e le stazioni che nessuna tratta utile tocca
    vive = {c for k in segments for c in k.split(">")}
    stations = [s for s in stations if s["code"] in vive]

    for i, x in enumerate(xings):
        x["covered"] = i in covered
        x["_i"] = i

    seen = {}
    xings.sort(key=lambda x: (not x["covered"], x["lat"]))
    remap = {}
    for new_i, x in enumerate(xings):
        remap[x["_i"]] = new_i
    for seg in segments.values():
        seg["x"] = [[remap[i], d] for i, d in seg["x"]]

    def near_station(x):
        best = None
        for st in stations:
            d = haversine((x["lat"], x["lon"]), (st["lat"], st["lon"]))
            if best is None or d < best[1]:
                best = (st["name"], d)
        return best

    for x in xings:
        x.pop("_i", None)
        base = x.pop("road", None)
        if base:
            nm = base
        else:
            # Senza nome della strada, "Passaggio a livello" sarebbe uguale per
            # tutti e inutile in elenco: si usa la stazione piu' vicina.
            st = near_station(x)
            nm = f"PL presso {st[0]}" if st else "Passaggio a livello"
            base = nm
        slug = "pl-" + "".join(c.lower() if c.isalnum() else "-" for c in base).strip("-")
        seen[slug] = seen.get(slug, 0) + 1
        x["id"] = slug if seen[slug] == 1 else f"{slug}-{seen[slug]}"
        x["name"] = nm
        x.pop("nodes", None)

    n_cov = sum(1 for x in xings if x["covered"])
    lats = [x["lat"] for x in xings] or [s["lat"] for s in stations]
    lons = [x["lon"] for x in xings] or [s["lon"] for s in stations]
    payload = {
        "slug": area["slug"], "name": area["name"], "region": area["region"],
        "generated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "day": day.strftime("%Y-%m-%d"), "weekday": day.weekday(),
        "bbox": [min(lats), min(lons), max(lats), max(lons)],
        "stations": [{k: s[k] for k in ("code", "name", "lat", "lon")} for s in stations],
        "crossings": xings,
        "covered": n_cov,
        "segments": segments,
        "trains": trains,
        "model": MODEL,
    }
    os.makedirs(OUTDIR, exist_ok=True)
    out = f"{OUTDIR}/{area['slug']}.json"
    json.dump(payload, open(out, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"\n{out}: {len(stations)} stazioni, {len(xings)} PL "
          f"({n_cov} con previsione, {len(xings)-n_cov} senza dati treno), "
          f"{len(segments)} tratte, {len(trains)} treni, "
          f"{os.path.getsize(out)/1024:.0f} KB", file=sys.stderr)
    update_index()


def pick_hubs(stations, graph, n):
    """Stazioni da cui enumerare i treni.

    La sola distribuzione geografica non basta: su Bologna sceglieva due
    fermate della Porrettana e ignorava la stazione centrale, perdendo quasi
    tutti i treni. Si combinano allora due criteri: quanti binari ci sono
    attorno alla stazione -- che distingue un nodo da una fermata di campagna --
    e la distribuzione sul territorio, perche' le stazioni grandi tendono a
    stare tutte vicine.
    """
    if len(stations) <= n:
        return list(stations)

    for st in stations:
        near = graph.nearest((st["lat"], st["lon"]), 500)[0]
        st["_size"] = 0 if near is None else sum(
            1 for nid, p in graph.pos.items()
            if abs(p[0] - st["lat"]) < 0.004 and abs(p[1] - st["lon"]) < 0.005)

    big = sorted(stations, key=lambda s: -s["_size"])
    chosen = [big[0]]                      # il nodo principale non puo' mancare
    for st in sorted(stations, key=lambda s: (s["lat"], s["lon"])):
        if len(chosen) >= n:
            break
        if all(haversine((st["lat"], st["lon"]), (c["lat"], c["lon"])) > 6000
               for c in chosen):
            chosen.append(st)
    for st in big:                         # se restano posti, i piu' grandi
        if len(chosen) >= n:
            break
        if st not in chosen:
            chosen.append(st)
    return chosen


# Passi di 90 minuti: e' all'incirca la finestra che partenze/arrivi
# restituiscono, quindi le fasce si toccano senza lasciare buchi.
SLOT_MIN = 90
WORKERS = 4      # ViaggiaTreno tollera qualche richiesta in parallelo, non molte


def scan_future_day(day, stations, codes):
    """Orario di un giorno futuro, interrogando ogni stazione.

    E' la via alternativa a quella notturna. andamentoTreno restituisce tutte
    le fermate di un treno in una chiamata sola, ma risponde solo per i treni
    con data di partenza odierna: per guardare avanti di un giorno resta solo
    partenze/arrivi stazione per stazione, che e' piu' costoso ma funziona
    sempre. L'unione dei due elenchi da', per ogni treno, l'ora di transito a
    ciascuna stazione: sono le ancore fra cui il motore interpola.
    """
    slots = []
    t = day.replace(hour=0, minute=0, second=0, microsecond=0)
    while t.day == day.day:
        slots.append(t.strftime("%a %b %d %Y %H:%M:%S GMT+0200").replace(" ", "%20"))
        t += timedelta(minutes=SLOT_MIN)

    jobs = [(st, slot, kind, field)
            for st in stations
            for slot in slots
            for kind, field in (("partenze", "compOrarioPartenza"),
                                ("arrivi", "compOrarioArrivo"))]
    print(f"  {len(stations)} stazioni x {len(slots)} fasce = {len(jobs)} chiamate",
          file=sys.stderr)

    trains = {}
    done = 0

    def fetch(job):
        st, slot, kind, field = job
        return st, field, vt(f"/{kind}/{st['code']}/{slot}")

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for st, field, rows in pool.map(fetch, jobs):
            done += 1
            if done % 400 == 0:
                print(f"    [{done}/{len(jobs)}] {len(trains)} treni", file=sys.stderr)
            for tr in rows:
                num, when = tr.get("numeroTreno"), tr.get(field)
                if not num or not when:
                    continue
                rec = trains.setdefault(num, {
                    "n": num, "cat": tr.get("categoria", ""),
                    "orig": tr.get("origine"), "dest": tr.get("destinazione"),
                    "_stops": {},
                })
                # arrivi non porta la destinazione, partenze non porta l'origine
                rec["orig"] = rec["orig"] or tr.get("origine")
                rec["dest"] = rec["dest"] or tr.get("destinazione")
                slot_st = rec["_stops"].setdefault(st["code"], {"s": st["code"],
                                                               "a": None, "d": None})
                slot_st["d" if field == "compOrarioPartenza" else "a"] = when

    out = []
    for rec in trains.values():
        stops = sorted(rec.pop("_stops").values(),
                       key=lambda x: x["d"] or x["a"] or "99:99")
        if len(stops) >= 2:
            rec["stops"] = stops
            out.append(rec)
    print(f"  {len(out)} treni sulla rete ({len(trains)-len(out)} con una sola "
          f"fermata nota)", file=sys.stderr)
    return out


def scan_with_coverage(day, stations, graph, n_hubs, codes):
    """Scansione in due fasi.

    Prima si interrogano pochi nodi scelti, che raccolgono la gran parte dei
    treni. Poi si controlla quali stazioni non compaiono in nessuno dei treni
    trovati: sono quelle servite da linee che i nodi non intercettano, e si
    interrogano direttamente. Cosi' la copertura si completa da sola senza
    dover interrogare tutte le stazioni, che costerebbe migliaia di chiamate.
    """
    hubs = pick_hubs(stations, graph, n_hubs)
    print(f"  nodi scelti: {', '.join(h['name'][:22] for h in hubs)}", file=sys.stderr)
    trains = scan_timetable(day, hubs, codes)

    served = {s["s"] for t in trains for s in t["stops"]}
    missing = [s for s in stations if s["code"] not in served]
    if not missing:
        return trains

    print(f"\n  {len(missing)} stazioni non ancora raggiunte, le interrogo:",
          file=sys.stderr)
    extra = scan_timetable(day, missing, codes)
    known = {t["n"] for t in trains}
    added = [t for t in extra if t["n"] not in known]
    print(f"  +{len(added)} treni recuperati", file=sys.stderr)
    return trains + added


def update_index():
    """Riscrive l'elenco delle aree disponibili leggendo i file generati."""
    definizioni = {a["slug"]: a for a in json.load(open(AREE))}
    areas = []
    for fn in sorted(os.listdir(OUTDIR)):
        if not fn.endswith(".json"):
            continue
        d = json.load(open(f"{OUTDIR}/{fn}"))
        if definizioni.get(d["slug"], {}).get("default"):
            d["default"] = True
        areas.append({
            "slug": d["slug"], "name": d["name"], "region": d["region"],
            "bbox": d["bbox"], "generated": d["generated"],
            "crossings": len(d["crossings"]),
            "covered": d.get("covered", len(d["crossings"])), "stations": len(d["stations"]),
            "trains": len(d["trains"]),
            "size_kb": round(os.path.getsize(f"{OUTDIR}/{fn}") / 1024),
            **({"default": True} if d.get("default") else {}),
        })
    areas.sort(key=lambda a: (a["region"], a["name"]))
    json.dump({"generated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
               "areas": areas}, open(INDEX, "w"),
              ensure_ascii=False, separators=(",", ":"))
    print(f"{INDEX}: {len(areas)} aree", file=sys.stderr)


if __name__ == "__main__":
    main()
