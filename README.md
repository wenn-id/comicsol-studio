# Comic Sol Studio Next

A new creator interface for [Comic Sol](https://github.com/wenn-id/comicsol): write a
pitch, shape the plan, render panels, and check pages in one workspace built for long
sessions.

Studio Next is an interface only. It mounts beside the unchanged
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
python -m comic_sol_studio_next --data-root /absolute/path/for/studio-data
```

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
| 01 Start | Pitch composer with a live 200 KB meter, page picker drawn as page sheets, language suggestions, and a planner picker that says which key is missing. Drag-and-drop archive import. |
| 02 Plan | The four plan documents read as a story (beats as a four-panel strip), a cast, and real storyboard pages drawn from the engine's 1600 x 2400 panel rectangles. JSON editing with live validity, a line diff of formatted JSON before anything is saved, agent proposals as reviewable drafts, and production approval. |
| 03 Generate | Route cards, a signed cost slate bound to the exact route, a phase pipeline with pause and resume, and a render board sorted into Needs you, In progress, Accepted, and History. |
| 04 Review | A light table for the accepted raster with a full-size viewer, staged promotion, QA findings grouped by panel and area, rerender, and private exports. |

Across stages: a stage track that shows real progress, a production log of workflow
events, a command palette (`Ctrl K`), focus mode for writing, day and night themes, and
status messages that stay out of the way.

| Keys | Action |
| --- | --- |
| `Ctrl K` | Commands |
| `Alt 1` to `Alt 4` | Start, Plan, Generate, Review |
| `Ctrl Enter` | Submit the form you are typing in |
| `Esc` | Close a dialog or leave focus mode |
| `?` | Keyboard shortcuts |

## Design notes

Design read: a four-stage production workspace for comic creators, in a night production
room language, dial ENERGY 3 / RHYTHM 2 / MOTION 2.

- Dark first: artwork reads as the brightest thing on screen and long night sessions are
  easier on the eyes. Day shift is a full light theme, not an afterthought.
- Ink, cyan, amber: the logo's palette. Cyan is structure (hairlines, selection, focus).
  Amber is reserved for the one primary action, the current stage, and the desk lamp.
- Comic Neue for headings only: it is the engine's own lettering face, bundled under the
  SIL Open Font License. Body text uses the system face for reading comfort.
- Crop marks on each stage's primary panel: the identity motif, borrowed from print
  production, and used nowhere else.
- Paper stays paper: storyboard pages and lettering render on white in both themes
  because that is the artwork's real surface.
- Motion only marks change: a short stage entrance, the stage connector filling, and a
  scanning hairline that runs only while a job or planner is really working. Reduced
  motion turns it off.
- Square 3 to 6 px radii and two-pixel square-cap icons drawn for this interface keep
  the look of a production desk instead of a generic app kit.

## Known limits

- The three creator WebMCP tools defined in the original Studio's `app.js`
  (`get_comic_context`, `create_comic`, `revise_comic`) are not registered here. The
  fourteen core tools from `webmcp.js` are.
- Without a planner, all four plan documents must be written as schema-valid JSON. The
  visual identity is derived from the character bible by a planner or the engine; the
  browser does not compute its fingerprint hash.
- There is no CI workflow yet.
