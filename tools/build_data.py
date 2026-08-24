#!/usr/bin/env python3
"""
Costruisce data/linea.json: la ferrovia Jonica con stazioni e passaggi a
livello, ciascuno con la sua progressiva lungo il binario.

La progressiva e' la chiave di tutto: dice quanti metri di rotaia separano un
passaggio a livello dalle stazioni che lo racchiudono, ed e' cio' che permette
poi di interpolare quando il treno ci passa sopra.

Le stazioni arrivano da OpenStreetMap per la posizione e da ViaggiaTreno per il
codice. Il collegamento fra i due mondi si fa cercando il nome OSM su
ViaggiaTreno e poi *verificando con le coordinate*: se la stazione trovata dista
piu' di 800 metri dal nodo OSM, l'abbinamento e' sbagliato e viene scartato.
Cosi' l'elenco si estende da solo a nuove tratte senza tabelle scritte a mano.
"""
import argparse, json, math, subprocess, sys, time

OVERPASS = "https://overpass-api.de/api/interpreter"
VT = "http://www.viaggiatreno.it/infomobilitamobile/resteasy/viaggiatreno"

# Tutta la Jonica calabrese, da Reggio Calabria a oltre Catanzaro Lido.
BBOX = (37.90, 15.55, 38.95, 16.85)
LINE_REF = "145"

# Distanza massima dalla linea per considerare un nodo "sulla Jonica": serve a
# escludere la Tirrenica e le stazioni di altre linee che cadono nel riquadro.
MAX_OFF_STATION = 250
MAX_OFF_CROSSING = 60
# Due nodi PL piu' vicini di cosi' sono lo stesso attraversamento stradale
# mappato piu' volte (uno per binario, o doppia mappatura).
MERGE_WITHIN = 40
# Scarto massimo fra la stazione OSM e quella ViaggiaTreno perche' l'abbinamento
# sia credibile. cercaStazione risponde per prefisso e restituisce comunque
# qualcosa anche quando non c'e' corrispondenza (a "AEROPORTO" propone "ARCHI"),
# quindi la verifica sulle coordinate e' l'unica difesa contro gli abbinamenti
# sbagliati.
MATCH_WITHIN = 600

NAME_OVERRIDES = {
    1820420755: "Via Cristoforo Colombo",
}


# ------------------------------------------------------------------ #
# Rete
# ------------------------------------------------------------------ #

def _curl(args, tries, what):
    last = ""
    for n in range(tries):
        if n:
            wait = 4 * n
            print(f"    {what} non risponde, riprovo fra {wait}s...", file=sys.stderr)
            time.sleep(wait)
        r = subprocess.run(args, capture_output=True, text=True)
        last = r.stdout.strip()
        if last.startswith(("{", "[")):
            try:
                return json.loads(last)
            except json.JSONDecodeError:
                pass
        if last == "":
            return None      # risposta vuota legittima (es. stazione sconosciuta)
    raise RuntimeError(f"{what} non risponde dopo {tries} tentativi: {last[:160]!r}")


def overpass(query, tries=4):
    """Overpass via curl: il Python di sistema non ha i certificati CA."""
    return _curl(["curl", "-s", "-m", "240", "-G", OVERPASS,
                  "--data-urlencode", "data=" + query], tries, "Overpass")


def vt(path, tries=3):
    return _curl(["curl", "-s", "-m", "40", VT + path], tries, "ViaggiaTreno")


# ------------------------------------------------------------------ #
# Geometria
# ------------------------------------------------------------------ #

def haversine(a, b):
    R = 6371008.8
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def key(pt):
    return (round(pt[0], 7), round(pt[1], 7))


def stitch(ways):
    """Ricuce i segmenti OSM nella linea principale.

    Sulla tratta intera la ferrovia non e' una catena semplice: ci sono
    raccordi che creano biforcazioni. Si costruisce quindi un grafo dei
    segmenti e si tiene il percorso piu' lungo fra due capilinea, che e' la
    linea vera; i tronchetti laterali restano fuori.
    """
    segs = []
    for w in ways:
        g = [(p["lat"], p["lon"]) for p in w.get("geometry", [])]
        if len(g) >= 2:
            segs.append(g)

    length = [sum(haversine(g[i - 1], g[i]) for i in range(1, len(g))) for g in segs]

    adj = {}
    for i, g in enumerate(segs):
        adj.setdefault(key(g[0]), []).append(i)
        adj.setdefault(key(g[-1]), []).append(i)

    terminals = [k for k, v in adj.items() if len(v) == 1]
    print(f"  {len(segs)} segmenti, {len(terminals)} capilinea, "
          f"{sum(1 for v in adj.values() if len(v) > 2)} biforcazioni", file=sys.stderr)
    if not terminals:
        raise RuntimeError("nessun capolinea: impossibile orientare la linea")

    def other_end(i, k):
        g = segs[i]
        a, b = key(g[0]), key(g[-1])
        return b if k == a else a

    def dijkstra(src):
        import heapq
        dist = {src: 0.0}
        prev = {}
        pq = [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, math.inf):
                continue
            for i in adj.get(u, []):
                v = other_end(i, u)
                nd = d + length[i]
                if nd < dist.get(v, math.inf):
                    dist[v] = nd
                    prev[v] = (u, i)
                    heapq.heappush(pq, (nd, v))
        return dist, prev

    best = (None, None, -1.0)
    for t in terminals:
        dist, _ = dijkstra(t)
        for u in terminals:
            if u != t and dist.get(u, -1) > best[2]:
                best = (t, u, dist[u])
    src, dst, total = best
    print(f"  percorso principale: {total/1000:.1f} km", file=sys.stderr)

    _, prev = dijkstra(src)
    chain = []
    cur = dst
    while cur != src:
        u, i = prev[cur]
        chain.append((i, u, cur))
        cur = u
    chain.reverse()

    line = []
    for i, frm, _to in chain:
        g = segs[i]
        if key(g[-1]) == frm:
            g = g[::-1]
        line.extend(g if not line else g[1:])
    return line


def chainages(line):
    out = [0.0]
    for i in range(1, len(line)):
        out.append(out[-1] + haversine(line[i - 1], line[i]))
    return out


def build_index(line, cum, cell=0.02):
    """Griglia per non confrontare ogni punto con tutti i segmenti della linea.

    Sui 234 km la linea ha decine di migliaia di vertici: senza indice la
    proiezione di duecento nodi diventa insostenibile.
    """
    grid = {}
    for i in range(len(line) - 1):
        for pt in (line[i], line[i + 1]):
            grid.setdefault((int(pt[0] / cell), int(pt[1] / cell)), set()).add(i)
    return grid, cell


def project(pt, line, cum, index):
    """Proietta un punto sulla linea. Ritorna (progressiva_m, scarto_m)."""
    grid, cell = index
    gi, gj = int(pt[0] / cell), int(pt[1] / cell)
    cand = set()
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            cand |= grid.get((gi + di, gj + dj), set())
    if not cand:
        return None, math.inf

    mx = math.cos(math.radians(pt[0])) * 111320.0
    my = 110540.0
    px, py = pt[1] * mx, pt[0] * my
    best = (None, math.inf)
    for i in cand:
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


# ------------------------------------------------------------------ #
# Abbinamento stazione OSM -> codice ViaggiaTreno
# ------------------------------------------------------------------ #

def _variants(name):
    """Nomi da provare su cercaStazione, dal piu' specifico al piu' generico.

    ViaggiaTreno abbrevia i santi ("S.ANDREA DELLO JONIO") e usa l'apostrofo
    dove OpenStreetMap usa l'accento ("ANNA'" contro "Anna"). La ricerca inoltre
    funziona per prefisso, quindi "ANDREA" non trova nulla mentre "S.ANDREA" si.
    """
    base = (name.upper()
            .replace("À", "A'").replace("È", "E'").replace("É", "E'")
            .replace("Ì", "I'").replace("Ò", "O'").replace("Ù", "U'"))
    out = [base]

    santo = base
    for pref in ("SANT'", "SANTA ", "SANTO ", "SAN "):
        if santo.startswith(pref):
            santo = "S." + santo[len(pref):].lstrip()
            out.append(santo)
            break
    # anche in mezzo al nome: "MOTTA SAN GIOVANNI" -> "MOTTA S.GIOVANNI"
    for pref in (" SANT'", " SANTA ", " SANTO ", " SAN "):
        if pref in base:
            out.append(base.replace(pref, " S."))

    for cand in list(out):
        words = cand.replace("-", " ").split()
        for n in (3, 2, 1):
            if len(words) > n:
                out.append(" ".join(words[:n]))

    seen, uniq = set(), []
    for v in out:
        v = v.strip()
        if v and v not in seen:
            seen.add(v)
            uniq.append(v)
    return uniq


def resolve_code(name, pt, cache):
    """Codice ViaggiaTreno per una stazione OSM, verificato sulle coordinate.

    Ritorna (codice, distanza_m, nome_viaggiatreno) oppure None.
    """
    best = None
    for attempt in _variants(name):
        found = vt("/cercaStazione/" + attempt.replace(" ", "%20"))
        if not found:
            continue
        for cand in found:
            code = cand.get("id")
            if not code:
                continue
            if code not in cache:
                det = vt(f"/dettaglioStazione/{code}/1")
                cache[code] = (det or {}).get("lat") and (det["lat"], det["lon"])
            coords = cache[code]
            if not coords:
                continue
            d = haversine(pt, coords)
            if d < MATCH_WITHIN and (best is None or d < best[1]):
                best = (code, d, cand.get("nomeLungo"))
        if best and best[1] < 120:
            break     # abbinamento gia' ottimo, inutile provare varianti piu' larghe
    return best


# ------------------------------------------------------------------ #

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/linea.json")
    ap.add_argument("--keep-geometry", action="store_true",
                    help="include la polilinea nel file (il frontend non la usa)")
    args = ap.parse_args()

    s, w, n, e = BBOX
    print("Scarico la linea da OpenStreetMap...", file=sys.stderr)
    ways = overpass(f'[out:json][timeout:240];'
                    f'way["railway"="rail"]["ref"="{LINE_REF}"]["service"!~"."]'
                    f'({s},{w},{n},{e});out geom;')["elements"]
    line = stitch(ways)
    cum = chainages(line)
    index = build_index(line, cum)
    print(f"  {len(line)} vertici, {cum[-1]/1000:.1f} km", file=sys.stderr)

    print("Scarico stazioni e passaggi a livello...", file=sys.stderr)
    time.sleep(3)
    nodes = overpass(f'''[out:json][timeout:240];
      ( node["railway"="level_crossing"]({s},{w},{n},{e});
        node["railway"="station"]({s},{w},{n},{e});
        node["railway"="halt"]({s},{w},{n},{e}); );
      out body;''')["elements"]

    stations, xings = [], []
    for el in nodes:
        t = el["tags"]
        rw = t.get("railway")
        pt = (el["lat"], el["lon"])
        ch, off = project(pt, line, cum, index)
        if ch is None:
            continue
        if rw in ("station", "halt") and off < MAX_OFF_STATION:
            stations.append({"osm_id": el["id"], "name": t.get("name") or "?",
                             "lat": el["lat"], "lon": el["lon"],
                             "chainage": round(ch, 1), "offset": round(off, 1)})
        elif rw == "level_crossing" and off < MAX_OFF_CROSSING:
            xings.append({"osm_id": el["id"], "barrier": t.get("crossing:barrier"),
                          "lat": el["lat"], "lon": el["lon"],
                          "chainage": round(ch, 1), "offset": round(off, 1)})

    stations = [x for x in stations if x["name"] != "?"]
    stations.sort(key=lambda x: x["chainage"])
    xings.sort(key=lambda x: x["chainage"])
    print(f"  sulla linea: {len(stations)} stazioni, {len(xings)} nodi PL", file=sys.stderr)

    # nomi delle strade
    print("Recupero i nomi delle strade...", file=sys.stderr)
    roads = {}
    for chunk in [xings[i:i + 120] for i in range(0, len(xings), 120)]:
        ids = ",".join(str(x["osm_id"]) for x in chunk)
        time.sleep(4)
        try:
            rr = overpass(f'[out:json][timeout:200];node(id:{ids})->.p;'
                          f'way(bn.p)["highway"];out body;')
            for el in rr.get("elements", []):
                nm = el.get("tags", {}).get("name") or el.get("tags", {}).get("ref")
                if el.get("type") == "way" and nm:
                    for nid in el.get("nodes", []):
                        roads.setdefault(nid, nm)
        except Exception as ex:
            print(f"  (nomi non recuperati per un blocco: {ex})", file=sys.stderr)

    # fusione dei nodi che sono lo stesso attraversamento
    merged = []
    for x in xings:
        x["road"] = NAME_OVERRIDES.get(x["osm_id"]) or roads.get(x["osm_id"])
        if merged and abs(x["chainage"] - merged[-1]["chainage"]) < MERGE_WITHIN:
            g = merged[-1]
            g["osm_ids"].append(x["osm_id"])
            g["road"] = g["road"] or x["road"]
            if x["barrier"] == "full" or not g["barrier"]:
                g["barrier"] = x["barrier"] or g["barrier"]
            if x["offset"] < g["offset"]:
                g.update({"lat": x["lat"], "lon": x["lon"],
                          "chainage": x["chainage"], "offset": x["offset"]})
            continue
        y = dict(x)
        y["osm_ids"] = [y.pop("osm_id")]
        merged.append(y)
    xings = merged
    print(f"  -> {len(xings)} attraversamenti distinti", file=sys.stderr)

    # codici ViaggiaTreno
    print(f"Abbino {len(stations)} stazioni a ViaggiaTreno...", file=sys.stderr)
    cache = {}
    matched, unmatched = [], []
    for st in stations:
        got = resolve_code(st["name"], (st["lat"], st["lon"]), cache)
        if got:
            st["code"], st["match_m"], st["vt_name"] = got
            matched.append(st)
        else:
            unmatched.append(st["name"])

    # Uno stesso codice non puo' appartenere a due stazioni: quando succede
    # l'abbinamento e' sbagliato per almeno una delle due. Si tiene la piu'
    # vicina e l'altra si scarta, invece di lasciare un doppione silenzioso.
    by_code = {}
    for st in matched:
        cur = by_code.get(st["code"])
        if cur is None or st["match_m"] < cur["match_m"]:
            if cur is not None:
                unmatched.append(f"{cur['name']} (codice {cur['code']} gia' assegnato)")
            by_code[st["code"]] = st
        else:
            unmatched.append(f"{st['name']} (codice {st['code']} gia' assegnato)")

    known = sorted(by_code.values(), key=lambda x: x["chainage"])
    for st in known:
        print(f"  {st['name']:34s} -> {st['code']}  ({st['vt_name']}, {st['match_m']:.0f} m)",
              file=sys.stderr)
    if unmatched:
        print(f"\n  {len(unmatched)} stazioni senza codice, escluse:", file=sys.stderr)
        for u in unmatched:
            print(f"    - {u}", file=sys.stderr)

    # slug e stazioni di riferimento
    def slug(x):
        base = x["road"] or f"km-{x['chainage']/1000:.3f}"
        keep = "".join(c.lower() if c.isalnum() else "-" for c in base)
        while "--" in keep:
            keep = keep.replace("--", "-")
        return "pl-" + keep.strip("-")

    seen = {}
    for x in xings:
        base = slug(x)
        seen[base] = seen.get(base, 0) + 1
        x["id"] = base if seen[base] == 1 else f"{base}-{seen[base]}"
        x["name"] = x["road"] or f"PL km {x['chainage']/1000:.1f}"
        before = [st for st in known if st["chainage"] <= x["chainage"]]
        after = [st for st in known if st["chainage"] > x["chainage"]]
        x["between"] = [before[-1]["code"] if before else None,
                        after[0]["code"] if after else None]
        x.pop("road", None)

    # un PL senza almeno una stazione per lato non e' interpolabile
    usable = [x for x in xings if x["between"][0] and x["between"][1]]
    if len(usable) != len(xings):
        print(f"  {len(xings)-len(usable)} PL fuori dalle stazioni note, esclusi",
              file=sys.stderr)

    out = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "OpenStreetMap (ODbL) + ViaggiaTreno (RFI)",
        "line": {"name": "Ferrovia Jonica", "ref": LINE_REF,
                 "length_m": round(cum[-1], 1)},
        "stations": [{k: st[k] for k in ("code", "name", "lat", "lon", "chainage")}
                     for st in known],
        "crossings": [{k: x[k] for k in ("id", "name", "lat", "lon", "chainage",
                                         "barrier", "between", "osm_ids")}
                      for x in usable],
        "model": {
            "lead_close_s": 150,
            "lead_open_s": 40,
            "accel": 0.5,
            "vmax_ms": round(120 / 3.6, 2),
            "vmax_note": "120 km/h, velocita' di rango sulla Jonica",
        },
    }
    if args.keep_geometry:
        out["line"]["geometry"] = [[round(p[0], 5), round(p[1], 5)] for p in line]

    with open(args.out, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    import os
    print(f"\n{args.out}: {len(known)} stazioni, {len(usable)} passaggi a livello, "
          f"{os.path.getsize(args.out)/1024:.0f} KB", file=sys.stderr)


if __name__ == "__main__":
    main()
