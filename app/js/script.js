
(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('gameWrap');
  let W = 360, H = 640;

  function resize() {
    const rect = wrap.getBoundingClientRect();
    W = canvas.width = Math.floor(rect.width * devicePixelRatio);
    H = canvas.height = Math.floor(rect.height * devicePixelRatio);
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(devicePixelRatio, devicePixelRatio);
  }
  new ResizeObserver(resize).observe(wrap);
  resize();

  // --- Game constants ---
  const GRAVITY = 1000; // px/s^2 (tuned)
  const THRUST = -2200;  // px/s^2 (hold-to-rise)
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
  const HEAT_INC = 32;   // per second when thrusting
  const HEAT_DEC = 34;   // per second when not thrusting

  // --- Game state ---
  let state = 'MENU';
  let time = 0, last = 0;
  let speed = START_SPEED;
  let gates = []; // {x, gapY, gapH}
  let coins = []; // {x,y,vy,spin}
  let shields = []; // {x,y,vy}
  let spawnTimer = 0, safeGates = 0, lastGapY = null, lastGateX = -9999;
  let score = 0, coinsTaken = 0;
  let best = Number(localStorage.getItem('ixijet_best')||0);

  // Robot
  const robot = { x: 0, y: 0, vy: 0, heat: 0, overheated: false, alive: true, shield:false, shieldTimer:0 };

  // Input
  let holding = false;
  function setHold(v){ holding = v; }
  window.addEventListener('keydown', e=>{
    if (e.repeat) return;
    if (e.code==='Space') { if(state!=='PLAY') start(); setHold(true); e.preventDefault(); }
    if (e.key==='p' || e.key==='P') togglePause();
    if (e.key==='r' || e.key==='R') restart();
  });
  window.addEventListener('keyup', e=>{ if (e.code==='Space') { setHold(false); e.preventDefault(); } });
  ['pointerdown','touchstart','mousedown'].forEach(ev => window.addEventListener(ev, (e)=>{ if(state!=='PLAY') start(); setHold(true); }));
  ['pointerup','pointercancel','touchend','mouseup','mouseleave'].forEach(ev => window.addEventListener(ev, ()=> setHold(false)));

  // UI Elements
  const scoreEl = document.getElementById('score');
  const bestEl  = document.getElementById('best');
  const jetfill = document.getElementById('jetfill');
  const menuOverlay = document.getElementById('menu');
  const howOverlay = document.getElementById('how');
  const overOverlay = document.getElementById('gameover');
  const finalScore = document.getElementById('finalScore');
  const finalBest = document.getElementById('finalBest');
  const finalCoins = document.getElementById('finalCoins');
  bestEl.textContent = `Best: ${best}`;

  document.getElementById('startBtn').onclick = ()=>{ start(); };
  document.getElementById('howBtn').onclick = ()=>{ howOverlay.style.display='grid'; menuOverlay.style.display='none'; };
  document.getElementById('backBtn').onclick = ()=>{ howOverlay.style.display='none'; menuOverlay.style.display='grid'; };
  document.getElementById('retryBtn').onclick = ()=>{ restart(); };
  document.getElementById('menuBtn').onclick = ()=>{ toMenu(); };

  function toMenu(){ state='MENU'; menuOverlay.style.display='grid'; howOverlay.style.display='none'; overOverlay.style.display='none'; }
  function start(){
    state='PLAY';
    menuOverlay.style.display='none'; howOverlay.style.display='none'; overOverlay.style.display='none';
    resetWorld();
  }
  function restart(){ if(state!=='PLAY') start(); }
  let paused=false;
  function togglePause(){ if(state==='PLAY'){ paused=!paused; }}

  function resetWorld(){
    speed = START_SPEED;
    gates.length=0; coins.length=0; shields.length=0;
    spawnTimer = 0; score = 0; coinsTaken=0; time=0; last=0;
    robot.x = Math.floor(W/devicePixelRatio * ROBOT_X);
    robot.y = (H/devicePixelRatio)/2; robot.vy = 0; robot.heat=0; robot.overheated=false; robot.alive=true; robot.shield=false; robot.shieldTimer=0; safeGates = 3; lastGapY = canvas.clientHeight * 0.5; lastGateX = -9999; // generous gaps for first gates
  }

  // --- Helpers ---
  function rand(min,max){ return Math.random()*(max-min)+min; }
  function clamp(v,min,max){ return v<min?min:(v>max?max:v); }

  // --- Drawing ---
  function drawBackground(dt){
    // Parallax starfield + faint grid
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const t = time * 0.04;

    // Stars
    const layers = [0.3, 0.6, 1.0];
    layers.forEach((m,i)=>{
      const starCount = 30 + i*20;
      ctx.globalAlpha = 0.4 + i*0.2;
      for(let s=0; s<starCount; s++){
        const x = ((s*97.3)%w) - (t * speed * (0.2+m));
        const y = ((s*53.7 + i*123.4)%h);
        const xr = ((x%w)+w)%w;
        ctx.fillStyle = i===2? '#c7d2fe' : '#93c5fd';
        ctx.fillRect(xr, y, i===0? 1: 2, i===0?1:2);
      }
    });
    ctx.globalAlpha = 1;

    // Faint scanlines
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for(let y=0;y<h;y+=3){ ctx.fillRect(0,y,w,1); }
  }

  function drawRobot(x,y,shield){
    // Ixian green robot with jetpack flame
    ctx.save();
    ctx.translate(x,y);

    // Body
    ctx.fillStyle = '#16a34a'; // green body
    ctx.strokeStyle = 'rgba(200,255,220,0.6)';
    ctx.lineWidth = 2;
    roundRect(-18,-14,36,28,8,true,true);

    // Eye visor
    ctx.fillStyle = '#0b1a12';
    roundRect(-12,-6,24,12,6,true,false);
    // Eye glow
    ctx.fillStyle = '#86efac';
    ctx.fillRect(-6,-3,12,6);

    // Antenna
    ctx.strokeStyle = '#34d399';
    ctx.beginPath(); ctx.moveTo(0,-14); ctx.lineTo(0,-22); ctx.stroke();
    ctx.fillStyle = '#34d399'; ctx.beginPath(); ctx.arc(0,-24,3,0,Math.PI*2); ctx.fill();

    // Jetpack thrusters
    ctx.fillStyle = '#173d2a';
    roundRect(-22,-6,6,12,3,true,false);
    roundRect(16,-6,6,12,3,true,false);

    // Flame if thrusting
    if (holding && !robot.overheated) {
      const f = (Math.sin(time*60)+1)/2; // flicker 0..1
      const len = 16 + f*9;
      const jitter = (Math.random()-0.5)*2;
      const gradL = ctx.createLinearGradient(-25,0,-25+len,0);
      gradL.addColorStop(0,'#fca5a5'); gradL.addColorStop(0.4,'#fdba74'); gradL.addColorStop(1,'#fde047');
      ctx.fillStyle = gradL;
      flame(-25, 2+jitter, len);
      const gradR = ctx.createLinearGradient(25,0,25-len,0);
      gradR.addColorStop(0,'#fca5a5'); gradR.addColorStop(0.4,'#fdba74'); gradR.addColorStop(1,'#fde047');
      ctx.fillStyle = gradR;
      flame(25, 2-jitter, -len);
    }

    // Shield effect
    if (shield){
      ctx.strokeStyle = `rgba(52,211,153,${0.6 + 0.3*Math.sin(time*6)})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0,0,26,0,Math.PI*2); ctx.stroke();
    }

    ctx.restore();
  }

  function roundRect(x,y,w,h,r,fill,stroke){
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y, x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x, y+h, rr);
    ctx.arcTo(x, y+h, x, y, rr);
    ctx.arcTo(x, y, x+w, y, rr);
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }
  function flame(x,y,len){
    ctx.beginPath();
    ctx.moveTo(x,y-3);
    ctx.quadraticCurveTo(x+len*0.3, y, x, y+3);
    ctx.quadraticCurveTo(x-len*0.2, y, x, y-3);
    ctx.fill();
  }

  function drawGates(){
    ctx.strokeStyle = '#22c55e';
    ctx.fillStyle = '#0c2a18';
    ctx.lineWidth = 3;
    gates.forEach(g=>{
      // Left pillar
      roundRect(g.x, 0, GATE_W, g.gapY - g.gapH/2, 10, true, false);
      // Right pillar
      roundRect(g.x, g.gapY + g.gapH/2, GATE_W, canvas.clientHeight - (g.gapY + g.gapH/2), 10, true, false);
      // Edges glow
      ctx.strokeStyle = 'rgba(34,197,94,0.85)';
      ctx.strokeRect(g.x+1.5, 0, GATE_W-3, g.gapY - g.gapH/2);
      ctx.strokeRect(g.x+1.5, g.gapY + g.gapH/2, GATE_W-3, canvas.clientHeight - (g.gapY + g.gapH/2));
      // Animated field
      const t = (time*120) % 20;
      ctx.fillStyle = 'rgba(34,197,94,0.12)';
      ctx.fillRect(g.x, g.gapY - g.gapH/2 - t, GATE_W, 6);
      ctx.fillRect(g.x, g.gapY + g.gapH/2 + t - 6, GATE_W, 6);
    });
  }

  function drawCoins(){
    coins.forEach(c=>{
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.spin);
      const r = COIN_R;
      const grad = ctx.createRadialGradient(0,0,2,0,0,r);
      grad.addColorStop(0,'#fef9c3'); grad.addColorStop(1,'#f59e0b');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.ellipse(0,0,r, r*0.7, 0, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(-r*0.5,-2,r,4);
      ctx.restore();
    });
  }

  function drawShields(){
    shields.forEach(s=>{
      ctx.save();
      ctx.translate(s.x, s.y);
      const r = SHIELD_R;
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#34d399';
      ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    });
  }

  // --- Collision helpers ---
  function collidesRobotRect(rx, ry, rw, rh){
    const bx = robot.x - 18, by = robot.y - 14, bw = 36, bh = 28;
    return !(bx>rx+rw || bx+bw<rx || by>ry+rh || by+bh<ry);
  }
  function collidesRobotCircle(cx,cy,cr){
    const bx = robot.x, by = robot.y;
    const dx = bx - cx, dy = by - cy;
    return (dx*dx + dy*dy) <= (cr+22)*(cr+22);
  }

  // --- Spawner (factored for tests) ---
  function spawnOneGate(){
    let gapH, gapY;
    const minGap = Math.max(180, canvas.clientHeight * 0.24); // absolute floor for gap size
    const maxShift = Math.max(90, canvas.clientHeight * 0.22); // limit vertical jump required between gates
    const minXGap = Math.max(140, canvas.clientWidth * 0.18); // ensure horizontal spacing

    if (safeGates > 0) {
      gapH = Math.min(Math.max(260, canvas.clientHeight * 0.3), 340);
      gapY = canvas.clientHeight * 0.5 + rand(-20, 20);
      safeGates--;
    } else {
      const desired = clamp( lerp(GATE_GAP_MAX, GATE_GAP_MIN, (speed-START_SPEED)/(MAX_SPEED-START_SPEED+0.0001) ), minGap, Math.max(240, canvas.clientHeight*0.28) );
      gapH = desired;
      let target = rand(gapH*0.6, canvas.clientHeight-gapH*0.6);
      if (lastGapY == null) lastGapY = canvas.clientHeight * 0.5;
      gapY = clamp(target, lastGapY - maxShift, lastGapY + maxShift);
    }
    lastGapY = gapY;

    const candidateX = canvas.clientWidth + 10;
    const minX = lastGateX + GATE_W + Math.max(140, canvas.clientWidth * 0.18);
    const enforcedX = Math.max(candidateX, minX);

    gates.push({ x: enforcedX, gapY, gapH, scored:false });
    lastGateX = enforcedX;

    if (Math.random() < COIN_CHANCE){
      coins.push({ x: enforcedX + GATE_W/2, y: gapY + rand(-gapH*0.25, gapH*0.25), vy: rand(-10,10), spin: Math.random()*Math.PI });
    }
    if (Math.random() < SHIELD_CHANCE){
      shields.push({ x: enforcedX + GATE_W/2, y: gapY + rand(-gapH*0.25, gapH*0.25), vy: rand(-8,8) });
    }
  }

  // --- Loop ---
  function step(ts){
    if (!last) last = ts;
    const dt = Math.min( (ts - last)/1000, 1/24 ); // clamp big frame gaps
    last = ts;

    if (state==='PLAY' && !paused) update(dt);
    render(dt);

    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);

  function update(dt){
    time += dt;

    // Speed increases over time
    speed = Math.min(MAX_SPEED, speed + SPEED_ACCEL*dt);

    // Spawn gates/coins/shields
    spawnTimer -= dt;
    if (spawnTimer <= 0){
      spawnTimer = GATE_INTERVAL;
      spawnOneGate();
    }

    // Robot physics
    if (holding && !robot.overheated){ robot.vy += THRUST * dt; robot.heat += HEAT_INC*dt; }
    else { robot.heat -= HEAT_DEC*dt; }
    robot.heat = clamp(robot.heat, 0, HEAT_MAX);
    robot.overheated = robot.heat >= HEAT_MAX - 0.001 && holding;

    robot.vy += GRAVITY * dt;
    robot.y += robot.vy * dt;

    // Boundaries
    const floor = canvas.clientHeight - 6, ceiling = 6;
    if (robot.y > floor){ robot.y = floor; crash(); }
    if (robot.y < ceiling){ robot.y = ceiling; robot.vy = Math.max(0, robot.vy); }

    // Move entities
    const dx = speed * dt;
    gates.forEach(g=> g.x -= dx);
    coins.forEach(c=>{ c.x -= dx; c.y += c.vy*dt; c.spin += dt*6; });
    shields.forEach(s=>{ s.x -= dx; s.y += s.vy*dt; });

    // Collisions + scoring
    gates.forEach(g=>{
      // score when robot passes center
      if (!g.scored && g.x + GATE_W < robot.x){ score++; g.scored = true; }
      // collide with top/bottom blocks
      if (collidesRobotRect(g.x, 0, GATE_W, g.gapY - g.gapH/2) || collidesRobotRect(g.x, g.gapY + g.gapH/2, GATE_W, canvas.clientHeight - (g.gapY + g.gapH/2))){
        if (robot.shield){ robot.shield=false; robot.shieldTimer=0; nudge(); } else crash();
      }
    });

    coins = coins.filter(c=>{
      if (collidesRobotCircle(c.x, c.y, COIN_R)) { coinsTaken++; score += 3; pop(c.x,c.y); return false; }
      return c.x > -40 && c.y>-40 && c.y < canvas.clientHeight+40;
    });

    shields = shields.filter(s=>{
      if (collidesRobotCircle(s.x, s.y, SHIELD_R)) { robot.shield = true; robot.shieldTimer = 6; pulse(s.x,s.y); return false; }
      return s.x > -40 && s.y>-40 && s.y < canvas.clientHeight+40;
    });

    if (robot.shield){ robot.shieldTimer -= dt; if (robot.shieldTimer<=0) robot.shield=false; }

    gates = gates.filter(g=> g.x > -GATE_W-10);

    scoreEl.textContent = `Score: ${score}`;
    jetfill.style.height = `${(robot.heat/HEAT_MAX)*100}%`;
  }

  function crash(){
    shake(7, 320);
    gameOver();
  }

  function gameOver(){
    state='OVER';
    finalScore.textContent = score;
    finalCoins.textContent = coinsTaken;
    if (score>best){ best=score; localStorage.setItem('ixijet_best', String(best)); }
    finalBest.textContent = best;
    bestEl.textContent = `Best: ${best}`;
    overOverlay.style.display='grid';
  }

  // --- Tiny effects ---
  let shakeTime=0, shakeMag=0;
  function shake(mag, ms){ shakeMag = mag; shakeTime = ms/1000; }
  function nudge(){ shake(3,180); }
  function pop(x,y){ flashes.push({x,y,r:4,alpha:0.9}); }
  function pulse(x,y){ pulses.push({x,y,t:0}); }
  const flashes=[]; const pulses=[];

  function render(dt){
    // Clear
    ctx.clearRect(0,0,canvas.clientWidth, canvas.clientHeight);
    drawBackground(dt);

    // Camera shake
    let ox=0, oy=0;
    if (shakeTime>0){ shakeTime -= dt; const s = (shakeTime>0? shakeMag:0); ox = (Math.random()-0.5)*s; oy = (Math.random()-0.5)*s; }
    ctx.save(); ctx.translate(ox, oy);

    // Draw entities
    drawGates();
    drawCoins();
    drawShields();
    drawRobot(robot.x, robot.y, robot.shield);

    // Effects
    flashes.forEach(f=>{ f.r += 120*dt; f.alpha -= 1.8*dt; });
    flashes.splice(0, flashes.length, ...flashes.filter(f=> f.alpha>0));
    flashes.forEach(f=>{ ctx.globalAlpha = Math.max(0,f.alpha); ctx.strokeStyle = '#fde047'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(f.x,f.y,f.r,0,Math.PI*2); ctx.stroke(); ctx.globalAlpha=1; });

    pulses.forEach(p=>{ p.t += dt; });
    pulses.splice(0,pulses.length, ...pulses.filter(p=> p.t<0.5));
    pulses.forEach(p=>{ const a = 1 - p.t/0.5; ctx.globalAlpha=a*0.6; ctx.strokeStyle='#7dd3fc'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(p.x,p.y, SHIELD_R + p.t*60, 0, Math.PI*2); ctx.stroke(); ctx.globalAlpha=1; });

    ctx.restore();

    // HUD tweaks
    if (state==='PLAY' && paused){
      ctx.fillStyle = 'rgba(2,6,23,0.5)'; ctx.fillRect(0,0,canvas.clientWidth, canvas.clientHeight);
      ctx.fillStyle = '#e2e8f0'; ctx.font = '700 24px system-ui, sans-serif'; ctx.textAlign='center';
      ctx.fillText('Paused (P to resume)', canvas.clientWidth/2, canvas.clientHeight/2);
    }
  }

  function lerp(a,b,t){ return a+(b-a)*t; }

  // --- Self tests (basic invariants) ---
  function runSelfTests(){
    const results = [];
    console.assert(clamp(5,0,10)===5, 'clamp mid failed');
    console.assert(clamp(-1,0,10)===0, 'clamp low failed');
    console.assert(clamp(11,0,10)===10, 'clamp high failed');

    resetWorld();
    for(let i=0;i<20;i++) spawnOneGate();

    const minGap = Math.max(180, canvas.clientHeight * 0.24);
    const maxShift = Math.max(90, canvas.clientHeight * 0.22);
    const minXGap = Math.max(140, canvas.clientWidth * 0.18);
    let ok = true;
    for(let i=1;i<gates.length;i++){
      const a=gates[i-1], b=gates[i];
      const xgap = b.x - (a.x + GATE_W);
      if (xgap < minXGap - 0.01){ ok=false; results.push(`xgap(${i})=${xgap.toFixed(2)}`); }
      if (b.gapH < minGap - 0.01){ ok=false; results.push(`gapH(${i})=${b.gapH.toFixed(2)}`); }
      if (Math.abs(b.gapY - a.gapY) > maxShift + 0.01){ ok=false; results.push(`slope(${i})=${Math.abs(b.gapY-a.gapY).toFixed(2)}`); }
    }
    console.assert(ok, 'Spawner constraints violated', results);
    if (ok) console.log('Self-tests passed ✓');

    resetWorld(); // clear test gates
  }

  // Start at menu and run tests once
  runSelfTests();
  toMenu();
})();