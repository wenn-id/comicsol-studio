# Comic Sol Studio

A full-stack creator application built directly on the
[Comic Sol engine](https://github.com/wenn-id/comicsol): write a story, shape the cast and
storyboard, render panels with the image model you choose (or upload your own art), review
every panel and page, and let the engine letter, compose, and bind a verified PDF.

Studio is its own application. It has its own FastAPI backend, API, project store,
landing page, and console. It does not use, mount, or import `comic-sol-web`.

## Status and governance

The interface is not a released Comic Sol surface. Under `wenn-id/comicsol` AGENTS.md
Article 9, a new distribution or execution surface needs either a published adoption
summary that meets the real evidence gate, or an explicit waiver from a named maintainer
recorded in both the relevant issue and the pull request. Neither exists yet. Record one
before distributing Studio.

## Run it

Python 3.11 and Node.js (Node runs the browser-module tests only).

```bash
python -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m comicsol_studio --data-root /absolute/path/for/studio-data
```

On Windows use `.venv\Scripts\python.exe`. `pip install` pulls the engine from
`wenn-id/comicsol` at the commit pinned in `pyproject.toml` (`7c0138d`, engine
`2.0.0rc6`). After installing, `comicsol-studio` is also on the path.

Open `http://127.0.0.1:8766/` for the landing page or `http://127.0.0.1:8766/studio/` for
the console. Studio binds loopback only.

- `--port` changes the port (default 8766). `COMICSOL_STUDIO_DATA_ROOT` can replace
  `--data-root`.
- Model routes are optional and appear only when their key is set in the environment that
  starts Studio. Keys never reach the page.

| Variable | Adds |
| --- | --- |
| `ANTHROPIC_API_KEY` | Plan drafts and visual review with Claude (`claude-opus-5-5`, override with `COMICSOL_STUDIO_ANTHROPIC_TEXT_MODEL`) |
| `OPENAI_API_KEY` | Plan drafts and visual review (`gpt-5.4-mini`, `COMICSOL_STUDIO_OPENAI_TEXT_MODEL`) and panel rendering (`gpt-image-2`, `COMICSOL_STUDIO_OPENAI_IMAGE_MODEL`) |

Claude requests use the server-side refusal fallback (`fallbacks: "default"`), so a
request declined by a safety classifier is retried on the model Anthropic recommends for
that category inside the same call.

Without any key every step still works: write the plan in the editor (or start from an
engine starter), upload your own images, and review them yourself.

## Test it

```bash
.venv/bin/python -m unittest discover -s tests -p "test_*.py"
.venv/bin/python -m ruff check comicsol_studio tests
```

- `test_api_flow.py`: the whole production over HTTP against the real engine, from a
  prompt to a verified PDF and an archive round trip, plus a failed review sent back to
  render, project management, outside edits advancing the revision, and file containment.
- `test_providers.py`: the planner's draft-to-plan assembly and repair loop, OpenAI over a
  mocked transport, the Anthropic request shape, and background runs (reference approval,
  batch rendering, model review, plan drafts).
- `test_app.py`: Host guard, CSRF, Origin checks, security headers, pages and deep links,
  raster conforming, configuration, launcher, and independence (no `comic-sol-web`, engine
  reached only through `engine.py` and only by public names).
- `test_web.py`: WCAG AA contrast for every text token on every surface in both themes, no
  em dashes, no remote origins or inline scripts, focus rings kept, the book's layouts
  matching the engine, and the console's pure modules under Node.

## How it is built

```
browser                         comicsol_studio (one process)              Comic Sol engine
--------------------------      ------------------------------------      ----------------
/            landing page       security.py  Host, Origin, CSRF, CSP
/studio/...  console     --->   api.py       /api/... routes
                                service.py   projects, revisions, runs
                                store.py     SQLite: projects, runs, events
                                providers/   Claude, OpenAI (optional)
                                engine.py    the only engine boundary  --->  comic_sol_product.engine
```

- `engine.py` drives the engine the way its documented agent workflow does: Studio writes
  the canonical plan documents and prompts through the engine's own `ProjectTransaction`,
  then calls public engine functions to validate, transition, prepare handoff jobs, accept
  rasters, normalize, letter, compose, record page QA, finalize, and move archives. No
  private engine name is used, and a test enforces it.
- Every project write carries the revision the creator saw. A fingerprint of the project's
  files is compared on every read, so a change made outside Studio (an agent, the engine
  CLI) advances the revision and the stale browser gets a conflict instead of overwriting.
- Panel prompts embed the engine's identity block verbatim, so a retry asks for the same
  character. Uploaded or generated images are center-cropped to the exact job size before
  the engine checks them.
- Reference sheets drawn by a model wait for the creator's approval before the engine
  activates them. Panel images are accepted but still need review.
- Reviews are recorded with their real reviewer and method: `creator` with
  `creator-visual-review`, or the model name with `vision-model-review`. Studio never
  writes a judgement on anyone's behalf; the "pass everything" helper fills notes from the
  plan for the creator to confirm before recording.
- Long model calls run in background threads and are polled by the console; a run that
  Studio did not finish (a restart) is marked failed, never left running.

## Design notes

Design read: a premium dark cinematic landing and a calm 2D creator console for comic
creators, in the owner's direction (obsidian `#08090B`, amber `#D9A441`, 80% luxury and
20% tech). Dials: landing ENERGY 3 / RHYTHM 3 / MOTION 3, console ENERGY 2 / RHYTHM 2 /
MOTION 1.

- Obsidian keeps the artwork the brightest thing on screen. Amber marks the primary action
  and the current stage only. Ivory is the paper the comics print on.
- Instrument Serif carries the luxury voice in display type; Manrope's squared geometry and
  tabular figures carry the tool. Comic Neue appears only where lettering is previewed,
  because it is the engine's lettering face.
- The hero is a softcover comic drawn in the browser: a laminated cover that bows as it
  opens, pages that curl as they turn, interior pages laid out on the engine's five page
  layouts. It renders only when the scroll or pointer changes, eases by time rather than by
  frame, shows a still of the open book with reduced motion, and a poster without WebGL.
- The console is 2D on purpose: forms, filmstrips, and paper sheets, with motion limited to
  state changes.
- Day theme is a full printed-paper palette with its own text-safe amber. Both themes pass
  WCAG AA for every text token on every surface (tested).
- The favicon mark is a placeholder drawn from a page layout; replace it with the official
  mark when one exists.

## Bundled third-party files

| File | Source | License |
| --- | --- | --- |
| `web/assets/vendor/three.module.min.js`, `three.core.min.js` | `three@0.185.1` from npm (`build/`), SHA-256 `86bcee24…beb6` and `05b26093…a90` | MIT (`three-LICENSE.txt`) |
| `web/assets/fonts/InstrumentSerif-*.woff2` | `google/fonts` `ofl/instrumentserif` at `5e8a3ba`, subset to Latin with fonttools | SIL OFL 1.1 |
| `web/assets/fonts/Manrope-Variable.woff2` | `google/fonts` `ofl/manrope/Manrope[wght].ttf` at `5e8a3ba`, subset to Latin | SIL OFL 1.1 |
| `web/assets/fonts/ComicNeue-Bold.ttf` | `wenn-id/comicsol` `assets/fonts` | SIL OFL 1.1 |

## Known limits

- Image rendering is wired for OpenAI only. Other providers need an adapter in
  `providers/` with the same `render()` shape.
- Live model calls were exercised only against mocked transports in tests; no provider key
  was available while building this version.
- Finishing runs the engine's full export and verification inside the request; on slow
  disks it takes several seconds, shown as a busy button.
- The WebMCP tools of the old Studio are not registered in this console yet.
