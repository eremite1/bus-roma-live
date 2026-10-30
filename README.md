# Bus Roma Live

Mappa in tempo reale di bus e tram ATAC a Roma:

- **tutti i mezzi sulla mappa**, che si muovono da soli, con numero di linea, freccia di direzione e capolinea ("verso Termini");
- **fermate** (compaiono avvicinando lo zoom): toccandone una vedi i prossimi passaggi in tempo reale;
- **linea**: scrivi un numero (es. 64) e vedi solo quei mezzi, il percorso e quanti ne vanno in ciascuna direzione;
- **percorso**: scrivi dove vuoi andare; parte dalla tua posizione, calcola il tragitto coi mezzi tenendo conto dei ritardi reali e ti mostra sulla mappa *il bus che devi prendere* e quanto è lontano dalla tua fermata. Si aggiorna da solo ogni minuto. Puoi anche tenere premuto un punto della mappa → "Portami qui".

Il sito si trova su: **https://eremite1.github.io/bus-roma-live/**

---

## Come funziona (in parole semplici)

| Pezzo | Cosa fa | Dove gira |
|---|---|---|
| `index.html`, `css/`, `js/` | La pagina con la mappa | Sul telefono/computer di chi la apre (pubblicata gratis da GitHub Pages) |
| `tools/build_static.py` | Ogni notte scarica gli orari ufficiali ATAC e prepara i file in `data/` (numeri di linea, capolinea, percorsi) | Su GitHub, in automatico |
| `worker/worker.js` | Il "ponte" che legge i GPS dei bus da Roma Mobilità e li passa alla mappa | Su Cloudflare (gratis) |
| Transitous | Calcola i percorsi, i passaggi alle fermate e le posizioni stimate | Servizio esterno libero e gratuito |

**Senza il ponte** la mappa funziona lo stesso, ma le posizioni dei mezzi sono *stimate* (calcolate da orari e ritardi).
**Con il ponte** vedi le posizioni GPS *vere* dei bus. Nella scritta in alto compare "GPS" invece di "posizioni stimate".

---

## Messa in funzione

### 1. Attivare il sito (una volta sola)

1. Apri il repository su GitHub → **Settings** (Impostazioni) → nel menu a sinistra **Pages**.
2. Alla voce **Source** scegli **GitHub Actions**.
3. Vai nella scheda **Actions**, clicca su **"Aggiorna dati e pubblica il sito"** → **Run workflow** → **Run workflow** (pulsante verde).
4. Dopo 2-3 minuti il sito è online all'indirizzo scritto sopra.

### 2. Creare il ponte per i GPS (facoltativo ma consigliato, 5 minuti)

1. Vai su **https://dash.cloudflare.com/sign-up** e crea un account gratuito (basta email e password).
2. Nel menu a sinistra: **Compute (Workers)** → **Workers & Pages** → **Create** → **Create Worker** (o "Start with Hello World").
3. Come nome scrivi `bus-roma` e premi **Deploy**.
4. Premi **Edit code**. Cancella tutto il testo che c'è a sinistra e incolla al suo posto *tutto* il contenuto del file `worker/worker.js` di questo repository.
5. Premi **Deploy** (in alto a destra).
6. Copia l'indirizzo che appare, del tipo `https://bus-roma.TUONOME.workers.dev`.
7. Prova: aprendo nel browser `https://bus-roma.TUONOME.workers.dev/vehicles` deve partire lo scaricamento di un file (sono i dati GPS).
8. Manda l'indirizzo a Claude, che lo inserisce nel file `config.js`. (Oppure: apri `config.js` su GitHub, matita ✏️, scrivi l'indirizzo tra gli apici di `PROXY_URL: ''`, poi **Commit changes**.)

Il piano gratuito di Cloudflare permette 100.000 richieste al giorno: per uso personale e per amici è più che sufficiente (il ponte ricorda i dati per 10 secondi, quindi anche con tante persone collegate Roma Mobilità viene interrogata al massimo 6 volte al minuto).

---

### 3. Attivare la lettura delle deviazioni (pulsante arancione)

Il pulsante arancione legge la foto del messaggio di deviazione e la disegna sulla mappa.
Per leggere il messaggio serve un'intelligenza artificiale: la sua "chiave" va messa nel ponte Cloudflare, dove resta segreta.

1. Crea la chiave (una delle due):
   - **Claude** (Anthropic): https://console.anthropic.com → *API Keys* → *Create Key*. Serve caricare un piccolo credito (minimo 5 $); ogni foto costa circa 1-2 centesimi. Puoi impostare un tetto di spesa mensile.
   - **Gemini** (Google): https://aistudio.google.com/apikey → *Create API key*. Ha un uso gratuito giornaliero.
2. Su Cloudflare apri il worker `bus-roma` → **Edit code** → sostituisci tutto il testo con il nuovo `worker/worker.js` → **Deploy**.
3. Sempre nel worker: **Settings** → **Variables and Secrets** → **Add** → tipo **Secret**:
   - nome `ANTHROPIC_API_KEY` (per Claude) oppure `GEMINI_API_KEY` (per Gemini)
   - valore: la chiave copiata al punto 1 → **Deploy**.

Solo la tua mappa (eremite1.github.io) può usare questa funzione.

**Attenzione:** la deviazione disegnata è un aiuto. Fa fede sempre il messaggio ufficiale; usa il telefono solo a mezzo fermo.

---

## Domande frequenti

**Il sito si aggiorna da solo?** Sì: le posizioni ogni 15 secondi mentre la pagina è aperta; linee e orari ogni notte.

**Perché un bus non ha la direzione?** Succede quando il GPS di ATAC non dice quale corsa sta facendo il mezzo (per esempio quando va o torna dal deposito).

**I dati GPS sono in ritardo?** Roma Mobilità li pubblica con 1-2 minuti di ritardo: la posizione può essere indietro di una fermata.

**Posso aggiungerlo alla schermata Home del telefono?** Sì: aprilo con Chrome (Android) o Safari (iPhone) → menu → "Aggiungi a schermata Home".

---

## Fonti dei dati

- Orari e GPS ATAC: [Roma Servizi per la Mobilità — Open Data](https://romamobilita.it/sistemi-e-tecnologie/open-data/)
- Percorsi, passaggi in tempo reale, posizioni stimate: [Transitous](https://transitous.org) (servizio comunitario, uso non commerciale)
- Mappa: © [OpenStreetMap](https://www.openstreetmap.org/copyright), [OpenFreeMap](https://openfreemap.org), [MapLibre](https://maplibre.org)

Progetto personale non commerciale, senza legami con ATAC o Roma Mobilità. Codice rilasciato con licenza MIT.

## Per chi programma

- `js/gtfsrt.js` legge il formato GTFS-Realtime senza librerie; `test/` contiene un generatore di feed/GTFS finti e una prova automatica con Playwright (`node test/e2e.mjs`).
- La mappa accetta `?proxy=https://...` nell'indirizzo per provare un ponte senza modificare `config.js`.
