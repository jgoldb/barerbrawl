# Barer Brawl

A first-person, three.js beat-'em-up set in an **endless, procedurally-generated yeshiva**.
You once learned here in peace. This morning, something turned — and the bochurim
are coming for you. Fight your way out, hall by hall. There is no ending, only how
deep you get before the chevra buries you.

Everything is generated at runtime — geometry, textures, characters, sound, and music.
No art or audio files. The only dependency is three.js (vendored offline in `vendor/`).

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
serve.mjs           zero-dependency static server
src/
  main.js           entry: renderer, scene, state machine, game loop, intro cutscene
  rng.js            seedable RNG
  audio.js          procedural Web Audio SFX + klezmer (Freygish) music engine
  input.js          keyboard/mouse + pointer lock
  textures.js       canvas-generated wood / plaster / carpet / stone / sefarim
  assets.js         shared materials & palettes
  props.js          bookshelves, tables, shtenders, chandeliers, Aron Kodesh, …
  characters.js     jointed bochur rig + first-person fists
  mapgen.js         procedural room/corridor layout
  roombuilder.js    turns map cells into meshes + colliders + lights + gates
  collide.js        circle-vs-AABB collision
  enemy.js          enemy AI, animation, combat
  player.js         camera rig, movement, view-model, combat, health
  cutscene.js       generic cinematic timeline director
  ui.js             HUD, menus, floating text, boss bar
  director.js       run orchestration: streaming, waves, difficulty, pickups
```

## A note on the setting

It's an affectionate, absurd action-game premise — a yeshiva turned brawl. The on-screen
flavor leans warm and Yiddish (*bochurim*, *chevra*, *chavrusa*, kugel power-ups, a shofar
blast at the start of each fight) rather than mean-spirited. Have fun with it. Gut voch.
