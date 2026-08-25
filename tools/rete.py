#!/usr/bin/env python3
"""
Funzioni condivise dai generatori: rete, grafo dei binari, abbinamento delle
stazioni a ViaggiaTreno.

Il modello e' un grafo e non una linea. Sulla Jonica bastava ricucire i
segmenti in un'unica polilinea e misurare le progressive, perche' la linea era
una sola. A Bologna non funziona: ci convergono otto linee, la stazione
centrale sta su tutte, e in OpenStreetMap la maggior parte dei segmenti non
porta il numero di linea (1186 su 1397) mentre i nomi sono incoerenti.

Con un grafo il problema sparisce: non serve sapere a quale linea appartiene un
binario. Per ogni coppia di stazioni consecutive di un treno si calcola il
percorso piu' breve sulle rotaie, e i passaggi a livello che ci stanno sopra
sono quelli che quel treno chiudera'.
"""
import heapq, json, math, subprocess, sys, time

OVERPASS = "https://overpass-api.de/api/interpreter"
VT = "http://www.viaggiatreno.it/infomobilitamobile/resteasy/viaggiatreno"

# I binari di servizio esistono nel grafo ma vanno evitati: un percorso che
# passasse per un fascio di manovra sarebbe piu' corto sulla carta e sbagliato
# nella realta'. Il peso li rende poco attraenti senza escluderli, perche'
# a volte sono l'unico collegamento mappato.
PENALTY = {None: 1.0, "spur": 1.6, "crossover": 1.4, "siding": 3.0, "yard": 6.0}

MATCH_WITHIN = 600     # scarto massimo fra stazione OSM e stazione ViaggiaTreno


# ------------------------------------------------------------------ #
# Rete
# ------------------------------------------------------------------ #

def _curl(args, tries, what, allow_empty=False):
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
        if last == "" and allow_empty:
            return None
    raise RuntimeError(f"{what} non risponde dopo {tries} tentativi: {last[:160]!r}")


def overpass(query, tries=4):
    return _curl(["curl", "-s", "-m", "300", "-G", OVERPASS,
                  "--data-urlencode", "data=" + query], tries, "Overpass")


def vt(path, tries=3):
    return _curl(["curl", "-s", "-m", "45", VT + path], tries, "ViaggiaTreno",
                 allow_empty=True) or []


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


class Graph:
    """Grafo dei binari: nodi OSM collegati dai segmenti delle way."""

    def __init__(self):
        self.pos = {}        # id nodo -> (lat, lon)
        self.adj = {}        # id nodo -> [(vicino, metri, costo)]

    @classmethod
    def from_ways(cls, ways):
        g = cls()
        for w in ways:
            ns = w.get("nodes", [])
            geo = w.get("geometry", [])
            if len(ns) != len(geo) or len(ns) < 2:
                continue
            weight = PENALTY.get(w.get("tags", {}).get("service"), 2.0)
            for i, nid in enumerate(ns):
                g.pos[nid] = (geo[i]["lat"], geo[i]["lon"])
            for i in range(len(ns) - 1):
                a, b = ns[i], ns[i + 1]
                d = haversine(g.pos[a], g.pos[b])
                if d <= 0:
                    continue
                g.adj.setdefault(a, []).append((b, d, d * weight))
                g.adj.setdefault(b, []).append((a, d, d * weight))
        return g

    def index(self, cell=0.005):
        """Griglia per trovare in fretta il nodo di binario piu' vicino."""
        grid = {}
        for nid, (la, lo) in self.pos.items():
            grid.setdefault((int(la / cell), int(lo / cell)), []).append(nid)
        self._grid, self._cell = grid, cell

    def nearest(self, pt, max_m=400):
        """Nodo di binario piu' vicino a un punto, o None se troppo lontano."""
        gi, gj = int(pt[0] / self._cell), int(pt[1] / self._cell)
        best, bd = None, max_m
        rings = 1
        while True:
            cand = []
            for di in range(-rings, rings + 1):
                for dj in range(-rings, rings + 1):
                    cand += self._grid.get((gi + di, gj + dj), [])
            for nid in cand:
                d = haversine(pt, self.pos[nid])
                if d < bd:
                    best, bd = nid, d
            if best or rings >= 3:
                return (best, bd) if best else (None, None)
            rings += 1

    def path(self, src, dst, limit_m=120000):
        """Percorso piu' breve sui binari. Ritorna (lista_nodi, metri_reali)."""
        dist = {src: 0.0}
        real = {src: 0.0}
        prev = {}
        pq = [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == dst:
                break
            if d > dist.get(u, math.inf) or d > limit_m:
                continue
            for v, metres, cost in self.adj.get(u, ()):
                nd = d + cost
                if nd < dist.get(v, math.inf):
                    dist[v] = nd
                    real[v] = real[u] + metres
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        if dst not in dist:
            return None, None
        chain = [dst]
        while chain[-1] != src:
            chain.append(prev[chain[-1]])
        chain.reverse()
        return chain, real[dst]


# ------------------------------------------------------------------ #
# Abbinamento stazione OSM -> codice ViaggiaTreno
# ------------------------------------------------------------------ #

def name_variants(name):
    """Nomi da provare su cercaStazione, dal piu' specifico al piu' generico.

    ViaggiaTreno abbrevia i santi ("S.ANDREA DELLO JONIO"), usa l'apostrofo
    dove OpenStreetMap usa l'accento ("ANNA'" contro "Anna") e cerca per
    prefisso, quindi "ANDREA" non trova nulla mentre "S.ANDREA" si'.
    """
    base = (name.upper()
            .replace("À", "A'").replace("È", "E'").replace("É", "E'")
            .replace("Ì", "I'").replace("Ò", "O'").replace("Ù", "U'"))
    out = [base]
    for pref in ("SANT'", "SANTA ", "SANTO ", "SAN "):
        if base.startswith(pref):
            out.append("S." + base[len(pref):].lstrip())
            break
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
    """Codice ViaggiaTreno di una stazione OSM, verificato sulle coordinate.

    La verifica non e' una formalita': cercaStazione risponde per prefisso e
    restituisce comunque un risultato anche quando non esiste corrispondenza
    (a "REGGIO DI CALABRIA AEROPORTO" propone "REGGIO DI CALABRIA ARCHI").
    Senza il controllo sulla distanza quell'errore entrerebbe nei dati zitto.
    """
    best = None
    for attempt in name_variants(name):
        for cand in vt("/cercaStazione/" + attempt.replace(" ", "%20")):
            code = cand.get("id")
            if not code:
                continue
            if code not in cache:
                det = vt(f"/dettaglioStazione/{code}/1")
                cache[code] = ((det or {}).get("lat") and (det["lat"], det["lon"])) or None
            if not cache[code]:
                continue
            d = haversine(pt, cache[code])
            if d < MATCH_WITHIN and (best is None or d < best[1]):
                best = (code, d, cand.get("nomeLungo"))
        if best and best[1] < 120:
            break
    return best


def dedupe_by_code(matched):
    """Uno stesso codice non puo' appartenere a due stazioni.

    Succede quando OpenStreetMap mappa la stessa stazione due volte, o quando
    l'abbinamento sbaglia. Si tiene la piu' vicina e si segnala l'altra.
    """
    by_code, dropped = {}, []
    for st in matched:
        cur = by_code.get(st["code"])
        if cur is None or st["match_m"] < cur["match_m"]:
            if cur is not None:
                dropped.append(f"{cur['name']} (codice {cur['code']} gia' assegnato)")
            by_code[st["code"]] = st
        else:
            dropped.append(f"{st['name']} (codice {st['code']} gia' assegnato)")
    return list(by_code.values()), dropped
