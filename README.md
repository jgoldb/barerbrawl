# Barer Brawl

A first-person, three.js beat-'em-up set in an **endless, procedurally-generated yeshiva**.
You once learned here in peace. This morning, something turned — and the bochurim
are coming for you. Fight your way out, hall by hall. There is no ending, only how
deep you get before the chevra buries you.

Everything is generated at runtime — geometry, textures, characters, sound, and music.
The lone exception is **Chaim Barer's face**: three photo billboards in `assets/`
(shipped with the game) used for the boss-lackey encounter every 15th hall. The only
dependency is three.js (vendored offline in `vendor/`).

---

## Run it

The game uses ES modules, so it must be served over HTTP (opening `index.html`
directly with `file://` will not work).

**Easiest (Windows):** double-click / run `run.ps1`, or:

```powershell
powershell -ExecutionPolicy Bypass -File run.ps1
```

**With Node:**

```bash
node serve.mjs          # then open http://localhost:8000
```

**With Python:**

```bash
python -m http.server 8000    # then open http://localhost:8000
```

Then click **Begin the Descent**. Click the canvas to lock the mouse and brawl.
A recent Chrome/Edge/Firefox with WebGL is required.

---

## Deploying & versioning (GitHub Pages)

There's no bundler — the repo *is* the site — so a returning player's browser can
happily serve last week's cached `main.js` against this week's `director.js`.
Two pieces prevent that:

- **`sw.js`** — a network-first service worker registered from `index.html`
  **on the deployed site only** (it is skipped, and any stray registration is torn
  down, on `localhost`). On every load it re-fetches each file from the network
  (bypassing the browser's HTTP cache) and only falls back to its own cache when
  offline. So a fresh deploy is picked up on the next load instead of up to ~10
  minutes later (GitHub Pages serves everything with `Cache-Control: max-age=600`,
  which is otherwise stale and un-overridable). It self-heals — being network-first,
  an online player can never get stuck on an old build.
- **`version.json`** — a tiny always-fresh probe. `index.html` reads it and shows
  the live build id in the menu footer (hover it) and logs it to the console, so
  you can confirm at a glance which deploy is live.

Before publishing, stamp a new build id:

```bash
npm run bump      # updates version.json's "build" timestamp
```

then commit and push. Bumping is optional (the worker keeps you fresh either way);
it just makes the deployed version visible for confirmation.

---

## Controls

| Input | Action |
|-------|--------|
| `W A S D` | Move |
| Mouse | Look |
| **Left click** | Jab — fast, builds combos |
| **Right click** | Haymaker — slow, heavy, knocks bochurim down |
| `Shift` | Sprint |
| `Space` | Shove — clear space when swarmed |
| `Esc` | Pause (releases the mouse) |

---

## How it plays

- **Sealed halls.** Enter a room and the gate slams behind you. Lay out every bochur
  to raise the far gate and press on.
- **Endless & procedural.** Rooms, corridors, décor, and enemy waves are generated on
  a seeded winding path. Only a few cells exist at once — it streams forever.
- **Ramping difficulty.** Deeper halls mean more enemies, tougher archetypes
  (fast *masmidim*, hulking *gabbaim*), extra waves, and — every fifth hall — the
  **Mashgiach**, a boss in the Great Shul.
- **Score & combos.** Chain hits to build a combo multiplier. Clearing a hall and
  felling tougher foes drops a **kugel** to restore vitality.
- **You will lose.** Survival regen is slow; the swarm eventually wins. The run ends
  when you drop. Then you go again, deeper.

---

## Project layout

```
index.html          markup + import map (three -> ./vendor)
css/style.css       HUD, menus, cinematic overlay
vendor/             three.js r160 (vendored for offline use)
assets/             Chaim Barer face billboards (the only image files) — ships with the game
serve.mjs           zero-dependency static server
src/
  main.js           entry: renderer, scene, state machine, game loop, intro cutscene
  rng.js            seedable RNG
  audio.js          procedural Web Audio SFX + klezmer (Freygish) music engine
  input.js          keyboard/mouse + pointer lock
  textures.js       canvas-generated wood / plaster / carpet / stone / sefarim
  assets.js         shared materials & palettes (+ loads the Barer billboards)
  props.js          bookshelves, tables, shtenders, chandeliers, Aron Kodesh, …
  characters.js     jointed bochur rig + first-person fists
  mapgen.js         procedural room/corridor layout
  roombuilder.js    turns map cells into meshes + colliders + lights + gates
  collide.js        circle-vs-AABB collision
  enemy.js          enemy AI, animation, combat (incl. Chaim Barer, the boss's lackey)
  player.js         camera rig, movement, view-model, combat, health
  cutscene.js       generic cinematic timeline director
  finisher.js       interactive Barer finisher (Jab / "LEWIE BALLEWIE!")
  ui.js             HUD, menus, floating text, boss bar
  director.js       run orchestration: streaming, waves, difficulty, pickups
```

## A note on the setting

It's an affectionate, absurd action-game premise — a yeshiva turned brawl. The on-screen
flavor leans warm and Yiddish (*bochurim*, *chevra*, *chavrusa*, kugel power-ups, a shofar
blast at the start of each fight) rather than mean-spirited. Have fun with it. Gut voch.
