# Comic Sol Studio

A full-stack creator application built directly on the
[Comic Sol engine](https://github.com/wenn-id/comicsol): write a story, shape the cast and
storyboard, render panels with the image model you choose (or upload your own art), review
every panel and page, and let the engine letter, compose, and bind a verified PDF.

Studio is its own application. It has its own FastAPI backend, API, project store,
landing page, and console. It does not use, mount, or import `comic-sol-web`.

## Status

Studio is in active development and is not yet a released Comic Sol surface. A live
preview runs at <https://wenn-id.github.io/comicsol-studio/> (see
[Pages preview](#pages-preview)).

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
- `test_pages.py`: the Pages preview build rebases every link onto the project path, loads
  the DEMO layer before the app, and leaves the shipped web files untouched.

## Pages preview

`pages/` builds a static preview of the real landing page and console for design review.
GitHub Pages cannot run Studio, so the console's `/api/*` calls are answered in the
browser by a DEMO layer (`pages/demo/mock.js`) that replays a recorded session. The
recording comes from `pages/record.py`, which drives the actual Studio app and the pinned
engine through the whole creator flow (create, plan, references, panels, panel and page
reviews, compose, finish) with the original [Rooftop Stories sample](pages/sample/README.md).
Its brief, plan, character reference and AI-created panels are bundled in this repository.
The application and engine produce every snapshot, review context, composed page and PDF.
The sample uses preset development reviews based on visual inspection; these are not
judgements made by a visitor or a live vision model. Images are stored as WebP.

In the preview, actions that match the next recorded step (prepare, upload, review,
compose, finish, rename, trash) advance the replay. Anything else, such as an archive
export or a plan the engine would have to validate, answers with a labelled DEMO message.
A DEMO panel shows the current step and can step the replay forward or restart it.
Nothing in `pages/` is part of the Python package.

`.github/workflows/pages.yml` records and builds the preview on every push to `main` and
on pull requests that touch Studio, and uploads it as the `studio-pages-preview`
artifact. Every push to `main` also deploys it to GitHub Pages at
<https://wenn-id.github.io/comicsol-studio/>.

To build it locally (the recording takes a few minutes):

```bash
python pages/record.py --sample pages/sample --out recording
python pages/build.py --recording recording --out _site/comicsol-studio --base /comicsol-studio/
python -m http.server 8790 --directory _site
```

Then open `http://127.0.0.1:8790/comicsol-studio/`. A plain static server has no 404
fallback, so reloading a deep console link only works on Pages; start from the landing page
or `studio/`.

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

Design read: an independent comic publisher's editorial landing and a flat creator
workspace. The owner selected the white-and-red concept, with a moving Three.js book and
an original comic. Dials: landing ENERGY 3 / RHYTHM 3 / MOTION 2; console ENERGY 2 /
RHYTHM 2 / MOTION 1.

- Paper `#F4F1EA`, charcoal `#25282B` and print red `#B43928` make the artwork the focus.
  Red marks primary actions and the current stage. Day is the default console theme;
  a saved night-theme preference remains respected.
- Manrope carries the interface with a compact, bold editorial hierarchy. The original
  illustrated cover uses its own condensed title; Comic Neue is the engine's lettering face.
- The hero is an actual Three.js softcover with deformable sheets, a matte cover and paper
  edges. It opens and turns through the two engine-composed Rooftop Stories pages. Previous,
  Next, Play/Pause, arrow keys and horizontal swipes control it. Animation pauses outside
  the viewport and in a hidden tab; reduced motion shows a still with manual view changes.
  Without WebGL, the bundled cover and readable PDF link remain available.
- The landing follows one original story: script, panel artwork, then composed page. The
  sections vary with that material rather than repeating feature cards or closing CTAs.
- The console is 2D on purpose: forms, filmstrips, and paper sheets, with motion limited to
  state changes. Flat editor sections keep the artwork and next action visible; technical
  lifecycle detail is available in a disclosure. Mobile navigation retains stage names.
- Both themes share their tokens with the landing; text contrast, control edges and focus
  colors are tested on every main surface. No new UI or Three.js dependency was added.
- The favicon mark is a placeholder drawn from a page layout; replace it with the official
  mark when one exists.

The [editorial redesign audit](anti-slop/audit-002-2026-10-09.md) records the selected
direction and validation. The [earlier cleanup audit](anti-slop/audit-001-2026-10-09.md)
is historical and describes the superseded dark-and-amber design.

## Bundled third-party files

| File | Source | License |
| --- | --- | --- |
| `web/assets/vendor/three.module.min.js`, `three.core.min.js` | `three@0.185.1` from npm (`build/`), SHA-256 `86bcee24…beb6` and `05b26093…a90` | MIT (`three-LICENSE.txt`) |
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
