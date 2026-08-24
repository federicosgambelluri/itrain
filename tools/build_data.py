#!/usr/bin/env python3
"""
Costruisce data/siderno.json a partire da OpenStreetMap.

Produce:
  - la polilinea della Ferrovia Jonica (ref 145) ricucita e ordinata
  - stazioni e passaggi a livello proiettati sulla linea (progressiva in metri)

La "progressiva" (chainage) e' la chiave di tutto: permette di sapere quanti
metri di binario ci sono fra una stazione e un passaggio a livello, e quindi
di interpolare quando il treno ci passa sopra.
"""
import json, math, subprocess, sys, time

OVERPASS = "https://overpass-api.de/api/interpreter"
# Da Ardore a Roccella Jonica: copre Siderno con ampio margine su entrambi i lati
BBOX = (38.16, 16.18, 38.34, 16.42)

# Codici stazione di ViaggiaTreno. OSM e RFI usano nomi diversi, quindi il
# ponte fra i due mondi va dichiarato a mano (sono cinque stazioni).
STATION_CODES = {
    "Ardore": "S11853",
    "Locri": "S11851",
    "Siderno": "S11850",
    "Gioiosa Jonica": "S11848",
    "Roccella Jonica": "S11847",
}

# Alcuni PL stanno su tratti stradali senza tag "name" in OSM. Qui si corregge
# a mano il nome mostrato: e' anche il posto giusto per sistemare un nome
# sbagliato dopo una verifica sul campo.
NAME_OVERRIDES = {
    1820420755: "Via Cristoforo Colombo",
}


def overpass(query, tries=4):
    """Interroga Overpass via curl (il Python di sistema non ha i certificati CA).

    Overpass limita le richieste ravvicinate e in quel caso risponde con un
    corpo vuoto o con HTML: riprovo con backoff crescente.
    """
    last = ""
    for n in range(tries):
        if n:
            wait = 5 * n
            print(f"    Overpass non ha risposto, riprovo fra {wait}s...", file=sys.stderr)
            time.sleep(wait)
        r = subprocess.run(
            ["curl", "-s", "-m", "180", "-G", OVERPASS, "--data-urlencode", "data=" + query],
            capture_output=True, text=True)
        last = r.stdout.strip()
        if last.startswith("{"):
            try:
                return json.loads(last)
            except json.JSONDecodeError:
                pass
    raise RuntimeError(f"Overpass non risponde dopo {tries} tentativi: {last[:200]!r}")


def haversine(a, b):
    R = 6371008.8
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def fetch_ways():
    s, w, n, e = BBOX
    q = f'''[out:json][timeout:120];
    way["railway"="rail"]["ref"="145"]
       ["service"!~"."]({s},{w},{n},{e});
    out geom;'''
    return overpass(q)["elements"]


def stitch(ways):
    """Ricuce i segmenti OSM in un'unica polilinea ordinata.

    Indicizza per estremo invece di identificare i segmenti per id(): la linea
    e' una catena semplice con due soli estremi di grado 1, quindi si percorre
    linearmente partendo da uno dei due capi.
    """
    segs = []
    for way in ways:
        g = [(p["lat"], p["lon"]) for p in way.get("geometry", [])]
        if len(g) >= 2:
            segs.append(g)

    def key(pt):
        return (round(pt[0], 7), round(pt[1], 7))

    # estremo -> lista di indici dei segmenti che vi terminano
    at = {}
    for i, g in enumerate(segs):
        at.setdefault(key(g[0]), []).append(i)
        at.setdefault(key(g[-1]), []).append(i)

    terminals = [k for k, v in at.items() if len(v) == 1]
    if not terminals:
        raise RuntimeError("nessun capolinea: la linea non e' una catena semplice")

    start_k = min(terminals)           # deterministico fra i due capi
    cur = at[start_k][0]
    seg = segs[cur]
    if key(seg[-1]) == start_k:
        seg = seg[::-1]
    line = list(seg)
    used = {cur}

    while True:
        tail = key(line[-1])
        nxt = [i for i in at.get(tail, []) if i not in used]
        if not nxt:
            break
        i = nxt[0]
        g = segs[i]
        if key(g[-1]) == tail:
            g = g[::-1]
        line.extend(g[1:])
        used.add(i)

    if len(used) != len(segs):
        print(f"  ATTENZIONE: {len(segs)-len(used)} segmenti non ricuciti",
              file=sys.stderr)
    print(f"  ricuciti {len(used)}/{len(segs)} segmenti -> {len(line)} punti",
          file=sys.stderr)
    return line


def chainages(line):
    """Progressiva cumulativa in metri per ogni vertice della polilinea."""
    out = [0.0]
    for i in range(1, len(line)):
        out.append(out[-1] + haversine(line[i - 1], line[i]))
    return out


def project(pt, line, cum):
    """Proietta un punto sulla polilinea. Ritorna (progressiva_m, scarto_m)."""
    best = (None, float("inf"))
    lat0 = math.radians(pt[0])
    mx = math.cos(lat0) * 111320.0
    my = 110540.0
    px, py = pt[1] * mx, pt[0] * my
    for i in range(len(line) - 1):
        ax, ay = line[i][1] * mx, line[i][0] * my
        bx, by = line[i + 1][1] * mx, line[i + 1][0] * my
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        cx, cy = ax + t * dx, ay + t * dy
        d = math.hypot(px - cx, py - cy)
        if d < best[1]:
            best = (cum[i] + t * math.sqrt(L2), d)
    return best


def main():
    s, w, n, e = BBOX
    print("Scarico la linea...", file=sys.stderr)
    line = stitch(fetch_ways())
    cum = chainages(line)
    print(f"  lunghezza linea: {cum[-1]/1000:.2f} km", file=sys.stderr)

    print("Scarico PL e stazioni...", file=sys.stderr)
    q = f'''[out:json][timeout:120];
    ( node["railway"="level_crossing"]({s},{w},{n},{e});
      node["railway"="station"]({s},{w},{n},{e});
      node["railway"="halt"]({s},{w},{n},{e}); );
    out body;'''
    nodes = overpass(q)["elements"]

    xings_raw = [x for x in nodes if x["tags"].get("railway") == "level_crossing"]

    # nome della strada: le way stradali che passano per quel nodo.
    # Una sola chiamata: Overpass limita le richieste ravvicinate.
    roads = {}
    if xings_raw:
        ids = ",".join(str(x["id"]) for x in xings_raw)
        try:
            time.sleep(6)
            rr = overpass(f'[out:json][timeout:120];'
                          f'node(id:{ids})->.p;way(bn.p)["highway"];out body;')
            for el in rr.get("elements", []):
                if el.get("type") != "way":
                    continue
                t = el.get("tags", {})
                nm = t.get("name") or t.get("ref")
                if not nm:
                    continue
                for nid in el.get("nodes", []):
                    roads.setdefault(nid, nm)
        except Exception as ex:
            print(f"  (nomi strade non recuperati: {ex})", file=sys.stderr)

    stations, xings = [], []
    for el in nodes:
        t = el["tags"]
        rw = t.get("railway")
        pt = (el["lat"], el["lon"])
        ch, off = project(pt, line, cum)
        if rw in ("station", "halt"):
            stations.append({
                "osm_id": el["id"], "name": t.get("name", "?"),
                "lat": el["lat"], "lon": el["lon"],
                "chainage": round(ch, 1), "offset": round(off, 1),
            })
        elif rw == "level_crossing":
            xings.append({
                "osm_id": el["id"],
                "road": roads.get(el["id"]),
                "barrier": t.get("crossing:barrier"),
                "lat": el["lat"], "lon": el["lon"],
                "chainage": round(ch, 1), "offset": round(off, 1),
            })

    # scarta i nodi troppo lontani dalla linea principale (probabili raccordi)
    stations = [x for x in stations if x["offset"] < 250]
    xings = [x for x in xings if x["offset"] < 60]
    stations.sort(key=lambda x: x["chainage"])
    xings.sort(key=lambda x: x["chainage"])

    # OSM mappa lo stesso attraversamento stradale come piu' nodi (un nodo per
    # binario, o doppia mappatura). Fondo i nodi entro 40 m di progressiva:
    # per l'utente in auto sono un unico passaggio a livello.
    merged = []
    for x in xings:
        if merged and abs(x["chainage"] - merged[-1]["chainage"]) < 40:
            g = merged[-1]
            g["osm_ids"].append(x["osm_id"])
            g["road"] = g["road"] or x["road"]
            # "full" (barriere complete) vince su "half"/"yes"/ignoto
            if x["barrier"] == "full" or not g["barrier"]:
                g["barrier"] = x["barrier"] or g["barrier"]
            if x["offset"] < g["offset"]:
                g["lat"], g["lon"] = x["lat"], x["lon"]
                g["chainage"], g["offset"] = x["chainage"], x["offset"]
            continue
        y = dict(x)
        y["osm_ids"] = [y.pop("osm_id")]
        merged.append(y)
    print(f"  {len(xings)} nodi PL -> {len(merged)} attraversamenti distinti",
          file=sys.stderr)
    xings = merged

    for x in xings:
        for nid in x["osm_ids"]:
            if nid in NAME_OVERRIDES:
                x["road"] = NAME_OVERRIDES[nid]
                break

    def slug(x):
        base = x["road"] or f"km-{x['chainage']/1000:.3f}"
        keep = "".join(c.lower() if c.isalnum() else "-" for c in base)
        while "--" in keep:
            keep = keep.replace("--", "-")
        return "pl-" + keep.strip("-")

    for st in stations:
        st["code"] = STATION_CODES.get(st["name"])
    known = [st for st in stations if st["code"]]
    if len(known) != len(stations):
        missing = [st["name"] for st in stations if not st["code"]]
        print(f"  ATTENZIONE: stazioni senza codice RFI: {missing}", file=sys.stderr)

    for x in xings:
        x["id"] = slug(x)
        x["name"] = x["road"] or f"PL km {x['chainage']/1000:.1f}"
        # stazione precedente e successiva lungo la linea: sono i due punti fra
        # cui interpolare l'orario di passaggio del treno sul PL
        before = [st for st in known if st["chainage"] <= x["chainage"]]
        after = [st for st in known if st["chainage"] > x["chainage"]]
        x["between"] = [before[-1]["code"] if before else None,
                        after[0]["code"] if after else None]
        x.pop("road", None)

    out = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "OpenStreetMap (ODbL) + codici stazione RFI/ViaggiaTreno",
        "line": {
            "name": "Ferrovia Jonica", "ref": "145",
            "length_m": round(cum[-1], 1),
            "geometry": [[round(p[0], 5), round(p[1], 5)] for p in line],
        },
        "stations": [{k: st[k] for k in ("code", "name", "lat", "lon", "chainage")}
                     for st in known],
        "crossings": [{k: x[k] for k in
                       ("id", "name", "lat", "lon", "chainage", "barrier",
                        "between", "osm_ids")} for x in xings],
        "model": {
            # Il PL si chiude quando il treno impegna il circuito a monte.
            # Fonte RFI: circa 2,5 minuti prima del passaggio. E' il valore di
            # partenza, poi l'app lo calibra per singolo PL sulle osservazioni.
            "lead_close_s": 150,
            # riapertura: sgombero del treno + risalita delle barriere
            "lead_open_s": 40,
            # accelerazione/decelerazione media di un regionale, m/s^2
            "accel": 0.5,
            # velocita' massima di linea: senza questo limite gli orari piu'
            # stretti richiederebbero al modello velocita' irrealistiche
            "vmax_ms": round(120 / 3.6, 2),
            "vmax_note": "120 km/h, velocita' di rango sulla Jonica in questo tratto",
        },
    }
    with open("data/siderno.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    import os
    kb = os.path.getsize("data/siderno.json") / 1024
    print(f"\ndata/siderno.json scritto ({kb:.0f} KB)", file=sys.stderr)
    print(f"{len(known)} stazioni, {len(xings)} passaggi a livello\n", file=sys.stderr)
    for st in known:
        print(f"  STAZ  km {st['chainage']/1000:7.3f}  {st['code']}  {st['name']}")
    print()
    for x in xings:
        a, b = x["between"]
        print(f"  PL    km {x['chainage']/1000:7.3f}  {x['name']:28s} "
              f"barriere={x['barrier'] or '?':5s} fra {a}/{b}")


if __name__ == "__main__":
    main()
