// IMPOSTAZIONI DELLA MAPPA
// Questo è l'unico file che potresti dover modificare a mano.

window.CONFIG = {
  // Indirizzo del "ponte" Cloudflare che legge i dati GPS di ATAC.
  // Lascialo vuoto ('') finché non l'hai creato: la mappa userà le posizioni stimate.
  // Esempio:  PROXY_URL: 'https://bus-roma.tuonome.workers.dev',
  PROXY_URL: 'https://bus-roma.ciabbro.workers.dev',

  // Ogni quanti secondi aggiornare le posizioni GPS (non scendere sotto 10).
  REFRESH_SECONDS: 20, // ATAC aggiorna i GPS circa ogni 60 secondi

  // Centro e zoom iniziale della mappa (Roma).
  CENTER: [12.4964, 41.9028],
  ZOOM: 12,

  // Servizio gratuito per percorsi, fermate e orari in tempo reale.
  TRANSITOUS_API: 'https://api.transitous.org',
};
