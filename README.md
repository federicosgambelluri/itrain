# iTrain — passaggi a livello

Sapere se il passaggio a livello è aperto, chiuso o sta per chiudersi
**prima di uscire di casa**, invece di scoprirlo fermi davanti alle sbarre.

Applicazione web statica: nessun database, nessun server, si pubblica su
GitHub Pages così com'è.

Copre **Calabria, Sicilia ed Emilia-Romagna**: 24 zone, una per provincia più
la fascia jonica della Locride, che segue la linea invece del confine
amministrativo.

**Zone coperte**

<!-- zone:inizio -->
| Zona | Regione | Passaggi a livello | Treni | Peso |
|---|---|---|---|---|
| Catanzaro e provincia | Calabria | tutti e 18 | 56 | 17 KB |
| Cosenza e provincia | Calabria | **30 su 31** con previsione | 39 | 27 KB |
| Crotone e provincia | Calabria | tutti e 16 | 24 | 14 KB |
| Locride e Ferrovia Jonica | Calabria | tutti e 40 | 111 | 77 KB |
| Reggio Calabria e provincia | Calabria | tutti e 17 | 57 | 37 KB |
| Vibo Valentia e provincia | Calabria | tutti e 6 | 28 | 19 KB |
| Bologna e provincia | Emilia-Romagna | **21 su 51** con previsione | 167 | 59 KB |
| Ferrara e provincia | Emilia-Romagna | **38 su 104** con previsione | 76 | 42 KB |
| Forlì-Cesena e provincia | Emilia-Romagna | tutti e 3 | 40 | 25 KB |
| Modena e provincia | Emilia-Romagna | **25 su 31** con previsione | 58 | 23 KB |
| Parma e provincia | Emilia-Romagna | tutti e 44 | 89 | 46 KB |
| Piacenza e provincia | Emilia-Romagna | tutti e 32 | 38 | 18 KB |
| Ravenna e provincia | Emilia-Romagna | **89 su 114** con previsione | 106 | 66 KB |
| Reggio Emilia e provincia | Emilia-Romagna | **46 su 93** con previsione | 69 | 39 KB |
| Rimini e provincia | Emilia-Romagna | **8 su 9** con previsione | 38 | 17 KB |
| Genova e provincia | Liguria | tutti e 9 | 170 | 117 KB |
| La Spezia e provincia | Liguria | **0 su 1** con previsione | 0 | 1 KB |
| Savona e provincia | Liguria | tutti e 30 | 108 | 53 KB |
| Campobasso e provincia | Molise | **2 su 59** con previsione | 8 | 10 KB |
| Isernia e provincia | Molise | **15 su 24** con previsione | 24 | 10 KB |
| Agrigento e provincia | Sicilia | **17 su 49** con previsione | 6 | 9 KB |
| Caltanissetta e provincia | Sicilia | **11 su 24** con previsione | 33 | 13 KB |
| Catania e provincia | Sicilia | **32 su 36** con previsione | 95 | 42 KB |
| Enna e provincia | Sicilia | tutti e 20 | 20 | 10 KB |
| Messina e provincia | Sicilia | tutti e 10 | 92 | 39 KB |
| Palermo e provincia | Sicilia | **35 su 48** con previsione | 127 | 50 KB |
| Ragusa e provincia | Sicilia | **39 su 40** con previsione | 21 | 16 KB |
| Siracusa e provincia | Sicilia | **47 su 50** con previsione | 52 | 24 KB |
| Trapani e provincia | Sicilia | tutti e 102 | 29 | 35 KB |

In totale **802 passaggi a livello con previsione** su 1111 censiti, in 29 zone.
<!-- zone:fine -->

I dati si scaricano una zona alla volta: chi sta a Siderno non ha motivo di
scaricare quelli di Bologna. Aggiungere una zona è una voce in
`tools/aree.json`.

---

## Quello che fa, e quello che non può fare

**RFI non pubblica lo stato delle barriere.** Non esiste nessuna API, pubblica o
privata, che dica se un passaggio a livello è alzato o abbassato in questo
istante. Questo va detto subito, perché definisce cos'è l'app: una
**previsione**, non una misura.

Quello che si sa davvero è *quando i treni passano dalle stazioni* — orario
previsto e ritardo reale, da ViaggiaTreno. Da lì si ricava tutto il resto.

---

## Come funziona la previsione

### 1. Dove sta il passaggio a livello, lungo il binario

Calcolato una volta per tutte (`tools/build_area.py`) costruendo un **grafo dei
binari** da OpenStreetMap: ogni nodo della rete, ogni segmento, la sua
lunghezza. Poi, per ogni coppia di stazioni che un treno percorre di seguito, si
calcola il cammino minimo sulle rotaie e si annota quali passaggi a livello ci
stanno sopra e a che distanza dalla prima stazione. Sono le **tratte**.

Il modello precedente usava una progressiva chilometrica lungo un'unica linea.
Funzionava sulla Jonica e si è rotto a Bologna: lì convergono otto linee, la
stazione centrale sta su tutte e una progressiva unica non esiste. In più
OpenStreetMap, in Emilia-Romagna, non tagga il numero di linea su 1186 segmenti
su 1397, e i nomi sono incoerenti — "Bologna-Verona" e "Verona-Bologna"
convivono. Con un grafo il problema non si pone: non serve sapere a quale linea
appartiene un binario, si misura lungo il percorso che il treno fa davvero.

I binari di servizio sono nel grafo ma pesati sei volte tanto, così un percorso
non taglia mai per un fascio di manovra.

### 2. Quando il treno ci passa sopra

Interpolando fra le due stazioni — ma **non linearmente**. Un treno riparte da
fermo e frena fino a fermarsi, quindi vicino alla stazione è molto più lento
della sua media. Su Via Genova a Siderno, a 196 metri dalla stazione, ignorare
questo sposterebbe la previsione di una ventina di secondi.

Si usa un profilo di velocità trapezoidale (accelerazione, crociera, frenata).
Nota la velocità di crociera V dalla distanza D e dal tempo T di orario
risolvendo `T = V/a + D/V`, e la si limita alla velocità di rango della linea.

### 3. Quando scendono le barriere

Circa **2 minuti e mezzo prima del transito**, valore dichiarato da RFI (prima
dell'ammodernamento superava i 4 minuti). È il numero meno solido dei tre,
perché dipende da dove si trova il circuito di binario che comanda la chiusura,
e cambia da impianto a impianto.

**Per questo l'app si calibra sul campo**, raccogliendo due cose diverse.

*«Com'è adesso? chiuso / aperto»* è la domanda facile: basta guardare le
sbarre. Dice se la previsione ci ha azzeccato, e l'app risponde con il conteggio
(«ha indovinato 7 volte su 9»). Se lo scarto è sistematico — spesso già chiuso
mentre l'app lo dà aperto — lo segnala.

Se poi il cambio è appena avvenuto, un secondo tocco su *«sì, proprio adesso»*
registra **l'istante della transizione**, che è tutt'altro dato: misura il
preavviso reale di quel passaggio a livello e sostituisce il valore di targa.
Dopo due o tre osservazioni la previsione smette di essere generica.

La distinzione conta. Una conferma di stato dice che *a un certo istante* la
sbarra era giù, non *quando* è scesa: è un limite, non una misura, e mescolarla
alle misure vere sposterebbe la mediana in modo scorretto. Per questo alimenta
il conteggio della precisione e non il modello.

Tutto resta in `localStorage`: niente database, niente dati che lasciano il
telefono, esportabili in JSON.

Le finestre che si sovrappongono vengono fuse: sulle linee a binario unico i
treni si incrociano in stazione e capita di vederne due fermi insieme per
cinque minuti. Per chi è in auto quello è un unico sbarramento, non due.

---

## Un tranello di ViaggiaTreno che vale la pena conoscere

`dettaglioStazione` vuole due parametri: il codice della stazione e **l'indice
di regione**. Passandone uno sbagliato il servizio non risponde con un errore:
risponde con `lat: 0.0`, coordinate che sembrano valide e non lo sono.

Costava caro. La verifica sulle coordinate scartava in silenzio tutte le
stazioni fuori dalla regione che avevo cablato, e con esse linee intere: la
Bologna–Portomaggiore risultava «senza dati» pur avendo i treni pubblicati.
Sistemarlo — leggendo l'indice giusto da `/regione/<codice>` — ha portato
Bologna da 6 a 21 passaggi a livello con previsione.

Alcune stazioni le coordinate non le hanno affatto, e sono proprio quelle delle
linee di gestori diversi da RFI. Per quelle si ripiega sul nome identico, ma
solo se la ricerca restituisce **un unico** candidato con quel nome: con un
omonimo l'abbinamento sarebbe un terno al lotto, e allora è meglio rinunciare.

---

## Il limite dei dati

L'app dipende da ViaggiaTreno, che è il sistema di **RFI**. Le linee esercite su
infrastruttura di altri gestori spesso non ci sono, e la copertura cambia molto
da regione a regione:

| Regione | Passaggi a livello con previsione |
|---|---|
| Calabria | 127 su 128 |
| Sicilia | 313 su 379 |
| Emilia-Romagna | 306 su 481 |

In Calabria la rete è quasi tutta RFI e la copertura è praticamente completa. In
Emilia-Romagna no: le linee con più passaggi a livello sono spesso FER — la rete
attorno a Reggio Emilia, la Ferrara–Codigoro, la Bologna–Vignola — e i loro
treni non compaiono. In Sicilia mancano soprattutto la Ferrovia Circumetnea e
alcune tratte a servizio ridotto.

Non tutte però mancano. La **Bologna–Portomaggiore** ha i treni pubblicati da
Budrio in poi, e la copertura di intere province — Piacenza, Parma, Ravenna —
è quasi completa. La Bologna–Vignola in questo periodo è sostituita da autobus
per lavori: lì «nessun dato» e «nessun treno» coincidono davvero.

Vale la pena notare dove i passaggi a livello *non* ci sono: Bologna città e la
Modena–Bologna sono in gran parte a livelli sfalsati, e su quelle linee di
passaggi a livello ne restano pochi. Forlì-Cesena, in tutta la provincia, ne ha
nove mappati su OpenStreetMap.

Ho cercato una seconda fonte per le linee mancanti: TPER pubblica in open data
il GTFS degli **autobus**, non quello dei treni, e non ho trovato un GTFS
ferroviario aperto. Restano i PDF degli orari, trascrivibili a mano nel formato
dell'app se un giorno servisse.

**I passaggi a livello scoperti restano comunque in elenco**, segnati come
«dati non disponibili» e grigi sulla mappa. Farli sparire sarebbe stata la
scelta comoda e quella sbagliata: chi apre l'app davanti a uno di essi deve
leggere *«non lo so»*, non trovare il nulla e concluderne che la zona sia
coperta. Se un giorno i dati compariranno, si accendono da soli.

---

## Il problema CORS, e perché serve un proxy

ViaggiaTreno **non manda l'header `Access-Control-Allow-Origin`**. Quando il
JavaScript della pagina chiede i dati, il browser li scarica davvero, poi
controlla quell'header, non lo trova e **rifiuta di consegnarli al codice**.

Non è RFI che blocca: è una regola del browser, uguale per tutti i siti, e dalla
pagina non è aggirabile in alcun modo. `curl` e i server non ne sono soggetti.
Nemmeno lo scraping aiuta: da browser resterebbe la stessa richiesta
cross-domain, con lo stesso blocco.

Serve quindi un intermediario che rifaccia la richiesta e riaggiunga l'header.
Questo progetto usa **solo proxy pubblici**, per scelta: niente account, niente
da configurare. Il prezzo è che nessuno è affidabile da solo — misurato sul
campo, `allorigins` risponde circa **una volta su tre**.

La contromisura è in `js/rfi.js`: una catena di quattro proxy provati in
sequenza, con memoria di quale ha funzionato per partire da quello la volta
dopo. Se cadono tutti, l'app ripiega sull'orario statico del repo e lo dichiara
in cima allo schermo, invece di mostrare orari sbagliati in silenzio.

### Il ponte personale

I proxy pubblici non sono equivalenti fra loro, e conviene sapere cosa sono:

| | Cos'è | Nato per questo? |
|---|---|---|
| `r.jina.ai` | il *Reader* di Jina AI, che trasforma pagine in testo per i modelli linguistici | **no**, lo usiamo di sbieco |
| `allorigins` | un proxy CORS open source, servizio gratuito alla comunità | sì |
| `cors.sh` | un proxy CORS, servizio gratuito con limiti | sì |
| `codetabs` | un sito di piccole utilità gratuite | sì, ma in piccolo |

In tutti si è ospiti: nessuno sa che esistiamo, nessuno deve niente. E non c'è
un "migliore" da scegliere una volta per tutte: misurando a due minuti di
distanza, `r.jina.ai` è passato da bloccato a tre risposte su tre, mentre
`allorigins` ha fatto il percorso inverso. È per questo che la catena ne ha
cinque e mette in quarantena chi fallisce, invece di puntare su uno solo.

### Un ponte proprio: provato, non funziona

`worker/itrain-proxy.js` è lo stesso ponte, ma proprio, da pubblicare su
Cloudflare Workers. **È stato costruito, pubblicato e provato: con ViaggiaTreno
non funziona.**

ViaggiaTreno sta dietro Akamai, che rifiuta le richieste in arrivo dalle reti
dei Worker con un "Access Denied". Verificato due volte, prima con uno
User-Agent dichiarato e poi con un insieme completo di header da browser,
Referer compreso: nessuna differenza. Che non sia questione di *come* ci si
presenta lo dimostra la prova opposta — da un indirizzo residenziale la stessa
chiamata passa con qualsiasi User-Agent, perfino vuoto. Il filtro guarda **da
dove** arrivi, e quello su Cloudflare non si cambia.

Il codice resta nel repository perché la conoscenza vale, e perché su un'altra
API senza CORS funzionerebbe così com'è. Le istruzioni sotto valgono in quel
caso.

1. Registrati su [dash.cloudflare.com](https://dash.cloudflare.com) — gratis,
   senza carta di credito.
2. *Compute (Workers)* → **Create** → **Start from Hello World** → dai un nome,
   per esempio `itrain-proxy`, e crea.
3. **Edit code**: cancella tutto e incolla il contenuto di
   `worker/itrain-proxy.js`. **Deploy**.
4. Copia l'indirizzo che ti dà (`https://itrain-proxy.<tuonome>.workers.dev`) e
   incollalo in `js/config.js`, poi committa.

Chi preferisce la riga di comando trova `worker/wrangler.toml` già pronto:
`npm i -g wrangler && cd worker && wrangler login && wrangler deploy`.

**Non può rompere nulla.** Con `PROXY_URL` vuoto il ponte non entra nemmeno
nell'elenco e l'app si comporta esattamente come prima. Configurato, diventa il
primo tentativo, ma se un giorno non rispondesse la quarantena lo scarta e si
scivola sui proxy pubblici senza che l'utente se ne accorga.

Il Worker **non è un proxy aperto**: accetta solo destinazioni su
`www.viaggiatreno.it` e solo sul percorso delle API. Un proxy che rigira
qualsiasi indirizzo diventa in fretta uno strumento per mascherare traffico
altrui, verrebbe abusato e Cloudflare lo spegnerebbe. Tiene inoltre in cache
venti secondi: i ritardi cambiano al minuto, quindi non si mostrano dati
vecchi, ma ViaggiaTreno viene interrogato molto meno.

Il piano gratuito copre 100.000 richieste al giorno. Un uso normale dell'app ne
fa qualche centinaio.

---

## Le notifiche, e il loro limite

Senza un server che le spedisca, **le push a app chiusa non sono possibili**:
il web push richiede un mittente che parli con il servizio push del browser.

Quello che l'app fa, e che copre l'uso reale, è programmare gli avvisi mentre è
viva — in primo piano o in una scheda in secondo piano. Apri l'app prima di
uscire, scegli il passaggio a livello, e l'avviso arriva al momento giusto.

Su iPhone le notifiche funzionano solo se il sito è stato aggiunto alla
schermata Home (Condividi → «Aggiungi a Home»). È una regola di Safari.

---

## La mappa

Un interruttore accende la **vista d'insieme**: tutti i passaggi a livello di
tutte le zone. L'indice pesa una settantina di chilobyte e si scarica solo
quando serve, perché contiene unicamente dove sono e come si chiamano. Lo stato
no: saperlo richiede l'orario dei treni della zona, e caricarle tutte insieme
vorrebbe dire quasi un megabyte per un'app che si apre in strada. I punti delle
altre zone restano quindi grigi, e toccandone uno si scarica la sua zona e lo si
apre già scelto — meglio un puntino grigio onesto che un colore inventato.

Leaflet è **incluso nel repository** (`vendor/leaflet/`, licenza BSD-2) invece
di essere preso da un CDN: l'app non dipende da un servizio esterno per
funzionare. Le piastrelle arrivano da OpenStreetMap e quelle sì, richiedono
rete; senza, restano i cerchi colorati su fondo neutro, che è comunque
leggibile. In tema scuro le piastrelle vengono invertite via CSS.

---

## Farla funzionare

### In locale

I moduli JavaScript e il caricamento dei dati non funzionano aprendo il file dal
disco: serve un server, anche minimo.

```bash
python3 -m http.server 8765
# poi apri http://localhost:8765
```

### Su GitHub Pages

1. Carica il repository su GitHub.
2. *Settings → Pages → Source: Deploy from a branch*, scegli `main` e `/ (root)`.
3. Il sito sarà su `https://<utente>.github.io/<repo>/`.

La geolocalizzazione e le notifiche richiedono HTTPS: GitHub Pages lo fornisce.

### Tenere aggiornati i dati

Il workflow `.github/workflows/aggiorna-aree.yml` rigenera ogni notte tutte le
zone e committa da solo. Rifiuta di committare se il risultato è sospetto —
pochi treni, pochi passaggi a livello, nessuno con previsione, codici stazione
duplicati, o troppe poche fermate medie per treno: un file troncato è peggio di
uno vecchio. Se una zona fallisce, le altre si aggiornano comunque.

A mano:

```bash
python3 tools/build_area.py jonica                 # di notte: via andamentoTreno
python3 tools/build_area.py modena --day-offset 1  # di giorno: guarda a domani
python3 tools/build_area.py bologna --cache-ways --keep-timetable
node tools/test_predict.mjs jonica                 # prova il motore senza rete
```

`--cache-ways` riusa binari e nodi già scaricati, `--keep-timetable` riusa
l'orario del file esistente: insieme rendono istantanea una rigenerazione in cui
è cambiata solo la logica.

**Due modi di leggere l'orario, per un vincolo di ViaggiaTreno.** Di notte
(`--day-offset 0`) si usa `andamentoTreno`, che restituisce tutte le fermate di
un treno in una chiamata sola: costa poco e non dipende da quante stazioni ci
sono. Ma risponde solo per i treni con data di partenza odierna, quindi a
giornata iniziata perderebbe tutti quelli già passati. Di giorno si guarda
allora al domani (`--day-offset 1`) interrogando `partenze` e `arrivi` stazione
per stazione: più costoso, ma funziona sempre. Lo script sceglie da sé in base
all'offset.

Overpass limita le richieste ravvicinate e su una serie di zone respinge: le
interrogazioni ruotano fra **quattro istanze** e, se nessuna risponde, si
ripiega sulla copia locale dei binari, che cambiano molto più lentamente degli
orari.

---

## Aggiungere una zona

Una voce in `tools/aree.json`, delimitata per confine amministrativo o per
riquadro:

```json
{
  "slug": "modena",
  "name": "Modena e provincia",
  "region": "Emilia-Romagna",
  "osm_area": "Modena",
  "admin_level": "6",
  "hubs": 8
}
```

Poi `python3 tools/build_area.py modena`. Nient'altro: l'indice delle zone si
riscrive da solo.

Le stazioni non vanno elencate a mano. Lo script le prende da OpenStreetMap e ne
ricava il codice RFI cercandone il nome su ViaggiaTreno, **verificando poi con
le coordinate**: se la stazione trovata dista più di 600 metri dal nodo OSM,
l'abbinamento viene scartato.

Quella verifica non è formale. `cercaStazione` cerca per prefisso e restituisce
comunque un risultato anche quando non c'è corrispondenza: alla richiesta
"REGGIO DI CALABRIA AEROPORTO" risponde "REGGIO DI CALABRIA ARCHI", che è
tutt'altra stazione. Senza il controllo sulle coordinate quell'errore
entrerebbe nei dati in silenzio. C'è anche un controllo sui codici duplicati,
perché una stessa stazione mappata due volte in OpenStreetMap — succede, ad
esempio a Catanzaro Lido — non deve generare un doppione.

Resta manuale una cosa sola: `NAME_OVERRIDES` in `tools/build_area.py`, per i
passaggi a livello che stanno su strade senza `name` in OpenStreetMap. È anche
il posto giusto per correggere un nome sbagliato dopo una verifica sul campo.

---

## Struttura

```
index.html            interfaccia
css/style.css         stile, chiaro e scuro, mobile e desktop
js/predict.js         motore: profilo di velocità, transiti, finestre di chiusura
js/trains.js          orario statico + ritardi reali, a strati
js/rfi.js             client ViaggiaTreno con catena di proxy
js/map.js             mappa dei passaggi a livello
js/calibration.js     osservazioni sul campo, in localStorage
js/notify.js          avvisi programmati
js/theme.js           tema chiaro, scuro o automatico
js/geo.js             distanze e geolocalizzazione
js/config.js          l'unica cosa da configurare: il ponte personale
worker/               il ponte verso ViaggiaTreno, da pubblicare su Cloudflare
js/app.js             interfaccia e composizione
sw.js                 cache offline
vendor/leaflet/       Leaflet 1.9.4, incluso invece che da CDN
data/aree.json        indice delle zone disponibili
data/aree/<slug>.json stazioni, PL, tratte, orario e parametri di una zona
tools/rete.py         grafo dei binari, mirror Overpass, abbinamento stazioni
tools/build_area.py   generatore di una zona
tools/aree.json       definizione delle zone
tools/test_predict.mjs prova del motore senza rete
```

---

## Fonti e licenze

- **Treni**: [ViaggiaTreno](http://www.viaggiatreno.it) (RFI). API non
  ufficiale e non documentata: può cambiare senza preavviso.
- **Passaggi a livello, binari, stazioni**:
  [OpenStreetMap](https://www.openstreetmap.org/copyright), licenza ODbL.
- **Mappa**: [Leaflet](https://leafletjs.com) (BSD-2), piastrelle OpenStreetMap.
- **Preavviso di chiusura**: valore dichiarato da RFI, poi calibrato sul campo.

Progetto indipendente, non affiliato a RFI, Trenitalia o TPER.

> **Alle sbarre guarda le sbarre, non il telefono.** Questa è una previsione, e
> una previsione può sbagliare: un treno merci non in orario, una manovra, un
> guasto. Non sostituisce mai quello che vedi con i tuoi occhi.
