/* ============================================================
   Room Planner — app logic
   Geometry is stored internally in METERS so units are just a
   display concern. The floor renders at a scale (px per meter)
   computed to fit the room in the stage, times a zoom factor.
   ============================================================ */

(() => {
  "use strict";

  const STORE_KEY = "room-planner:v1";
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

  /* Default opening sizes, authored in feet */
  const DOOR_W_M = 2.75 * M_PER_FT;   // ~33 in interior door
  const WINDOW_W_M = 3.0 * M_PER_FT;  // ~36 in window

  /* ---- Default state ---- */
  const defaultState = () => ({
    unit: "ft",
    room: { w: 12 * M_PER_FT, l: 14 * M_PER_FT },
    snap: true,
    zoom: 1,
    colorSeed: 0,
    pieces: [],
    openings: [],   // { id, kind:'door'|'window', wall, pos(m), width(m), flip }
  });

  let state = load() || defaultState();
  let selectedId = null;
  let baseScale = 40; // px per meter, recomputed on render

  /* ---- Element handles ---- */
  const $ = (id) => document.getElementById(id);
  const els = {
    roomW: $("roomW"), roomL: $("roomL"),
    roomArea: $("roomArea"), pieceCount: $("pieceCount"),
    presets: $("presets"), addForm: $("addForm"),
    addLabel: $("addLabel"), addW: $("addW"), addD: $("addD"),
    pieceList: $("pieceList"), emptyPieces: $("emptyPieces"), clearAll: $("clearAll"),
    addDoor: $("addDoor"), addWindow: $("addWindow"),
    openingList: $("openingList"), emptyOpenings: $("emptyOpenings"), openingsLayer: $("openingsLayer"),
    snapToggle: $("snapToggle"),
    zoomIn: $("zoomIn"), zoomOut: $("zoomOut"), zoomFit: $("zoomFit"),
    stageScroll: $("stageScroll"), stage: $("stage"), floor: $("floor"),
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
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.room || !Array.isArray(s.pieces)) return null;
      if (!Array.isArray(s.openings)) s.openings = []; // migrate older saves
      return s;
    } catch (_) { return null; }
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
    p.x = Math.max(0, Math.min(p.x, Math.max(0, state.room.w - fp.w)));
    p.y = Math.max(0, Math.min(p.y, Math.max(0, state.room.l - fp.d)));
  }

  /* ---- Openings (doors/windows) attach to a wall at an offset along it ---- */
  const isHoriz = (o) => o.wall === "top" || o.wall === "bottom";
  const wallLen = (o) => (isHoriz(o) ? state.room.w : state.room.l);
  function clampOpening(o) {
    o.width = Math.min(o.width, wallLen(o));           // never wider than the wall
    o.pos = Math.max(0, Math.min(o.pos, wallLen(o) - o.width));
  }
  // Pixel geometry for a given scale. Returns endpoints on the wall (a->b),
  // the interior normal (into the room), and the wall-line coordinate.
  function openingPx(o, s) {
    const fw = state.room.w * s, fh = state.room.l * s;
    const len = o.width * s, a = o.pos * s, b = (o.pos + o.width) * s;
    if (isHoriz(o)) {
      const y = o.wall === "top" ? 0 : fh;
      const ny = o.wall === "top" ? 1 : -1;            // interior direction (down/up)
      return { horiz: true, y, ny, a, b, len, fw, fh };
    }
    const x = o.wall === "left" ? 0 : fw;
    const nx = o.wall === "left" ? 1 : -1;             // interior direction (right/left)
    return { horiz: false, x, nx, a, b, len, fw, fh };
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
  function computeScale() {
    const pad = 44; // room for edge dimension labels
    const availW = Math.max(120, els.stageScroll.clientWidth - pad * 2);
    const availH = Math.max(120, els.stageScroll.clientHeight - pad * 2);
    const fit = Math.min(availW / state.room.w, availH / state.room.l);
    baseScale = fit * state.zoom;
  }

  function render() {
    computeScale();
    const s = baseScale;
    const floorW = state.room.w * s;
    const floorH = state.room.l * s;

    els.floor.style.width = floorW + "px";
    els.floor.style.height = floorH + "px";
    els.floor.dataset.w = fmtDim(state.room.w);
    els.floor.dataset.l = fmtDim(state.room.l);

    // Grid: scale each axis to an EVEN number of cells so a real grid line
    // falls on the room's midline. Cell size is nudged toward the nominal
    // grid unit rather than splitting a square.
    const u = U();
    const gridM = u.grid / u.perM;                       // nominal minor cell (m)
    const majorMult = Math.max(1, Math.round(u.major / u.grid));
    const nx = evenCells(state.room.w, gridM, s);
    const ny = evenCells(state.room.l, gridM, s);
    const minorX = (state.room.w / nx) * s;
    const minorY = (state.room.l / ny) * s;
    const majorX = minorX * majorMult;
    const majorY = minorY * majorMult;
    els.floor.style.backgroundSize =
      `${minorX}px ${minorY}px, ${minorX}px ${minorY}px, ${majorX}px ${majorY}px, ${majorX}px ${majorY}px`;

    // Furniture — reconcile DOM
    const seen = new Set();
    for (const p of state.pieces) {
      seen.add(p.id);
      let node = els.floor.querySelector(`[data-id="${p.id}"]`);
      if (!node) node = createPieceNode(p);
      positionPiece(node, p, s);
    }
    // remove stale nodes
    els.floor.querySelectorAll(".piece").forEach((n) => {
      if (!seen.has(n.dataset.id)) n.remove();
    });

    reconcileOpenings(s);
    renderList();
    renderOpeningList();
    renderMeta();
    syncInputs();
  }

  /* Reconcile the per-opening hit boxes, then repaint the SVG graphics. */
  function reconcileOpenings(s) {
    const seen = new Set();
    for (const o of state.openings) {
      seen.add(o.id);
      let node = els.floor.querySelector(`.opening-hit[data-id="${o.id}"]`);
      if (!node) node = createOpeningHit(o);
      positionOpeningHit(node, o, s);
    }
    els.floor.querySelectorAll(".opening-hit").forEach((n) => {
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
    els.floor.appendChild(node);
    return node;
  }

  function positionOpeningHit(node, o, s) {
    const g = openingPx(o, s);
    const pad = 9;                 // grab margin perpendicular to a window
    let x, y, w, h;
    if (o.kind === "door") {
      const depth = o.width * s;   // swing reaches one door-width into the room
      if (g.horiz) { x = g.a; w = g.len; y = g.ny > 0 ? g.y : g.y - depth; h = depth; }
      else         { y = g.a; h = g.len; x = g.nx > 0 ? g.x : g.x - depth; w = depth; }
    } else {
      if (g.horiz) { x = g.a; w = g.len; y = g.y - pad; h = pad * 2; }
      else         { y = g.a; h = g.len; x = g.x - pad; w = pad * 2; }
    }
    node.style.transform = `translate(${x}px, ${y}px)`;
    node.style.width = Math.max(6, w) + "px";
    node.style.height = Math.max(6, h) + "px";
    node.classList.toggle("selected", o.id === selectedId);
  }

  /* Paint all door/window graphics into the shared SVG overlay. */
  function drawOpenings(s) {
    const fw = state.room.w * s, fh = state.room.l * s;
    els.openingsLayer.setAttribute("width", fw);
    els.openingsLayer.setAttribute("height", fh);
    let out = "";
    for (const o of state.openings) {
      const g = openingPx(o, s);
      if (o.kind === "window") {
        const T = 7;
        if (g.horiz) {
          out += `<rect class="win-body" x="${g.a}" y="${g.y - T / 2}" width="${g.len}" height="${T}" />`
              +  `<line class="win-line" x1="${g.a}" y1="${g.y}" x2="${g.b}" y2="${g.y}" />`;
        } else {
          out += `<rect class="win-body" x="${g.x - T / 2}" y="${g.a}" width="${T}" height="${g.len}" />`
              +  `<line class="win-line" x1="${g.x}" y1="${g.a}" x2="${g.x}" y2="${g.b}" />`;
        }
      } else {
        // Door: hinge H, opposite jamb J, open leaf tip L (perpendicular into room)
        const r = o.width * s;
        let H, J, L;
        if (g.horiz) {
          const p1 = [g.a, g.y], p2 = [g.b, g.y];
          H = o.flip ? p2 : p1; J = o.flip ? p1 : p2;
          L = [H[0], g.y + g.ny * r];
        } else {
          const p1 = [g.x, g.a], p2 = [g.x, g.b];
          H = o.flip ? p2 : p1; J = o.flip ? p1 : p2;
          L = [g.x + g.nx * r, H[1]];
        }
        const cross = (J[0] - H[0]) * (L[1] - H[1]) - (J[1] - H[1]) * (L[0] - H[0]);
        const sweep = cross < 0 ? 1 : 0;
        out += `<path class="door-arc" d="M ${J[0]} ${J[1]} A ${r} ${r} 0 0 ${sweep} ${L[0]} ${L[1]}" />`
            +  `<line class="door-leaf" x1="${H[0]}" y1="${H[1]}" x2="${L[0]}" y2="${L[1]}" />`;
      }
    }
    els.openingsLayer.innerHTML = out;
  }

  function createPieceNode(p) {
    const node = document.createElement("div");
    node.className = "piece";
    node.dataset.id = p.id;
    node.innerHTML = `<span class="p-label"></span><span class="p-dim mono"></span>`;
    node.addEventListener("pointerdown", (e) => startDrag(e, p, node));
    els.floor.appendChild(node);
    return node;
  }

  function positionPiece(node, p, s) {
    const fp = footprint(p);
    const w = fp.w * s, h = fp.d * s;
    node.style.transform = `translate(${p.x * s}px, ${p.y * s}px)`;
    node.style.width = w + "px";
    node.style.height = h + "px";
    node.style.background = p.color;
    node.style.color = textOn(p.color);
    node.classList.toggle("selected", p.id === selectedId);
    node.classList.toggle("tiny", Math.min(w, h) < 48);
    node.querySelector(".p-label").textContent = p.label;
    node.querySelector(".p-dim").textContent = `${fmt(p.w)}×${fmt(p.d)}`;
  }

  function renderMeta() {
    const areaM = state.room.w * state.room.l;
    // Report area in the system's large unit: ft² for imperial, m² for metric.
    const areaDisp = U().metric
      ? `${(Math.round(areaM * 10) / 10)} m²`
      : `${Math.round(areaM / (M_PER_FT * M_PER_FT))} ft²`;
    els.roomArea.textContent = areaDisp;
    const n = state.pieces.length;
    els.pieceCount.textContent = `${n} ${n === 1 ? "piece" : "pieces"}`;
    els.clearAll.hidden = n === 0;
  }

  function renderList() {
    els.pieceList.innerHTML = "";
    els.emptyPieces.style.display = state.pieces.length ? "none" : "block";
    for (const p of state.pieces) {
      const li = document.createElement("li");
      li.className = "piece-item" + (p.id === selectedId ? " selected" : "");
      li.dataset.id = p.id;
      li.innerHTML = `
        <input type="color" class="swatch" value="${p.color}" title="Change color" aria-label="Color for ${escapeAttr(p.label)}" />
        <div class="piece-main">
          <input class="piece-label-input" value="${escapeAttr(p.label)}" maxlength="24" aria-label="Label" />
          <div class="piece-dims">
            <input type="number" class="edit-w mono" min="0.1" step="any" value="${fmt(p.w)}" aria-label="Width" />
            <span>×</span>
            <input type="number" class="edit-d mono" min="0.1" step="any" value="${fmt(p.d)}" aria-label="Depth" />
            <span>${unitLabel()}</span>
          </div>
        </div>
        <div class="piece-actions">
          <button class="mini-btn act-rotate" title="Rotate 90°" aria-label="Rotate">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v4h-4"/></svg>
          </button>
          <button class="mini-btn act-dupe" title="Duplicate" aria-label="Duplicate">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
          </button>
          <button class="mini-btn danger act-del" title="Remove" aria-label="Remove">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13h10l1-13"/></svg>
          </button>
        </div>`;

      li.querySelector(".swatch").addEventListener("input", (e) => {
        p.color = e.target.value;
        const node = els.floor.querySelector(`.piece[data-id="${p.id}"]`);
        if (node) { node.style.background = p.color; node.style.color = textOn(p.color); }
        save();
      });
      li.querySelector(".piece-label-input").addEventListener("input", (e) => {
        p.label = e.target.value; save();
        const node = els.floor.querySelector(`.piece[data-id="${p.id}"] .p-label`);
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
      li.querySelector(".act-rotate").addEventListener("click", () => rotatePiece(p));
      li.querySelector(".act-dupe").addEventListener("click", () => duplicatePiece(p));
      li.querySelector(".act-del").addEventListener("click", () => removePiece(p.id));
      li.addEventListener("click", (e) => {
        if (e.target.closest("button, input")) return;
        select(p.id);
      });
      els.pieceList.appendChild(li);
    }
  }

  const ICON = {
    door: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 21h16M7 21V4h8v17M13 12v.01"/><path d="M15 4a5 5 0 0 1 5 5v12" stroke-opacity="0.5"/></svg>`,
    window: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M4 12h16"/></svg>`,
    flip: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v18M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13h10l1-13"/></svg>`,
  };

  function renderOpeningList() {
    els.openingList.innerHTML = "";
    els.emptyOpenings.style.display = state.openings.length ? "none" : "block";
    for (const o of state.openings) {
      const li = document.createElement("li");
      li.className = "opening-item" + (o.id === selectedId ? " selected" : "");
      li.dataset.id = o.id;
      const wallName = o.wall.charAt(0).toUpperCase() + o.wall.slice(1);
      const flipBtn = o.kind === "door"
        ? `<button class="mini-btn act-flip" title="Flip hinge" aria-label="Flip hinge">${ICON.flip}</button>` : "";
      li.innerHTML = `
        <span class="op-icon">${ICON[o.kind]}</span>
        <div class="op-main">
          <div class="op-kind">${o.kind === "door" ? "Door" : "Window"} <span class="op-wall">· ${wallName} wall</span></div>
          <div class="op-dims">
            <input type="number" class="op-w mono" min="0.1" step="any" value="${fmt(o.width)}" aria-label="Width" />
            <span>${unitLabel()} wide</span>
          </div>
        </div>
        <div class="op-actions">
          ${flipBtn}
          <button class="mini-btn danger act-opdel" title="Remove" aria-label="Remove">${ICON.trash}</button>
        </div>`;
      li.querySelector(".op-w").addEventListener("change", (e) => {
        o.width = Math.max(0.05, toMeters(parseFloat(e.target.value) || 0));
        clampOpening(o); save(); render();
      });
      const flip = li.querySelector(".act-flip");
      if (flip) flip.addEventListener("click", () => flipOpening(o));
      li.querySelector(".act-opdel").addEventListener("click", () => removeOpening(o.id));
      li.addEventListener("click", (e) => {
        if (e.target.closest("button, input")) return;
        select(o.id);
      });
      els.openingList.appendChild(li);
    }
  }

  function syncInputs() {
    if (document.activeElement !== els.roomW) els.roomW.value = fmt(state.room.w);
    if (document.activeElement !== els.roomL) els.roomL.value = fmt(state.room.l);
    els.snapToggle.checked = state.snap;
    els.unitLabels.forEach((n) => (n.textContent = unitLabel()));
    els.unitBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.unit === state.unit));
  }

  /* ================= Piece operations ================= */
  function addPiece(label, wDisp, dDisp) {
    const w = toMeters(wDisp), d = toMeters(dDisp);
    // Cascade new pieces so they don't stack exactly
    const off = toMeters(unitStep()) * (state.pieces.length % 8) * 2;
    const p = {
      id: uid(), label: label || "Piece",
      w, d, rot: 0, color: nextColor(),
      x: snapVal(Math.min(off, Math.max(0, state.room.w - w))),
      y: snapVal(Math.min(off, Math.max(0, state.room.l - d))),
    };
    clampPiece(p);
    state.pieces.push(p);
    selectedId = p.id;
    save(); render();
  }
  function rotatePiece(p) {
    p.rot = (p.rot + 90) % 360;
    clampPiece(p); save(); render();
  }
  function duplicatePiece(src) {
    const p = { ...src, id: uid(), label: src.label,
      x: src.x + toMeters(unitStep()) * 2, y: src.y + toMeters(unitStep()) * 2 };
    clampPiece(p);
    state.pieces.push(p);
    selectedId = p.id;
    save(); render();
  }
  function removePiece(id) {
    state.pieces = state.pieces.filter((p) => p.id !== id);
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
    const o = { id: uid(), kind, wall: "top", width, pos: 0, flip: false };
    o.pos = Math.max(0, state.room.w / 2 - width / 2);   // centered on the top wall
    clampOpening(o);
    state.openings.push(o);
    selectedId = o.id;
    save(); render();
    return o;
  }
  function flipOpening(o) { o.flip = !o.flip; save(); render(); }
  function removeOpening(id) {
    state.openings = state.openings.filter((o) => o.id !== id);
    if (selectedId === id) selectedId = null;
    save(); render();
  }

  /* ================= Dragging ================= */
  let drag = null;
  function startDrag(e, p, node) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    select(p.id);
    if (selectedId !== p.id) selectedId = p.id; // ensure selected after toggle
    node.classList.add("dragging");
    node.setPointerCapture(e.pointerId);
    const rect = els.floor.getBoundingClientRect();
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

  /* ---- Dragging an opening: it slides along its wall and snaps to whichever
       wall is nearest, so you can drag a door from one wall to another. ---- */
  let odrag = null;
  function startDragOpening(e, o, node) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectedId = o.id;
    node.classList.add("dragging");
    node.setPointerCapture(e.pointerId);
    odrag = { o, node, pointerId: e.pointerId, rect: els.floor.getBoundingClientRect() };
    render(); // reflect selection in the lists/outline
    node.addEventListener("pointermove", onDragOpening);
    node.addEventListener("pointerup", endDragOpening);
    node.addEventListener("pointercancel", endDragOpening);
  }
  function onDragOpening(e) {
    if (!odrag) return;
    const { o, rect } = odrag;
    const px = (e.clientX - rect.left) / baseScale;    // pointer in room meters
    const py = (e.clientY - rect.top) / baseScale;
    const W = state.room.w, L = state.room.l;
    // Nearest wall by perpendicular distance
    const d = { top: Math.abs(py), bottom: Math.abs(L - py), left: Math.abs(px), right: Math.abs(W - px) };
    o.wall = Object.keys(d).reduce((best, k) => (d[k] < d[best] ? k : best), "top");
    const along = isHoriz(o) ? px : py;                // position of pointer along the wall
    o.pos = snapVal(along - o.width / 2);
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

  /* ================= Presets UI ================= */
  function buildPresets() {
    PRESETS.forEach((preset, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "preset-chip";
      const color = PALETTE[i % PALETTE.length];
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

  /* ================= Events ================= */
  function bind() {
    // Room dimensions
    const applyRoom = () => {
      const w = toMeters(parseFloat(els.roomW.value) || 0);
      const l = toMeters(parseFloat(els.roomL.value) || 0);
      if (w > 0) state.room.w = w;
      if (l > 0) state.room.l = l;
      state.pieces.forEach(clampPiece);
      state.openings.forEach(clampOpening);
      save(); render();
    };
    els.roomW.addEventListener("change", applyRoom);
    els.roomL.addEventListener("change", applyRoom);

    // Add doors / windows
    els.addDoor.addEventListener("click", () => addOpening("door"));
    els.addWindow.addEventListener("click", () => addOpening("window"));

    // Add piece
    els.addForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const label = els.addLabel.value.trim();
      const w = parseFloat(els.addW.value);
      const d = parseFloat(els.addD.value);
      if (!(w > 0) || !(d > 0)) return;
      addPiece(label, w, d);
      els.addForm.reset();
      els.addLabel.focus();
    });

    els.clearAll.addEventListener("click", () => {
      if (!state.pieces.length) return;
      if (confirm("Remove all pieces from the room?")) {
        state.pieces = []; selectedId = null; save(); render();
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
      try { localStorage.setItem("room-planner:theme", next); } catch (_) {}
      render();
    });

    // Deselect on background click
    els.stageScroll.addEventListener("pointerdown", (e) => {
      if (e.target === els.stageScroll || e.target === els.stage || e.target === els.floor) {
        if (selectedId) { selectedId = null; render(); }
      }
    });

    // Keyboard: delete selected, rotate/flip, nudge with arrows
    document.addEventListener("keydown", (e) => {
      if (!selectedId) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const nudge = toMeters(unitStep());
      const p = state.pieces.find((x) => x.id === selectedId);
      const o = state.openings.find((x) => x.id === selectedId);
      if (p) {
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removePiece(p.id); }
        else if (e.key === "r" || e.key === "R") { rotatePiece(p); }
        else if (e.key === "ArrowLeft")  { p.x -= nudge; clampPiece(p); save(); render(); }
        else if (e.key === "ArrowRight") { p.x += nudge; clampPiece(p); save(); render(); }
        else if (e.key === "ArrowUp")    { p.y -= nudge; clampPiece(p); save(); render(); }
        else if (e.key === "ArrowDown")  { p.y += nudge; clampPiece(p); save(); render(); }
        else return;
      } else if (o) {
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeOpening(o.id); }
        else if ((e.key === "f" || e.key === "F") && o.kind === "door") { flipOpening(o); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp")    { o.pos -= nudge; clampOpening(o); save(); render(); }
        else if (e.key === "ArrowRight" || e.key === "ArrowDown") { o.pos += nudge; clampOpening(o); save(); render(); }
        else return;
      } else return;
      if (e.key.startsWith("Arrow")) e.preventDefault();
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
      const t = localStorage.getItem("room-planner:theme");
      if (t) document.documentElement.setAttribute("data-theme", t);
    } catch (_) {}
  }

  function seedExample() {
    // First-run: drop in a couple of pieces + a door and window
    if (state.pieces.length || state.openings.length) return;
    addPiece("Queen bed", 5, 6.7);
    addPiece("Dresser", 5, 1.7);
    const win = addOpening("window");            // top wall, centered
    const door = addOpening("door");
    door.wall = "bottom";
    door.pos = Math.max(0, state.room.w / 2 - door.width / 2);
    clampOpening(door);
    selectedId = null;
  }

  initTheme();
  buildPresets();
  bind();
  seedExample();
  render();
})();
