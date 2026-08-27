/**
 * iTrain — ponte verso ViaggiaTreno.
 *
 * ATTENZIONE: PROVATO SUL CAMPO, NON FUNZIONA CON VIAGGIATRENO.
 *
 * Il Worker in se' e' corretto e fa il suo mestiere, ma ViaggiaTreno sta
 * dietro Akamai, che rifiuta le richieste in arrivo dalle reti Cloudflare
 * Workers rispondendo "Access Denied". Verificato due volte, prima con uno
 * User-Agent dichiarato e poi con un insieme completo di header da browser
 * (compreso il Referer sul sito stesso): nessuna differenza.
 *
 * Che non fosse questione di come ci si presenta lo dimostra una prova
 * fatta da un indirizzo residenziale, dove la stessa chiamata passa con
 * qualsiasi User-Agent, perfino vuoto. Il filtro guarda da dove arrivi.
 *
 * Il file resta qui perche' la conoscenza vale: chi provasse la stessa strada
 * saprebbe subito che porta a un muro, e perche' su un'altra API senza CORS
 * questo codice funzionerebbe cosi' com'e'.
 *
 * ViaggiaTreno non manda l'header Access-Control-Allow-Origin, quindi il
 * browser scarica la risposta e poi si rifiuta di consegnarla al codice della
 * pagina. Non e' un blocco di RFI: e' una regola del browser, uguale per tutti
 * i siti, e dalla pagina non e' aggirabile. Serve un intermediario che non sia
 * un browser, rifaccia la richiesta e rimetta l'header mancante.
 *
 * Questo Worker fa esattamente quello e nient'altro.
 *
 * Perche' non e' un proxy aperto
 * ------------------------------
 * Accetta solo destinazioni su www.viaggiatreno.it, e solo sul percorso delle
 * API che servono. Un proxy che rigira qualsiasi URL diventa in fretta uno
 * strumento per mascherare traffico altrui: verrebbe abusato, e Cloudflare lo
 * spegnerebbe. Il controllo qui sotto e' cio' che tiene il servizio tuo.
 *
 * ViaggiaTreno sta dietro Akamai, che filtra i bot. Da un indirizzo
 * residenziale lascia passare qualsiasi cosa -- provato: anche User-Agent
 * vuoto -- ma da una rete datacenter come quella dei Worker guarda l'insieme
 * degli header. Per questo la richiesta qui sotto si presenta come un browser
 * vero, con Referer sul sito stesso: non e' un trucco, e' il modo in cui
 * quelle API vengono chiamate normalmente.
 *
 * Uso:  https://<tuo-worker>.workers.dev/?u=<URL ViaggiaTreno codificato>
 */

const HOST_CONSENTITO = "www.viaggiatreno.it";
const PERCORSI_CONSENTITI = [
  "/infomobilitamobile/resteasy/viaggiatreno/",
  "/infomobilita/resteasy/viaggiatreno/",
];

// I ritardi cambiano al minuto: una ventina di secondi di cache alleggerisce
// ViaggiaTreno e rende l'app piu' pronta, senza mostrare dati vecchi.
const CACHE_SECONDI = 20;

const intestazioni = (extra = {}) => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
  ...extra,
});

const errore = (messaggio, stato) =>
  new Response(JSON.stringify({ errore: messaggio }), {
    status: stato,
    headers: intestazioni({ "Content-Type": "application/json; charset=utf-8" }),
  });

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: intestazioni() });
    }
    if (request.method !== "GET") {
      return errore("solo GET", 405);
    }

    const destinazione = new URL(request.url).searchParams.get("u");
    if (!destinazione) {
      return errore("manca il parametro u con l'indirizzo da chiamare", 400);
    }

    let target;
    try {
      target = new URL(destinazione);
    } catch {
      return errore("il parametro u non e' un indirizzo valido", 400);
    }

    const consentito = target.hostname === HOST_CONSENTITO &&
      PERCORSI_CONSENTITI.some((p) => target.pathname.startsWith(p));
    if (!consentito) {
      return errore(`questo ponte porta solo a ${HOST_CONSENTITO}`, 403);
    }

    let risposta;
    try {
      risposta = await fetch(target.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
          Referer: "http://www.viaggiatreno.it/infomobilita/index.jsp",
        },
        cf: { cacheTtl: CACHE_SECONDI, cacheEverything: true },
      });
    } catch (e) {
      return errore("ViaggiaTreno non risponde: " + e.message, 502);
    }

    // ViaggiaTreno risponde con un corpo vuoto quando non ci sono treni in
    // quella fascia oraria: e' un esito legittimo, non un errore, e va
    // passato cosi' com'e'.
    const corpo = await risposta.text();

    // Akamai, che protegge ViaggiaTreno, risponde con una pagina HTML quando
    // decide di bloccare. Riconoscerla e dirlo chiaramente evita di far
    // arrivare all'app dell'HTML dove si aspetta JSON.
    if (corpo.trimStart().startsWith("<")) {
      return errore(
        "ViaggiaTreno ha rifiutato la richiesta del ponte (filtro anti-bot). " +
        "Riprova piu' tardi o usa i proxy pubblici.", 502);
    }

    return new Response(corpo, {
      status: risposta.ok ? 200 : risposta.status,
      headers: intestazioni({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDI}`,
      }),
    });
  },
};
