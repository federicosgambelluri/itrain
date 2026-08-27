/**
 * iTrain — ponte verso ViaggiaTreno.
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
          Accept: "application/json",
          "User-Agent": "iTrain (https://github.com/federicosgambelluri/itrain)",
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
    return new Response(corpo, {
      status: risposta.ok ? 200 : risposta.status,
      headers: intestazioni({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDI}`,
      }),
    });
  },
};
