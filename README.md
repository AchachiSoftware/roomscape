# RoomScape

A small, self-contained web app for mapping out a room or wall and dragging
scaled furniture around to see how it fits — built for planning a new apartment.

![RoomScape](docs/preview.png)

## Features

- **Any room shape, reshaped by hand** — the room is whatever outline you give
  it, and you edit it on the plan rather than in a form. Drag a **wall** and it
  slides along its own normal while the walls it meets stretch to follow; drag
  a **corner** to pull the outline about; hit the `+` that appears on a wall to
  split it, or double-click the wall at the spot you want the new corner. Drop
  a corner onto its neighbour and the two **weld together**, dropping the wall
  between them. A drag that would tangle the walls is refused rather than
  applied, and `Esc` abandons one mid-gesture. Every wall is labelled with its
  own length, the grid clips to the outline, and area is computed from the real
  polygon. A piece that no longer fits inside the outline gets a red dashed edge.
- **Or draw it from scratch** — **Draw the outline** turns the stage into a
  sketch pad: click each corner and the walls follow, squaring themselves up
  unless you hold `Shift`, with every wall's length called out as you go.
  Closing the loop on the first corner (or `Enter`) commits the room; the room
  you're replacing stays on screen as a faint tracing guide. A first visit opens
  straight into it, so the first thing you do is draw your own place.
- **Rectangles stay editable as numbers** — while the outline still *is* a plain
  rectangle, the panel offers width and length fields; the moment it isn't, they
  give way to the corner count and a way back to a rectangle.
- **Add furniture** — give a piece a label and its width × depth. Tap a preset
  (bed, sofa, dining table, desk…) to pre-fill common sizes.
- **Closets** — switch the add form to **Closet** for closet presets (reach-in,
  walk-in, wardrobe, linen). Closets draw as built-in structure: hatched fill,
  door leaves on the front edge and a hanging rod set back from them. Rotating a
  closet moves its doors to the next side, so you can point it at the room it
  opens into.
- **Arrange by dragging** — move pieces around the floor; optional snap-to-grid
  keeps things aligned. Select a piece to rotate 90°, duplicate, or remove it.
- **Recolor any piece** — each piece has a color swatch (native color picker);
  the label text automatically flips to stay readable on the chosen fill.
- **Doors & windows** — add a door or window and drag it onto any wall (it snaps
  to the nearest one and slides along it), including the angled walls of a custom
  outline. Doors draw a true swing arc so you can eyeball clearance.
- **Fully rotatable doors** — a wall door has four orientations: hinge at either
  jamb, swinging either way. **Rotate** (button or `R`) steps through all four;
  the individual **hinge** (`F`) and **swing in/out** (`O`) toggles are still
  there when you know which one you want. Door/window graphics draw above
  furniture so you can see when a piece blocks an opening; the view reserves
  margin so outward swings stay on-screen.
- **Feet, inches, meters, or centimeters** — switch units anytime from the
  segmented control; geometry is stored internally in meters so nothing gets
  distorted, and area is reported in the system's large unit (ft² or m²).
- **Centered grid** — each axis's grid is scaled to an even number of cells so
  a real grid line lands on the room's exact midline, marked with a dashed
  center crosshair for quick eyeballing of halves.
- **Autosaves** — your layout persists in the browser (localStorage).
- **Light & dark** themes; keyboard support (arrows nudge, `R` rotates,
  `Delete` removes the selected piece or corner, `Esc` backs out of whatever is
  in progress).

## Running it

It's a static site — no build step or dependencies.

```bash
# from this folder, any static server works, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a browser.

## Project layout

```
roomscape/
├── index.html   # markup + structure
├── styles.css   # design tokens, both themes, all styling
├── app.js       # state, rendering, drag/units/persistence
└── README.md
```

## Notes

- Geometry is stored in meters internally; units are a display concern only.
- The room is always a polygon. A plain rectangle is stored as width × length
  so the number fields keep working; anything else keeps a vertex list, and the
  app drops back to the rectangle form on its own whenever an edit happens to
  leave a rectangle behind. Walls, openings and clamping all work off that
  polygon, so nothing assumes four square corners.
- Openings attach to a wall by edge index plus an offset along it, so any edit
  that adds or removes walls re-homes them by where they sat on the plan.
- An outline is re-origined to (0, 0) after every edit, with the furniture
  carried along, which is what lets you drag the left or top wall outward.
- Furniture colors come from a fixed muted categorical palette kept distinct
  from the UI accent so pieces read clearly against the floor.
- Fonts (`Hanken Grotesk`, `JetBrains Mono`) load from Google Fonts; the app
  degrades gracefully to system fonts offline.
