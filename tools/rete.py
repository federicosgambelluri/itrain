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

# Piu' istanze Overpass: quella principale limita le richieste ravvicinate e
# su una serie di zone si viene respinti. Ruotando fra i mirror una zona non
# fallisce solo perche' un server ha detto di no.
# (overpass.osm.ch e' escluso: ha solo dati svizzeri.)
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
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
            wait = 8 * n * n
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


def overpass(query, rounds=3):
    """Interroga Overpass provando i mirror a turno.

    A ogni giro si passano in rassegna tutti i mirror; se nessuno risponde si
    aspetta sempre di piu' prima di ricominciare, perche' il limite di
    frequenza si sblocca da solo dopo qualche minuto.
    """
    errors = []
    for r in range(rounds):
        if r:
            wait = 45 * r
            print(f"    nessun mirror Overpass disponibile, riprovo fra {wait}s...",
                  file=sys.stderr)
            time.sleep(wait)
        for url in OVERPASS_MIRRORS:
            out = subprocess.run(
                ["curl", "-s", "-m", "300", "-G", url,
                 "--data-urlencode", "data=" + query],
                capture_output=True, text=True).stdout.strip()
            if out.startswith("{"):
                try:
                    return json.loads(out)
                except json.JSONDecodeError:
                    pass
            errors.append(url.split("/")[2])
    raise RuntimeError("Overpass non risponde su nessun mirror: "
                       + ", ".join(dict.fromkeys(errors)))


def vt(path, tries=3, raw=False):
    """Chiama ViaggiaTreno. Con raw=True ritorna il testo: /regione da' un numero."""
    if raw:
        r = subprocess.run(["curl", "-s", "-m", "45", VT + path],
                           capture_output=True, text=True)
        return r.stdout.strip()
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


def _normalise(name):
    """Forma confrontabile di un nome di stazione fra OSM e ViaggiaTreno."""
    out = (name.upper()
           .replace("À", "A").replace("È", "E").replace("É", "E")
           .replace("Ì", "I").replace("Ò", "O").replace("Ù", "U")
           .replace("'", " ").replace(".", " ").replace("-", " "))
    for lungo, breve in (("SANT ", "S "), ("SANTA ", "S "), ("SANTO ", "S "),
                         ("SAN ", "S ")):
        out = out.replace(lungo, breve)
    return " ".join(out.split())


def station_coords(code, cache):
    """Coordinate di una stazione ViaggiaTreno, o None se non le pubblica.

    L'ultimo segmento di dettaglioStazione e' l'indice di regione, e va preso
    da /regione/<codice>: passandone uno sbagliato il servizio non da' errore
    ma risponde con latitudine 0, coordinate che sembrano valide e non lo sono.
    E' un tranello silenzioso -- prima le stazioni fuori dalla regione 1
    venivano tutte scartate senza motivo apparente.
    """
    if code in cache:
        return cache[code]

    reg = vt(f"/regione/{code}", raw=True)
    coords = None
    if isinstance(reg, str) and reg.strip().isdigit():
        det = vt(f"/dettaglioStazione/{code}/{reg.strip()}")
        lat = (det or {}).get("lat")
        lon = (det or {}).get("lon")
        # latitudine 0 e' il valore che il servizio restituisce quando non sa
        if lat and lon and abs(lat) > 1:
            coords = (lat, lon)
    cache[code] = coords
    return coords


def resolve_code(name, pt, cache):
    """Codice ViaggiaTreno di una stazione OSM, verificato sulle coordinate.

    La verifica non e' una formalita': cercaStazione cerca per prefisso e
    restituisce comunque un risultato anche quando non esiste corrispondenza
    (a "REGGIO DI CALABRIA AEROPORTO" propone "REGGIO DI CALABRIA ARCHI").
    Senza il controllo sulla distanza quell'errore entrerebbe nei dati zitto.

    Alcune stazioni pero' le coordinate non le hanno affatto: capita sulle
    linee di gestori diversi da RFI, come la Bologna-Portomaggiore. Scartarle
    farebbe sparire linee intere che invece i treni li hanno. Per quelle si
    ripiega sul nome identico, e solo se la ricerca restituisce un unico
    candidato con quel nome: un omonimo renderebbe l'abbinamento un terno al
    lotto, e allora e' meglio rinunciare.

    Ritorna (codice, distanza_m|None, nome_viaggiatreno, verificato).
    """
    best = None
    exact = {}
    target = _normalise(name)

    for attempt in name_variants(name):
        for cand in vt("/cercaStazione/" + attempt.replace(" ", "%20")):
            code = cand.get("id")
            if not code:
                continue
            coords = station_coords(code, cache)
            if coords:
                d = haversine(pt, coords)
                if d < MATCH_WITHIN and (best is None or d < best[1]):
                    best = (code, d, cand.get("nomeLungo"), True)
            elif _normalise(cand.get("nomeLungo") or "") == target:
                exact[code] = cand.get("nomeLungo")
        if best and best[1] < 120:
            break

    if best:
        return best
    if len(exact) == 1:
        code, nome = next(iter(exact.items()))
        return (code, None, nome, False)
    return None


def dedupe_by_code(matched):
    """Uno stesso codice non puo' appartenere a due stazioni.

    Succede quando OpenStreetMap mappa la stessa stazione due volte, o quando
    l'abbinamento sbaglia. Si tiene la piu' vicina e si segnala l'altra.
    """
    # gli abbinamenti verificati sulle coordinate battono quelli sul solo nome
    matched = sorted(matched, key=lambda s: (s.get("verified") is False,
                                             s.get("match_m") if s.get("match_m") is not None else 1e9))
    by_code, dropped = {}, []
    for st in matched:
        cur = by_code.get(st["code"])
        key = lambda x: (x.get("verified") is False,
                         x["match_m"] if x.get("match_m") is not None else 1e9)
        if cur is None or key(st) < key(cur):
            if cur is not None:
                dropped.append(f"{cur['name']} (codice {cur['code']} gia' assegnato)")
            by_code[st["code"]] = st
        else:
            dropped.append(f"{st['name']} (codice {st['code']} gia' assegnato)")
    return list(by_code.values()), dropped
