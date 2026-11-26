# Third-party notices

## Three.js

The files under `lib/` are vendored from Three.js r160, including its examples
and add-ons.

- Project: <https://threejs.org/>
- Source: <https://github.com/mrdoob/three.js/tree/r160>
- License: MIT
- Copyright: 2010-2023 three.js authors

The full license text is in [`LICENSES/three.js-MIT.txt`](LICENSES/three.js-MIT.txt).

## Poly Haven

The sky lighting and the visible sky are derived from CC0 (public domain)
"pure sky" HDRIs published by Poly Haven. `tools/blender/build_sky.py` rotates,
level-matches and re-encodes them; only the derived files are in the repository.

- Project: <https://polyhaven.com/>
- License: CC0 1.0 Universal (<https://polyhaven.com/license>)
- `kloofendal_48d_partly_cloudy_puresky` -> `textures/hdri/day.hdr`,
  `textures/sky-day.jpg`
- `qwantani_sunset_puresky` -> `textures/hdri/dusk.hdr`, `textures/sky-dusk.jpg`

`tools/blender/render_hero.py` (not part of the deployed game) also reads Poly
Haven's CC0 `asphalt_02` texture set from the git-ignored local cache
`tools/blender/cache/`.

## Playwright

Playwright is installed as a development-only dependency for browser regression
testing. It is not bundled into the deployed game.

- Project: <https://playwright.dev/>
- Source: <https://github.com/microsoft/playwright>
- License: Apache License 2.0

## AI-finished menu artwork

`assets/hero-grid.jpg` and `assets/hero-nose.jpg` are path-traced Blender
renders of this project's own car model that were then run through an AI
image-finishing pass (OpenAI Codex image generation). They contain no
third-party marks. Unlike the rest of the assets they are governed by the
generating service's output terms rather than authored end to end here; see
`ASSET_PROVENANCE.md`. The game runs unchanged without them.

No ElevenLabs-generated audio is included in the open-source repository. The
optional sound-generation tools call an external service; output created with
them is governed by the applicable user account and service terms.
