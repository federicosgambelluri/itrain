# iTrain — passaggi a livello della Ferrovia Jonica

Sapere se il passaggio a livello è aperto, chiuso o sta per chiudersi
**prima di uscire di casa**, invece di scoprirlo fermi davanti alle sbarre.

Copre **35 passaggi a livello e 36 stazioni** lungo i 204 km della Jonica, da
Reggio Calabria Centrale a Cropani. L'app mostra sempre quello più vicino a te.

Applicazione web statica: nessun database, nessun server, si pubblica su
GitHub Pages così com'è.

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

Calcolato una volta per tutte da OpenStreetMap (`tools/build_data.py`): i
segmenti della ferrovia Jonica vengono ricuciti in un'unica polilinea di 204 km,
poi stazioni e passaggi a livello ci vengono proiettati sopra per ottenere la
**progressiva**, cioè quanti metri di binario li separano.

Sulla tratta intera la ferrovia non è una catena semplice — ci sono raccordi che
creano biforcazioni — quindi lo script costruisce un grafo dei segmenti e tiene
il percorso più lungo fra due capilinea, scartando i tronchetti laterali.

| Passaggio a livello | Progressiva | Distanza dalla stazione di Siderno |
|---|---|---|
| Via Genova | km 15,583 | 196 m |
| Via Torquato Tasso | km 15,310 | 469 m |
| Via Cristoforo Colombo | km 15,100 | 679 m |
| Via Jonio | km 14,588 | 1191 m |

Tutti e quattro stanno fra la stazione e Locri: sono esattamente quelli che
tagliano la strada verso il mare.

### 2. Quando il treno ci passa sopra

Interpolando fra le due stazioni che lo racchiudono — ma **non linearmente**.
Un treno riparte da fermo e frena fino a fermarsi, quindi vicino alla stazione
è molto più lento della sua media. Su Via Genova, a 196 metri dalla stazione,
ignorare questo sposterebbe la previsione di una ventina di secondi.

Si usa un profilo di velocità trapezoidale (accelerazione, crociera, frenata).
Nota la velocità di crociera V dalla distanza D e dal tempo T di orario
risolvendo `T = V/a + D/V`, e la si limita alla velocità di rango della linea.

### 3. Quando scendono le barriere

Circa **2 minuti e mezzo prima del transito**, valore dichiarato da RFI (prima
dell'ammodernamento superava i 4 minuti). È il numero meno solido dei tre,
perché dipende da dove si trova il circuito di binario che comanda la chiusura,
e cambia da impianto a impianto.

**Per questo l'app si calibra sul campo.** I tasti *«si è chiuso ora»* e *«si è
riaperto ora»* misurano il preavviso reale di *quel* passaggio a livello e
sostituiscono il valore di targa. Dopo due o tre osservazioni la previsione
smette di essere generica. Le osservazioni restano in `localStorage`: niente
database, niente dati che lasciano il telefono, esportabili in JSON.

Le finestre che si sovrappongono vengono fuse: sulla Jonica, a binario unico, i
treni si incrociano in stazione e capita di vederne due fermi insieme per
cinque minuti. Per chi è in auto quello è un unico sbarramento, non due.

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

Se un giorno volessi più affidabilità, un Cloudflare Worker gratuito da quindici
righe risolve la cosa: basta aggiungerlo in testa a `PROXIES`.

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

Due workflow già pronti in `.github/workflows/`, che committano da soli:

| Workflow | Quando | Cosa fa |
|---|---|---|
| `aggiorna-dati.yml` | ogni notte alle 3:30 | riscarica l'orario dei treni |
| `aggiorna-passaggi.yml` | il primo del mese | riscarica i PL da OpenStreetMap |

Entrambi rifiutano di committare se il risultato è sospetto — troppo pochi
treni, poche fermate medie per treno, meno di quattro PL attorno a Siderno, o
due stazioni con lo stesso codice: un file troncato è peggio di uno vecchio.

**L'orario notturno non è una comodità, è un vincolo.** ViaggiaTreno impone due
limiti che insieme decidono la forma dello scanner:

- `partenze` e `arrivi` non restituiscono i treni già passati;
- `andamentoTreno` — l'unico che dà tutte le fermate di un treno in una sola
  chiamata — risponde soltanto per i treni con data di partenza odierna.

A notte fonda entrambi spariscono: la giornata è tutta davanti. È questo che
rende il costo indipendente dal numero di stazioni: interrogarle tutte una per
una richiederebbe oltre milleseicento chiamate al giorno, mentre così ne bastano
circa duecentocinquanta indipendentemente da quanto è lunga la tratta.

L'orario si costruisce per accumulo, annotando in quali giorni della settimana
ciascun treno circola. Finché un giorno è coperto solo in parte l'app lo
dichiara invece di far finta di niente.

A mano:

```bash
python3 tools/build_timetable.py            # orario di oggi (da lanciare di notte)
python3 tools/build_timetable.py --reset    # ricostruisce da zero
python3 tools/build_data.py                 # geometria, stazioni e PL
node tools/test_predict.mjs                 # prova il motore senza rete
```

---

## Estendere ad altre linee

Serve cambiare **due valori** in `tools/build_data.py`: `BBOX` (il riquadro
geografico) e `LINE_REF` (il numero della linea in OpenStreetMap). Poi si
rigenerano i dati. Nient'altro.

Le stazioni non vanno più elencate a mano. Lo script le prende da
OpenStreetMap e ne ricava il codice RFI cercandone il nome su ViaggiaTreno,
**verificando poi con le coordinate**: se la stazione trovata dista più di 600
metri dal nodo OSM, l'abbinamento viene scartato.

Quella verifica non è formale. `cercaStazione` cerca per prefisso e restituisce
comunque un risultato anche quando non c'è corrispondenza: alla richiesta
"REGGIO DI CALABRIA AEROPORTO" risponde "REGGIO DI CALABRIA ARCHI", che è
tutt'altra stazione. Senza il controllo sulle coordinate quell'errore
entrerebbe nei dati in silenzio. C'è anche un controllo sui codici duplicati,
perché una stessa stazione mappata due volte in OpenStreetMap — succede, ad
esempio a Catanzaro Lido — non deve generare un doppione.

Resta manuale una cosa sola: `NAME_OVERRIDES`, per i passaggi a livello che
stanno su strade senza `name` in OpenStreetMap. È anche il posto giusto per
correggere un nome sbagliato dopo una verifica sul campo.

Il codice non ha nulla di specifico su una località: PL, stazioni e progressive
arrivano tutti dai file in `data/`.

---

## Struttura

```
index.html            interfaccia
css/style.css         stile, chiaro e scuro, mobile e desktop
js/predict.js         motore: profilo di velocità, transiti, finestre di chiusura
js/trains.js          orario statico + ritardi reali, a strati
js/rfi.js             client ViaggiaTreno con catena di proxy
js/calibration.js     osservazioni sul campo, in localStorage
js/notify.js          avvisi programmati
js/geo.js             distanze e geolocalizzazione
js/app.js             interfaccia e composizione
sw.js                 cache offline
js/theme.js           tema chiaro, scuro o automatico
data/linea.json       linea, stazioni, passaggi a livello, parametri del modello
data/timetable.json   orario di riferimento, rete di sicurezza
tools/                generatori dei dati e prova del motore
```

---

## Fonti e licenze

- **Treni**: [ViaggiaTreno](http://www.viaggiatreno.it) (RFI). API non
  ufficiale e non documentata: può cambiare senza preavviso.
- **Passaggi a livello e geometria della linea**:
  [OpenStreetMap](https://www.openstreetmap.org/copyright), licenza ODbL.
- **Preavviso di chiusura**: valore dichiarato da RFI, poi calibrato sul campo.

Progetto indipendente, non affiliato a RFI o Trenitalia.

> **Alle sbarre guarda le sbarre, non il telefono.** Questa è una previsione, e
> una previsione può sbagliare: un treno merci non in orario, una manovra, un
> guasto. Non sostituisce mai quello che vedi con i tuoi occhi.
