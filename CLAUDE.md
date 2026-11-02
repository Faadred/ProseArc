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
npm start          # run in dev
npm run dist       # dist/ProseArc-Setup-<v>.exe + ProseArc-<v>-portable.exe (electron-builder)
node --check main.js renderer.js preload.js src/*.js   # the only checks today: there are no tests yet
```

## GitHub and privacy

- The GitHub user was renamed **FEzio78 → Faadred** on 2026-11-02. The remote here now points to
  `Faadred/ProseArc`, and this repo's commits use the noreply e-mail `31814579+Faadred@users.noreply.github.com`
  (set 2026-11-02; older commits carry the personal address, already public).
- `package.json` → `build.publish.owner` still says `FEzio78`: change it to `Faadred` in the next release.
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
  reader, glossary, settings). `index.html`, `styles.css`, `i18n.js` (English + Arabic table).
- `src/engine.js` — the translation run: provider → HTTP request (OpenAI shape, Anthropic native), streaming,
  timeout + retry, resumable. `src/prompt.js` — messages per segment (style brief, glossary terms found in the
  segment, continuity context). `src/segmenter.js`, `src/store.js` (projects as JSON, atomic saves, settings,
  API keys in their own file — plain text today), importers `epub.js`, `docx.js`, `pdf.js`, `html-to-blocks.js`,
  `src/exporter.js`.
- Data: `%APPDATA%\prosearc\` (`projects\`, `glossary-global.json`, settings, keys).
- Providers today: `local` (LM Studio / any OpenAI-compatible URL, default `http://localhost:1234`), `openai`,
  `openrouter`, `gemini`, `anthropic`, `compatible`.

## Where we left off (2026-11-02)

- Uncommitted on `main` (from July): continuity context now sends source ⇢ translation pairs plus a 2-segment
  look-ahead, and asks the model to settle "you" (singular/plural, gender) from that context (`src/prompt.js`,
  label/hint in `i18n.js` + `index.html`). Not tested in a run yet. The user said to skip it for now: leave it
  alone unless they bring it up. If it is ever committed, remove the comment in `prompt.js` that quotes a line
  from the test book first.
- The user finds the app good but busy for someone new, and plain-looking next to Subloc ("looks meh"; it was
  built before they cared about looks). They want it to look and feel as easy and solid as Subloc.

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
