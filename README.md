# comicsol-studio

A new creator interface for [Comic Sol](https://github.com/wenn-id/comicsol): write a
pitch, shape the plan, render panels, and check pages in one workspace built for long
sessions.

comicsol-studio is an interface only. It mounts beside the unchanged
[`comic-sol-web`](https://github.com/wenn-id/comic-sol-studio) application on the same
origin and reuses that application's API, loopback session, CSRF cookie, revision guards,
and published browser client (`/static/api.js`, `/static/state.js`, `/static/webmcp.js`).
It adds no API route, stores no provider credential, and never calls a provider.

## Status and governance

This repository is private and the interface is not a released Comic Sol surface. Under
`wenn-id/comicsol` AGENTS.md Article 9, a new distribution or execution surface needs
either a published adoption summary that meets the real evidence gate, or an explicit
waiver from a named maintainer recorded in both the relevant issue and the pull request.
Neither exists yet. Record one before making this repository public or distributing the
interface.

## Run it

Python 3.11 with `comic-sol-web` installed from `wenn-id/comic-sol-studio` (built and
tested against commit `21a0603`) plus its pinned engine, and Node.js for the tests.

```bash
python -m comicsol_studio --data-root /absolute/path/for/studio-data
```

After `pip install --no-deps -e .` the same launcher is also on the path as
`comicsol-studio`. The distribution is named `comicsol-studio`; its Python import package
is `comicsol_studio`, because module names cannot contain hyphens.

Open `http://127.0.0.1:8766/studio/`. The launcher only binds a loopback address.

- `--port` changes the port (default 8766).
- `--agent-images` offers the backend's agent-native image route, where a local agent
  session supplies rasters. No provider is called.
- Planners and hosted image routes appear when `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
  is set in the environment that starts Studio. The page never sees the keys.

## Test it

```bash
python -m unittest discover -s tests -p "test_*.py" -v
```

- `test_app.py`: server composition, asset serving and revalidation, backend routes
  stay reachable, fail-closed startup, packaging, launcher flags.
- `test_ui_contracts.py`: no HTML parsing of text, no remote origins, no telemetry,
  storage limited to two interface preferences, drift checks against the backend client
  and the WebMCP DOM hooks, confirmation ordering, landmarks, focus, motion, and WCAG AA
  contrast for every text token in both themes.
- `test_ui_runtime.py`: the pure modules under Node, including draft reconciliation
  against the backend's real `state.js` store.

## What the creator gets

| Stage | What it does |
| --- | --- |
| 01 Create | A hero that fans out the engine's five real page layouts, and a prompt composer docked to the bottom of the screen: title, prompt or story mode, Pages, Language, and Planner chips, a live 200 KB meter, and archive import by picker or by dropping the file anywhere. A banner reopens the project already in progress. |
| 02 Plan | The four plan documents read as a story (beats as a four-panel strip), a cast, and real storyboard pages drawn from the engine's 1600 x 2400 panel rectangles. JSON editing with live validity, a line diff of formatted JSON before anything is saved, agent proposals as reviewable drafts, and production approval. Unsaved edits surface as a floating action dock. |
| 03 Generate | A render bar docked to the bottom: route and authentication chips and a cost confirmation bound to the exact route. When the idempotent queue hands back jobs that already ran, Studio says so instead of claiming new work. A phase pipeline with pause and resume, and a render board of media-style job cards sorted into Needs you, In progress, Accepted, and History. |
| 04 Review | A light table for the accepted raster with a full-size viewer, staged promotion, QA findings grouped by panel and area, rerender, and private exports. |

Across stages: top navigation whose dots report each stage's real state, a production
log drawer, a command palette (`Ctrl K`), focus mode for writing, day and night themes,
and status messages that stay out of the way.

| Keys | Action |
| --- | --- |
| `Ctrl K` | Commands |
| `Alt 1` to `Alt 4` | Create, Plan, Generate, Review |
| `Ctrl Enter` | Submit the form you are typing in |
| `Esc` | Close a dialog or leave focus mode |
| `?` | Keyboard shortcuts |

## Design notes

Design read: a creative SaaS workspace for comic creators, in the media-first language
the owner asked for (a near-black canvas, big rounded cards, a prompt composer docked to
the bottom, as in AI media studios such as Higgsfield), carried by Comic Sol's own
identity. Dial ENERGY 3 / RHYTHM 2 / MOTION 2.

- Near-black canvas: generated pages and panels read as the brightest things on screen.
  Day shift is a full light theme with its own text-safe amber.
- Amber is the only accent, from the Comic Sol logo: the primary action, the current
  stage, and one warm glow behind the Create hero. Cyan marks information and focus.
- Archivo, heavy and expanded, for display headings gives the bold SaaS voice without
  copying the reference's typeface; the same family keeps body text consistent.
- Comic Neue appears only in lettering previews, because it is the engine's lettering face.
- Comic pages stay paper white with ink borders in both themes: that is the artwork's
  real surface. The Create hero draws the engine's actual layouts with screentone fills.
- Radii come in three steps (10, 14, 20 px) so inputs, cards, and the composer read as
  different kinds of object.
- Motion marks change only: a short stage entrance, the hero pages spreading on hover, a
  shimmer on jobs that are really rendering, and drawers sliding in. Reduced motion turns
  it all off.

## Bundled fonts

Both fonts are under the SIL Open Font License 1.1; the license text ships next to each file.

- `Archivo-Variable.ttf`: `ofl/archivo/Archivo[wdth,wght].ttf` from `google/fonts` at commit
  `95f4904fc8bcf26d3420fe315560c96417c6dec7`, git blob
  `cc64253d36665a5ca0d6719cdf1e32b3de453b51`, SHA-256
  `0e094a7d3c7c4c25cf1310c4b30014f1dae9332220b1c2c88f4fa996f0b05053`.
  `OFL-Archivo.txt` is `ofl/archivo/OFL.txt` at the same commit, git blob
  `8597481ebc941863ab228e79ea4305507cd73cc6`.
- `ComicNeue-Bold.ttf`: copied from `wenn-id/comicsol` `assets/fonts`, which records its
  `google/fonts` provenance; SHA-256
  `3e7e5fccfd7e0788f317b43312151c1bd5cf058c9697a8d83eac3939050bd61e`.

## Known limits

- The three creator WebMCP tools defined in the original Studio's `app.js`
  (`get_comic_context`, `create_comic`, `revise_comic`) are not registered here. The
  fourteen core tools from `webmcp.js` are.
- Without a planner, all four plan documents must be written as schema-valid JSON. The
  visual identity is derived from the character bible by a planner or the engine; the
  browser does not compute its fingerprint hash.
- There is no CI workflow yet.
