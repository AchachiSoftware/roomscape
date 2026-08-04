# Room Planner

A small, self-contained web app for mapping out a room or wall and dragging
scaled furniture around to see how it fits — built for planning a new apartment.

![Room Planner](docs/preview.png)

## Features

- **Set a room or wall** — enter width × length; the floor plan renders to scale
  on a drafting-style grid with edge dimension labels.
- **Add furniture** — give a piece a label and its width × depth. Tap a preset
  (bed, sofa, dining table, desk…) to pre-fill common sizes.
- **Arrange by dragging** — move pieces around the floor; optional snap-to-grid
  keeps things aligned. Select a piece to rotate 90°, duplicate, or remove it.
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
room-planner/
├── index.html   # markup + structure
├── styles.css   # design tokens, both themes, all styling
├── app.js       # state, rendering, drag/units/persistence
└── README.md
```

## Notes

- Geometry is stored in meters internally; units are a display concern only.
- Furniture colors come from a fixed muted categorical palette kept distinct
  from the UI accent so pieces read clearly against the floor.
- Fonts (`Hanken Grotesk`, `JetBrains Mono`) load from Google Fonts; the app
  degrades gracefully to system fonts offline.
