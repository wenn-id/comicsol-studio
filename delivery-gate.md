# antislop delivery gate: comicsol-studio, SaaS redesign (2026-10-08)

Design read: creative SaaS workspace for comic creators, in the media-first language the
owner asked for ("like Higgsfield": near-black canvas, big rounded cards, prompt composer
docked to the bottom), with Comic Sol's amber accent and an expanded Archivo display face
chosen by the owner. Dial ENERGY 3 / RHYTHM 2 / MOTION 2.

R-30 note: the owner explicitly asked for the reference's feel. The build borrows the
layout language only; colour (Comic Sol amber), typeface (Archivo, not the reference's
Space Grotesk), copy, and imagery (the engine's own page layouts) are Comic Sol's.

## Click-through (R-35), `127.0.0.1:8766` with `--agent-images`, after the redesign

- Create: hero, resume banner, and composer fit one 1440 x 900 screen; composer chips and the Create button sit on one row; Create view reopened the current project.
- Generate: confirmation enables Queue; changing Auth clears the confirmation; Queue -> `POST /api/generation/queue` 201; the backend returned the existing cancelled job, and Studio now reports "Nothing new was queued ... (cancelled)" instead of a false success; Cancel on a live job -> History (first build, same handler).
- Import round trip: exported the project archive (31 KB), selected it in the composer's file input -> confirm dialog with name and size -> Validate and import -> new project at revision 1 opened in Plan with a success message.
- Review: Run QA -> 30 findings in 11 groups; Review nav dot turned amber.
- Plan: storyboard pages, panel selection, and detail render; the unsaved-edits dock appears only when there are edits.
- Themes: night and day both checked on Create.
- Mobile 375 px: no horizontal overflow on any stage; composer no longer sticks over the hero; touch targets 44 px or larger except selects that fill a 44 px chip.
- Console: expected 404s from `GET /api/workflows/<id>` for a project with no workflow.
- Not exercised live (no provider keys, no agent raster): staged promotion, provider switch, pause and resume, planner polling, production approval.

## Block 1: Hard Gate

- R-02 PASS: `test_copy_has_no_em_dash` covers every UI file.
- R-03 PASS: 375 px check, no overflow; composer unsticks on phones and short windows.
- R-17 PASS: only live counts (jobs, findings, bytes).
- R-18 PASS: no testimonials.
- R-23 PASS: no new logo or people imagery; hero pages are the engine's real layouts.
- R-24 PASS: navigation lists four stages that exist; locked stages are disabled.
- R-25 PASS: contrast test now also covers `--amber-text` in both themes.
- R-26 PASS: every control has a real behaviour; disabled controls explain why.
- R-27 PASS: empty, loading, and error states on every stage; queue repeats now explained.
- R-28 PASS: no FAQ.
- R-32 PASS: focus rings stay; only `#stage` and the composer's own fields drop theirs, replaced by the composer ring (tested).
- R-33 PASS: no patch scripts in the project.
- R-34 PASS: both themes checked.
- R-35 PASS: click-through above.
- R-36 PASS: README states the private, unreleased status.
- R-37 PASS: direction from the owner (reference, accent, typeface) recorded above.
- R-38 PASS: no fabricated content.

## Block 2: Purpose-Gate

- R-01 PASS: one gradient glow behind the Create hero marks the focal point; screentone fills mark comic pages.
- R-04 PASS: square-cap icons tied to actions.
- R-06 PASS: Archivo expanded for display (owner choice, distinct from the reference); uppercase only on display headings and labels.
- R-07 PASS: no background grid; dot screentone only inside page panels and job banners, where it reads as print.
- R-08 PASS: the play glyph marks the two "start work" buttons only.
- R-09 PASS: no decorative badges; the "Studio" tag names the product area.
- R-10 PASS: blur only on the top bar.
- R-12 PASS: shadows on floating objects only (composer, dialogs, toasts, drawer, paper pages).
- R-13 PASS: glow on the hero and the focused composer ring only.
- R-14 PASS: job cards differ by state; lanes carry hierarchy.
- R-19 PASS: motion marks change or real work only; reduced motion respected.
- R-22 PASS: no illustrations beyond the engine's layouts.

## Block 3: Liveliness

- Dials declared and matched: bold display type and amber CTAs (ENERGY 3), each stage keeps its own composition (RHYTHM 2), purposeful motion (MOTION 2). PASS
- One focal point per screen: the composer on Create, the board on Generate, the light table on Review, the binder on Plan. PASS
- One deliberate accent: amber. PASS
- Identity motif: paper-white comic pages with ink borders and screentone, from hero to storyboard. PASS

## Block 4: Craftsmanship and Quality Locks

- C-1 to C-5 PASS: reasons in README "Design notes"; no dead controls; no template sections; resilient states, themes, breakpoints, keyboard; nothing fabricated.
- R-05 PASS: layouts follow each stage's task.
- R-11 PASS: three radius steps, no pill-everything.
- R-15 PASS: specific actions ("Create", "Queue", "Validate and import", "Create private export").
- R-16 PASS: no buzzwords.
- R-20 PASS: amber, paper pages, and Comic Sol copy keep the identity.
- R-21 PASS: dark default for a media tool, working light theme.
- R-29 PASS: near-black neutrals, amber, cyan, status green and red.
- R-30 PASS with owner request: see note above.
- R-31 PASS: one-line reasons in README.
