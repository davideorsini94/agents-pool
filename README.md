# Agents Windows

Finestra multi-console per un team di agenti AI alimentati da [OpenCode Go](https://opencode.ai/docs/go/).
App desktop per **Linux, macOS e Windows** (Electron + TypeScript, nessuna dipendenza a runtime).

- Una console colorata per ogni agente: nome, ruolo, modello, stato, e **tutto** quello che fa e pensa
  (ragionamento in streaming, testo, chiamate agli strumenti con argomenti e risultati, deleghe, permessi, errori, token/costo).
- Si parla con un solo agente **principale**; gli altri collaborano secondo un **protocollo di interazione** scritto a parole.
  Il controllo torna sempre al principale, che produce la risposta finale.
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
(`~/Library/Application Support/agents-windows` su macOS, `%APPDATA%/agents-windows` su Windows, `~/.config/agents-windows` su Linux).

## Primo avvio

1. **Chiave API**: incolla la chiave OpenCode Go e premi *Valida e continua*. La chiave viene verificata con una richiesta minima
   (modello `glm-5.3-flash`, 1 token) e salvata cifrata con il keychain del sistema. Se hai la CLI `opencode` configurata,
   *Importa da opencode* legge la chiave da `~/.local/share/opencode/auth.json`.
2. **Wizard**: scegli la cartella di lavoro (workspace), quanti agenti impiegare — per ciascuno nome del ruolo, modello, prompt di comportamento
   e colore — poi l'agente principale e il protocollo di interazione (testo libero).
3. **Workbench**: una griglia con tante console quanti sono gli agenti, focus sul principale (che ha la casella di input).
   `Ctrl/Cmd+1…9` mette a fuoco la console N.

## Permessi

Tre modalità (Impostazioni → Permessi): **strict**, **balanced** (default), **relaxed**.
Le letture nel workspace e le informazioni di sistema/rete sono sempre consentite; le scritture nel workspace sono automatiche in balanced/relaxed;
i comandi shell vengono classificati (benigno / sensibile / privilegiato / distruttivo — es. `sudo`, `netsh`, `ip`, `networksetup`, `rm -rf`, `reg add`)
e mostrati all'utente con *Consenti*, *Consenti per la sessione* (solo comandi benigni) o *Nega*. Le richieste hanno un timeout e vengono
registrate nella console dell'agente che le ha fatte.

## Build dei pacchetti

```bash
npm run dist:mac     # .dmg (arm64 + x64)
npm run dist:win     # installer NSIS
npm run dist:linux   # AppImage + .deb
```

I pacchetti finiscono in `release/` (non firmati: imposta `CSC_LINK`/`CSC_KEY_PASSWORD` per firmare).
Da macOS si producono `.dmg` (arm64 e x64) e l'AppImage Linux per l'architettura dell'host; il `.deb` richiede il download di `fpm`
e l'installer Windows richiede un host Windows (o `wine`). Il workflow `.github/workflows/build.yml` produce tutti i pacchetti
sui tre sistemi operativi su GitHub Actions (tag `v*` o avvio manuale).

## Test

```bash
OPENCODE_API_KEY=sk-... node scripts/api-smoke.mjs   # client API: validazione chiave, modelli, streaming con tool call, classificatore comandi
node scripts/e2e-smoke.mjs                             # app reale via Playwright: import chiave, setup, delega + scrittura file, permesso, hot reload
```

Il test end-to-end usa una cartella dati isolata (`AGENTS_WINDOWS_USER_DATA`, utile anche per profili separati) e importa la chiave
dalla CLI `opencode` tramite il pulsante dell'app; salva screenshot e log in `$E2E_SCRATCH`. Consuma qualche centesimo di quota Go.

## Struttura

```
src/shared/types.d.ts   contratto condiviso: modello dati, eventi console, IPC (window.api)
src/main/               processo Electron: client API, loop agenti, orchestratore, strumenti, permessi, config/stato, IPC
src/renderer/           UI vanilla TS/CSS: schermata chiave, wizard, workbench/console, impostazioni, modali
docs/PLAN.md            specifica di implementazione; docs/RESEARCH.md contratto API OpenCode Go verificato
```

Sicurezza: `contextIsolation` e `sandbox` attivi, `nodeIntegration` disattivo, CSP restrittiva, la chiave API non lascia mai il processo main.
