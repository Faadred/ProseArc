<p align="center">
  <img src="assets/logo.png" alt="ProseArc" width="420" />
</p>

<p align="center"><a href="#arabic">العربية ↓</a></p>

A **human‑in‑the‑loop workspace for translating novels** with a **local or cloud** AI model. Import a manuscript, let the model produce a first‑pass translation, then review it side‑by‑side, read it as a book, and polish it — keeping full control over quality, consistency, and tone.

> **Local by default, cloud optional.** Out of the box, every AI call goes to a *local* server (LM Studio) — nothing leaves your machine. You can optionally connect a cloud provider (OpenAI, OpenRouter, Gemini, Claude); then the text you translate is sent to that provider.

Built with Electron + plain HTML/CSS/JS — no UI framework.

## Screenshots

|  |  |
| --- | --- |
| ![Library — your books](assets/screenshots/library_EN.png) | ![Review — original vs. translation](assets/screenshots/review_EN.png) |
| ![Reader — read it as a book](assets/screenshots/reader_EN.png) | ![Glossary — terms & auto‑suggested names](assets/screenshots/glossary_EN.png) |

---

## Features

- **Project library & per‑book hub** — each book is one project; open it to a page with **Read / Translate / Review / Export** and progress at a glance.
- **Structure‑aware import** — import **TXT, Markdown, EPUB, Word (.docx), or PDF**. Headings, paragraphs, block quotes, lists, scene breaks, and *italic* / **bold** emphasis are preserved through translation and back out to every export — not flattened into a wall of text. PDF structure is reconstructed heuristically (headings, paragraphs, emphasis; running headers and page numbers are stripped); scanned/image‑only PDFs are not supported.
- **Local or cloud models** — translate with a **local** server (LM Studio, or any OpenAI‑compatible) *or* a **cloud** provider (**OpenAI, OpenRouter, Gemini, Claude**); choose per book. API keys are stored only on your device.
- **Translation engine** — streams progress and a live activity log; per‑request timeout + auto‑retry; resumable runs.
- **Per‑book translation style** — an optional brief (tone, formality, audience) sent with every segment.
- **Split‑screen review editor** — original vs. editable translation, **RTL‑aware** (e.g. Arabic), a virtualized navigator for tens of thousands of segments, **filter by status**, search with live match **highlighting**, **find & replace** across all translations, and one‑click *retranslate* / *mark all reviewed*.
- **Reader** — read the finished translation as a book: chapter **contents**, adjustable **font / size / width / theme** (dark · sepia · light), **resume position**, per‑paragraph **bookmarks & notes**, and **bilingual** tap‑to‑reveal of the original.
- **Glossary** — a shared dictionary plus per‑project terms (project overrides shared), injected only into segments where a term appears, to stop name‑drift — plus **auto‑suggested names** detected from the book.
- **Export** — TXT, Markdown, PDF, and EPUB (RTL‑aware), with a warning if any segment is still untranslated.
- **Settings** — app‑wide defaults for new projects (model, languages, context) plus appearance.
- **Polish** — bundled fonts (Spectral / Amiri / Inter), dark + light themes, book covers, and a full **English / Arabic** interface with RTL.
- **Updates itself** — the installed app checks GitHub for a new version on start.

## Coming next

ProseArc is getting easier to start with:

- **A fresh look** that uses the whole window, with clear icons and bigger book covers.
- **A first‑run setup** that checks your PC and gets you translating in a few clicks.
- **A built‑in translator** (llama.cpp): no LM Studio needed, still fully on your PC.
- **Find models on Hugging Face** from inside the app, with the right file for your PC suggested and the download checked.
- **A providers page** in Settings: one card per AI provider (OpenAI, Claude, Gemini, OpenRouter, Groq, DeepSeek, Ollama, LM Studio…), with keys stored encrypted.

---

## Download & run

For most people — no Node, no setup:

**[⬇ Download the latest release](https://github.com/Faadred/ProseArc/releases/latest)** (Windows)

- **Installer** (`ProseArc‑Setup‑*.exe`) — adds a Start Menu shortcut + uninstaller, or
- **Portable** (`ProseArc‑*‑portable.exe`) — a single file, just double‑click.

> Because the app isn't code‑signed, Windows SmartScreen may say *“Windows protected your PC.”* Click **More info → Run anyway**.

## You'll also need: a model

ProseArc doesn't bundle an AI model — you point it at one. Two ways:

**Local — private, free, offline.** Run a model on your own machine with **[LM Studio](https://lmstudio.ai/)**:
1. Install LM Studio and **load** a chat/instruct model.
2. Open **Developer / Local Server** → **Start Server** (defaults to `http://localhost:1234`).
3. In ProseArc, keep the provider on **Local** and click **Test connection**.

**Cloud — often higher quality, paid per use.** Use **OpenAI, OpenRouter, Gemini, or Claude**:
1. Get an API key from the provider.
2. In **Settings → API keys**, paste it under that provider.
3. In the book's **Workspace**, set **Provider** to it and enter a **model id** (e.g. `gpt-4o-mini`, `claude-3-5-sonnet-latest`, `gemini-2.0-flash`, or an OpenRouter id like `openai/gpt-4o-mini`).

> Cloud keys are stored only on your device — never in projects or exports. Local stays fully offline.

## Using ProseArc

Create a project and import a `.txt`, `.md`, `.epub`, `.docx`, or `.pdf`. Set the source/target languages, then press **Start translating** (with your local server running). Polish in **Review**, **Read** the result as a book, and **Export** to TXT / Markdown / PDF / EPUB. Set defaults once in **Settings**.

---

## Build from source

Only needed if you want to run or build it yourself. Requires **[Node.js](https://nodejs.org/) 18+** (developed on 26).

```bash
npm install
npm start        # run in dev
npm run dist     # build a portable .exe + installer into dist/
```

## Where data lives

Each project is a single JSON file under your OS per‑app data folder — `%APPDATA%\prosearc\projects\` on Windows (i.e. `C:\Users\<you>\AppData\Roaming\prosearc\projects\`). Saves are atomic (written to a temp file, then renamed into place), so an interrupted save never leaves a half‑written, corrupt project. The shared glossary sits alongside that folder at `%APPDATA%\prosearc\glossary-global.json`.

## License

MIT — see [LICENSE](LICENSE).

---

<a id="arabic"></a>

<div dir="rtl">

# ProseArc — بالعربية

**مساحة عمل لترجمة الروايات بإشراف بشري** باستخدام نموذج ذكاء اصطناعي **محلي أو سحابي**. استورد مخطوطة، ودع النموذج يُنتج ترجمة أولية، ثم راجِعها جنبًا إلى جنب، واقرأها ككتاب، وهذّبها — مع تحكّم كامل في الجودة والاتساق والأسلوب.

> **محلي افتراضيًا، وسحابي اختياريًا.** افتراضيًا، كل طلب يذهب إلى خادم *محلي* (LM Studio) — لا شيء يغادر جهازك. ويمكنك اختياريًا ربط مزوّد سحابي (OpenAI أو OpenRouter أو Gemini أو Claude)؛ عندها يُرسَل النص الذي تترجمه إلى ذلك المزوّد.

مبني على Electron وHTML/CSS/JS عادي — دون إطار عمل للواجهة.

## لقطات

|  |  |
| --- | --- |
| ![المكتبة](assets/screenshots/library_AR.png) | ![المراجعة](assets/screenshots/review_AR.png) |
| ![القارئ](assets/screenshots/reader_AR.png) | ![المسرد](assets/screenshots/glossary_AR.png) |

## المزايا

- **مكتبة المشاريع وصفحة لكل كتاب** — كل كتاب مشروع؛ افتحه لتظهر صفحته مع **قراءة / ترجمة / مراجعة / تصدير** والتقدّم في لمحة.
- **استيراد واعٍ بالبنية** — استورد **TXT وMarkdown وEPUB وWord ‏(.docx) وPDF**. تُحفَظ العناوين والفقرات والاقتباسات والقوائم وفواصل المشاهد والتشكيل *المائل* / **العريض** خلال الترجمة وفي كل تصدير — دون تحويلها إلى نص متراصّ. تُستعاد بنية PDF بطرق استدلالية (العناوين والفقرات والتشكيل، مع إزالة الترويسات وأرقام الصفحات)؛ ملفات PDF الممسوحة ضوئيًا (صور فقط) غير مدعومة.
- **نماذج محلية أو سحابية** — ترجم عبر خادم **محلي** (LM Studio أو أي خادم متوافق مع OpenAI) أو مزوّد **سحابي** (**OpenAI وOpenRouter وGemini وClaude**)؛ اختر لكل كتاب. تُخزَّن مفاتيح API على جهازك فقط.
- **محرّك الترجمة** — يعرض التقدّم وسجلًا حيًّا؛ مهلة لكل طلب مع إعادة محاولة تلقائية؛ تشغيل قابل للاستئناف.
- **أسلوب ترجمة لكل كتاب** — موجز اختياري (النبرة، الرسمية، الجمهور) يُرسَل مع كل مقطع.
- **محرّر مراجعة بشاشة مقسّمة** — الأصل مقابل ترجمة قابلة للتحرير، **يدعم RTL** (مثل العربية)، متصفّح مُحسَّن لعشرات آلاف المقاطع، **تصفية حسب الحالة**، بحث مع **تظليل** للمطابقات، و**بحث واستبدال** في كل الترجمات.
- **القارئ** — اقرأ الترجمة النهائية ككتاب: **محتويات** الفصول، وضبط **الخط/الحجم/العرض/السمة** (داكن · بنّي · فاتح)، و**استئناف الموضع**، و**إشارات وملاحظات** لكل فقرة، وكشف **ثنائي اللغة** للأصل بنقرة.
- **المسرد** — قاموس مشترك ومصطلحات لكل مشروع (مصطلحات المشروع تتجاوز المشتركة)، تُحقَن فقط في المقاطع التي يظهر فيها المصطلح لمنع تذبذب الأسماء — مع **أسماء مقترحة** تلقائيًا من الكتاب.
- **التصدير** — TXT وMarkdown وPDF وEPUB (يدعم RTL)، مع تنبيه إن بقي أي مقطع غير مترجم.
- **الإعدادات** — قيم افتراضية على مستوى التطبيق للمشاريع الجديدة (النموذج، اللغات، السياق) إضافةً إلى المظهر.
- **لمسات** — خطوط مضمّنة (Spectral / Amiri / Inter)، سمتان داكنة وفاتحة، أغلفة للكتب، وواجهة كاملة **بالإنجليزية / العربية** مع RTL.
- **يحدّث نفسه** — يتحقق التطبيق المثبَّت من وجود إصدار جديد على GitHub عند تشغيله.

## القادم

نعمل على أن يصبح ProseArc أسهل في البداية:

- **مظهر جديد** يستخدم النافذة كلها، مع أيقونات واضحة وأغلفة أكبر للكتب.
- **إعداد عند أول تشغيل** يفحص جهازك ويجهّزك للترجمة ببضع نقرات.
- **مترجم مدمج** (llama.cpp): لا حاجة إلى LM Studio، ويبقى كل شيء على جهازك.
- **البحث عن النماذج في Hugging Face** من داخل التطبيق، مع اقتراح الملف المناسب لجهازك والتحقق من التنزيل.
- **صفحة للمزوّدين** في الإعدادات: بطاقة لكل مزوّد ذكاء اصطناعي (OpenAI وClaude وGemini وOpenRouter وGroq وDeepSeek وOllama وLM Studio…)، مع حفظ المفاتيح مشفّرة.

## التنزيل والتشغيل

لمعظم الناس — دون Node ودون إعداد:

**[⬇ نزّل أحدث إصدار](https://github.com/Faadred/ProseArc/releases/latest)** (ويندوز)

- **المثبِّت** (`ProseArc‑Setup‑*.exe`) — يضيف اختصارًا في قائمة ابدأ وأداة إزالة، أو
- **المحمول** (`ProseArc‑*‑portable.exe`) — ملف واحد، انقر نقرًا مزدوجًا فحسب.

> لأن التطبيق غير موقَّع رقميًا، قد يعرض ويندوز تحذير SmartScreen («حمى ويندوز جهازك»). اضغط **مزيد من المعلومات ← التشغيل على أي حال**.

## ستحتاج أيضًا إلى نموذج

لا يتضمّن ProseArc نموذجًا — أنت توجّهه إلى واحد. بطريقتين:

**محلي — خاص ومجاني وبلا إنترنت.** شغّل نموذجًا على جهازك عبر **[LM Studio](https://lmstudio.ai/)**:
1. ثبّت LM Studio و**حمّل** نموذج محادثة/تعليمات.
2. افتح **Developer / Local Server** ← **Start Server** (الافتراضي `http://localhost:1234`).
3. في ProseArc، أبقِ المزوّد على **محلي** واضغط **اختبار الاتصال**.

**سحابي — غالبًا أعلى جودة، مدفوع حسب الاستخدام.** استخدم **OpenAI أو OpenRouter أو Gemini أو Claude**:
1. احصل على مفتاح API من المزوّد.
2. في **الإعدادات ← مفاتيح API**، الصقه تحت ذلك المزوّد.
3. في **مساحة عمل** الكتاب، اضبط **المزوّد** عليه وأدخل **معرّف النموذج** (مثل `gpt-4o-mini` أو `claude-3-5-sonnet-latest` أو `gemini-2.0-flash` أو معرّف OpenRouter مثل `openai/gpt-4o-mini`).

> تُخزَّن مفاتيح السحابة على جهازك فقط — لا في المشاريع ولا في الملفات المصدَّرة. ويبقى المحلي بلا اتصال تمامًا.

## كيفية الاستخدام

أنشئ مشروعًا واستورد ملف `.txt` أو `.md` أو `.epub` أو `.docx` أو `.pdf`. اضبط لغتي المصدر والهدف، ثم اضغط **بدء الترجمة** (مع تشغيل الخادم المحلي). هذّب في **المراجعة**، و**اقرأ** النتيجة ككتاب، و**صدّر** إلى TXT / Markdown / PDF / EPUB. اضبط الافتراضيات مرة واحدة في **الإعدادات**.

## البناء من المصدر

يلزم فقط إن أردت تشغيله أو بناءه بنفسك. يتطلّب **[Node.js](https://nodejs.org/) 18+**.

```bash
npm install
npm start        # التشغيل للتطوير
npm run dist     # بناء نسخة محمولة ومثبِّت في dist/
```

## أين تُحفَظ البيانات

كل مشروع ملف JSON واحد داخل مجلد بيانات التطبيق في نظامك — `%APPDATA%\prosearc\projects\` على ويندوز. عمليات الحفظ ذرّية (تُكتب في ملف مؤقت ثم يُعاد تسميته)، فلا يترك أي انقطاع مشروعًا تالفًا. يوجد المسرد المشترك بجوار ذلك المجلد في `%APPDATA%\prosearc\glossary-global.json`.

## الرخصة

MIT — انظر [LICENSE](LICENSE).

</div>
