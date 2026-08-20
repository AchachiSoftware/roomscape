/* ============================================================
   RoomScape — app logic
   Geometry is stored internally in METERS so units are just a
   display concern. The floor renders at a scale (px per meter)
   computed to fit the room in the stage, times a zoom factor.

   The room is a POLYGON. Rectangles and L-shapes are generated
   from parameters; "custom" keeps an editable vertex list. All
   plan geometry (walls, openings, clamping) works off that
   polygon, so nothing downstream assumes four square corners.
   ============================================================ */

(() => {
  "use strict";

  const STORE_KEY = "roomscape:v1";
  const THEME_KEY = "roomscape:theme";
  const LEGACY_STORE_KEY = "room-planner:v1";   // pre-RoomScape name
  const LEGACY_THEME_KEY = "room-planner:theme";
  const M_PER_FT = 0.3048;

  /* ---- Supported display units. Geometry is always meters internally. ----
     perM  : display units per meter
     step  : snap / input increment, in display units
     grid  : nominal minor grid cell, in display units
     major : heavier grid line every N display units (multiple of grid) */
  const UNITS = {
    ft: { perM: 1 / M_PER_FT, label: "ft", step: 0.5,  grid: 1,   major: 5,   metric: false },
    in: { perM: 1 / 0.0254,   label: "in", step: 1,    grid: 6,   major: 12,  metric: false },
    m:  { perM: 1,            label: "m",  step: 0.05, grid: 0.5, major: 1,   metric: true  },
    cm: { perM: 100,          label: "cm", step: 5,    grid: 25,  major: 100, metric: true  },
  };

  /* ---- Muted categorical furniture palette (distinct from UI teal) ---- */
  const PALETTE = [
    "#C56B4E", // terracotta
    "#5B85A6", // dusty blue
    "#6E8E6A", // sage
    "#C79A3E", // ochre
    "#9B6A8F", // mauve
    "#5E7480", // slate
    "#A6705A", // clay
    "#8A8B4A", // olive
  ];
  /* Closets read as built-in structure rather than furniture, so they get
     one neutral tone instead of a slot in the categorical palette. */
  const CLOSET_COLOR = "#7C8890";

  /* ---- Presets: typical footprints, stored in feet for authoring ---- */
  const PRESETS = [
    { label: "Queen bed",   w: 5.0, d: 6.7 },
    { label: "Sofa",        w: 7.0, d: 3.0 },
    { label: "Dining table",w: 6.0, d: 3.5 },
    { label: "Desk",        w: 4.0, d: 2.0 },
    { label: "Dresser",     w: 5.0, d: 1.7 },
    { label: "Nightstand",  w: 1.5, d: 1.5 },
    { label: "Armchair",    w: 2.7, d: 2.7 },
    { label: "Bookshelf",   w: 3.0, d: 1.0 },
  ];
  const CLOSET_PRESETS = [
    { label: "Reach-in closet", w: 6.0, d: 2.0 },
    { label: "Walk-in closet",  w: 6.0, d: 6.0 },
    { label: "Wardrobe",        w: 4.0, d: 2.0 },
    { label: "Linen closet",    w: 2.5, d: 1.8 },
  ];

  /* Default opening sizes, authored in feet */
  const DOOR_W_M = 2.75 * M_PER_FT;   // ~33 in interior door
  const WINDOW_W_M = 3.0 * M_PER_FT;  // ~36 in window

  /* A door on a wall has exactly four orientations: hinge at either jamb,
     swinging either way. Cycling this list is "rotate". */
  const DOOR_STATES = [
    { flip: false, out: false },
    { flip: true,  out: false },
    { flip: true,  out: true  },
    { flip: false, out: true  },
  ];

  /* ---- Default state ---- */
  const defaultState = () => ({
    unit: "ft",
    /* The outline is drawn and dragged on the plan, so "shape" is only about
       how it is stored: a plain rectangle keeps its width and length (which
       is what the number fields edit), anything else keeps a vertex list.
       Nothing switches modes by hand — the shape follows the polygon. */
    room: {
      shape: "rect",                                   // rect | custom
      w: 12 * M_PER_FT, l: 14 * M_PER_FT,              // bounding box
      poly: null,                                      // vertex list when shape === custom
    },
    snap: true,
    zoom: 1,
    colorSeed: 0,
    pieces: [],     // { id, type:'furniture'|'closet', label, w, d, rot, color, x, y, locked }
    openings: [],   // { id, kind:'door'|'window', edge, pos(m), width(m), flip, out, locked }
  });

  const saved = load();
  const firstVisit = !saved;
  let state = saved || defaultState();
  let selectedId = null;
  let baseScale = 40;         // px per meter, recomputed on render
  let addType = "furniture";  // which preset group / piece type the add form builds

  /* Derived room geometry, rebuilt whenever the room changes. x0/y0 are the
     outline's bounding-box origin. Settled outlines always start at (0,0);
     one being dragged is allowed to run negative until the gesture ends and
     re-origins it, so the plan can't shift under the pointer mid-drag. */
  const R = { poly: [], edges: [], x0: 0, y0: 0, w: 1, l: 1, area: 0, names: [] };

  /* The view frame: the slab of plan the floor element covers, in meters.
     Normally exactly the room's bounding box; while an outline is being
     dragged or drawn it is frozen larger than the room so the sheet stays
     put on screen while the room under it changes size. */
  const V = { ox: 0, oy: 0, w: 1, l: 1 };
  let frozenView = null;   // { ox, oy, w, l, scale } for the length of a gesture

  /* ---- Element handles ---- */
  const $ = (id) => document.getElementById(id);
  const els = {
    rectFields: $("rectFields"), customFields: $("customFields"),
    roomW: $("roomW"), roomL: $("roomL"),
    resetPoly: $("resetPoly"), pointCount: $("pointCount"),
    drawOutline: $("drawOutline"),
    drawBar: $("drawBar"), drawMsg: $("drawMsg"),
    drawUndo: $("drawUndo"), drawFinish: $("drawFinish"), drawCancel: $("drawCancel"),
    roomArea: $("roomArea"), pieceCount: $("pieceCount"),
    typeToggle: $("typeToggle"),
    presets: $("presets"), addForm: $("addForm"),
    addLabel: $("addLabel"), addW: $("addW"), addD: $("addD"), addSubmit: $("addSubmit"),
    pieceList: $("pieceList"), emptyPieces: $("emptyPieces"), clearAll: $("clearAll"),
    orderHint: $("orderHint"),
    addDoor: $("addDoor"), addWindow: $("addWindow"),
    openingList: $("openingList"), emptyOpenings: $("emptyOpenings"),
    roomLayer: $("roomLayer"), openingsLayer: $("openingsLayer"),
    snapToggle: $("snapToggle"),
    zoomIn: $("zoomIn"), zoomOut: $("zoomOut"), zoomFit: $("zoomFit"),
    stageScroll: $("stageScroll"), stage: $("stage"),
    floor: $("floor"), plan: $("plan"),
    themeToggle: $("themeToggle"),
    unitBtns: document.querySelectorAll(".unit-toggle button"),
    unitLabels: document.querySelectorAll("[data-unit-label]"),
  };

  /* ================= Unit helpers ================= */
  const U = () => UNITS[state.unit] || UNITS.ft;
  const unitStep = () => U().step;                 // snap increment, in current unit
  const toDisplay = (m) => m * U().perM;
  const toMeters  = (v) => v / U().perM;
  const unitLabel = () => U().label;

  function fmt(m) {
    const v = toDisplay(m);
    // Trim to at most 1 decimal, drop trailing .0
    return (Math.round(v * 10) / 10).toString();
  }
  function fmtDim(m) { return `${fmt(m)}${unitLabel()}`; }

  /* ================= Persistence ================= */
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
  }
  function load() {
    try {
      let raw = localStorage.getItem(STORE_KEY);
      if (!raw) {
        // Migrate a layout saved under the old "room-planner" key.
        raw = localStorage.getItem(LEGACY_STORE_KEY);
        if (raw) {
          localStorage.setItem(STORE_KEY, raw);
          localStorage.removeItem(LEGACY_STORE_KEY);
        }
      }
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.room || !Array.isArray(s.pieces)) return null;
      return migrate(s);
    } catch (_) { return null; }
  }

  /* Bring a save from an older schema up to the current one. */
  function migrate(s) {
    if (!Array.isArray(s.openings)) s.openings = [];
    if (!s.room.shape) s.room.shape = "rect";
    if (!Array.isArray(s.room.poly)) s.room.poly = null;
    if (s.room.shape === "custom" && !s.room.poly) s.room.shape = "rect";
    // L-shaped rooms used to be a template with a cut-out corner. They are
    // just outlines now, so an old save is turned into the outline it drew.
    if (s.room.shape === "l") {
      s.room.poly = lShapePoly(s.room.w, s.room.l, s.room.notch);
      s.room.shape = s.room.poly ? "custom" : "rect";
    }
    delete s.room.notch;

    for (const p of s.pieces) {
      if (p.type !== "closet") p.type = "furniture";
      if (typeof p.rot !== "number") p.rot = 0;
      p.locked = !!p.locked;
    }
    // Openings used to name a wall; they now index a polygon edge. On a
    // rectangle those edges run top, right, bottom, left.
    const WALL_EDGE = { top: 0, right: 1, bottom: 2, left: 3 };
    for (const o of s.openings) {
      if (typeof o.edge !== "number") o.edge = WALL_EDGE[o.wall] ?? 0;
      delete o.wall;
      o.flip = !!o.flip; o.out = !!o.out; o.locked = !!o.locked;
    }
    return s;
  }

  /* ================= Room polygon ================= */
  /* Vertices for the current shape, in meters, in the polygon's own frame. */
  const buildPoly = () => buildPolyFrom(state.room);
  function buildPolyFrom(rm) {
    if (rm.shape === "custom" && Array.isArray(rm.poly) && rm.poly.length >= 3) {
      return rm.poly.map((p) => [p[0], p[1]]);
    }
    const w = Math.max(0.1, rm.w), l = Math.max(0.1, rm.l);
    return [[0, 0], [w, 0], [w, l], [0, l]];
  }

  /* The old L-shaped template, kept only to convert saves that still use it. */
  function lShapePoly(w, l, notch) {
    if (!notch || !(w > 0) || !(l > 0)) return null;
    const nw = Math.max(0.05, Math.min(notch.w, w - 0.05));
    const nl = Math.max(0.05, Math.min(notch.l, l - 0.05));
    switch (notch.corner) {
      case "tl": return [[nw, 0], [w, 0], [w, l], [0, l], [0, nl], [nw, nl]];
      case "tr": return [[0, 0], [w - nw, 0], [w - nw, nl], [w, nl], [w, l], [0, l]];
      case "bl": return [[0, 0], [w, 0], [w, l], [nw, l], [nw, l - nl], [0, l - nl]];
      default:   return [[0, 0], [w, 0], [w, l - nl], [w - nw, l - nl], [w - nw, l], [0, l]];
    }
  }

  /* Shoelace area. Positive means the ring runs clockwise on screen (y down),
     which is the winding the inward-normal formula below assumes. */
  function polyArea(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    }
    return a / 2;
  }

  /* ---- Outline predicates ------------------------------------------------
     Reshaping the outline by hand needs answers the parametric shapes never
     had to give: where the polygon actually sits, and whether a half-finished
     drag has turned it into something that is no longer a room. A drag that
     would tangle the walls is simply refused, which is why the shape can't be
     knotted into a bow-tie any more. */
  const clonePoly = (poly) => poly.map((p) => [p[0], p[1]]);

  function polyBBox(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1, w: x1 - x0, l: y1 - y0 };
  }

  /* Two walls that aren't neighbours crossing means the outline is tangled,
     and nothing downstream — area, grid clipping, inward normals — survives it. */
  function polySelfIntersects(poly) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      for (let j = i + 1; j < n; j++) {
        const j2 = (j + 1) % n;
        if (j === i2 || j2 === i) continue;          // shares a corner
        if (segCross(poly[i], poly[i2], poly[j], poly[j2])) return true;
      }
    }
    return false;
  }

  const MIN_WALL_M = 0.12;      // below this a wall is a slip, not a wall
  const MIN_AREA_M = 0.25;

  /* Is this still a room? `melt` names one corner that is allowed to sit on
     top of its neighbour: that is a weld in progress, and the wall between
     them disappears when the drag is released. */
  function polyValid(poly, melt = -1) {
    if (!Array.isArray(poly) || poly.length < 3) return false;
    for (const p of poly) if (!isFinite(p[0]) || !isFinite(p[1])) return false;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      if (i === melt || (i + 1) % n === melt) continue;
      const a = poly[i], b = poly[(i + 1) % n];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_WALL_M) return false;
    }
    // A wall that doubles straight back over the one before it is a zero-width
    // spur, not a corner. The crossing test above can't see it — two collinear
    // segments never "cross" — so it is caught here.
    for (let i = 0; i < n; i++) {
      const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (l1 < 1e-6 || l2 < 1e-6) continue;           // a weld in progress
      const dot = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (l1 * l2);
      if (dot < -0.999) return false;
    }
    const bb = polyBBox(poly);
    if (bb.w < 0.3 || bb.l < 0.3) return false;
    if (Math.abs(polyArea(poly)) < MIN_AREA_M) return false;
    return !polySelfIntersects(poly);
  }

  /* Where two infinite lines meet, or null when they run parallel. */
  function lineIntersect(p1, p2, p3, p4) {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (Math.abs(d) < 1e-9) return null;
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
    return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
  }

  /* Slide one wall along its own normal, keeping it parallel to itself and
     letting its two corners run along the walls they meet — the way a floor
     plan behaves when you push a wall. Where the neighbouring wall is parallel
     there is nothing to run along, so the corner just travels with the wall. */
  function moveEdgePoly(poly, i, dist) {
    const n = poly.length;
    const iA = i, iB = (i + 1) % n;
    const A = poly[iA], B = poly[iB];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1e-9;
    const nx = -dy / len, ny = dx / len;
    const A2 = [A[0] + nx * dist, A[1] + ny * dist];
    const B2 = [B[0] + nx * dist, B[1] + ny * dist];
    const out = clonePoly(poly);
    out[iA] = lineIntersect(poly[(iA - 1 + n) % n], A, A2, B2) || A2;
    out[iB] = lineIntersect(B, poly[(iB + 1) % n], A2, B2) || B2;
    return out;
  }

  /* Recompute every cached quantity that depends on the room outline. */
  function rebuildRoom() {
    let poly = buildPoly();
    if (polyArea(poly) < 0) {
      poly.reverse();
      // Keep the editable copy in the same order, or vertex indices desync.
      if (state.room.shape === "custom") state.room.poly = poly.map((p) => [p[0], p[1]]);
    }
    R.poly = poly;
    const bb = polyBBox(poly);
    R.x0 = bb.x0; R.y0 = bb.y0;
    R.w = Math.max(0.1, bb.w);
    R.l = Math.max(0.1, bb.l);
    state.room.w = R.w;
    state.room.l = R.l;
    R.area = Math.abs(polyArea(poly));

    R.edges = poly.map((a, i) => {
      const b = poly[(i + 1) % poly.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1e-6;
      const ux = dx / len, uy = dy / len;
      // With clockwise-on-screen winding, (-uy, ux) points into the room.
      return { a, b, ux, uy, nx: -uy, ny: ux, len, ang: Math.atan2(uy, ux) };
    });
    R.names = edgeNames();

    for (const o of state.openings) {
      o.edge = Math.max(0, Math.min(o.edge | 0, R.edges.length - 1));
      clampOpening(o);
    }
    state.pieces.forEach(clampPiece);
  }

  /* Short names for walls, derived from which way each one faces. Repeats get
     numbered, so an L-shaped room reads "Top 1 / Top 2". */
  function edgeNames() {
    const base = R.edges.map((e) => {
      if (Math.abs(e.ux) > Math.abs(e.uy) * 3) return e.ny > 0 ? "Top" : "Bottom";
      if (Math.abs(e.uy) > Math.abs(e.ux) * 3) return e.nx > 0 ? "Left" : "Right";
      return "Angled";
    });
    const total = {}, seen = {};
    base.forEach((n) => (total[n] = (total[n] || 0) + 1));
    return base.map((n) => {
      if (total[n] === 1) return n;
      seen[n] = (seen[n] || 0) + 1;
      return `${n} ${seen[n]}`;
    });
  }

  /* ---- Point/rect tests against the outline ---- */
  function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > pt[1]) !== (yj > pt[1]) &&
          pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // Proper crossing only — segments that merely touch at an endpoint don't count,
  // so a piece pushed flush against a wall isn't reported as sticking out.
  function segCross(p1, p2, p3, p4) {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (Math.abs(d) < 1e-12) return false;
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
    const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
  }
  /* True when any part of the piece falls outside the room outline. The test
     rect is inset a hair so pieces parked against a wall read as inside. */
  function pieceOutside(p) {
    if (state.room.shape === "rect") return false;   // clamping already guarantees it
    const fp = footprint(p), e = 1e-3;
    const x0 = p.x + e, y0 = p.y + e;
    const x1 = p.x + fp.w - e, y1 = p.y + fp.d - e;
    if (x1 <= x0 || y1 <= y0) return false;
    const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (const pt of c) if (!pointInPoly(pt, R.poly)) return true;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      for (const ed of R.edges) if (segCross(a, b, ed.a, ed.b)) return true;
    }
    return false;
  }

  /* ================= Color ================= */
  function nextColor() {
    const c = PALETTE[state.colorSeed % PALETTE.length];
    state.colorSeed++;
    return c;
  }
  // Choose readable text color for a given block fill
  function textOn(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? "#1c2529" : "#ffffff";
  }

  /* ================= Snapping & clamping ================= */
  function snapVal(m) {
    if (!state.snap) return m;
    const stepM = toMeters(unitStep());
    return Math.round(m / stepM) * stepM;
  }
  // effective footprint accounting for rotation
  function footprint(p) {
    return p.rot % 180 === 0 ? { w: p.w, d: p.d } : { w: p.d, d: p.w };
  }
  function clampPiece(p) {
    const fp = footprint(p);
    p.x = Math.max(R.x0, Math.min(p.x, R.x0 + Math.max(0, R.w - fp.w)));
    p.y = Math.max(R.y0, Math.min(p.y, R.y0 + Math.max(0, R.l - fp.d)));
  }

  /* ---- Openings (doors/windows) attach to a wall at an offset along it ---- */
  const edgeOf = (o) => R.edges[o.edge] || R.edges[0];
  /* An opening never draws wider than the wall it is on, but the width it was
     given is kept intact: walls move now, and a door that had to squeeze onto
     a short wall gets its full width back when that wall grows again. */
  function openWidth(o) {
    const e = edgeOf(o);
    return e ? Math.min(o.width, e.len) : o.width;
  }
  function clampOpening(o) {
    const e = edgeOf(o);
    if (!e) return;
    o.pos = Math.max(0, Math.min(o.pos, Math.max(0, e.len - openWidth(o))));
  }
  /* Pixel geometry for a given scale: the opening's two jambs on the wall,
     the wall direction, and the inward normal. */
  function openingPx(o, s) {
    const e = edgeOf(o);
    const A = [(e.a[0] + e.ux * o.pos) * s, (e.a[1] + e.uy * o.pos) * s];
    const len = openWidth(o) * s;
    const B = [A[0] + e.ux * len, A[1] + e.uy * len];
    return { A, B, ux: e.ux, uy: e.uy, nx: e.nx, ny: e.ny, len, ang: e.ang };
  }

  /* Number of grid cells along a dimension: even (so a line hits the exact
     center), close to the nominal cell size, and never so dense that lines
     blur together. Returns an even integer >= 2. */
  function evenCells(dimM, cellM, s) {
    let n = Math.max(2, Math.round(dimM / cellM));
    if (n % 2 !== 0) {
      const cLow = dimM / (n - 1), cHigh = dimM / (n + 1);
      n = Math.abs(cLow - cellM) <= Math.abs(cHigh - cellM) ? n - 1 : n + 1;
    }
    // Keep minor lines at least ~7px apart on screen
    let maxN = Math.floor((dimM * s) / 7);
    if (maxN % 2) maxN -= 1;
    if (maxN >= 2) n = Math.min(n, maxN);
    return Math.max(2, n);
  }

  /* ================= Rendering ================= */
  const STAGE_PAD = 44;   // room for edge dimension labels
  const stageRoom = () => ({
    w: Math.max(120, els.stageScroll.clientWidth - STAGE_PAD * 2),
    h: Math.max(120, els.stageScroll.clientHeight - STAGE_PAD * 2),
  });

  function computeScale() {
    if (frozenView) { baseScale = frozenView.scale; return; }
    const avail = stageRoom();
    // Reserve margin so outward door swings stay on-screen: an outward door
    // reaches up to its own width beyond the wall.
    const outM = state.openings.reduce(
      (m, o) => (o.kind === "door" && o.out ? Math.max(m, o.width) : m), 0);
    const fit = Math.min(avail.w / (R.w + 2 * outM), avail.h / (R.l + 2 * outM));
    baseScale = fit * state.zoom;
  }

  /* Which slab of plan the floor element covers. Normally the room's bounding
     box exactly; a frozen frame (set while a wall or corner is being dragged)
     wins, and drawing an outline gets the whole stage to work on. */
  function updateFrame() {
    computeScale();
    if (frozenView) {
      V.ox = frozenView.ox; V.oy = frozenView.oy;
      V.w = frozenView.w;   V.l = frozenView.l;
      return;
    }
    if (DRAW.active) {
      const avail = stageRoom();
      const cw = Math.max(R.w, avail.w / baseScale);
      const cl = Math.max(R.l, avail.h / baseScale);
      V.ox = R.x0 - (cw - R.w) / 2; V.oy = R.y0 - (cl - R.l) / 2;
      V.w = cw; V.l = cl;
      return;
    }
    V.ox = R.x0; V.oy = R.y0; V.w = R.w; V.l = R.l;
  }

  /* Pin the frame for the length of a drag. The floor grows by the padding on
     every side while the plan slides the other way by the same amount, so the
     room stays exactly where it was on screen — and then has somewhere to grow
     into as a wall is dragged outward, instead of the sheet re-centring itself
     out from under the pointer on every pointer move. */
  function freezeView() {
    const s = baseScale, avail = stageRoom();
    const padX = Math.max(0, Math.min((avail.w / s - R.w) / 2, R.w * 0.7));
    const padY = Math.max(0, Math.min((avail.h / s - R.l) / 2, R.l * 0.7));
    frozenView = {
      ox: R.x0 - padX, oy: R.y0 - padY,
      w: R.w + padX * 2, l: R.l + padY * 2, scale: s,
    };
  }

  const planRect = () => els.plan.getBoundingClientRect();
  /* Pointer position in room meters, against a rect captured when the gesture
     began — the frame is frozen for the duration, so it stays valid. */
  const ptM = (e, rect) => [
    (e.clientX - rect.left) / baseScale,
    (e.clientY - rect.top) / baseScale,
  ];

  function render(opts) {
    updateFrame();
    const s = baseScale;

    els.floor.style.width = round2(V.w * s) + "px";
    els.floor.style.height = round2(V.l * s) + "px";
    els.floor.classList.toggle("is-drawing", DRAW.active);
    // Everything on the plan is positioned in room coordinates; the frame is
    // applied once, here, by sliding the whole plan under the floor window.
    els.plan.style.transform =
      `translate(${round2(-V.ox * s)}px, ${round2(-V.oy * s)}px)`;

    if (DRAW.active) drawSketch(s); else drawRoom(s);

    // Furniture — reconcile DOM
    const seen = new Set();
    const ordered = [];
    for (const p of state.pieces) {
      seen.add(p.id);
      let node = els.plan.querySelector(`.piece[data-id="${p.id}"]`);
      if (!node) node = createPieceNode(p);
      positionPiece(node, p, s);
      ordered.push(node);
    }
    // remove stale nodes
    els.plan.querySelectorAll(".piece").forEach((n) => {
      if (!seen.has(n.dataset.id)) n.remove();
    });
    // Pieces all share one z-index, so DOM order is paint order: the last
    // entry in state.pieces lands on top. Re-append only when it drifts,
    // since moving a node mid-drag would break its pointer capture.
    const current = [...els.plan.querySelectorAll(".piece")];
    if (current.some((n, i) => n !== ordered[i])) {
      for (const n of ordered) els.plan.appendChild(n);
    }

    reconcileOpenings(s);
    reconcileHandles(s);
    renderMeta();
    // A live gesture repaints the plan on every pointer move. Rebuilding the
    // side rails at that rate is wasted work, and the room panel would flicker
    // between shapes while a wall is still mid-drag.
    if (!(opts && opts.planOnly)) {
      renderList();
      renderOpeningList();
      syncInputs();
      syncDrawBar();
    }
  }
  const renderPlan = () => render({ planOnly: true });

  /* ---- The floor sheet: fill, grid, outline and wall dimensions, all drawn
       in one SVG so the grid can be clipped to a non-rectangular outline. ---- */
  function drawRoom(s) {
    const W = R.w * s, H = R.l * s;
    const x0 = R.x0 * s, y0 = R.y0 * s;
    const pts = R.poly.map(([x, y]) => `${round2(x * s)},${round2(y * s)}`).join(" ");
    sizeLayer(els.roomLayer, s);

    // Grid: scale each axis to an EVEN number of cells so a real grid line
    // falls on the room's midline. Cell size is nudged toward the nominal
    // grid unit rather than splitting a square.
    const u = U();
    const gridM = u.grid / u.perM;
    const majorMult = Math.max(1, Math.round(u.major / u.grid));
    const nx = evenCells(R.w, gridM, s);
    const ny = evenCells(R.l, gridM, s);
    const stepX = W / nx, stepY = H / ny;
    const yA = round2(y0), yB = round2(y0 + H), xA = round2(x0), xB = round2(x0 + W);
    let minor = "", major = "";
    for (let i = 1; i < nx; i++) {
      const x = round2(x0 + i * stepX);
      if (i % majorMult) minor += `M${x} ${yA}V${yB}`; else major += `M${x} ${yA}V${yB}`;
    }
    for (let j = 1; j < ny; j++) {
      const y = round2(y0 + j * stepY);
      if (j % majorMult) minor += `M${xA} ${y}H${xB}`; else major += `M${xA} ${y}H${xB}`;
    }

    els.roomLayer.innerHTML =
      `<defs><clipPath id="roomClip"><polygon points="${pts}" /></clipPath></defs>` +
      `<polygon class="room-fill" points="${pts}" />` +
      `<g clip-path="url(#roomClip)">` +
        `<path class="grid-minor" d="${minor}" />` +
        `<path class="grid-major" d="${major}" />` +
        `<line class="center-rule" x1="${round2(x0 + W / 2)}" y1="${yA}" x2="${round2(x0 + W / 2)}" y2="${yB}" />` +
        `<line class="center-rule" x1="${xA}" y1="${round2(y0 + H / 2)}" x2="${xB}" y2="${round2(y0 + H / 2)}" />` +
      `</g>` +
      `<polygon class="room-outline" points="${pts}" />` +
      dimLabels(s);
  }

  /* Wall dimension chips. A plain rectangle only needs two (width and length);
     any other outline gets one per wall, since none of them is implied. */
  function dimLabels(s) {
    const which = state.room.shape === "rect" ? [0, 3] : R.edges.map((_, i) => i);
    let out = "";
    for (const i of which) {
      const e = R.edges[i];
      if (!e || e.len * s < 26) continue;              // too short to letter
      const mx = ((e.a[0] + e.b[0]) / 2) * s - e.nx * 15;
      const my = ((e.a[1] + e.b[1]) / 2) * s - e.ny * 15;
      out += dimChip(mx, my, (e.ang * 180) / Math.PI, fmtDim(e.len),
                     wdrag && wdrag.i === i ? " live" : "");
    }
    return out;
  }

  /* One measurement chip, laid along the wall it belongs to. */
  function dimChip(x, y, deg, txt, extra = "") {
    if (deg > 90 || deg < -90) deg += 180;             // never upside down
    const w = txt.length * 7.2 + 10;
    return `<g transform="translate(${round2(x)} ${round2(y)}) rotate(${round2(deg)})">` +
           `<rect class="dim-bg${extra}" x="${round2(-w / 2)}" y="-9" width="${round2(w)}" height="18" rx="4" />` +
           `<text class="dim-text${extra}" x="0" y="0" text-anchor="middle" dominant-baseline="central">${txt}</text>` +
           `</g>`;
  }

  /* A layer is anchored on the plan origin and draws in plan pixels, so its box
     is only ever a hint — anything outside it still paints. It is sized to reach
     exactly the far edge of the frame and no further: a box that overhung the
     floor would give the stage something to scroll to. */
  function sizeLayer(layer, s) {
    const w = round2(Math.max(1, (V.ox + V.w) * s));
    const h = round2(Math.max(1, (V.oy + V.l) * s));
    layer.setAttribute("width", w);
    layer.setAttribute("height", h);
    layer.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  /* Reconcile the per-opening hit boxes, then repaint the SVG graphics. */
  function reconcileOpenings(s) {
    const seen = new Set();
    for (const o of state.openings) {
      seen.add(o.id);
      let node = els.plan.querySelector(`.opening-hit[data-id="${o.id}"]`);
      if (!node) node = createOpeningHit(o);
      positionOpeningHit(node, o, s);
    }
    els.plan.querySelectorAll(".opening-hit").forEach((n) => {
      if (!seen.has(n.dataset.id)) n.remove();
    });
    drawOpenings(s);
  }

  function createOpeningHit(o) {
    const node = document.createElement("div");
    node.className = "opening-hit";
    node.dataset.id = o.id;
    node.title = o.kind === "door" ? "Door — drag to a wall" : "Window — drag to a wall";
    node.addEventListener("pointerdown", (e) => startDragOpening(e, o, node));
    els.plan.appendChild(node);
    return node;
  }

  /* Hit boxes cover exactly what the opening draws: a door's swing fills a
     square one door-width deep on the swing side of the wall, a window is a
     thin band straddling it.

     The box is anchored on the graphic's CENTER, not a corner. An element
     rotates about its own center, so a corner anchor only lands correctly on a
     wall that happens to run left-to-right — on every other wall the box swings
     a full door-width away from the door it is supposed to catch. */
  function positionOpeningHit(node, o, s) {
    const g = openingPx(o, s);
    const w = Math.max(6, g.len);
    let depth, off;                              // off: center offset along the inward normal
    if (o.kind === "door") {
      depth = Math.max(6, openWidth(o) * s);     // swing reaches one door-width off the wall
      off = (o.out ? -1 : 1) * depth / 2;        // sits wholly on the side it swings toward
    } else {
      depth = 18;                                // grab margin either side of a window
      off = 0;
    }
    const cx = (g.A[0] + g.B[0]) / 2 + g.nx * off;
    const cy = (g.A[1] + g.B[1]) / 2 + g.ny * off;
    node.style.width = w + "px";
    node.style.height = depth + "px";
    node.style.transform =
      `translate(${round2(cx - w / 2)}px, ${round2(cy - depth / 2)}px) ` +
      `rotate(${round2((g.ang * 180) / Math.PI)}deg)`;
    node.classList.toggle("selected", o.id === selectedId);
    node.classList.toggle("locked", !!o.locked);
  }

  /* Paint all door/window graphics into the shared SVG overlay. */
  function drawOpenings(s) {
    sizeLayer(els.openingsLayer, s);
    let out = "";
    for (const o of state.openings) {
      const g = openingPx(o, s);
      if (o.kind === "window") {
        out += `<line class="win-body" x1="${round2(g.A[0])}" y1="${round2(g.A[1])}" x2="${round2(g.B[0])}" y2="${round2(g.B[1])}" />`
            +  `<line class="win-line" x1="${round2(g.A[0])}" y1="${round2(g.A[1])}" x2="${round2(g.B[0])}" y2="${round2(g.B[1])}" />`;
      } else {
        // Door: hinge H, opposite jamb J, open leaf tip L perpendicular to the
        // wall. `flip` picks the hinge jamb, `out` picks the swing side; the
        // four combinations are every orientation a wall door can have.
        const r = openWidth(o) * s;
        const dir = o.out ? -1 : 1;
        const H = o.flip ? g.B : g.A;
        const J = o.flip ? g.A : g.B;
        const L = [H[0] + g.nx * dir * r, H[1] + g.ny * dir * r];
        const cross = (J[0] - H[0]) * (L[1] - H[1]) - (J[1] - H[1]) * (L[0] - H[0]);
        const sweep = cross < 0 ? 1 : 0;
        out += `<path class="door-arc" d="M ${round2(J[0])} ${round2(J[1])} A ${round2(r)} ${round2(r)} 0 0 ${sweep} ${round2(L[0])} ${round2(L[1])}" />`
            +  `<line class="door-leaf" x1="${round2(H[0])}" y1="${round2(H[1])}" x2="${round2(L[0])}" y2="${round2(L[1])}" />`;
      }
    }
    els.openingsLayer.innerHTML = out;
  }

  /* ---- Wall and corner handles -----------------------------------------
     The outline is edited on the plan itself, in every shape mode: every wall
     is a drag strip that slides the wall along its normal, every corner is a
     handle, and each strip carries a "+" that drops a new corner into it.
     Dragging a wall of a rectangle keeps it a rectangle; moving a corner is
     what turns a template into a free outline.

     Nodes are pooled rather than rebuilt, because a drag holds on to the
     handle it started on and re-creating it mid-gesture would strand it. ---- */
  function poolNodes(cls, count, make) {
    const cur = [...els.plan.querySelectorAll("." + cls)];
    while (cur.length > count) cur.pop().remove();
    while (cur.length < count) {
      const node = make();
      els.plan.appendChild(node);
      cur.push(node);
    }
    cur.forEach((n, i) => (n.dataset.i = i));
    return cur;
  }

  /* Which way a wall moves when you pull it, as a cursor. */
  function wallCursor(ang) {
    const d = (((ang * 180) / Math.PI) % 180 + 180) % 180;
    if (d < 22.5 || d >= 157.5) return "ns-resize";
    if (d < 67.5) return "nesw-resize";
    if (d < 112.5) return "ew-resize";
    return "nwse-resize";
  }

  const WALL_HIT_PX = 15;

  function reconcileHandles(s) {
    const edges = DRAW.active ? [] : R.edges;
    const verts = DRAW.active ? [] : R.poly;

    const walls = poolNodes("wall-hit", edges.length, () => {
      const node = document.createElement("div");
      node.className = "wall-hit";
      node.innerHTML = `<span class="wall-add" title="Add a corner on this wall">+</span>`;
      node.addEventListener("pointerdown", (e) => startDragWall(e, +node.dataset.i));
      node.addEventListener("dblclick", (e) => {
        e.preventDefault();
        insertVertex(+node.dataset.i, ptM(e, planRect()));
      });
      const add = node.querySelector(".wall-add");
      add.addEventListener("pointerdown", (e) => e.stopPropagation());
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        insertVertex(+node.dataset.i);
      });
      return node;
    });
    walls.forEach((node, i) => {
      const e = edges[i];
      const len = Math.max(10, e.len * s);
      const cx = ((e.a[0] + e.b[0]) / 2) * s, cy = ((e.a[1] + e.b[1]) / 2) * s;
      const deg = (e.ang * 180) / Math.PI;
      node.style.width = round2(len) + "px";
      node.style.height = WALL_HIT_PX + "px";
      node.style.transform =
        `translate(${round2(cx - len / 2)}px, ${round2(cy - WALL_HIT_PX / 2)}px) ` +
        `rotate(${round2(deg)}deg)`;
      node.style.cursor = wallCursor(e.ang);
      node.title = `${R.names[i] || "Wall"} — ${fmtDim(e.len)}. Drag to move it, double-click to add a corner.`;
      node.classList.toggle("dragging", !!wdrag && wdrag.i === i);
      const add = node.querySelector(".wall-add");
      add.hidden = len < 52;
      add.style.transform = `translate(-50%, -50%) rotate(${round2(-deg)}deg)`;
    });

    const corners = poolNodes("vertex-hit", verts.length, () => {
      const node = document.createElement("div");
      node.className = "vertex-hit";
      node.title = "Drag to reshape · drop it on the next corner to merge them · Delete removes it";
      node.addEventListener("pointerdown", (e) => startDragVertex(e, +node.dataset.i));
      return node;
    });
    corners.forEach((node, i) => {
      const [x, y] = verts[i];
      node.style.transform = `translate(${round2(x * s - 7)}px, ${round2(y * s - 7)}px)`;
      node.classList.toggle("selected", selectedId === `vtx:${i}`);
      node.classList.toggle("dragging", !!vdrag && vdrag.i === i);
      node.classList.toggle("weld", !!vdrag && vdrag.weld === i);
    });
  }

  function createPieceNode(p) {
    const node = document.createElement("div");
    node.className = "piece";
    node.dataset.id = p.id;
    node.innerHTML =
      `<span class="c-rod" hidden></span><span class="c-doors" hidden></span>` +
      `<span class="p-lock" hidden aria-hidden="true">${ICON.lockSm}</span>` +
      `<span class="p-label"></span><span class="p-dim mono"></span>`;
    node.addEventListener("pointerdown", (e) => startDrag(e, p, node));
    els.plan.appendChild(node);
    return node;
  }

  function positionPiece(node, p, s) {
    const fp = footprint(p);
    const w = fp.w * s, h = fp.d * s;
    node.style.transform = `translate(${round2(p.x * s)}px, ${round2(p.y * s)}px)`;
    node.style.width = w + "px";
    node.style.height = h + "px";
    node.style.background = p.color;
    node.style.color = textOn(p.color);
    node.classList.toggle("selected", p.id === selectedId);
    node.classList.toggle("tiny", Math.min(w, h) < 48);
    node.classList.toggle("closet", p.type === "closet");
    node.classList.toggle("locked", !!p.locked);
    node.querySelector(".p-lock").hidden = !p.locked;
    const out = pieceOutside(p);
    node.classList.toggle("outside", out);
    node.title = out ? "This piece sticks outside the room outline" : "";
    node.querySelector(".p-label").textContent = p.label;
    node.querySelector(".p-dim").textContent = `${fmt(p.w)}×${fmt(p.d)}`;
    dressCloset(node, p, w, h);
  }

  /* A closet reads as an alcove: door leaves drawn on the front edge, a hanging
     rod parallel to the back. Rotating the piece moves the doors to the next
     side, which is how you point a closet at the room it opens into. */
  const CLOSET_SIDES = ["bottom", "left", "top", "right"];
  function dressCloset(node, p, w, h) {
    const rod = node.querySelector(".c-rod");
    const doors = node.querySelector(".c-doors");
    if (p.type !== "closet") { rod.hidden = true; doors.hidden = true; return; }
    rod.hidden = false; doors.hidden = false;

    // rot 0 puts the doors on the bottom edge; each 90° turn moves them round.
    const front = CLOSET_SIDES[(((p.rot / 90) | 0) % 4 + 4) % 4];
    const vertical = front === "left" || front === "right";
    const depth = vertical ? w : h;                       // front-to-back depth, px
    const inset = Math.max(4, Math.min(14, depth * 0.3));

    const reset = { top: "", right: "", bottom: "", left: "",
                    width: "", height: "", borderTop: "", borderLeft: "" };
    Object.assign(doors.style, reset);
    Object.assign(rod.style, reset);

    if (vertical) {
      doors.style.top = "0"; doors.style.bottom = "0"; doors.style.width = "3px";
      rod.style.top = "12%"; rod.style.bottom = "12%"; rod.style.width = "0";
      rod.style.borderLeft = "1px dashed currentColor";
    } else {
      doors.style.left = "0"; doors.style.right = "0"; doors.style.height = "3px";
      rod.style.left = "12%"; rod.style.right = "12%"; rod.style.height = "0";
      rod.style.borderTop = "1px dashed currentColor";
    }
    doors.style[front] = "0";
    rod.style[front] = inset + "px";                      // sits back from the doors
  }

  function renderMeta() {
    // Report area in the system's large unit: ft² for imperial, m² for metric.
    els.roomArea.textContent = U().metric
      ? `${(Math.round(R.area * 10) / 10)} m²`
      : `${Math.round(R.area / (M_PER_FT * M_PER_FT))} ft²`;
    const n = state.pieces.length;
    els.pieceCount.textContent = `${n} ${n === 1 ? "piece" : "pieces"}`;
    els.clearAll.hidden = n === 0;
    if (els.pointCount) {
      const c = R.poly.length;
      els.pointCount.textContent = `${c} corner${c === 1 ? "" : "s"}`;
    }
  }

  function renderList() {
    els.pieceList.innerHTML = "";
    els.emptyPieces.style.display = state.pieces.length ? "none" : "block";
    els.orderHint.hidden = state.pieces.length < 2;
    // Shown front-most first, like a layers panel — the reverse of paint order.
    for (const p of state.pieces.slice().reverse()) {
      const li = document.createElement("li");
      li.className = "piece-item" + (p.id === selectedId ? " selected" : "")
                                  + (p.locked ? " locked" : "");
      li.dataset.id = p.id;
      const lockBtn =
        `<button class="mini-btn act-lock${p.locked ? " active" : ""}" title="${
          p.locked ? "Locked — click to unlock (L)" : "Lock in place so clicks pass through it (L)"
        }" aria-pressed="${p.locked}" aria-label="${p.locked ? "Unlock" : "Lock"} ${escapeAttr(p.label)}">${
          p.locked ? ICON.lock : ICON.unlock}</button>`;
      li.innerHTML = `
        <button type="button" class="drag-handle" title="Drag to reorder, or use the arrow keys. With a piece selected: [ and ] to step, { and } to send fully back or front." aria-label="Reorder ${escapeAttr(p.label)}">${ICON.grip}</button>
        <input type="color" class="swatch" value="${p.color}" title="Change color" aria-label="Color for ${escapeAttr(p.label)}" />
        <div class="piece-main">
          <div class="piece-label-row">
            <input class="piece-label-input" value="${escapeAttr(p.label)}" maxlength="24" aria-label="Label" />
            ${p.type === "closet" ? `<span class="p-tag" title="Closet — rotate to move its doors">${ICON.closet}</span>` : ""}
          </div>
          <div class="piece-dims">
            <input type="number" class="edit-w mono" min="0.1" step="any" value="${fmt(p.w)}" aria-label="Width" />
            <span>×</span>
            <input type="number" class="edit-d mono" min="0.1" step="any" value="${fmt(p.d)}" aria-label="Depth" />
            <span>${unitLabel()}</span>
          </div>
        </div>
        <div class="piece-actions">
          ${lockBtn}
          <button class="mini-btn act-rotate" title="${p.type === "closet" ? "Rotate 90° — moves the doors to the next side (R)" : "Rotate 90° (R)"}" aria-label="Rotate"${p.locked ? " disabled" : ""}>${ICON.rotate}</button>
          <button class="mini-btn act-dupe" title="Duplicate (D)" aria-label="Duplicate">${ICON.copy}</button>
          <button class="mini-btn danger act-del" title="Remove" aria-label="Remove"${p.locked ? " disabled" : ""}>${ICON.trash}</button>
        </div>`;

      li.querySelector(".swatch").addEventListener("input", (e) => {
        p.color = e.target.value;
        const node = els.plan.querySelector(`.piece[data-id="${p.id}"]`);
        if (node) { node.style.background = p.color; node.style.color = textOn(p.color); }
        save();
      });
      li.querySelector(".piece-label-input").addEventListener("input", (e) => {
        p.label = e.target.value; save();
        const node = els.plan.querySelector(`.piece[data-id="${p.id}"] .p-label`);
        if (node) node.textContent = p.label;
      });
      li.querySelector(".edit-w").addEventListener("change", (e) => {
        p.w = Math.max(0.01, toMeters(parseFloat(e.target.value) || 0));
        clampPiece(p); save(); render();
      });
      li.querySelector(".edit-d").addEventListener("change", (e) => {
        p.d = Math.max(0.01, toMeters(parseFloat(e.target.value) || 0));
        clampPiece(p); save(); render();
      });
      const handle = li.querySelector(".drag-handle");
      handle.addEventListener("pointerdown", (e) => startListDrag(e, li));
      handle.addEventListener("keydown", (e) => {
        // Up in the list is toward the front, i.e. later in the paint order.
        const delta = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
        if (!delta) return;
        e.preventDefault();
        if (movePiece(p, delta)) {
          els.pieceList
            .querySelector(`.piece-item[data-id="${p.id}"] .drag-handle`)
            ?.focus();
        }
      });
      li.querySelector(".act-lock").addEventListener("click", () => toggleLock(p));
      li.querySelector(".act-rotate").addEventListener("click", () => rotatePiece(p));
      li.querySelector(".act-dupe").addEventListener("click", () => duplicatePiece(p));
      li.querySelector(".act-del").addEventListener("click", () => removePiece(p.id));
      li.addEventListener("click", (e) => {
        if (e.target.closest("button, input")) return;
        if (performance.now() - ldragEndedAt < 300) return;  // tail of a reorder
        select(p.id);
      });
      els.pieceList.appendChild(li);
    }
  }

  const ICON = {
    grip: `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`,
    door: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 21h16M7 21V4h8v17M13 12v.01"/><path d="M15 4a5 5 0 0 1 5 5v12" stroke-opacity="0.5"/></svg>`,
    window: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M4 12h16"/></svg>`,
    closet: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M12 4v16M9.5 12h.01M14.5 12h.01"/></svg>`,
    rotate: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v4h-4"/></svg>`,
    flip: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v18M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg>`,
    swing: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 3v18"/><path d="M7 8a10 10 0 0 1 10 10"/><path d="M17 14v4h-4"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13h10l1-13"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
    // Closed shackle = locked, open shackle = the click that will lock it.
    lock: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>`,
    unlock: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.6-1.6"/></svg>`,
    lockSm: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>`,
  };

  function renderOpeningList() {
    els.openingList.innerHTML = "";
    els.emptyOpenings.style.display = state.openings.length ? "none" : "block";
    for (const o of state.openings) {
      const li = document.createElement("li");
      li.className = "opening-item" + (o.id === selectedId ? " selected" : "")
                                    + (o.locked ? " locked" : "");
      li.dataset.id = o.id;
      const wallName = R.names[o.edge] || "wall";
      const swing = o.kind === "door" && o.out ? " · out" : "";   // "in" is the default, so it goes unsaid
      const dis = o.locked ? " disabled" : "";
      const doorBtns = o.kind === "door"
        ? `<button class="mini-btn act-rot" title="Rotate — steps through all four hinge / swing positions (R)" aria-label="Rotate door"${dis}>${ICON.rotate}</button>`
          + `<button class="mini-btn act-flip" title="Flip the hinge to the other jamb (F)" aria-label="Flip hinge"${dis}>${ICON.flip}</button>`
          + `<button class="mini-btn act-swing${o.out ? " active" : ""}" title="${o.out ? "Swinging outward — click for inward (O)" : "Swinging inward — click for outward (O)"}" aria-label="Toggle swing direction"${dis}>${ICON.swing}</button>`
        : "";
      const lockBtn =
        `<button class="mini-btn act-oplock${o.locked ? " active" : ""}" title="${
          o.locked ? "Locked — click to unlock (L)" : "Lock to this wall so clicks pass through it (L)"
        }" aria-pressed="${o.locked}" aria-label="${o.locked ? "Unlock" : "Lock"} ${o.kind}">${
          o.locked ? ICON.lock : ICON.unlock}</button>`;
      li.innerHTML = `
        <span class="op-icon">${ICON[o.kind]}</span>
        <div class="op-main">
          <div class="op-kind">${o.kind === "door" ? "Door" : "Window"} <span class="op-wall">· ${escapeAttr(wallName)}${swing}</span></div>
          <div class="op-dims">
            <input type="number" class="op-w mono" min="0.1" step="any" value="${fmt(o.width)}" aria-label="Width" />
            <span>${unitLabel()} wide</span>
          </div>
        </div>
        <div class="op-actions">
          ${lockBtn}
          ${doorBtns}
          <button class="mini-btn danger act-opdel" title="Remove" aria-label="Remove"${dis}>${ICON.trash}</button>
        </div>`;
      li.querySelector(".op-w").addEventListener("change", (e) => {
        o.width = Math.max(0.05, toMeters(parseFloat(e.target.value) || 0));
        clampOpening(o); save(); render();
      });
      li.querySelector(".act-oplock").addEventListener("click", () => toggleLock(o));
      li.querySelector(".act-rot")?.addEventListener("click", () => rotateOpening(o));
      li.querySelector(".act-flip")?.addEventListener("click", () => flipOpening(o));
      li.querySelector(".act-swing")?.addEventListener("click", () => toggleSwing(o));
      li.querySelector(".act-opdel").addEventListener("click", () => removeOpening(o.id));
      li.addEventListener("click", (e) => {
        if (e.target.closest("button, input")) return;
        select(o.id);
      });
      els.openingList.appendChild(li);
    }
  }

  function syncInputs() {
    const rm = state.room;
    if (document.activeElement !== els.roomW) els.roomW.value = fmt(rm.w);
    if (document.activeElement !== els.roomL) els.roomL.value = fmt(rm.l);
    // A room that is still a plain rectangle can be typed in; once it isn't,
    // the numbers give way to the corner count and the way back.
    els.rectFields.hidden = rm.shape !== "rect" || DRAW.active;
    els.customFields.hidden = rm.shape === "rect" || DRAW.active;
    els.drawOutline.classList.toggle("is-active", DRAW.active);
    els.typeToggle.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.type === addType));
    els.snapToggle.checked = state.snap;
    els.unitLabels.forEach((n) => (n.textContent = unitLabel()));
    els.unitBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.unit === state.unit));
  }

  /* ================= Piece operations ================= */
  function addPiece(label, wDisp, dDisp, type) {
    const w = toMeters(wDisp), d = toMeters(dDisp);
    const kind = type === "closet" ? "closet" : "furniture";
    // Cascade new pieces so they don't stack exactly
    const off = toMeters(unitStep()) * (state.pieces.length % 8) * 2;
    const p = {
      id: uid(), type: kind, label: label || (kind === "closet" ? "Closet" : "Piece"),
      w, d, rot: 0, color: kind === "closet" ? CLOSET_COLOR : nextColor(),
      x: snapVal(Math.min(off, Math.max(0, R.w - w))),
      y: snapVal(Math.min(off, Math.max(0, R.l - d))),
      locked: false,
    };
    clampPiece(p);
    state.pieces.push(p);
    selectedId = p.id;
    save(); render();
    return p;
  }
  function rotatePiece(p) {
    if (p.locked) return;
    p.rot = (p.rot + 90) % 360;
    clampPiece(p); save(); render();
  }
  /* Locking takes a piece or an opening out of play on the plan: clicks fall
     straight through to whatever sits behind it, and nothing can move, rotate
     or delete it until it is unlocked. It stays selectable from the rails. */
  function toggleLock(item) {
    item.locked = !item.locked;
    save(); render();
  }
  function duplicatePiece(src) {
    // The copy is the one you are about to place, so it never inherits the lock.
    const p = { ...src, id: uid(), label: src.label, locked: false,
      x: src.x + toMeters(unitStep()) * 2, y: src.y + toMeters(unitStep()) * 2 };
    clampPiece(p);
    state.pieces.push(p);
    selectedId = p.id;
    save(); render();
  }
  /* Shift a piece through the paint order. delta > 0 moves it toward the
     front (drawn on top), delta < 0 toward the back. */
  function movePiece(p, delta) {
    const i = state.pieces.indexOf(p);
    if (i < 0) return false;
    const j = Math.max(0, Math.min(state.pieces.length - 1, i + delta));
    if (i === j) return false;
    state.pieces.splice(i, 1);
    state.pieces.splice(j, 0, p);
    save(); render();
    return true;
  }
  function removePiece(id) {
    const p = state.pieces.find((x) => x.id === id);
    if (!p || p.locked) return;
    state.pieces = state.pieces.filter((x) => x.id !== id);
    if (selectedId === id) selectedId = null;
    save(); render();
  }
  function select(id) {
    selectedId = selectedId === id ? null : id;
    render();
  }

  /* ================= Opening operations ================= */
  function addOpening(kind) {
    const width = kind === "door" ? DOOR_W_M : WINDOW_W_M;
    const o = { id: uid(), kind, edge: 0, width, pos: 0, flip: false, out: false, locked: false };
    const e = R.edges[0];
    o.width = Math.min(width, e.len);
    o.pos = Math.max(0, e.len / 2 - o.width / 2);       // centered on the first wall
    clampOpening(o);
    state.openings.push(o);
    selectedId = o.id;
    save(); render();
    return o;
  }
  /* Step through every orientation a wall door can take: hinge left/right
     crossed with swinging in/out. */
  function rotateOpening(o) {
    if (o.kind !== "door" || o.locked) return;
    const i = DOOR_STATES.findIndex((d) => d.flip === !!o.flip && d.out === !!o.out);
    const next = DOOR_STATES[(i + 1) % DOOR_STATES.length];
    o.flip = next.flip; o.out = next.out;
    save(); render();
  }
  function flipOpening(o) { if (o.locked) return; o.flip = !o.flip; save(); render(); }
  function toggleSwing(o) { if (o.locked) return; o.out = !o.out; save(); render(); }
  function removeOpening(id) {
    const o = state.openings.find((x) => x.id === id);
    if (!o || o.locked) return;
    state.openings = state.openings.filter((x) => x.id !== id);
    if (selectedId === id) selectedId = null;
    save(); render();
  }

  /* ================= Room shape operations ================= */
  function resetPoly() {
    cancelDrawing();
    state.room.shape = "rect";
    state.room.poly = null;
    selectedId = null;
    rebuildRoom(); save(); render();
  }

  /* ---- Committing an edited outline -------------------------------------
     Every direct edit — a wall pushed, a corner dragged, an outline drawn —
     lands here. It refuses a polygon that is no longer a room, and once the
     gesture is over it re-origins the outline so its bounding box starts at
     (0,0) again, carrying the furniture along so pieces stay put against the
     walls they were sitting on. Mid-gesture it deliberately does NOT re-origin:
     the plan would then slide out from under the pointer every time a wall
     crossed the top or left edge.

     Returns the offset it applied, or false if the outline was rejected. ---- */
  function applyOutline(poly, gesture) {
    const melt = gesture && gesture.weld >= 0 ? gesture.i : -1;
    if (!polyValid(poly, melt)) return false;
    let dx = 0, dy = 0;
    if (gesture) {
      // Pieces are re-derived from where they were when the drag began, so
      // squeezing the room and opening it up again puts them back.
      for (const [pc, x0, y0] of gesture.pieces0) { pc.x = x0; pc.y = y0; }
    } else {
      const bb = polyBBox(poly);
      dx = bb.x0; dy = bb.y0;
      if (dx || dy) {
        poly = poly.map(([x, y]) => [x - dx, y - dy]);
        for (const pc of state.pieces) { pc.x -= dx; pc.y -= dy; }
      }
      if (polyArea(poly) < 0) poly.reverse();   // keep the screen-clockwise winding
    }
    state.room.shape = "custom";
    state.room.poly = poly;
    if (!gesture) simplifyShape();
    rebuildRoom();
    return { dx, dy };
  }

  /* An outline that is exactly what a template would generate goes back to
     being that template, so the width/length fields keep working after you
     drag a wall of a plain rectangle. The comparison is vertex-for-vertex in
     order: any other match would renumber the walls under the doors already
     hung on them. */
  function simplifyShape() {
    const poly = state.room.poly;
    if (!poly) return;
    const bb = polyBBox(poly);
    const w = bb.w, l = bb.l;
    const same = (a, b) => a.length === b.length &&
      a.every((q, i) => Math.abs(q[0] - b[i][0]) < 1e-4 && Math.abs(q[1] - b[i][1]) < 1e-4);
    if (poly.length !== 4) return;
    if (!same(buildPolyFrom({ shape: "rect", w, l }), poly)) return;
    state.room.shape = "rect";
    state.room.w = w; state.room.l = l;
    state.room.poly = null;
  }

  /* ---- Keeping doors and windows on the right wall ----------------------
     Openings are stored as "wall index + offset along it", so any edit that
     adds, drops or reorders walls has to re-home them. Their positions on the
     plan are the thing worth preserving, so they are recorded before the edit
     and re-attached to whatever wall ends up nearest afterwards. */
  function openingCenters() {
    return state.openings.map((o) => {
      const e = edgeOf(o);
      const t = o.pos + openWidth(o) / 2;
      return { o, x: e.a[0] + e.ux * t, y: e.a[1] + e.uy * t };
    });
  }
  function reattachOpenings(list, dx = 0, dy = 0) {
    for (const { o, x, y } of list) {
      const hit = nearestEdge(x - dx, y - dy);
      o.edge = hit.index;
      o.pos = hit.along - openWidth(o) / 2;
      clampOpening(o);
    }
  }

  /* Split a wall in two. Without a point it splits at the midpoint, which is
     what the "+" on the wall does. */
  function insertVertex(edgeIndex, at) {
    const e = R.edges[edgeIndex];
    if (!e) return;
    const pt = at || [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    const poly = clonePoly(R.poly);
    poly.splice(edgeIndex + 1, 0, [snapVal(pt[0]), snapVal(pt[1])]);
    const centers = openingCenters();
    const off = applyOutline(poly, null);
    if (!off) return;
    reattachOpenings(centers, off.dx, off.dy);
    selectedId = `vtx:${edgeIndex + 1}`;
    save(); render();
  }
  function removeVertex(i) {
    if (R.poly.length <= 3) return;
    const poly = clonePoly(R.poly);
    poly.splice(i, 1);
    const centers = openingCenters();
    const off = applyOutline(poly, null);
    if (!off) return;
    reattachOpenings(centers, off.dx, off.dy);
    selectedId = null;
    save(); render();
  }

  /* ---- Undo for a single gesture: enough state to put the room back the way
       it was if a drag is abandoned with Escape, or ends somewhere illegal. */
  function snapshotOutline() {
    return {
      room: JSON.parse(JSON.stringify(state.room)),
      pieces: state.pieces.map((p) => [p.id, p.x, p.y]),
      openings: state.openings.map((o) => [o.id, o.edge, o.pos, o.width]),
    };
  }
  function restoreOutline(snap) {
    state.room = snap.room;
    const at = new Map(snap.pieces.map(([id, x, y]) => [id, [x, y]]));
    for (const p of state.pieces) {
      const q = at.get(p.id);
      if (q) { p.x = q[0]; p.y = q[1]; }
    }
    const op = new Map(snap.openings.map(([id, edge, pos, width]) => [id, [edge, pos, width]]));
    for (const o of state.openings) {
      const q = op.get(o.id);
      if (q) { o.edge = q[0]; o.pos = q[1]; o.width = q[2]; }
    }
    rebuildRoom();
  }

  /* ================= Drawing an outline from scratch =================
     A sketch mode: click corners onto the grid and the walls follow, with the
     first corner acting as the target that closes the loop. Nothing is
     committed until the ring closes, so the room on screen stays untouched
     underneath as a tracing reference. */
  const DRAW = { active: false, blank: false, pts: [], hover: null, close: false, undo: null, msg: "" };
  const CLOSE_PX = 15;      // how near the first corner counts as "closing"

  function startDrawing(blank) {
    if (DRAW.active) return;
    endOutlineDrag(true);
    DRAW.active = true;
    DRAW.blank = !!blank;      // first visit: nothing to trace over yet
    DRAW.pts = []; DRAW.hover = null; DRAW.close = false; DRAW.msg = "";
    DRAW.undo = snapshotOutline();
    selectedId = null;
    render();
  }
  function cancelDrawing() {
    if (!DRAW.active) return;
    DRAW.active = false;
    DRAW.pts = []; DRAW.hover = null; DRAW.close = false; DRAW.msg = "";
    render();
  }
  function undoDrawPoint() {
    if (!DRAW.active || !DRAW.pts.length) return;
    DRAW.pts.pop();
    DRAW.msg = "";
    render();
  }
  function finishDrawing() {
    if (!DRAW.active) return;
    if (DRAW.pts.length < 3) {
      DRAW.msg = "A room needs at least three corners.";
      syncDrawBar();
      return;
    }
    const centers = openingCenters();
    const off = applyOutline(clonePoly(DRAW.pts), null);
    if (!off) {
      DRAW.msg = "Those walls cross or double back — undo the last corner and try again.";
      syncDrawBar();
      return;
    }
    reattachOpenings(centers, off.dx, off.dy);
    DRAW.active = false;
    DRAW.pts = []; DRAW.hover = null; DRAW.close = false; DRAW.msg = "";
    selectedId = null;
    save(); render();
  }

  /* Where the pointer wants to drop a corner: on the grid, squared up to the
     previous wall when it is nearly square already (hold Shift for a free
     angle), and pulled onto the first corner once the ring can close. */
  function sketchPoint(e) {
    let [x, y] = ptM(e, planRect());
    DRAW.close = false;
    const first = DRAW.pts[0];
    if (DRAW.pts.length >= 3 &&
        Math.hypot(x - first[0], y - first[1]) * baseScale < CLOSE_PX) {
      DRAW.close = true;
      return [first[0], first[1]];
    }
    x = snapVal(x); y = snapVal(y);
    const last = DRAW.pts[DRAW.pts.length - 1];
    if (last && !e.shiftKey) {
      const dx = Math.abs(x - last[0]), dy = Math.abs(y - last[1]);
      if (dx > dy * 3.5) y = last[1];
      else if (dy > dx * 3.5) x = last[0];
    }
    return [x, y];
  }

  function addSketchPoint(e) {
    const pt = sketchPoint(e);
    DRAW.hover = pt;
    if (DRAW.close) { finishDrawing(); return; }
    const last = DRAW.pts[DRAW.pts.length - 1];
    // Ignore a second click on the corner just dropped.
    if (last && Math.hypot(last[0] - pt[0], last[1] - pt[1]) * baseScale < 4) return;
    DRAW.pts.push(pt);
    DRAW.msg = "";
    render();
  }

  /* The sketch sheet: grid across the whole stage, the room being replaced
     left in as a faint tracing guide, and the walls drawn so far with their
     lengths called out as they are laid down. */
  function drawSketch(s) {
    sizeLayer(els.roomLayer, s);
    const u = U();
    const gridM = u.grid / u.perM;
    const majorMult = Math.max(1, Math.round(u.major / u.grid));
    const x0 = V.ox * s, y0 = V.oy * s, x1 = (V.ox + V.w) * s, y1 = (V.oy + V.l) * s;
    let minor = "", major = "";
    if (gridM * s >= 6) {
      for (let i = Math.ceil(V.ox / gridM); i <= Math.floor((V.ox + V.w) / gridM); i++) {
        const x = round2(i * gridM * s);
        const d = `M${x} ${round2(y0)}V${round2(y1)}`;
        if (i % majorMult) minor += d; else major += d;
      }
      for (let j = Math.ceil(V.oy / gridM); j <= Math.floor((V.oy + V.l) / gridM); j++) {
        const y = round2(j * gridM * s);
        const d = `M${round2(x0)} ${y}H${round2(x1)}`;
        if (j % majorMult) minor += d; else major += d;
      }
    }

    const at = ([x, y]) => `${round2(x * s)},${round2(y * s)}`;
    const pts = DRAW.pts;
    let out =
      `<rect class="sketch-bg" x="${round2(x0)}" y="${round2(y0)}" ` +
      `width="${round2(x1 - x0)}" height="${round2(y1 - y0)}" />` +
      `<path class="grid-minor" d="${minor}" />` +
      `<path class="grid-major" d="${major}" />` +
      (DRAW.blank ? "" : `<polygon class="sketch-ghost" points="${R.poly.map(at).join(" ")}" />`);

    if (pts.length) {
      const hover = DRAW.hover;
      const ring = hover && !DRAW.close ? pts.concat([hover]) : pts;
      if (ring.length >= 3) {
        out += `<polygon class="sketch-fill${DRAW.close ? " armed" : ""}" points="${ring.map(at).join(" ")}" />`;
      }
      out += `<path class="sketch-line" d="M${pts.map((q) => `${round2(q[0] * s)} ${round2(q[1] * s)}`).join("L")}" />`;
      const last = pts[pts.length - 1];
      if (hover) {
        out += `<path class="sketch-band${DRAW.close ? " closing" : ""}" ` +
               `d="M${round2(last[0] * s)} ${round2(last[1] * s)}` +
               `L${round2(hover[0] * s)} ${round2(hover[1] * s)}" />`;
      }
      // Lengths: every wall laid down, plus the one being dragged out now.
      const segs = pts.slice(1).map((q, i) => [pts[i], q]);
      if (hover && !DRAW.close) segs.push([last, hover]);
      if (DRAW.close) segs.push([last, pts[0]]);
      for (const [a, b] of segs) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len * s < 26) continue;
        out += dimChip(((a[0] + b[0]) / 2) * s + (dy / len) * 15,
                       ((a[1] + b[1]) / 2) * s - (dx / len) * 15,
                       (Math.atan2(dy, dx) * 180) / Math.PI, fmtDim(len), " live");
      }
      pts.forEach((q, i) => {
        const cls = i === 0 ? `sketch-dot start${DRAW.close ? " armed" : ""}` : "sketch-dot";
        out += `<circle class="${cls}" cx="${round2(q[0] * s)}" cy="${round2(q[1] * s)}" r="${i === 0 ? 7 : 4}" />`;
      });
    } else if (DRAW.hover) {
      out += `<circle class="sketch-dot" cx="${round2(DRAW.hover[0] * s)}" cy="${round2(DRAW.hover[1] * s)}" r="4" />`;
    }
    els.roomLayer.innerHTML = out;
  }

  function syncDrawBar() {
    els.drawBar.hidden = !DRAW.active;
    if (!DRAW.active) return;
    const n = DRAW.pts.length;
    els.drawMsg.textContent = DRAW.msg || (
      n === 0 ? (DRAW.blank
        ? "Start with your room: click a corner, then walk around the walls."
        : "Click to drop the first corner.")
      : n < 3 ? "Keep clicking corners — walls square up on their own, hold Shift for a free angle."
      : "Click the first corner again to close the room, or press Enter.");
    els.drawCancel.textContent = DRAW.blank ? "Skip" : "Cancel";
    els.drawMsg.classList.toggle("warn", !!DRAW.msg);
    els.drawUndo.disabled = n === 0;
    els.drawFinish.disabled = n < 3;
  }

  /* ================= Dragging ================= */
  let drag = null;
  function startDrag(e, p, node) {
    if (e.button != null && e.button !== 0) return;
    if (p.locked) return;          // CSS already lets the click through; belt and braces
    e.preventDefault();
    select(p.id);
    if (selectedId !== p.id) selectedId = p.id; // ensure selected after toggle
    node.classList.add("dragging");
    node.setPointerCapture(e.pointerId);
    const rect = planRect();
    drag = {
      p, node, pointerId: e.pointerId,
      // offset between pointer and piece origin, in meters
      dx: (e.clientX - rect.left) / baseScale - p.x,
      dy: (e.clientY - rect.top) / baseScale - p.y,
      rect,
    };
    node.addEventListener("pointermove", onDrag);
    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);
  }
  function onDrag(e) {
    if (!drag) return;
    const rect = drag.rect;
    let x = (e.clientX - rect.left) / baseScale - drag.dx;
    let y = (e.clientY - rect.top) / baseScale - drag.dy;
    drag.p.x = snapVal(x);
    drag.p.y = snapVal(y);
    clampPiece(drag.p);
    positionPiece(drag.node, drag.p, baseScale);
  }
  function endDrag(e) {
    if (!drag) return;
    drag.node.classList.remove("dragging");
    try { drag.node.releasePointerCapture(drag.pointerId); } catch (_) {}
    drag.node.removeEventListener("pointermove", onDrag);
    drag.node.removeEventListener("pointerup", endDrag);
    drag.node.removeEventListener("pointercancel", endDrag);
    drag = null;
    save();
  }

  /* ---- Reordering the piece list. The dragged row is moved through the DOM
       live as the pointer passes its neighbours' midpoints, then the resulting
       order is written back to state on release. ---- */
  let ldrag = null;
  let ldragEndedAt = -Infinity;
  function startListDrag(e, li) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    ldrag = { li, pointerId: e.pointerId };
    li.classList.add("reordering");
    els.pieceList.classList.add("is-reordering");
    // Listen on the window rather than capturing the pointer: re-inserting the
    // dragged row into the DOM would release a capture held on it, and the
    // rest of the gesture would then be delivered somewhere else entirely.
    window.addEventListener("pointermove", onListDrag);
    window.addEventListener("pointerup", endListDrag);
    window.addEventListener("pointercancel", endListDrag);
  }
  function onListDrag(e) {
    if (!ldrag || e.pointerId !== ldrag.pointerId) return;
    e.preventDefault();
    const list = els.pieceList;
    // Nudge the list when dragging against either edge of its scroll area.
    const lr = list.getBoundingClientRect();
    if (e.clientY < lr.top + 28) list.scrollTop -= 8;
    else if (e.clientY > lr.bottom - 28) list.scrollTop += 8;

    const dragged = ldrag.li;
    for (const other of list.querySelectorAll(".piece-item")) {
      if (other === dragged) continue;
      const r = other.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const otherIsAbove = !!(dragged.compareDocumentPosition(other) &
                              Node.DOCUMENT_POSITION_PRECEDING);
      if (otherIsAbove && e.clientY < mid) { list.insertBefore(dragged, other); break; }
      if (!otherIsAbove && e.clientY > mid) { list.insertBefore(dragged, other.nextSibling); break; }
    }
  }
  function endListDrag(e) {
    if (!ldrag || (e && e.pointerId !== ldrag.pointerId)) return;
    window.removeEventListener("pointermove", onListDrag);
    window.removeEventListener("pointerup", endListDrag);
    window.removeEventListener("pointercancel", endListDrag);
    ldrag.li.classList.remove("reordering");
    els.pieceList.classList.remove("is-reordering");
    ldrag = null;
    ldragEndedAt = performance.now();   // swallow the click this gesture trails
    commitListOrder();
  }
  function commitListOrder() {
    const byId = new Map(state.pieces.map((p) => [p.id, p]));
    const next = [...els.pieceList.querySelectorAll(".piece-item")]
      .map((n) => byId.get(n.dataset.id))
      .filter(Boolean)
      .reverse();                          // list is front-first, state is back-first
    if (next.length !== state.pieces.length) { render(); return; }  // lost a row somehow
    const changed = next.some((p, i) => p !== state.pieces[i]);
    state.pieces = next;
    if (changed) save();
    render();
  }

  /* ---- Dragging an opening: it slides along its wall and hops to whichever
       wall is nearest, so you can drag a door around the whole outline. ---- */
  let odrag = null;
  function startDragOpening(e, o, node) {
    if (e.button != null && e.button !== 0) return;
    if (o.locked) return;
    e.preventDefault();
    e.stopPropagation();
    selectedId = o.id;
    node.classList.add("dragging");
    node.setPointerCapture(e.pointerId);
    odrag = { o, node, pointerId: e.pointerId, rect: planRect() };
    render(); // reflect selection in the lists/outline
    node.addEventListener("pointermove", onDragOpening);
    node.addEventListener("pointerup", endDragOpening);
    node.addEventListener("pointercancel", endDragOpening);
  }
  /* Nearest wall to a point, plus how far along that wall the foot lands. */
  function nearestEdge(px, py) {
    let best = { index: 0, along: 0, dist: Infinity };
    R.edges.forEach((e, i) => {
      const t = Math.max(0, Math.min(e.len, (px - e.a[0]) * e.ux + (py - e.a[1]) * e.uy));
      const d = Math.hypot(px - (e.a[0] + e.ux * t), py - (e.a[1] + e.uy * t));
      if (d < best.dist) best = { index: i, along: t, dist: d };
    });
    return best;
  }
  function onDragOpening(e) {
    if (!odrag) return;
    const { o, rect } = odrag;
    const px = (e.clientX - rect.left) / baseScale;    // pointer in room meters
    const py = (e.clientY - rect.top) / baseScale;
    const hit = nearestEdge(px, py);
    o.edge = hit.index;
    o.pos = snapVal(hit.along - openWidth(o) / 2);
    clampOpening(o);
    drawOpenings(baseScale);
    positionOpeningHit(odrag.node, o, baseScale);
  }
  function endDragOpening(e) {
    if (!odrag) return;
    odrag.node.classList.remove("dragging");
    try { odrag.node.releasePointerCapture(odrag.pointerId); } catch (_) {}
    odrag.node.removeEventListener("pointermove", onDragOpening);
    odrag.node.removeEventListener("pointerup", endDragOpening);
    odrag.node.removeEventListener("pointercancel", endDragOpening);
    odrag = null;
    save(); render();
  }

  /* ---- Reshaping the room by hand ---------------------------------------
     Wall drags and corner drags share one shape: freeze the view so the sheet
     can't move under the pointer, work from a copy of the outline taken when
     the gesture started (so every pointer move recomputes from scratch instead
     of accumulating drift), refuse anything that isn't a room any more, and
     re-origin once on release.

     Both listen on the window rather than capturing the pointer: the handles
     are pooled and can be re-positioned mid-drag, and a capture held on a node
     that gets touched would strand the rest of the gesture. ---- */
  let wdrag = null, vdrag = null;

  function beginOutlineGesture(e) {
    freezeView();
    renderPlan();                       // apply the frozen frame before measuring
    return {
      pointerId: e.pointerId,
      rect: planRect(),
      poly: clonePoly(R.poly),
      pieces0: state.pieces.map((p) => [p, p.x, p.y]),
      undo: snapshotOutline(),
      weld: -1,
      moved: false,
    };
  }
  function outlineListeners(on, move, up) {
    const fn = on ? window.addEventListener : window.removeEventListener;
    fn.call(window, "pointermove", move);
    fn.call(window, "pointerup", up);
    fn.call(window, "pointercancel", up);
  }
  /* Settle whatever was being dragged. `abort` puts the room back. */
  function endOutlineDrag(abort) {
    const g = wdrag || vdrag;
    if (!g) return false;
    if (wdrag) outlineListeners(false, onDragWall, endDragWall);
    else outlineListeners(false, onDragVertex, endDragVertex);
    const welding = !!vdrag && g.weld >= 0 && g.moved && R.poly.length > 3;
    wdrag = null; vdrag = null; frozenView = null;
    if (abort || !g.moved) {
      restoreOutline(g.undo);
    } else {
      let poly = clonePoly(R.poly);
      let centers = null;
      if (welding) {
        centers = openingCenters();
        poly.splice(g.i, 1);            // the two corners become one
      }
      const off = applyOutline(poly, null);
      if (!off) restoreOutline(g.undo);
      else if (centers) reattachOpenings(centers, off.dx, off.dy);
      save();
    }
    if (g.weld >= 0) selectedId = null;
    render();
    return true;
  }

  /* ---- Pushing a wall ---- */
  function startDragWall(e, i) {
    if (e.button != null && e.button !== 0) return;
    if (DRAW.active || wdrag || vdrag) return;
    const edge = R.edges[i];
    if (!edge) return;
    e.preventDefault();
    e.stopPropagation();
    selectedId = null;
    const g = beginOutlineGesture(e);
    g.i = i;
    g.nx = edge.nx; g.ny = edge.ny;
    // The wall's own distance from the origin along its normal: snapping that
    // is what lands a dragged wall back on the grid.
    g.proj0 = edge.a[0] * edge.nx + edge.a[1] * edge.ny;
    g.start = ptM(e, g.rect);
    wdrag = g;
    outlineListeners(true, onDragWall, endDragWall);
    renderPlan();
  }
  function onDragWall(e) {
    if (!wdrag || e.pointerId !== wdrag.pointerId) return;
    e.preventDefault();
    const pt = ptM(e, wdrag.rect);
    let d = (pt[0] - wdrag.start[0]) * wdrag.nx + (pt[1] - wdrag.start[1]) * wdrag.ny;
    d = snapVal(wdrag.proj0 + d) - wdrag.proj0;
    const next = moveEdgePoly(wdrag.poly, wdrag.i, d);
    if (!polyValid(next)) return;        // a move that would tangle the walls is simply refused
    wdrag.moved = true;
    if (applyOutline(next, wdrag)) renderPlan();
  }
  function endDragWall(e) {
    if (!wdrag || (e && e.pointerId !== wdrag.pointerId)) return;
    endOutlineDrag(false);
  }

  /* ---- Moving a corner ---- */
  const WELD_PX = 14;
  /* The neighbouring corner this one is close enough to merge with. Only
     neighbours: welding two corners from opposite sides of the room would
     pinch it into two rooms rather than simplify it. */
  function weldTarget(g, x, y) {
    const n = g.poly.length;
    if (n <= 3) return -1;               // a triangle has no corner to spare
    let best = -1, bd = WELD_PX / baseScale;
    for (const j of [(g.i - 1 + n) % n, (g.i + 1) % n]) {
      const d = Math.hypot(g.poly[j][0] - x, g.poly[j][1] - y);
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }
  function startDragVertex(e, i) {
    if (e.button != null && e.button !== 0) return;
    if (DRAW.active || wdrag || vdrag) return;
    const v = R.poly[i];
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    selectedId = `vtx:${i}`;
    const g = beginOutlineGesture(e);
    g.i = i;
    const p0 = ptM(e, g.rect);
    g.gx = p0[0] - v[0]; g.gy = p0[1] - v[1];   // grab offset, so the corner doesn't jump
    vdrag = g;
    outlineListeners(true, onDragVertex, endDragVertex);
    renderPlan();
  }
  function onDragVertex(e) {
    if (!vdrag || e.pointerId !== vdrag.pointerId) return;
    e.preventDefault();
    const pt = ptM(e, vdrag.rect);
    let x = snapVal(pt[0] - vdrag.gx), y = snapVal(pt[1] - vdrag.gy);
    // Auto-connect: bring a corner onto its neighbour and the two weld into
    // one when you let go, dropping the wall that ran between them.
    const j = weldTarget(vdrag, x, y);
    vdrag.weld = j;
    if (j >= 0) { x = vdrag.poly[j][0]; y = vdrag.poly[j][1]; }
    const poly = clonePoly(vdrag.poly);
    poly[vdrag.i] = [x, y];
    if (!polyValid(poly, j >= 0 ? vdrag.i : -1)) return;
    vdrag.moved = true;
    if (applyOutline(poly, vdrag)) renderPlan();
  }
  function endDragVertex(e) {
    if (!vdrag || (e && e.pointerId !== vdrag.pointerId)) return;
    endOutlineDrag(false);
  }

  /* ================= Presets UI ================= */
  function buildPresets() {
    els.presets.innerHTML = "";
    const list = addType === "closet" ? CLOSET_PRESETS : PRESETS;
    list.forEach((preset, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "preset-chip";
      const color = addType === "closet" ? CLOSET_COLOR : PALETTE[i % PALETTE.length];
      chip.innerHTML = `<span class="dot" style="background:${color}"></span>${preset.label}`;
      chip.addEventListener("click", () => {
        // preset dims are authored in feet -> convert to the current unit
        const round1 = (x) => Math.round(x * 10) / 10;
        els.addLabel.value = preset.label;
        els.addW.value = round1(toDisplay(preset.w * M_PER_FT));
        els.addD.value = round1(toDisplay(preset.d * M_PER_FT));
        els.addLabel.focus();
      });
      els.presets.appendChild(chip);
    });
  }
  function setAddType(type) {
    if (addType === type) return;
    addType = type;
    els.addLabel.placeholder = type === "closet" ? "e.g. Reach-in closet" : "e.g. Queen bed";
    els.addSubmit.textContent = type === "closet" ? "Place closet" : "Place in room";
    buildPresets();
    syncInputs();
  }

  /* ================= Events ================= */
  function bind() {
    // Room shape
    els.resetPoly.addEventListener("click", resetPoly);
    els.drawOutline.addEventListener("click", () => {
      if (DRAW.active) cancelDrawing(); else startDrawing();
    });
    els.drawUndo.addEventListener("click", undoDrawPoint);
    els.drawFinish.addEventListener("click", finishDrawing);
    els.drawCancel.addEventListener("click", cancelDrawing);

    /* Sketching happens on the stage itself: the pointer trails a wall behind
       it, a click drops a corner, and a double-click (or the first corner)
       closes the room. */
    els.stageScroll.addEventListener("pointermove", (e) => {
      if (!DRAW.active) return;
      DRAW.hover = sketchPoint(e);
      renderPlan();
    });
    els.stageScroll.addEventListener("pointerleave", () => {
      if (!DRAW.active) return;
      DRAW.hover = null;
      renderPlan();
    });
    els.stageScroll.addEventListener("dblclick", (e) => {
      if (!DRAW.active) return;
      e.preventDefault();
      finishDrawing();
    });

    // Room dimensions
    const applyRoom = () => {
      const w = toMeters(parseFloat(els.roomW.value) || 0);
      const l = toMeters(parseFloat(els.roomL.value) || 0);
      if (w > 0) state.room.w = w;
      if (l > 0) state.room.l = l;
      rebuildRoom(); save(); render();
    };
    els.roomW.addEventListener("change", applyRoom);
    els.roomL.addEventListener("change", applyRoom);

    // Add doors / windows
    els.addDoor.addEventListener("click", () => addOpening("door"));
    els.addWindow.addEventListener("click", () => addOpening("window"));

    // Add piece
    els.typeToggle.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => setAddType(b.dataset.type)));
    els.addForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const label = els.addLabel.value.trim();
      const w = parseFloat(els.addW.value);
      const d = parseFloat(els.addD.value);
      if (!(w > 0) || !(d > 0)) return;
      addPiece(label, w, d, addType);
      els.addForm.reset();
      els.addLabel.focus();
    });

    els.clearAll.addEventListener("click", () => {
      if (!state.pieces.length) return;
      // Locked pieces survive a clear — that protection is the point of the lock.
      const kept = state.pieces.filter((p) => p.locked);
      if (kept.length === state.pieces.length) {
        alert("Every piece is locked. Unlock the ones you want to remove first.");
        return;
      }
      const msg = kept.length
        ? `Remove all unlocked pieces? ${kept.length} locked ${kept.length === 1 ? "piece stays" : "pieces stay"}.`
        : "Remove all pieces from the room?";
      if (confirm(msg)) {
        state.pieces = kept; selectedId = null; save(); render();
      }
    });

    // Units
    els.unitBtns.forEach((b) =>
      b.addEventListener("click", () => {
        if (state.unit === b.dataset.unit) return;
        state.unit = b.dataset.unit;
        save(); render();
      })
    );

    // Snap
    els.snapToggle.addEventListener("change", (e) => {
      state.snap = e.target.checked; save();
    });

    // Zoom
    const setZoom = (z) => { state.zoom = Math.max(0.4, Math.min(3, z)); save(); render(); };
    els.zoomIn.addEventListener("click", () => setZoom(state.zoom * 1.2));
    els.zoomOut.addEventListener("click", () => setZoom(state.zoom / 1.2));
    els.zoomFit.addEventListener("click", () => setZoom(1));

    // Theme
    els.themeToggle.addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const isDark = cur ? cur === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
      const next = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
      render();
    });

    // Deselect on background click
    els.stageScroll.addEventListener("pointerdown", (e) => {
      if (DRAW.active) {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        addSketchPoint(e);
        return;
      }
      if (e.target === els.stageScroll || e.target === els.stage ||
          e.target === els.floor || e.target === els.plan || e.target === els.roomLayer) {
        if (selectedId) { selectedId = null; render(); }
      }
    });

    /* Keyboard: everything acts on the current selection. Letters are the
       initial of the verb (R)otate, (L)ock, (D)uplicate, (F)lip, sw(O)ng-out;
       arrows nudge by one snap step, or ten with Shift held. Locked items only
       answer to L and Escape. */
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // leave browser shortcuts alone
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        // Escape backs out of whatever is in progress, innermost first.
        if (endOutlineDrag(true)) return;
        if (DRAW.active) { cancelDrawing(); return; }
        if (selectedId) { selectedId = null; render(); }
        return;
      }
      if (DRAW.active) {
        if (e.key === "Enter") { e.preventDefault(); finishDrawing(); }
        else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); undoDrawPoint(); }
        return;
      }
      if (!selectedId) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const del = key === "Delete" || key === "Backspace";
      const nudge = toMeters(unitStep()) * (e.shiftKey ? 10 : 1);
      const p = state.pieces.find((x) => x.id === selectedId);
      const o = state.openings.find((x) => x.id === selectedId);
      const v = selectedId.startsWith("vtx:") ? parseInt(selectedId.slice(4), 10) : -1;
      if (p) {
        // "l" and duplicate stay live while locked; every mutation below is
        // gated so a locked piece can't be nudged, spun or thrown away.
        if (key === "l") { toggleLock(p); }
        else if (key === "d") { duplicatePiece(p); }
        else if (p.locked) return;
        else if (del) { e.preventDefault(); removePiece(p.id); }
        else if (key === "r") { rotatePiece(p); }
        else if (key === "]") { movePiece(p, 1); }
        else if (key === "[") { movePiece(p, -1); }
        else if (key === "}") { movePiece(p, state.pieces.length); }
        else if (key === "{") { movePiece(p, -state.pieces.length); }
        else if (key === "ArrowLeft")  { p.x -= nudge; clampPiece(p); save(); render(); }
        else if (key === "ArrowRight") { p.x += nudge; clampPiece(p); save(); render(); }
        else if (key === "ArrowUp")    { p.y -= nudge; clampPiece(p); save(); render(); }
        else if (key === "ArrowDown")  { p.y += nudge; clampPiece(p); save(); render(); }
        else return;
      } else if (o) {
        if (key === "l") { toggleLock(o); }
        else if (o.locked) return;
        else if (del) { e.preventDefault(); removeOpening(o.id); }
        else if (key === "r" && o.kind === "door") { rotateOpening(o); }
        else if (key === "f" && o.kind === "door") { flipOpening(o); }
        else if (key === "o" && o.kind === "door") { toggleSwing(o); }
        else if (key === "ArrowLeft" || key === "ArrowUp")    { o.pos -= nudge; clampOpening(o); save(); render(); }
        else if (key === "ArrowRight" || key === "ArrowDown") { o.pos += nudge; clampOpening(o); save(); render(); }
        else return;
      } else if (v >= 0) {
        if (del) { e.preventDefault(); removeVertex(v); }
        else return;
      } else return;
      if (key.startsWith("Arrow")) e.preventDefault();
    });

    // Re-fit on resize
    let rAF;
    window.addEventListener("resize", () => {
      cancelAnimationFrame(rAF);
      rAF = requestAnimationFrame(render);
    });
  }

  /* ================= Utils ================= */
  function uid() { return Math.random().toString(36).slice(2, 9); }
  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ================= Init ================= */
  function initTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY)
        || localStorage.getItem(LEGACY_THEME_KEY);
      if (t) document.documentElement.setAttribute("data-theme", t);
    } catch (_) {}
  }

  initTheme();
  rebuildRoom();
  if (!firstVisit) save();     // write back anything migrate() had to fix up
  buildPresets();
  bind();
  // Nothing saved yet: open on the sketch so the first thing anyone does is
  // draw their own room. Skipping it leaves the plain rectangle underneath.
  if (firstVisit) startDrawing(true);
  render();
})();
