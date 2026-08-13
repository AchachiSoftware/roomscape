# RoomScape

A small, self-contained web app for mapping out a room or wall and dragging
scaled furniture around to see how it fits — built for planning a new apartment.

![RoomScape](docs/preview.png)

## Features

- **Rooms that aren't rectangles** — pick **Rectangle**, **L-shaped** (choose
  which corner is cut away and how deep), or **Custom**. In custom mode the
  outline gets draggable corner handles: drag a corner to move it, tap the `+`
  on a wall to add one, select a corner and press `Delete` to drop it. Every
  wall is labelled with its own length, the grid clips to the outline, and area
  is computed from the real polygon. A piece that no longer fits inside the
  outline is flagged with a red dashed edge.
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
  `Delete` removes the selected piece).

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
- The room is always a polygon — rectangles and L-shapes are generated from
  parameters, custom outlines keep an editable vertex list. Walls, openings and
  clamping all work off that polygon, so nothing assumes four square corners.
  Openings attach to a wall by edge index plus an offset along it.
- Furniture colors come from a fixed muted categorical palette kept distinct
  from the UI accent so pieces read clearly against the floor.
- Fonts (`Hanken Grotesk`, `JetBrains Mono`) load from Google Fonts; the app
  degrades gracefully to system fonts offline.
