# Agents Pool

Finestra multi-console per un team di agenti AI alimentati da [OpenCode Go](https://opencode.ai/docs/go/).
App desktop per **Linux, macOS e Windows** (Electron + TypeScript, nessuna dipendenza a runtime).

- Una console colorata per ogni agente: nome, ruolo, modello, stato, e **tutto** quello che fa e pensa
  (ragionamento in streaming, testo, chiamate agli strumenti con argomenti e risultati, deleghe, permessi, errori, token/costo).
- Si parla con un solo agente **orchestratore**; gli altri collaborano secondo un **protocollo di interazione** scritto a parole.
  Il controllo torna sempre a lui, che produce la risposta finale.
- Architettura a **ruoli con istanze dinamiche**: orchestratore, planner, worker e verificatore sono *template* configurabili
  (quanti vuoi, di qualunque ruolo, aggiungibili e rimovibili quando vuoi). I worker vengono istanziati per singolo task, con
  contesto pulito e una console effimera propria, e comunicano solo con l'orchestratore (hub-and-spoke, mai fra loro).
- Le richieste conversazionali costano **zero agenti**: l'orchestratore risponde da solo (livello T0) e delega solo quando serve
  (T1 un worker, T2 più worker in parallelo, T3 pianificazione prima di eseguire).
- Limiti applicati dal codice e modificabili nelle impostazioni: worker paralleli (4), istanze per richiesta (8), round di
  correzione (1), budget per task in token/chiamate/secondi con arresto automatico.
- Strumenti: lettura/scrittura/modifica file nel workspace, ricerca, esecuzione comandi, informazioni di sistema e di rete, domande all'utente.
- Le azioni sensibili chiedono **autorizzazione direttamente all'utente** (modale), senza passare dall'agente principale.
- Tutte le impostazioni (prompt, protocollo, modelli, agenti, workspace, modalità permessi, chiave) si modificano a caldo:
  vengono applicate alla chiamata successiva **senza perdere** cronologia e lavoro in corso.

## Requisiti

- Node.js ≥ 20 (sviluppato con Node 24) e npm.
- Una chiave API OpenCode Go (`sk-…`), dalla console Zen dopo aver sottoscritto il piano Go.

## Avvio in sviluppo

```bash
npm install
npm start
```

`npm run dev` avvia con log verbosi (`--dev`). I log del processo main sono in `<userData>/logs/main.log`
(`~/Library/Application Support/Agents Pool` su macOS, `%APPDATA%/Agents Pool` su Windows, `~/.config/Agents Pool` su Linux).

## Primo avvio

1. **Chiave API**: incolla la chiave OpenCode Go e premi *Valida e continua*. La chiave viene verificata con una richiesta minima
   (modello `glm-5.3-flash`, 1 token) e salvata cifrata con il keychain del sistema. Se hai la CLI `opencode` configurata,
   *Importa da opencode* legge la chiave da `~/.local/share/opencode/auth.json`.
2. **Wizard**: scegli la cartella di lavoro (workspace), quanti agenti impiegare — per ciascuno nome del ruolo, modello, prompt di comportamento
   e colore — poi l'agente principale e il protocollo di interazione (testo libero).
3. **Workbench**: una griglia con tante console quanti sono gli agenti, focus sul principale (che ha la casella di input).
   `Ctrl/Cmd+1…9` mette a fuoco la console N.

## Permessi

Le letture nel workspace e le informazioni di sistema/rete sono sempre consentite. I comandi shell vengono classificati
(benigno / sensibile / privilegiato / distruttivo — es. `sudo`, `netsh`, `ip`, `networksetup`, `rm -rf`, `reg add`) e, quando serve
il tuo consenso, la richiesta arriva **direttamente a te** in un modale con *Consenti*, *Consenti per la sessione* (solo comandi
benigni) o *Nega*, senza passare dall'orchestratore. Le richieste hanno un timeout e restano registrate nella console dell'agente
che le ha fatte. Quattro modalità in Impostazioni → Autorizzazioni:

| Modalità | Comportamento |
|---|---|
| **Rigorosa** | conferma per ogni scrittura, eliminazione e comando |
| **Bilanciata** (default) | scritture ed eliminazioni dentro il workspace automatiche; comandi e uscite dal workspace chiedono conferma |
| **Permissiva** | comandi innocui e letture fuori dal workspace automatici; restano protetti i percorsi di sistema e le azioni distruttive |
| **Bypass** | **non chiede mai nulla**: ogni scrittura, eliminazione e comando parte subito, anche fuori dal workspace, sui percorsi di sistema e distruttivo |

Il bypass non riduce la tracciabilità: ogni azione concessa senza chiedere genera comunque un evento nella console dell'agente e una
riga in `logs/main.log`, e finché è attivo l'intestazione mostra un badge rosso *BYPASS PERMESSI* (cliccabile per cambiare modalità).
Usalo solo su una macchina e una cartella che puoi permetterti di perdere.

## Build dei pacchetti

```bash
npm run dist:mac     # .dmg (arm64 + x64)
npm run dist:win     # installer NSIS
npm run dist:linux   # AppImage + .deb
```

I pacchetti finiscono in `release/` (non firmati: imposta `CSC_LINK`/`CSC_KEY_PASSWORD` per firmare).
Da macOS si producono `.dmg` (arm64 e x64) e l'AppImage Linux per l'architettura dell'host; il `.deb` richiede il download di `fpm`
e l'installer Windows richiede un host Windows (o `wine`).

Il workflow `.github/workflows/build.yml` produce i pacchetti sui tre sistemi operativi via GitHub Actions. Pusha un tag `vX.Y.Z`
per farli pubblicare automaticamente come GitHub Release (link permanente, niente scadenza a 90 giorni degli artefatti di Actions):

```bash
npm version 1.0.3   # aggiorna package.json/package-lock.json e crea il tag v1.0.3
git push && git push --tags
```

Un avvio manuale del workflow (senza tag) compila e carica solo gli artefatti della run, senza toccare le Release.

### App non firmata: cosa vedrai al primo avvio

I pacchetti non sono firmati con un certificato Apple Developer / Windows (serve un abbonamento a pagamento). Al primo avvio:

- **macOS**: Gatekeeper mostra *"'Agents Pool.app' è danneggiato e non può essere aperto"* — non è vero, è solo l'app scaricata da
  internet senza firma. Sblocco da Terminale (una volta sola, dopo aver spostato l'app in Applicazioni):
  ```bash
  xattr -cr "/Applications/Agents Pool.app"
  ```
- **Windows**: SmartScreen avvisa che l'app non è riconosciuta. *"Ulteriori informazioni"* → *"Esegui comunque"*.

Per eliminare questi avvisi per chiunque scarichi l'app serve firmare i pacchetti: su macOS con un certificato Developer ID
(`CSC_LINK`/`CSC_KEY_PASSWORD`, più la notarizzazione Apple), su Windows con un certificato di code signing.

## Test

```bash
OPENCODE_API_KEY=sk-... node scripts/api-smoke.mjs   # client API: validazione chiave, modelli, streaming con tool call, classificatore comandi
node scripts/e2e-smoke.mjs                             # app reale via Playwright: import chiave, setup, delega + scrittura file, permesso, hot reload
```

Il test end-to-end usa una cartella dati isolata (`AGENTS_POOL_USER_DATA`, utile anche per profili separati) e importa la chiave
dalla CLI `opencode` tramite il pulsante dell'app; salva screenshot e log in `$E2E_SCRATCH`. Consuma qualche centesimo di quota Go.

## Struttura

```
src/shared/types.d.ts   contratto condiviso: modello dati, eventi console, IPC (window.api)
src/main/               processo Electron: client API, loop agenti, orchestratore, strumenti, permessi, config/stato, IPC
src/renderer/           UI vanilla TS/CSS: schermata chiave, wizard, workbench/console, impostazioni, modali
docs/PLAN.md            specifica di implementazione; docs/RESEARCH.md contratto API OpenCode Go verificato
```

Sicurezza: `contextIsolation` e `sandbox` attivi, `nodeIntegration` disattivo, CSP restrittiva, la chiave API non lascia mai il processo main.
