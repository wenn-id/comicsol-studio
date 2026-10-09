# Rooftop Stories

An original two-page sample created for Studio's editorial white-and-red redesign.
It replaces the upstream Sunlight Courier demonstration.

Mena leaves a busy day behind, climbs to the rooftop, and sits with a pigeon while the
city continues below. Four panels use one character, one location and short captions.

## Files

- `source/` holds the original brief and request. Its artwork manifest points to the
  same locally bundled WebP assets used by the landing page; no artwork is downloaded
  when recording or browsing the sample.
- `plan/` holds the story, character bible and two-horizontal storyboards. These are
  validated by the actual pinned Comic Sol engine during recording.
- `qa/` holds development-fixture review evidence based on visual inspection of the
  generated artwork. Recording replays these preset decisions; they are not a review
  performed by a visitor or a vision-model call.
- `comicsol_studio/web/assets/img/rooftop-page-*.webp` are the composed engine pages
  used as the Three.js book's two interior textures.

The artwork was created with OpenAI's built-in image generation tool. A single Mena
reference guided all four panel images and the cover. The engine conforms panel
dimensions, adds the captions, composes the pages and verifies the export. No paid
Studio provider call is used by the recording script.

## Art direction and prompts

Reference: an adult with warm brown skin, short curly black hair, a terracotta hoodie,
black trousers and off-white sneakers. Independent graphic-novel pen-and-ink art with
architectural hatching, warm white paper, near-black ink and a restrained red accent.

Panel prompts share that reference and ask for a single text-free image with protected
caption space at upper left:

1. A wide three-quarter view of Mena pushing the stairwell door open onto the rooftop.
2. Mena seated safely on a broad parapet with sneakers supported on the rooftop floor.
3. A close three-quarter portrait of Mena noticing a pigeon, hands resting on her knee.
4. A very wide rear view of Mena and the pigeon, with relaxed shoulders and the same city.

Cover: a flat 2:3 editorial composition with a red upper field, a large warm-white
`ROOFTOP STORIES` title, and Mena above a detailed black-and-white city below. The cover
is mapped onto the actual bendable Three.js softcover, not shipped as a fake book render.

## Record it

With Studio installed in the active Python environment:

```bash
python pages/record.py --sample pages/sample --out recording
python pages/build.py --recording recording --out _site --base /comicsol-studio/
```

The landing artwork is a bundled design sample. The Pages replay is rebuilt from the
real application and engine; visitor edits in the static replay do not create new art.
