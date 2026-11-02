# ProseArc — notes for development sessions

A human-in-the-loop workspace for translating novels with an AI model: import a book (TXT, MD, EPUB, DOCX, PDF),
the model drafts a translation segment by segment, then the user reviews it side by side, reads it as a book and
exports it (TXT, MD, PDF, EPUB). Arabic is the main target; RTL everywhere. English/Arabic UI.
Electron + plain HTML/CSS/JS (no UI framework, no build step). Windows. MIT licence.
Public repo: https://github.com/Faadred/ProseArc (latest release v1.3.0, 2026-07-02).

The same author's other app, **Subloc** (https://github.com/Faadred/Subloc; a checkout is also on this PC, ask the
user for the path), is the model for where ProseArc is going: it looks polished, feels simple for newcomers and
solid for experts. Read its `CLAUDE.md` and code when porting an idea (files listed at the end).

## Commands

```bash
npm install
npm start          # run in dev (or double-click start.bat: installs packages + fetches the engine first)
npm run fetch-engine   # llama.cpp Vulkan build of the current stable release → vendor/llama (git-ignored, checked)
npm run dist       # fetch-engine, then dist/ProseArc-Setup-<v>.exe + portable exe (engine bundled as resources/llama)
node --check main.js renderer.js preload.js setup.js icons.js i18n.js src/*.js   # the only checks: no tests yet
```

## GitHub and privacy

- The GitHub user was renamed **FEzio78 → Faadred** on 2026-11-02. The remote here now points to
  `Faadred/ProseArc`, and this repo's commits use the noreply e-mail `31814579+Faadred@users.noreply.github.com`
  (set 2026-11-02; older commits carry the personal address, already public).
- `package.json` → `build.publish.owner` is `Faadred` (changed for 1.4.0 on `feat/redesign`).
  Installed copies up to 1.3.0 look for updates at `FEzio78/ProseArc` and work only through GitHub's redirect, so
  the old name must never host a `ProseArc` repo (the user holds the name with an empty `FEzio78` organization).
- Test books are private: `*.pdf` is git-ignored (a commercial novel sits in the folder for testing). Never
  commit or push book text, not even a quoted line in a code comment or commit message.
- Workflow so far: feature branches (`feat/…`, `docs/…`) → pull request → `main`; releases via `gh release`
  with the installer + portable exe + `latest.yml` (electron-updater needs it).

## Layout

- `main.js` — window, IPC handlers (`projects:*`, `cover:*`, `glossary:*`, `settings:*`, `secrets:*`,
  `manuscript:pick`, `export:project`, `engine:*`), electron-updater check on start.
- `preload.js` — the bridge the renderer uses. `renderer.js` — all UI (library, book hub, workspace, review,
  reader, glossary, settings, models panel, shortcuts). `setup.js` — first-run Setup wizard. `icons.js` — Lucide
  icons (ISC) used as `icon(name)` / `<i data-icon>`; add new ones from `lucide-static`. `index.html`,
  `styles.css` (tokens in `:root`, sections appended per step), `i18n.js` (English + Arabic table).
- `src/engine.js` — the translation run: provider → HTTP request (OpenAI shape, Anthropic native), streaming,
  timeout + retry, resumable. `src/prompt.js` — messages per segment (style brief, glossary terms found in the
  segment, continuity context). `src/segmenter.js`, `src/store.js` (projects as JSON, atomic saves, settings,
  API keys in their own file — plain text today), importers `epub.js`, `docx.js`, `pdf.js`, `html-to-blocks.js`,
  `src/exporter.js`.
- Built-in translator (step 3): `src/llama.js` runs `llama-server` hidden on 127.0.0.1 with a free port (one
  model, `-np 1 --no-mmproj --no-webui --reasoning-budget 0` unless thinking is on), stops on quit;
  `src/llama-release.js` follows llama.cpp's stable release (`releases/latest` only carries `nightly-tag.txt`
  naming the build, e.g. v0.8.0 → b11960), downloads zips checked against GitHub's SHA-256 digest, unzips with
  Windows' `tar.exe`. Bundled build in `vendor/llama` (dev) / `resources/llama` (installed); downloads (NVIDIA
  CUDA 12, updates) in `%APPDATA%\prosearc\engine\<flavour>-<build>`; Undo pins the previous build.
  `src/models.js` scans the user's model folders recursively for `.gguf` (skips mmproj/split parts), reads the
  GGUF header, rates fit. `src/hardware.js` (GPU + VRAM from the display-adapter registry keys, RAM, CPU),
  `src/local-servers.js` (finds LM Studio / Ollama).
- Find models (step 4): `src/hub.js` searches Hugging Face (`/api/models?filter=gguf&sort=downloads`, skips gated,
  private, audio/embedding repos), lists a repo's files (`/tree/main?recursive=true`; skips mmproj/MTP/imatrix,
  split parts, files without an LFS SHA-256), rates fit, recommends Q4_K_M first. `src/download.js` is the one
  downloader (models and engine builds): Node `https` (fetch() was ~13x slower on big files), resumable `.part`,
  SHA-256 while downloading, free-space check. `models-dialog.js` is the Find models window. Downloads go to
  `<download folder>/<owner>/<repo>/<file>`; the default download folder is the first model folder (the user's
  real `E:\Ai\lm-studio\models`), so in tests always point the demo profile's `downloadFolder` at a scratch
  folder first.
- Data: `%APPDATA%\prosearc\` (`projects\`, `glossary-global.json`, settings, keys, `app-config.json` for
  model folders + engine choice, `engine\`).
- Providers (step 5): one registry, `src/providers.js` (id, kind builtin/local/cloud/custom, base URL, key link),
  used by the engine and the UI: `builtin`, `lmstudio`, `ollama`, `openai`, `anthropic` (native API), `gemini`,
  `openrouter`, `groq`, `deepseek`, `huggingface` (router.huggingface.co), `compatible`. `local` + a full `apiUrl`
  is the pre-step-5 setting: still honoured by the engine; books on it switch to lmstudio/ollama when opened.
  Local apps get `reasoning_effort: "none"` unless thinking is on. Secrets file (`<id>` = key, `<id>BaseUrl` =
  address) is encrypted with Electron `safeStorage` (`{v:2, enc}`); old plain files are upgraded on first read.
  UI: Settings tabs General / Providers / Built-in translator (`providers-ui.js`), logos in `provider-logos.js`
  (simple-icons, CC0; OpenAI and Groq have lettermarks — no logo in simple-icons).
- The user's models for testing: `E:\Ai\lm-studio\models` (LM Studio layout, publisher/model/file.gguf). Use
  them in place; never copy or download multi-GB models for tests. No Ollama on this PC.

## Where we left off (2026-11-02, end of a long session)

- **Steps 1–5 of the plan are done on branch `feat/redesign`** (local only: not pushed, not merged; the user
  decides when). Commits: redesign (cfe7375, 34bce66), Setup (3afac1d), built-in llama.cpp (6ff7ed3),
  Hugging Face models (1364b01), Providers + encrypted keys (cc59fb4), then Setup switch/skip, neutral provider
  wording and this README/notes update. Next: the user tests the branch (`start.bat`), then **step 6, release**.
- Step 6 so far (2026-11-02): version 1.4.0, `build.publish.owner` → `Faadred`, README intro + new screenshots
  (public-domain books on a demo profile), app updates in Settings → General → Updates (`app:*` IPC; portable/dev
  get a link to the releases page), installer built (`dist/ProseArc-Setup-1.4.0.exe`), release notes in
  `RELEASE_NOTES_v1.4.0.md` (untracked). Branch pushed with a PR to `main`. Left: merge, then `gh release`.
- Not tested yet: a full translation with a real cloud key (no keys used; LM Studio, Groq 401 and the Hugging
  Face router were checked live); engine Undo (needs a newer llama.cpp stable); a multi-GB Hugging Face download
  (only a 100 MB model was downloaded).
- The user's wishes from this session: no opinions in the UI about which provider/model to use (cards and Setup
  say only where something runs: on this PC / online); Setup must always offer a way out (switch between this PC
  and online on the Connect step, "Skip for now"); the app must look right at its smallest window (980×600: the
  sidebar becomes an icon rail below 1100 px). No Ollama on this PC: don't test it.
- Don't imply local translation needs strong hardware: small models (~4B) run on a modest GPU or on CPU/RAM and
  can translate well; quality depends on the model. Translation goes passage by passage (built-in context 8K),
  never the whole book at once.
- How screens were tested: the real app on a **separate demo profile** (a launcher that calls
  `app.setPath('userData', …)` before requiring `main.js`, made-up demo books, remote debugging to drive it and
  take screenshots). Never use the user's real `%APPDATA%\prosearc`, and point the demo profile's
  `downloadFolder` at a scratch folder before testing downloads.
- Parked in `git stash` (from July; was uncommitted on `main`): continuity context now sends source ⇢ translation pairs plus a 2-segment
  look-ahead, and asks the model to settle "you" (singular/plural, gender) from that context (`src/prompt.js`,
  label/hint in `i18n.js` + `index.html`). Not tested in a run yet. The user said to skip it for now: leave it
  alone and don't list it as an open item unless they bring it up. If it is ever committed, remove the comment in `prompt.js` that quotes a line
  from the test book first.
- The user found the app good but busy for someone new and plain next to Subloc; steps 1–5 answer that.

## Decision: stay on Electron/JavaScript (2026-11-02)

The user asked whether to move to Python; the call was to stay. ProseArc works (v1.3.0) and its hardest parts are
HTML/CSS strengths: book typography, RTL, the reader, EPUB/PDF export. A PySide6 rewrite would spend months getting
back to today. What should come from Subloc is its *designs*, and they port easily: llama.cpp runs as its own
program (`llama-server.exe`) talked to over HTTP, and Hugging Face is a plain web API.

## Plan (the user's direction, 2026-11-02)

Work on a branch per step, test in the real app, merge when the user says. Steps 1 and 2 can go together.

1. **A real redesign of the look** (the user's screenshot of the Library, 2026-11-02, at about 2000 px wide:
   one small book card in a narrow centre column, the rest of the window empty). What makes it look plain, and
   the fix:
   - `.view { max-width: 1000px; margin: 0 auto }` in `styles.css` leaves most of a big window empty. Let pages
     use the width (Library: a responsive grid of book cards, `repeat(auto-fill, minmax(220px, 1fr))`; keep a
     narrow measure only for reading text: the reader, the style brief).
   - The sidebar uses text dots as icons, and shows Workspace / Review / Read / Glossary even when no book is open.
     Use real icons (Lucide SVGs, coloured by CSS, like Subloc's `subloc/ui/icons.py` + `assets/icons`). Global
     items: Library, Glossary (shared), Settings. A book's pages appear only when a book is open, under its cover
     and title, so the next step is obvious.
   - Language and Dark/Light are three big buttons at the bottom: move them into Settings (or a small icon row).
   - Text is small for a large window (15 px base, many 0.82 rem labels): raise the base size, fewer greys.
   - Book cards: the cover as the hero (book proportions, ~2:3, not a cropped band), title, languages, a coloured
     progress bar, a "Continue" button, other actions (rename, cover, delete) in a ⋯ menu. Books without a cover
     get a generated one (title on a tinted background).
   - Empty and first-run states with one clear action ("Import your first book"). Subloc's Home is a good
     reference: big "New project" target + recent list.
   - Keep the warm palette and gold accent (it suits books, like Subloc's single yellow accent); tidy the tokens
     in `:root` (surfaces in 3 steps, one line colour, one radius scale, spacing scale) the way Subloc's
     `subloc/ui/theme.py` does. Hover/focus states and short transitions everywhere; toasts for messages that need
     no answer.
   - README screenshots must be remade from a public-domain or made-up book (the current test books are
     commercial novels: never show their covers or text in the repo).
2. **Easy for newcomers.** A first-run Setup like Subloc's (`subloc/ui/setup.py`): check the PC (graphics card,
   memory), choose *On this PC* (built-in) or *Online provider*, pick or find a model, download it checked, a quick
   test translation, done. Then one obvious path per book: Import → Translate → Review → Read / Export.
   Advanced options (context size, timeouts, custom URLs) behind an "Advanced" fold, sensible defaults.
   Short messages that need no answer as toasts; questions and real errors as dialogs; one icon set (Lucide SVGs,
   no emoji as icons); keyboard shortcuts with a help window.
3. **Built-in translator (llama.cpp).** Ship `llama-server` (Vulkan build, works on any GPU); on NVIDIA PCs offer
   the CUDA 12 build as a checked download. Start it hidden on `127.0.0.1` with a free port and treat it as
   another OpenAI-compatible provider. Engine updates like Subloc 0.2.2 (`subloc/llama.py`, `subloc/engine.py`):
   follow llama.cpp's *stable* release (it only carries `nightly-tag.txt` naming the build), download the Windows
   zips checked against GitHub's asset digest, run `llama-server --version` before switching, keep the old build
   for Undo, use the newest of bundled vs downloaded.
4. **Find models on Hugging Face.** Port `subloc/hub.py` + `subloc/ui/models_dialog.py`: search
   `https://huggingface.co/api/models?filter=gguf&sort=downloads` (skip gated, private, embedding/speech models),
   list a repo's files from `/api/models/<repo>/tree/main?recursive=true` (skip `mmproj`, `mtp`, split files,
   files without an LFS SHA-256), rate each file for this PC (fits the card / partly / processor / too big),
   pre-select the preferred quant (Q4_K_M first), download resumable and checked against the LFS SHA-256.
   Note in the UI that untested models may translate worse, Arabic especially.
5. **Providers page in Settings** (the user's reference: a searchable grid of provider cards, each with its logo
   and a green "Activated" badge when set up). Clicking a card opens its panel: API key (or URL), Test, model list
   from the provider's `/models`, a "Get a key" link. **AI models only** (the user's choice): Built-in
   (llama.cpp), Ollama, LM Studio, OpenAI, Anthropic Claude, Google Gemini, OpenRouter, Groq, DeepSeek,
   Hugging Face (Inference Providers), Custom (any OpenAI-compatible URL). Classic translators (DeepL, Google
   Translate, Azure) are left out: they can't follow the glossary, style brief or story context. Store keys
   encrypted with Electron's `safeStorage` instead of plain text. Logos: simple-icons (CC0) where available.
6. **Release.** `publish.owner` → Faadred, links in the README, release notes Arabic first then English with the
   installer's SHA-256, shown to the user before publishing. Later: code signing (SmartScreen warns today).

Where to look in Subloc: `subloc/hub.py` (search, fit, recommend, checked download), `subloc/llama.py` (engine
updates, Undo), `subloc/engine.py` (start/stop llama-server, pick backend, readable errors),
`subloc/hardware.py` (GPU/VRAM/RAM), `subloc/download.py` (resumable + SHA-256), `subloc/ui/setup.py`,
`subloc/ui/models_dialog.py`, `subloc/ui/widgets.py` (Banner, Toast).
