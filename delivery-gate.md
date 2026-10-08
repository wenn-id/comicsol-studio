# antislop delivery gate: Comic Sol Studio rebuild (2026-10-08)

Mode: applied during the build. The owner asked for autonomous work without stopping, so
the mode question was not asked; record a preference with `npx antislop-ai --mode` if a
different mode is wanted next time.

Design read: a premium dark cinematic landing page and a calm 2D creator console for comic
creators, in the owner's direction (obsidian `#08090B`, amber `#D9A441`, 80% luxury and 20%
tech, Three.js softcover hero). Dials: landing ENERGY 3 / RHYTHM 3 / MOTION 3; console
ENERGY 2 / RHYTHM 2 / MOTION 1.

## Click-through (R-35)

Run against `python -m comicsol_studio --port 8788` with a fresh data root, in the app's
browser pane (interactions) and headless Chrome over CDP (screenshots at 1440 x 900 and
390 x 844, both themes).

- Landing: hero scrubbed at 0, 0.24, 0.36, 0.5, 0.66, 0.82, 0.87, 0.97: cover opens, five
  leaves turn, chapter captions I to III change with scroll, camera dives at the end. Nav
  links `#making`, `#engine`, `#run` scroll to existing sections; both "Open the Studio"
  buttons go to `/studio/`; footer links point at the two real repositories. Layout figure
  reads `/api/engine` (engine 2.0.0rc6). Phone: separate camera path, book clear of the
  headline, no horizontal overflow.
- Library: empty library opens the composer; "From an idea" with title, idea, 1 page ->
  `POST /api/projects` 201 -> Plan of the new project. Starter cards and archive import
  exercised through the API tests.
- Plan: typing a logline -> engine issues 28 -> 27 within a second; issue list names the
  field ("Story · beginning"); JSON tab -> "Apply JSON" -> "Save plan" -> toast "Plan
  saved..." and status "Ready to render".
- Render: job cards show prompt, size, attempts; uploads accepted through the API tests;
  model batch, reference approval, and discard exercised with a fake provider in tests.
- Review: "Pass everything, with notes from the plan" fills seven checks and fourteen trait
  notes from the storyboard; "Record my review" -> "Panel p01-01: accepted." and the next
  panel is selected. Pages: both pages recorded -> Studio moves to Finish.
- Finish: "Finish the comic" -> "Bound." with Download PDF, Open PDF, QA report links; the
  spread reader shows "Page 1 of 2" and steps with buttons and arrow keys.
- Shell: Day/Night toggle switches and persists; Ctrl K opens the palette, typing "render"
  and Enter navigates; Activity opens the drawer with Studio and engine events, Escape
  closes it.
- Console: no errors logged during the run. The only console output is a Direct3D shader
  compiler precision warning from three.js on the landing page.

## Block 1: Hard Gate

- R-02 PASS: `test_copy_has_no_em_dash` scans every HTML, CSS, and JS file.
- R-03 PASS: every console view measured at 390 px: `scrollWidth == innerWidth`; buttons
  wrap on phones; tap targets 36 to 46 px with 44 px for primary navigation.
- R-17 PASS: only live counts (issues, panels accepted, pages, words, bytes, attempts).
- R-18 PASS: no testimonials.
- R-23 PASS: no logo invented; the wordmark is text; the favicon mark is labelled in the
  README as a placeholder; landing art is drawn procedurally and the inside cover says so.
- R-24 PASS: landing nav lists three sections that exist; console nav lists five stages
  that exist, locked ones marked.
- R-25 PASS: `test_text_tokens_meet_wcag_aa_on_every_surface` (both themes, six text
  tokens, four surfaces) and `test_primary_button_text`.
- R-26 PASS: every control has a behaviour; model buttons appear only when a key exists.
- R-27 PASS: loading, empty, and error states on library, project, plan, render, review,
  finish, activity; error states show the engine's details.
- R-28 PASS: no FAQ.
- R-32 PASS: focus rings kept (`test_focus_outline_is_never_removed`); tabs, segmented
  controls, and the reader take arrow keys; dialogs close with Escape.
- R-33 PASS: no patch scripts.
- R-34 PASS: night and day both checked; contrast tested in both.
- R-35 PASS: click-through above.
- R-36 PASS: claims are engine facts (layouts, lifecycle, checks, PDF verification).
- R-37 PASS: owner direction recorded above.
- R-38 PASS: no fabricated content; sample page lines on the hero are fiction drawn for the
  specimen book, not claims.

## Block 2: Purpose-Gate

- R-01 PASS: amber glow only in the hero's light and on the drawn sun; it is the brand's
  one warm accent.
- R-04 PASS: a small square-cap icon set drawn for Studio's own actions.
- R-06 PASS: Instrument Serif for the luxury display voice, Manrope for UI precision and
  tabular numbers; reasons in the README.
- R-07 PASS: no background grid; halftone appears only inside comic art.
- R-08 PASS: no decorative arrows.
- R-09 PASS: badges mark real states (job status, review decision).
- R-10 PASS: blur only on the landing masthead once scrolled.
- R-12 PASS: shadows only on paper (covers, pages, sheets), dialogs, and toasts.
- R-13 PASS: no glow on UI controls.
- R-14 PASS: job cards differ by state; the "wide" review stage on the landing carries the
  checklist because review is where most of the work is.
- R-19 PASS: landing motion is scroll-driven and stops when nothing changes; console motion
  marks state changes only; reduced motion respected on both.
- R-22 PASS: illustrations are the product itself (a comic book on the engine's layouts).

## Block 3: Liveliness

- Dials declared and matched: the landing pins, turns pages, and varies every section's
  composition (RHYTHM 3); the console keeps consistent stage pages (RHYTHM 2). PASS
- One focal point per screen: the book; the lifecycle list; the layouts row; the command
  block; in the console, the next step, the editor, the job grid, the art under review,
  the reader. PASS
- One deliberate accent: amber. PASS
- Identity motif: paper-white comic pages on obsidian, from the hero book to covers,
  storyboard sheets, and the reader. PASS

## Block 4: Craftsmanship and Quality Locks

- C-1 to C-5 PASS: reasons in the README; no dead controls; sections come from the
  engine's real workflow; states, themes, breakpoints, keyboard checked; nothing invented.
- R-05 PASS: no hero-plus-cards template; the landing follows the book, then the
  lifecycle, the engine, and the run command.
- R-11 PASS: three radius steps (6, 10, 18 px).
- R-15 PASS: specific actions ("Open the Studio", "Create the comic", "Save plan",
  "Record my review", "Letter and compose pages", "Finish the comic").
- R-16 PASS: no buzzwords.
- R-20 PASS: obsidian, amber, serif display, and comic paper make it Comic Sol's.
- R-21 PASS: dark by owner direction and because artwork must dominate; working day theme.
- R-29 PASS: obsidian and ivory neutrals, amber accent, sage and ember for status only.
- R-30 PASS: no product cloned.
- R-31 PASS: one-line reasons in the README "Design notes".
