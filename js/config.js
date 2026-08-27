/**
 * Configurazione dell'app.
 *
 * L'unica cosa da impostare a mano, e solo se vuoi.
 */

/**
 * Indirizzo del tuo ponte verso ViaggiaTreno (Cloudflare Worker).
 *
 * Lasciandolo vuoto l'app funziona esattamente come prima, appoggiandosi ai
 * proxy pubblici. Incollandolo qui, il tuo ponte diventa il primo tentativo e
 * i proxy pubblici restano come riserva: se il Worker un giorno non
 * rispondesse, l'app scivola su di loro senza accorgersene.
 *
 * Esempio:
 *   export const PROXY_URL = "https://itrain-proxy.tuonome.workers.dev/";
 *
 * Il codice del Worker sta in worker/itrain-proxy.js, e le istruzioni per
 * pubblicarlo nel README.
 */
export const PROXY_URL = "";
