# antislop delivery gate: Studio Next, first build (2026-10-08)

Design read: four-stage production workspace for comic creators, night production room
language, dial ENERGY 3 / RHYTHM 2 / MOTION 2. Direction came from the owner's choice of
"Ruang produksi malam" (dark first, cyan hairlines, amber primary, light mode kept) and the
Comic Sol logo.

## Click-through (R-35), run against `127.0.0.1:8766` with `--agent-images`

- Start: typed title and pitch, byte meter updated (122 B of 200 KB); Create comic project -> `POST /api/projects` 201, Plan opened.
- Plan: filled four documents -> "3 documents changed" summary and tab dots; Review changes -> formatted line diff (+39/+41/+249/+43); Save with an empty visual identity -> server 400, now shown as a specific message; Save with valid documents -> revision 2, status Storyboarded; Read/Edit toggle, all four tabs, storyboard panel selection and panel detail.
- Generate: stage track click and Alt 3; cost checkbox enables Queue only for the selected route; Queue -> `POST /api/generation/queue` 201, job "Waiting for your agent" in In progress; Cancel -> toast, job moved to History.
- Review: Run QA -> 30 findings grouped into 11 areas, stage status "QA findings"; Export without the replace box -> guard message; with it -> confirm dialog -> private blob download link, focus moved to it.
- Shell: Ctrl K palette filter and Enter -> Plan; focus mode on and Esc; Log open and close; `?` shortcut sheet; day and night themes; reload restores the project, also when a stage is clicked during restore.
- Mobile 375 px: no horizontal overflow on any stage; tap targets under 44 px fixed (segmented controls, reasons summary).
- Console: only expected 404s from `GET /api/workflows/<id>` when no workflow exists (once per visit).
- Not exercised live (no provider keys, no agent raster submission): staged promotion, provider switch, pause/resume, planner polling, production approval, archive import. Covered by code inspection and the confirmation-order tests only.

## Block 1: Hard Gate

- R-02 PASS: `test_copy_has_no_em_dash` scans every UI file.
- R-03 PASS: 375 px check found no overflow on Start, Plan, Generate, Review.
- R-17 PASS: no statistics; counts shown are live job and finding counts.
- R-18 PASS: no testimonials.
- R-23 PASS: no new logo or people imagery; the sun mark is the existing brand glyph, the font is the engine's bundled Comic Neue.
- R-24 PASS: stage track lists four stages that exist; locked stages are disabled with "Needs a project".
- R-25 PASS: `test_both_themes_define_the_same_tokens_and_meet_aa_contrast` checks every text token on every surface in both themes at 4.5:1 or more.
- R-26 PASS: every control calls a real API or toggles real state; disabled controls say why.
- R-27 PASS: empty, loading, and error states on every stage (planner, routes, board lanes, light table, QA, log).
- R-28 PASS: no FAQ.
- R-32 PASS: tabs, palette, dialogs, stage track work by keyboard; focus ring tested; only `#stage` drops the default ring and replaces it.
- R-33 PASS: features live in source; no patch scripts in the project.
- R-34 PASS: both themes checked visually and by the contrast test.
- R-35 PASS: click-through above.
- R-36 PASS: no claims beyond what the code does; README states the private, unreleased status.
- R-37 PASS: direction chosen by the owner; dials declared.
- R-38 PASS: placeholders say what goes in a field; no realistic fake data in the UI.

## Block 2: Purpose-Gate

- R-01 PASS: one gradient, the desk-lamp pool, marks the focal workspace; the slate stripe marks the cost slip.
- R-04 PASS: custom square-cap icons, each tied to its action (upload, download, focus, pause).
- R-06 PASS: Comic Neue is the engine's lettering face, headings only; slash-label eyebrows come from the logo.
- R-07 PASS: no background grid or pattern.
- R-08 PASS: no decorative arrows.
- R-09 PASS: chips mark real state (status, tone, cast); no capsule badges.
- R-10 PASS: no glassmorphism.
- R-12 PASS: shadow only on paper pages, the accepted raster, toasts, and dialogs (lifted objects).
- R-13 PASS: no glow.
- R-14 PASS: route, job, and format cards differ by content; lanes carry hierarchy.
- R-19 PASS: motion marks stage change, connector progress, and real in-flight work only; reduced motion respected.
- R-22 PASS: no illustrations; the only imagery is the creator's own pages.

## Block 3: Liveliness

- Dials declared: ENERGY 3 / RHYTHM 2 / MOTION 2. PASS
- Output matches the dials: each stage has its own composition (composer, binder, board, light table). PASS
- One focal point per screen: the crop-marked primary panel. PASS
- Whitespace is structural: panel gaps and stage head spacing separate work areas. PASS
- One deliberate accent: amber for the primary action, current stage, and lamp. PASS
- Identity motif: crop marks plus paper-white comic pages. PASS
- Design read declared before generation. PASS

## Block 4: Craftsmanship and Quality Locks

- C-1 PASS: decisions and reasons are listed in README "Design notes".
- C-2 PASS: no control without behaviour.
- C-3 PASS: no template sections; every panel maps to a backend capability.
- C-4 PASS: states, themes, breakpoints, keyboard covered above.
- C-5 PASS: nothing fabricated.
- R-05 PASS: app layout built per stage task, not a dashboard shell.
- R-11 PASS: 3 to 6 px radii; no pills.
- R-15 PASS: specific actions ("Create comic project", "Queue generation", "Create private export").
- R-16 PASS: no buzzwords.
- R-20 PASS: swapping the name still leaves the production-desk identity.
- R-21 PASS: dark default justified for a creative tool; working light theme.
- R-29 PASS: ink, cyan, amber plus status green and red.
- R-30 PASS: not modelled on another product.
- R-31 PASS: one-line reasons in README.
