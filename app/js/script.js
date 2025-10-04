(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const wrap = document.getElementById("gameWrap");
  let W = 360,
    H = 640;

  function resize() {
    const rect = wrap.getBoundingClientRect();
    const DPR = Math.min(2, window.devicePixelRatio || 1); // cap DPR to avoid huge canvases on Android
    W = canvas.width = Math.max(1, Math.floor(rect.width * DPR));
    H = canvas.height = Math.max(1, Math.floor(rect.height * DPR));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(DPR, DPR);
    ctx.imageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;
  }

  // Use RO when available; otherwise fallback to window.resize.
  // Defer the actual resize to the next frame to avoid RO feedback loops on some Android builds.
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => requestAnimationFrame(resize));
    ro.observe(wrap);
  } else {
    window.addEventListener("resize", resize);
  }
  resize();

  // Prevent iOS pinch/double-tap zoom and text selection jitter
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault(), {
    passive: false,
  });

  // Block default touch gestures on the game area (so hold doesn't trigger select/zoom)
  // NOTE: we still allow taps on UI (buttons/links/overlays)
  ["touchstart", "touchmove", "touchend"].forEach((ev) =>
    wrap.addEventListener(
      ev,
      (e) => {
        const t = e.target;
        if (
          t &&
          (t.closest(".overlay") || t.closest("button") || t.closest("a"))
        )
          return;
        e.preventDefault();
      },
      { passive: false }
    )
  );

  // --- Game constants ---
  const GRAVITY = 1000; // px/s^2 (tuned)
  const THRUST = -2200; // px/s^2 (hold-to-rise)
  const ROBOT_X = 0.24; // portion of width
  const GATE_GAP_MIN = 160; // px at 720p baseline; scale with height
  const GATE_GAP_MAX = 260;
  const GATE_W = 78;
  const COIN_R = 10;
  const SHIELD_R = 12;
  const START_SPEED = 180; // px/s
  const MAX_SPEED = 420;
  const SPEED_ACCEL = 3.5; // px/s per second
  const GATE_INTERVAL = 1.55; // seconds
  const COIN_CHANCE = 0.5;
  const SHIELD_CHANCE = 0.1;

  // Jetpack heat (overheat mechanic)
  const HEAT_MAX = 100;
  const HEAT_INC = 32; // per second when thrusting
  const HEAT_DEC = 34; // per second when not thrusting

  // --- Game state ---
  let state = "MENU";
  let time = 0,
    last = 0;
  let speed = START_SPEED;
  let gates = []; // {x, gapY, gapH}
  let coins = []; // {x,y,vy,spin}
  let shields = []; // {x,y,vy}
  let spawnTimer = 0,
    safeGates = 0,
    lastGapY = null,
    lastGateX = -9999;
  let score = 0,
    coinsTaken = 0;
  let best = Number(localStorage.getItem("ixijet_best") || 0);
  let decayTimer = 0;
  // Antenna LED flash state
  const led = { a: 0, next: 0 }; // a = current flash intensity 0..1, next = time until next flash (sec)

  // Robot
  const robot = {
    x: 0,
    y: 0,
    vy: 0,
    heat: 0,
    overheated: false,
    alive: true,
    shield: false,
    shieldTimer: 0,
  };

  // Input
  let holding = false;
  function setHold(v) {
    holding = v;
  }
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "Space") {
      if (state !== "PLAY") start();
      setHold(true);
      e.preventDefault();
    }
    if (e.key === "p" || e.key === "P") togglePause();
    if (e.key === "r" || e.key === "R") restart();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      setHold(false);
      e.preventDefault();
    }
  });
  ["pointerdown", "touchstart", "mousedown"].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      const t = e.target;
      // ignore UI: overlays, buttons, links
      if (t && (t.closest(".overlay") || t.closest("button") || t.closest("a")))
        return;
      if (state !== "PLAY") start();
      setHold(true);
    })
  );
  ["pointerup", "pointercancel", "touchend", "mouseup", "mouseleave"].forEach(
    (ev) => window.addEventListener(ev, () => setHold(false))
  );

  // UI Elements
  const scoreEl = document.getElementById("score");
  const bestEl = document.getElementById("best");
  const menuOverlay = document.getElementById("menu");
  const howOverlay = document.getElementById("how");
  const overOverlay = document.getElementById("gameover");
  const finalScore = document.getElementById("finalScore");
  const finalBest = document.getElementById("finalBest");
  const finalCoins = document.getElementById("finalCoins");
  bestEl.textContent = `Best: ${best}`;

  function bindTap(el, fn) {
    ["click", "touchend", "pointerup"].forEach((ev) =>
      el.addEventListener(
        ev,
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          fn();
        },
        { passive: false }
      )
    );
  }

  bindTap(document.getElementById("startBtn"), start);
  bindTap(document.getElementById("howBtn"), () => {
    howOverlay.style.display = "grid";
    menuOverlay.style.display = "none";
  });
  bindTap(document.getElementById("backBtn"), () => {
    howOverlay.style.display = "none";
    menuOverlay.style.display = "grid";
  });
  bindTap(document.getElementById("retryBtn"), restart);
  bindTap(document.getElementById("menuBtn"), toMenu);

  function toMenu() {
    state = "MENU";
    menuOverlay.style.display = "grid";
    howOverlay.style.display = "none";
    overOverlay.style.display = "none";
  }
  function start() {
    state = "PLAY";
    menuOverlay.style.display = "none";
    howOverlay.style.display = "none";
    overOverlay.style.display = "none";
    resetWorld();
  }
  function restart() {
    if (state !== "PLAY") start();
  }
  let paused = false;
  function togglePause() {
    if (state === "PLAY") {
      paused = !paused;
    }
  }

  function resetWorld() {
    speed = START_SPEED;
    gates.length = 0;
    coins.length = 0;
    shields.length = 0;
    spawnTimer = 0;
    score = 0;
    coinsTaken = 0;
    time = 0;
    last = 0;
    robot.x = Math.floor((W / devicePixelRatio) * ROBOT_X);
    robot.y = H / devicePixelRatio / 2;
    robot.vy = 0;
    robot.heat = 0;
    robot.overheated = false;
    robot.alive = true;
    robot.shield = false;
    robot.shieldTimer = 0;
    safeGates = 3;
    lastGapY = canvas.clientHeight * 0.5;
    lastGateX = -9999; // generous gaps for first gates
    led.a = 0;
    led.next = rand(0.25, 1.0); // faster first flash
  }

  // --- Helpers ---
  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }
  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  // --- Drawing ---
  function drawBackground(dt) {
    // Parallax starfield + faint grid
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    const t = time * 0.04;

    // Stars
    const layers = [0.3, 0.6, 1.0];
    layers.forEach((m, i) => {
      const starCount = 30 + i * 20;
      ctx.globalAlpha = 0.4 + i * 0.2;
      for (let s = 0; s < starCount; s++) {
        const x = ((s * 97.3) % w) - t * speed * (0.2 + m);
        const y = (s * 53.7 + i * 123.4) % h;
        const xr = ((x % w) + w) % w;
        ctx.fillStyle = i === 2 ? "#c7d2fe" : "#93c5fd";
        ctx.fillRect(xr, y, i === 0 ? 1 : 2, i === 0 ? 1 : 2);
      }
    });
    ctx.globalAlpha = 1;

    // Faint scanlines
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    for (let y = 0; y < h; y += 3) {
      ctx.fillRect(0, y, w, 1);
    }
  }

  function drawRobot(x, y, shield) {
    // Ixian green robot with jetpack flame
    ctx.save();
    ctx.translate(x, y);

    // Body
    ctx.fillStyle = "#16a34a"; // green body
    ctx.strokeStyle = "rgba(200,255,220,0.6)";
    ctx.lineWidth = 2;
    roundRect(-18, -14, 36, 28, 8, true, true);

    // Eye visor
    ctx.fillStyle = "#0b1a12";
    roundRect(-12, -6, 24, 12, 6, true, false);
    // Eye glow
    ctx.fillStyle = "#86efac";
    ctx.fillRect(-6, -3, 12, 6);

    // Antenna
    ctx.strokeStyle = "#34d399";
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(0, -22);
    ctx.stroke();

    // Neon LED cap (brighter + faster)
    const baseR = 3;
    const flick = led.a * (0.7 + 0.5 * Math.sin(time * 34)); // more shimmer
    const r = baseR + 1.8 * flick; // larger pulse

    // hot white->mint->green radial core
    const grad = ctx.createRadialGradient(0, -24, 0.1, 0, -24, r);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.45, "rgba(167,243,208,1)"); // mint
    grad.addColorStop(1, "rgba(34,197,94,0.95)");
    ctx.fillStyle = grad;

    // strong neon glow
    ctx.shadowColor = `rgba(52,211,153,${0.65 + 0.35 * Math.min(1, led.a)})`;
    ctx.shadowBlur = 12 + 32 * led.a;

    ctx.beginPath();
    ctx.arc(0, -24, r, 0, Math.PI * 2);
    ctx.fill();

    // additive outer ring for extra punch
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `rgba(52,211,153,${0.35 + 0.55 * Math.min(1, led.a)})`;
    ctx.lineWidth = 1.5 + 2.5 * led.a;
    ctx.beginPath();
    ctx.arc(0, -24, r + 1.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";

    // cleanup glow
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";

    // brighter specular highlight
    ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.55 * Math.min(1, led.a)})`;
    ctx.beginPath();
    ctx.arc(-1.0, -25, 1.0 + 0.8 * led.a, 0, Math.PI * 2);
    ctx.fill();

    // Jetpack thrusters
    ctx.fillStyle = "#173d2a";
    roundRect(-22, -6, 6, 12, 3, true, false);
    roundRect(16, -6, 6, 12, 3, true, false);

    // Flame if thrusting (IXI green)
    if (holding && !robot.overheated) {
      const f = (Math.sin(time * 60) + 1) / 2; // 0..1 flicker
      const len = 16 + f * 9 + thrustHold * 14; // grows as you hold
      const jitter = (Math.random() - 0.5) * (2 + thrustHold * 0.6);

      ctx.save();
      // subtle neon bloom to match the theme
      ctx.globalCompositeOperation = "lighter";
      const glow = 0.45 + 0.35 * f;
      ctx.shadowColor = `rgba(52,211,153,${glow})`;
      ctx.shadowBlur = 14 + 10 * f;

      // left nozzle: white core -> mint -> green
      let gradL = ctx.createLinearGradient(-25, 0, -25 + len, 0);
      gradL.addColorStop(0.0, "rgba(255,255,255,0.95)"); // hot core
      gradL.addColorStop(0.35, "rgba(167,243,208,0.95)"); // mint
      gradL.addColorStop(1.0, "rgba(22,163,74,0.95)"); // green
      ctx.fillStyle = gradL;
      flame(-25, 2 + jitter, len);

      // right nozzle (mirror)
      let gradR = ctx.createLinearGradient(25, 0, 25 - len, 0);
      gradR.addColorStop(0.0, "rgba(255,255,255,0.95)");
      gradR.addColorStop(0.35, "rgba(167,243,208,0.95)");
      gradR.addColorStop(1.0, "rgba(22,163,74,0.95)");
      ctx.fillStyle = gradR;
      flame(25, 2 - jitter, -len);

      ctx.restore();
    }

    // Shield effect
    if (shield) {
      ctx.strokeStyle = `rgba(52,211,153,${0.6 + 0.3 * Math.sin(time * 6)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 26, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  function roundRect(x, y, w, h, r, fill, stroke) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }
  function flame(x, y, len) {
    ctx.beginPath();
    ctx.moveTo(x, y - 3);
    ctx.quadraticCurveTo(x + len * 0.3, y, x, y + 3);
    ctx.quadraticCurveTo(x - len * 0.2, y, x, y - 3);
    ctx.fill();
  }

  function drawGates() {
    ctx.strokeStyle = "#22c55e";
    ctx.fillStyle = "#0c2a18";
    ctx.lineWidth = 3;
    gates.forEach((g) => {
      // Left pillar
      roundRect(g.x, 0, GATE_W, g.gapY - g.gapH / 2, 10, true, false);
      // Right pillar
      roundRect(
        g.x,
        g.gapY + g.gapH / 2,
        GATE_W,
        canvas.clientHeight - (g.gapY + g.gapH / 2),
        10,
        true,
        false
      );
      // Edges glow
      ctx.strokeStyle = "rgba(34,197,94,0.85)";
      ctx.strokeRect(g.x + 1.5, 0, GATE_W - 3, g.gapY - g.gapH / 2);
      ctx.strokeRect(
        g.x + 1.5,
        g.gapY + g.gapH / 2,
        GATE_W - 3,
        canvas.clientHeight - (g.gapY + g.gapH / 2)
      );
      // Animated field
      const t = (time * 120) % 20;
      ctx.fillStyle = "rgba(34,197,94,0.12)";
      ctx.fillRect(g.x, g.gapY - g.gapH / 2 - t, GATE_W, 6);
      ctx.fillRect(g.x, g.gapY + g.gapH / 2 + t - 6, GATE_W, 6);

      // Errode gate for when shield activated
      erodeGate(g);
    });
  }

  // Smaller IXI logo + animated glow
  function drawIxiLogo(x, y, r, rot) {
    // r here is a “virtual” size; we’ll draw a bit smaller than before
    const size = r * 1.7; // was ~2.1 – now a little smaller
    const ringR = size * 0.52;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);

    // Pulsing glow (0.25–0.55 alpha)
    const glowA = 0.4 + 0.15 * Math.sin(time * 6 + x * 0.02);
    ctx.shadowBlur = size * 0.9;
    ctx.shadowColor = `rgba(52, 211, 153, ${glowA})`;

    ctx.lineWidth = Math.max(1.5, size * 0.18);
    ctx.strokeStyle = "#34d399";

    // left ring
    ctx.beginPath();
    ctx.arc(-size * 0.28, 0, ringR, 0, Math.PI * 2);
    ctx.stroke();
    // right ring
    ctx.beginPath();
    ctx.arc(size * 0.28, 0, ringR, 0, Math.PI * 2);
    ctx.stroke();

    // cleanup
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.restore();
  }

  function drawCoins() {
    // keep the slow spin you already set in update()
    coins.forEach((c) => drawIxiLogo(c.x, c.y, COIN_R, c.spin));
  }

  function drawShields() {
    shields.forEach((s) => {
      ctx.save();
      ctx.translate(s.x, s.y);
      const r = SHIELD_R;
      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#34d399";
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    });
  }

  // Erode gate edges: punch-out chips + additive neon glow + occasional crumbs
  function erodeGate(g) {
    if (decayTimer <= 0) return;

    const t = time * 60; // animate seed
    const strength = Math.min(1, decayTimer / 1.8);
    const bitesBase = 12; // chips per gate per frame
    const bites = (bitesBase + Math.sin(t * 0.07 + g.x * 0.01) * 4) | 0;
    const cell = 4; // pixel cell size for retro look

    const edgeTopY = Math.max(0, g.gapY - g.gapH / 2);
    const edgeBottomY = Math.min(canvas.clientHeight, g.gapY + g.gapH / 2);

    function prand(i) {
      const s = Math.sin(i * 12.9898 + t + g.x * 0.013) * 43758.5453;
      return s - Math.floor(s);
    }

    ctx.save();

    // 1) Punch out little “chips” at the inner edges (destination-out)
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.95)";
    for (let i = 0; i < bites; i++) {
      const onBottom = prand(i * 3) > 0.5;
      const yEdge = onBottom ? edgeBottomY : edgeTopY;

      // bias x near inner edge
      const r = prand(i * 5 + 1);
      const x = g.x + Math.pow(r, 1.5) * (GATE_W - cell);

      // bite size (slightly larger / varied)
      const w = cell * (2 + ((prand(i * 7 + 2) * 4) | 0));
      const h = cell * (1 + ((prand(i * 11 + 3) * 3) | 0));

      // jitter
      const jitter = (prand(i * 13 + 4) - 0.5) * 8 * strength;
      const y = onBottom ? yEdge + jitter : yEdge - h + jitter;

      ctx.fillRect(x, y, w, h);

      // 2) Occasionally spawn a neon crumb from this chip
      if (Math.random() < 0.35 * strength) {
        const vx = (Math.random() * 50 + 40) * (Math.random() < 0.5 ? -1 : 1);
        const vy = (onBottom ? -1 : 1) * (Math.random() * 30 + 10);
        spawnCrumb(x + w * 0.5, y + (onBottom ? 0 : h), vx * 0.8, vy * 0.8);
      }
    }

    // 3) Add a thin neon glow band at the edge (additive)
    ctx.globalCompositeOperation = "lighter";
    const glowA =
      0.12 + 0.1 * strength + 0.06 * Math.sin(time * 7 + g.x * 0.01);
    ctx.fillStyle = `rgba(52,211,153,${glowA})`;
    const band = 6; // vertical thickness of glow “aura”
    ctx.fillRect(g.x, edgeTopY - band, GATE_W, band);
    ctx.fillRect(g.x, edgeBottomY, GATE_W, band);

    // faint scanline outline (source-over)
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(52,211,153,0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.x, edgeTopY);
    ctx.lineTo(g.x + GATE_W, edgeTopY);
    ctx.moveTo(g.x, edgeBottomY);
    ctx.lineTo(g.x + GATE_W, edgeBottomY);
    ctx.stroke();

    ctx.restore();
  }
  // Single source of truth for laser geometry
  function getLaserBounds() {
    // keep in sync with drawTopLaser visuals
    return { y: 3, h: 6 }; // beam from y=3 to y=9
  }

  function drawTopLaser() {
    const w = canvas.clientWidth;
    const { y, h } = getLaserBounds(); // << use shared bounds
    const pulse = 10 + 3 * Math.sin(time * 8); // glow “breathes”

    // Base beam
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, "rgba(255, 80, 80, 0.9)");
    grad.addColorStop(1, "rgba(220, 38, 38, 0.9)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, y, w, h);

    // Hot core line
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fillRect(0, y + h * 0.45, w, 1.2);

    // Glow (additive)
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(239, 68, 68, 0.22)";
    ctx.fillRect(0, 0, w, y + h + pulse);
    ctx.globalCompositeOperation = "source-over";
  }

  // --- Collision helpers ---
  function collidesRobotRect(rx, ry, rw, rh) {
    const bx = robot.x - 18,
      by = robot.y - 14,
      bw = 36,
      bh = 28;
    return !(bx > rx + rw || bx + bw < rx || by > ry + rh || by + bh < ry);
  }
  function collidesRobotCircle(cx, cy, cr) {
    const bx = robot.x,
      by = robot.y;
    const dx = bx - cx,
      dy = by - cy;
    return dx * dx + dy * dy <= (cr + 22) * (cr + 22);
  }

  // --- Spawner (factored for tests) ---
  function spawnOneGate() {
    let gapH, gapY;
    const minGap = Math.max(180, canvas.clientHeight * 0.24); // absolute floor for gap size
    const maxShift = Math.max(90, canvas.clientHeight * 0.22); // limit vertical jump required between gates
    const minXGap = Math.max(140, canvas.clientWidth * 0.18); // ensure horizontal spacing

    if (safeGates > 0) {
      gapH = Math.min(Math.max(260, canvas.clientHeight * 0.3), 340);
      gapY = canvas.clientHeight * 0.5 + rand(-20, 20);
      safeGates--;
    } else {
      const desired = clamp(
        lerp(
          GATE_GAP_MAX,
          GATE_GAP_MIN,
          (speed - START_SPEED) / (MAX_SPEED - START_SPEED + 0.0001)
        ),
        minGap,
        Math.max(240, canvas.clientHeight * 0.28)
      );
      gapH = desired;
      let target = rand(gapH * 0.6, canvas.clientHeight - gapH * 0.6);
      if (lastGapY == null) lastGapY = canvas.clientHeight * 0.5;
      gapY = clamp(target, lastGapY - maxShift, lastGapY + maxShift);
    }
    lastGapY = gapY;

    const candidateX = canvas.clientWidth + 10;
    const minX = lastGateX + GATE_W + Math.max(140, canvas.clientWidth * 0.18);
    const enforcedX = Math.max(candidateX, minX);

    gates.push({ x: enforcedX, gapY, gapH, scored: false });
    lastGateX = enforcedX;

    if (Math.random() < COIN_CHANCE) {
      // Clamp coin vertically to sit safely inside the gap (+margin)
      const y = clamp(
        gapY,
        gapY - gapH / 2 + (COIN_R + 6),
        gapY + gapH / 2 - (COIN_R + 6)
      );
      coins.push({ x: enforcedX + GATE_W / 2, y, spin: 0 }); // no vy drifting
    }

    // (shield spawn block)
    if (Math.random() < SHIELD_CHANCE) {
      // Keep shield strictly inside the gap, with a margin
      const margin = SHIELD_R + 8;
      const y = clamp(gapY, gapY - gapH / 2 + margin, gapY + gapH / 2 - margin);
      shields.push({
        x: enforcedX + GATE_W / 2,
        y,
        vy: 0, // no vertical drift so it can't wander into the beams
      });
    }
  }

  // --- Loop ---
  function step(ts) {
    if (!last) last = ts;
    const dt = Math.min((ts - last) / 1000, 1 / 24); // clamp big frame gaps
    last = ts;

    if (state === "PLAY" && !paused) update(dt);
    render(dt);

    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);

  function update(dt) {
    time += dt;

    // Antenna LED: random flash scheduler + decay
    led.next -= dt;
    if (led.next <= 0) {
      led.a = 1.25; // brighter peak
      led.next = rand(0.35, 1.2); // quicker cadence
    }
    if (led.a > 0) led.a = Math.max(0, led.a - dt * 3.2); // snappier fade

    // Speed increases over time
    speed = Math.min(MAX_SPEED, speed + SPEED_ACCEL * dt);

    // Spawn gates/coins/shields
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnTimer = GATE_INTERVAL;
      spawnOneGate();
    }

    // Robot physics
    if (holding && !robot.overheated) {
      robot.vy += THRUST * dt;
      robot.heat += HEAT_INC * dt;
    } else {
      robot.heat -= HEAT_DEC * dt;
    }
    robot.heat = clamp(robot.heat, 0, HEAT_MAX);
    robot.overheated = robot.heat >= HEAT_MAX - 0.001 && holding;

    // Throttle meter: ramps while holding, drops when released
    if (holding && !robot.overheated) {
      thrustHold = Math.min(1, thrustHold + dt * 1.8); // ~0.55s to full
    } else {
      thrustHold = Math.max(0, thrustHold - dt * 2.0);
    }

    robot.vy += GRAVITY * dt;
    robot.y += robot.vy * dt;

    // Boundaries
    const floor = canvas.clientHeight - 6,
      ceiling = 6;
    if (robot.y > floor) {
      robot.y = floor;
      crash();
    }
    if (robot.y < ceiling) {
      robot.y = ceiling;
      robot.vy = Math.max(0, robot.vy);
    }

    // Laser hazard (lethal even with shield)
    {
      const { y: ly, h: lh } = getLaserBounds();
      // small margin so what you see matches what kills you
      const margin = 1;
      if (
        collidesRobotRect(0, ly - margin, canvas.clientWidth, lh + margin * 2)
      ) {
        crash(); // do not consume shield; laser is instant KO
      }
    }

    // Move entities
    const dx = speed * dt;
    gates.forEach((g) => (g.x -= dx));
    coins.forEach((c) => {
      c.x -= dx;
      c.spin += dt * 1.9;
    });

    shields.forEach((s) => {
      s.x -= dx;
      s.y += s.vy * dt;
    });

    // --- emit short "spitting" pixel trail from both nozzles while thrusting ---
    if (holding && !robot.overheated) {
      const rate = 24 + 60 * thrustHold; // particles/sec, grows with hold time
      emitCarry += rate * dt; // accumulator to keep rate stable
      while (emitCarry > 1) {
        const jitter = (Math.random() - 0.5) * 3;
        spawnPuff(robot.x - 25, robot.y + 2 + jitter); // left nozzle
        spawnPuff(robot.x + 25, robot.y + 2 + jitter); // right nozzle
        emitCarry -= 1;
      }
    }

    // --- step & cull puffs ---
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 240 * dt; // slight downward pull
      if (p.age >= p.life) puffs.splice(i, 1);
    }

    // Collisions + scoring
    gates.forEach((g) => {
      // score when robot passes center
      if (!g.scored && g.x + GATE_W < robot.x) {
        score++;
        g.scored = true;
      }
      // collide with top/bottom blocks
      if (
        collidesRobotRect(g.x, 0, GATE_W, g.gapY - g.gapH / 2) ||
        collidesRobotRect(
          g.x,
          g.gapY + g.gapH / 2,
          GATE_W,
          canvas.clientHeight - (g.gapY + g.gapH / 2)
        )
      ) {
        if (robot.shield) {
          robot.shield = false;
          robot.shieldTimer = 0;
          nudge();
        } else crash();
      }
    });

    coins = coins.filter((c) => {
      if (collidesRobotCircle(c.x, c.y, COIN_R)) {
        coinsTaken++;
        score += 3;
        pop(c.x, c.y);
        return false;
      }
      return c.x > -40 && c.y > -40 && c.y < canvas.clientHeight + 40;
    });

    shields = shields.filter((s) => {
      if (collidesRobotCircle(s.x, s.y, SHIELD_R)) {
        robot.shield = true;
        robot.shieldTimer = 6;
        pulse(s.x, s.y);
        decayTimer = 1.8; // <<< start erosion for ~1.8s

        return false;
      }
      return s.x > -40 && s.y > -40 && s.y < canvas.clientHeight + 40;
    });

    if (robot.shield) {
      robot.shieldTimer -= dt;
      if (robot.shieldTimer <= 0) robot.shield = false;
    }

    if (decayTimer > 0) decayTimer -= dt;

    gates = gates.filter((g) => g.x > -GATE_W - 10);

    scoreEl.textContent = `Score: ${score}`;
  }

  function crash() {
    shake(7, 320);
    gameOver();
  }

  function gameOver() {
    state = "OVER";
    finalScore.textContent = score;
    finalCoins.textContent = coinsTaken;
    if (score > best) {
      best = score;
      localStorage.setItem("ixijet_best", String(best));
    }
    finalBest.textContent = best;
    bestEl.textContent = `Best: ${best}`;
    overOverlay.style.display = "grid";
  }

  // --- Tiny effects ---
  let shakeTime = 0,
    shakeMag = 0;
  function shake(mag, ms) {
    shakeMag = mag;
    shakeTime = ms / 1000;
  }
  function nudge() {
    shake(3, 180);
  }
  function pop(x, y) {
    flashes.push({ x, y, r: 4, alpha: 0.9 });
  }
  function pulse(x, y) {
    pulses.push({ x, y, t: 0 });
  }
  const flashes = [];
  const pulses = [];

  // Thruster "spitting" particles + hold throttle
  const puffs = [];
  let thrustHold = 0; // 0..1, how long you've been holding
  let emitCarry = 0; // emitter accumulator for stable emission rates

  function spawnPuff(x, y) {
    const burst = Math.random() < 0.12 + 0.28 * thrustHold; // occasional bigger spit
    const s = burst
      ? Math.random() < 0.5
        ? 3
        : 4
      : Math.random() < 0.5
      ? 2
      : 3;
    const vx = -(110 + 140 * thrustHold + Math.random() * 60); // drift left
    const vy = (Math.random() - 0.5) * (18 + 22 * thrustHold); // tiny vertical jitter
    const life = burst ? 0.18 : 0.28 + Math.random() * 0.12; // short-lived pixels
    puffs.push({ x, y, vx, vy, life, age: 0, size: s });
  }

  // Neon crumbs that fly off eroded gate edges
  const crumbs = [];
  function spawnCrumb(x, y, vx, vy) {
    // keep memory bounded
    if (crumbs.length > 180) crumbs.shift();
    crumbs.push({ x, y, vx, vy, a: 1, s: Math.random() < 0.5 ? 2 : 3 });
  }

  // Update + draw crumbs (additive)
  function drawCrumbs(dt) {
    if (!crumbs.length) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(52,211,153,0.9)";
    for (let i = crumbs.length - 1; i >= 0; i--) {
      const c = crumbs[i];
      // motion + fade
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vy += 220 * dt; // tiny gravity
      c.a -= dt / 0.55; // ~0.55s lifetime
      if (c.a <= 0) {
        crumbs.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.max(0, Math.min(1, c.a));
      ctx.fillRect(c.x | 0, c.y | 0, c.s, c.s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  function drawPuffs() {
    if (!puffs.length) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of puffs) {
      const a = Math.max(0, 1 - p.age / p.life);

      // tiny white-hot core
      ctx.globalAlpha = 0.55 * a;
      ctx.fillStyle = "rgba(255,255,255,1)";
      ctx.fillRect(p.x | 0, p.y | 0, p.size - 1, p.size - 1);

      // green glow rim
      ctx.globalAlpha = 0.9 * a;
      ctx.fillStyle = "rgba(52,211,153,1)";
      ctx.fillRect((p.x - 1) | 0, (p.y - 1) | 0, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function render(dt) {
    // Clear
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    drawBackground(dt);

    // Camera shake
    let ox = 0,
      oy = 0;
    if (shakeTime > 0) {
      shakeTime -= dt;
      const s = shakeTime > 0 ? shakeMag : 0;
      ox = (Math.random() - 0.5) * s;
      oy = (Math.random() - 0.5) * s;
    }
    ctx.save();
    ctx.translate(ox, oy);

    // Draw entities
    drawTopLaser();
    drawGates();
    drawCrumbs(dt); //  crumbs render above gates
    drawCoins();
    drawShields();
    drawPuffs();
    drawRobot(robot.x, robot.y, robot.shield);

    // Effects
    flashes.forEach((f) => {
      f.r += 120 * dt;
      f.alpha -= 1.8 * dt;
    });
    flashes.splice(0, flashes.length, ...flashes.filter((f) => f.alpha > 0));
    flashes.forEach((f) => {
      ctx.globalAlpha = Math.max(0, f.alpha);
      ctx.strokeStyle = "#fde047";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    pulses.forEach((p) => {
      p.t += dt;
    });
    pulses.splice(0, pulses.length, ...pulses.filter((p) => p.t < 0.5));
    pulses.forEach((p) => {
      const a = 1 - p.t / 0.5;
      ctx.globalAlpha = a * 0.6;
      ctx.strokeStyle = "#7dd3fc";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, SHIELD_R + p.t * 60, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    ctx.restore();

    // HUD tweaks
    if (state === "PLAY" && paused) {
      ctx.fillStyle = "rgba(2,6,23,0.5)";
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "700 24px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        "Paused (P to resume)",
        canvas.clientWidth / 2,
        canvas.clientHeight / 2
      );
    }
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // --- Self tests (basic invariants) ---
  function runSelfTests() {
    const results = [];
    console.assert(clamp(5, 0, 10) === 5, "clamp mid failed");
    console.assert(clamp(-1, 0, 10) === 0, "clamp low failed");
    console.assert(clamp(11, 0, 10) === 10, "clamp high failed");

    resetWorld();
    for (let i = 0; i < 20; i++) spawnOneGate();

    const minGap = Math.max(180, canvas.clientHeight * 0.24);
    const maxShift = Math.max(90, canvas.clientHeight * 0.22);
    const minXGap = Math.max(140, canvas.clientWidth * 0.18);
    let ok = true;
    for (let i = 1; i < gates.length; i++) {
      const a = gates[i - 1],
        b = gates[i];
      const xgap = b.x - (a.x + GATE_W);
      if (xgap < minXGap - 0.01) {
        ok = false;
        results.push(`xgap(${i})=${xgap.toFixed(2)}`);
      }
      if (b.gapH < minGap - 0.01) {
        ok = false;
        results.push(`gapH(${i})=${b.gapH.toFixed(2)}`);
      }
      if (Math.abs(b.gapY - a.gapY) > maxShift + 0.01) {
        ok = false;
        results.push(`slope(${i})=${Math.abs(b.gapY - a.gapY).toFixed(2)}`);
      }
    }
    console.assert(ok, "Spawner constraints violated", results);
    if (ok) console.log("Self-tests passed ✓");

    resetWorld(); // clear test gates
  }

  // Start at menu and run tests once
  runSelfTests();
  toMenu();
})();
