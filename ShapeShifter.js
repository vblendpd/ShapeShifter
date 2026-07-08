function StartGame(canvas) {
  'use strict';

  //read the canvas actual size (CSS) so the internal drawing resolution matches what the browser is rendering
  //falls back to offsetWidth/offsetHeight and to 860x580 if the element has no size yet (hidden with display:none)
  const cssRect = canvas.getBoundingClientRect();
  const CANVAS_W = Math.round(cssRect.width) || canvas.offsetWidth || 860;

  //height fallback preserves the original 860x580 aspect ratio (580/860) if we only know the width
  const CANVAS_H = Math.round(cssRect.height) || canvas.offsetHeight || Math.round(CANVAS_W * (580 / 860));
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.style.display = 'block';
  canvas.style.cursor = 'crosshair';

  const ctx = canvas.getContext('2d');
  const TAU = Math.PI * 2; //one full turn in radians used everywhere angles wrap around a circle
  const HP_PER_STAGE = 2;  //hit points a boss tentacle node has at each of its 4 stages before it morph

  //linear interpolation
  const Lerp = (a, b, t) => a + (b - a) * t;

  //restrict v to the [mi, ma] range (used a lot for keeping things on-screen).
  const Clamp = (v, mi, ma) => Math.max(mi, Math.min(ma, v));

  //these functions are the core of the shape morphing visuals
  //every tentacle node is a polygon that can smoothly change its number of sides (hexagon -> pentagon -> square -> triangle)
  //and distorted frame by frame using one of wave, spiral, shatter, etc.

  //ease in/out curve: slow at both ends but fast in the middle
  //used as the default blend curve when morphing from one polygon to another
  const EaseSmooth = t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

  //elastic overshoot and settle
  //the curve briefly swings past 1 before settling giving a spring snap to the style
  //formula is the standard exponentially-decaying sine wave used for easing curves
  function EaseElastic(t) {
    if (t <= 0)
      return 0;
    if (t >= 1)
      return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
  }

  //returns 0 at the start/end of a morph and peaks at 1 halfway through a half sine wave
  //used to scale how strong a given distortion should be at any given point
  const MorphEnvelope = fp => Math.sin(fp * Math.PI);

  //vertex ring for a polygon that is transitioning between sF-sided shape and sT-sided shape blended by morph progress "mp"
  //sF/sT == 1 is treated as "no shape" (radius =  0)
  function BuildMorphVertices(cx, cy, r, rot, sF, sT, mp, ef) {
    ef = ef || EaseSmooth;
    const n = [];
    const nV = Math.max(sF, sT, 2); //always sample enough vertices to represent the denser of the two shapes
    for (let i = 0; i < nV; i++) {
      //angle of this vertex on the "from" shape and on the "to" shape
      //(i % sF)/sF spaces sF vertices evenly around the circle
      //rot is a slow continuous spin applied to the whole node
      const aF = sF === 1 ? 0 : (i % sF) / sF * TAU + rot;
      const aT = sT === 1 ? 0 : (i % sT) / sT * TAU + rot;
      const rF = sF === 1 ? 0 : r;
      const rT = sT === 1 ? 0 : r;
      const e = ef(mp);
      //convert polar coordinates and Lerp between the "from" point and "to" point using the eased progress "e"
      n.push({
        x: cx + Lerp(Math.cos(aF) * rF, Math.cos(aT) * rT, e),
        y: cy + Lerp(Math.sin(aF) * rF, Math.sin(aT) * rT, e)
      });
    }
    return n;
  }

  //traces a closed polygon path through a list of vertices without stroke
  function StrokeV(v) {
    ctx.beginPath();
    v.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.closePath();
  }

  //each DrawMorphXXX function takes the same base polygon (from BuildMorphVertices) and displaces its vertices
  //"fp" is morph progress in [0,1] and most styles scale their distortion strength by MorphEnvelope(fp)
  // the effect is strongest mid-morph and settles to a clean polygon once the morph complete

  //wave: walks along each polygon edge in S small steps and offsets each step perpendicular to the edge by a sine wave
  //phase depends on both position along the edge (t) and animation time (at)
  //the wave appears to travel along the outline over time
  function DrawMorphWave(cx, cy, r, rot, sF, sT, fp, at) {
    const v = BuildMorphVertices(cx, cy, r, rot, sF, sT, fp);
    const n = v.length;
    const S = 10;
    const wa = r * 0.14 * MorphEnvelope(fp);
    if (wa < 0.3) { //distortion negligible (mid-morph not happening)
      StrokeV(v);   //just draw the plain polygon
      return;
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const vA = v[i], vB = v[(i + 1) % n];
      for (let s = 0; s <= S; s++) {
        const t = s / S;
        const bx = Lerp(vA.x, vB.x, t);
        const by = Lerp(vA.y, vB.y, t);

        //px,py is the edge vector rotated 90° (i.e. the outward normal direction of this edge segment)
        const px = -(vB.y - vA.y);
        const py = vB.x - vA.x;
        const pl = Math.sqrt(px * px + py * py) || 1;       //edge length used to normalize
        const wo = Math.sin(t * Math.PI * 3 + at * 4) * wa; //wave offset: 3 ripples per edge animated by "at"
        (s === 0 && i === 0) ? ctx.moveTo(bx + px / pl * wo, by + py / pl * wo) : ctx.lineTo(bx + px / pl * wo, by + py / pl * wo);
      }
    }
    ctx.closePath();
  }

  //spring: "overshoot then settle"
  //uses the elastic easing curve instead of the smooth one
  //vertices fly slightly past their target position before snapping back
  function DrawMorphElastic(cx, cy, r, rot, sF, sT, fp) {
    StrokeV(BuildMorphVertices(cx, cy, r, rot, sF, sT, fp, EaseElastic));
  }

  //twist: each vertex of the base polygon is rotated about the node center by an angle that increases with vertex index (i/n)
  //the shape looks like it's wrung out like a spiral
  function DrawMorphSpiral(cx, cy, r, rot, sF, sT, fp) {
    const v = BuildMorphVertices(cx, cy, r, rot, sF, sT, fp);
    const n = v.length;
    const ms = Math.PI * 0.7 * MorphEnvelope(fp); //max swirl angle
    if (ms < 0.01) {
      StrokeV(v);
      return;
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const dx = v[i].x - cx;
      const dy = v[i].y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const a = Math.atan2(dy, dx);
      const sw = ms * (0.4 + 0.6 * (i / n)); //later vertices twist further than earlier ones
      i === 0 ? ctx.moveTo(cx + Math.cos(a + sw) * d, cy + Math.sin(a + sw) * d) : ctx.lineTo(cx + Math.cos(a + sw) * d, cy + Math.sin(a + sw) * d);
    }
    ctx.closePath();
  }

  //curl: this rotates only the "from" angle of each vertex by a curl angle "ca" before lerping to the "to"
  function DrawMorphCurl(cx, cy, r, rot, sF, sT, fp) {
    const nV = Math.max(sF, sT, 2);
    const ca = MorphEnvelope(fp) * Math.PI * 0.55;  //curl angle peaks mid-morph
    ctx.beginPath();
    for (let i = 0; i < nV; i++) {
      const aF = sF === 1 ? 0 : (i % sF) / sF * TAU + rot;
      const aT = sT === 1 ? 0 : (i % sT) / sT * TAU + rot;
      const rF = sF === 1 ? 0 : r;
      const rT = sT === 1 ? 0 : r;
      const e = EaseSmooth(fp);
      //same lerp as BuildMorphVertices but the "from" angle is offset by ca
      i === 0 ? ctx.moveTo(cx + Lerp(Math.cos(aF + ca) * rF, Math.cos(aT) * rT, e), cy + Lerp(Math.sin(aF + ca) * rF, Math.sin(aT) * rT, e)) : ctx.lineTo(cx + Lerp(Math.cos(aF + ca) * rF, Math.cos(aT) * rT, e), cy + Lerp(Math.sin(aF + ca) * rF, Math.sin(aT) * rT, e));
    }
    ctx.closePath();
  }

  //shatter: pushes every vertex outward along its own radial direction by a fixed amount "sr"
  function DrawMorphShatter(cx, cy, r, rot, sF, sT, fp) {
    const v = BuildMorphVertices(cx, cy, r, rot, sF, sT, fp);
    const n = v.length;
    const sr = r * 0.3 * MorphEnvelope(fp);
    if (sr < 0.3) {
      StrokeV(v);
      return;
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const dx = v[i].x - cx;
      const dy = v[i].y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      i === 0 ? ctx.moveTo(v[i].x + dx / d * sr, v[i].y + dy / d * sr) : ctx.lineTo(v[i].x + dx / d * sr, v[i].y + dy / d * sr);
    }
    ctx.closePath();
  }

  //inflate: scales every vertex radius uniformly by a factor pf
  //grows during the morph and shrinks back to 1
  //the whole shape looks like balloons outward and then deflates back to its normal size
  function DrawMorphInflate(cx, cy, r, rot, sF, sT, fp) {
    const pf = 1 + MorphEnvelope(fp) * 0.45;
    const nV = Math.max(sF, sT, 2); //up to 45% larger at the peak of the morph
    ctx.beginPath();
    for (let i = 0; i < nV; i++) {
      const aF = sF === 1 ? 0 : (i % sF) / sF * TAU + rot;
      const aT = sT === 1 ? 0 : (i % sT) / sT * TAU + rot;
      const rF = (sF === 1 ? 0 : r) * pf;
      const rT = (sT === 1 ? 0 : r) * pf;
      const e = EaseSmooth(fp);
      i === 0 ? ctx.moveTo(cx + Lerp(Math.cos(aF) * rF, Math.cos(aT) * rT, e), cy + Lerp(Math.sin(aF) * rF, Math.sin(aT) * rT, e)) : ctx.lineTo(cx + Lerp(Math.cos(aF) * rF, Math.cos(aT) * rT, e), cy + Lerp(Math.sin(aF) * rF, Math.sin(aT) * rT, e));
    }
    ctx.closePath();
  }

  //pull: takes the base polygon and yanks just ONE vertex selected by index "pi"
  //other vertex stays put
  function DrawMorphPull(cx, cy, r, rot, sF, sT, fp, pi) {
    const v = BuildMorphVertices(cx, cy, r, rot, sF, sT, fp);
    const n = v.length;
    const pd = r * 0.55 * MorphEnvelope(fp);
    const ti = (pi || 0) % n; //which vertex index gets pulled
    if (pd < 0.3) {
      StrokeV(v);
      return;
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      let px = v[i].x, py = v[i].y;
      if (i === ti) {
        const dx = px - cx;
        const dy = py - cy;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        px += dx / d * pd;
        py += dy / d * pd;
      }
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  //picks which distortion style function to run for a given node
  function DrawNodeShape(cx, cy, r, sF, sT, mp, style, rot, at, pi) {
    switch (style) {
      case 'wave':
        DrawMorphWave(cx, cy, r, rot, sF, sT, mp, at);
        break;
      case 'elastic':
        DrawMorphElastic(cx, cy, r, rot, sF, sT, mp);
        break;
      case 'spiral':
        DrawMorphSpiral(cx, cy, r, rot, sF, sT, mp);
        break;
      case 'curl':
        DrawMorphCurl(cx, cy, r, rot, sF, sT, mp);
        break;
      case 'shatter':
        DrawMorphShatter(cx, cy, r, rot, sF, sT, mp);
        break;
      case 'inflate':
        DrawMorphInflate(cx, cy, r, rot, sF, sT, mp);
        break;
      case 'pull':
        DrawMorphPull(cx, cy, r, rot, sF, sT, mp, pi);
        break;
      default:
        DrawMorphElastic(cx, cy, r, rot, sF, sT, mp);
    }
  }

  let gameTimer = 0, gameState = 'play';
  let gamePhase = 'bossintro', bossIntroTimer = 160;
  const keysDown = {};

  const _onKeyDown = e => {
    keysDown[e.key] = true;
    if (e.key === ' ')
      e.preventDefault(); //stop space bar from scrolling the page
  };

  const _onKeyUp = e => {
    keysDown[e.key] = false;
  };

  const _onMDown = () => {
    keysDown['shoot'] = true;
  };
  const _onMUp = () => {
    keysDown['shoot'] = false;
  };

  const _onMouseMove = e => {
    // Convert mouse position from CSS pixels to canvas-internal pixels,
    // since the canvas's CSS size and its drawing-buffer size (CANVAS_W/H)
    // can differ (e.g. canvas scaled by CSS).
    const rect = canvas.getBoundingClientRect(), mx = (e.clientX - rect.left) * (CANVAS_W / rect.width),
      my = (e.clientY - rect.top) * (CANVAS_H / rect.height);
    // Only let the player move once the cursor is in the lower "play area"
    // (below the dividing line drawn in DrawBackground), so mousing over the
    // HUD/boss area up top doesn't drag the ship up there.
    if (my > CANVAS_H * 0.517) {
      player.targetX = Clamp(mx, 20, CANVAS_W - 20);
      player.targetY = Clamp(my, CANVAS_H * 0.552, CANVAS_H - 35);
    }
  };
  const _onTouchMove = e => {
    e.preventDefault(); // stop the page from scrolling/zooming while dragging on the canvas
    const t = e.touches[0], rect = canvas.getBoundingClientRect();
    player.targetX = Clamp((t.clientX - rect.left) * (CANVAS_W / rect.width), 20, CANVAS_W - 20);
    player.targetY = Clamp((t.clientY - rect.top) * (CANVAS_H / rect.height), CANVAS_H * 0.552, CANVAS_H - 35);
    keysDown['shoot'] = true; // touch-dragging also auto-fires, since there's no separate "fire" button on mobile
  };
  const _onTouchEnd = () => {
    keysDown['shoot'] = false;
  };

  document.addEventListener('keydown', _onKeyDown);
  document.addEventListener('keyup', _onKeyUp);
  canvas.addEventListener('mousemove', _onMouseMove);
  canvas.addEventListener('mousedown', _onMDown);
  document.addEventListener('mouseup', _onMUp); // listens on document (not canvas) so releasing off-canvas still stops firing
  canvas.addEventListener('touchmove', _onTouchMove, {passive: false}); // passive:false so preventDefault() is allowed
  canvas.addEventListener('touchend', _onTouchEnd);

  let playerBullets = [], particles = [];

  //spawns "count" small glowing dots that fly outward from x,y in random directions
  //used for hit sparks and death explosions.
  function SpawnSparks(x, y, color, count = 8, speed = 3, lifetime = 0.6) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;            //random direction
      const v = speed * (0.5 + Math.random());  //random speed 0.5x-1.5x
      particles.push({
        x,
        y,
        velocityX: Math.cos(a) * v,
        velocityY: Math.sin(a) * v,
        life: lifetime,
        maxLife: lifetime,
        radius: 2 + Math.random() * 3,
        color,
        type: 'spark'
      });
    }
  }

  //spawns an expanding ring shockwave at x,y that grows from radius 8 to maxRadius
  //"delay" lets a ring wait before it starts expanding
  function SpawnRing(x, y, color, maxRadius, delay = 0) {
    particles.push({x, y, radius: 8, maxRadius, life: 1, color, type: 'ring', delay});
  }

  const player = {
    x: CANVAS_W * 0.5,
    y: CANVAS_H * 0.862,
    //targetX/targetY are where the mouse wants the ship to be
    //actual x,y eases toward this target each frame for smooth motion
    targetX: CANVAS_W * 0.5,
    targetY: CANVAS_H * 0.862,
    hitRadius: 15,
    moveSpeed: 3.8,       //pixels/frame added when using keyboard movement
    hp: 5,
    maxHp: 5,
    shootCooldown: 0,
    shootRate: 18         //frames between shots
  };


  //the boss is built from 4 tentacles each a chain of 3 nodes radiating from a central core
  //every node is an independently-destructible polygon
  const NODE_ANIM_STYLES = ['inflate', 'spiral', 'wave', 'shatter', 'pull', 'curl', 'elastic'];
  const NODE_COLORS = ['#b07fd4', '#3dba6b', '#f5a623', '#e8715a', '#ff9ecd', '#58d4c8', '#f0c040'];
  const TENTACLE_COUNT = 4;
  const TENTACLE_LENGTH = 3;

  //tentacle scale rescales all the hardcoded pixel distances relative to the canvas height the original art was tuned for
  const TS = CANVAS_H / 580;

  //distance from the core to node 0, node 0 to node 1, and node 1 to node 2 along a tentacle
  const TENTACLE_NODE_DISTANCES = [Math.round(120 * TS), Math.round(110 * TS), Math.round(95 * TS)];

  class TentacleNode {
    //ti = which tentacle (0..3)
    //ci = position along that tentacle, 0 = closest to the core, TENTACLE_LENGTH-1 = the tip
    constructor(ti, ci, color, style, pi) {
      this.tentacleIndex = ti;
      this.chainIndex = ci;
      this.color = color;
      this.animStyle = style;   //which DrawMorphXXX
      this.pullIndex = pi || 0; //which vertex the corner pull should tug

      //nodes closer to the core are drawn bigger (40/32/24 base radius for chain positions 0/1/2)
      this.drawRadius = Math.round((ci === 0 ? 40 : ci === 1 ? 32 : 24) * TS);

      //stage counts down from 3 to 0: each stage represents the node morphing into a shape with fewer sides
      //hp is the hit points within the current stage
      //once hp hits 0 the node either drops a stage or explode
      this.stage = 3;
      this.hp = HP_PER_STAGE;
      this.maxHp = HP_PER_STAGE;
      this.sidesFrom = 6;
      this.sidesTo = 6;
      this.morphProgress = 1; //1 = fully settled into current shape, 0 = just started morphing
      this.animPhase = Math.random() * TAU;
      this.rotation = Math.random() * TAU;
      this.rotationSpeed = 0.003 + Math.random() * 0.005; //each node spins at its own random slow rate
      this.dead = false;
      //world-space position recomputed every frame
      this.worldX = 0;
      this.worldY = 0;
    }

    //maps a stage number to a polygon side-count: stage 3 -> hexagon (6), stage 2 -> pentagon (5) etc.
    SidesForStage(s) {
      return s + 3;
    }

    Hit() {
      if (this.morphProgress < 1)
        return;
      this.hp--;
      SpawnSparks(this.worldX, this.worldY, this.color, 6, 2.5, 0.35);
      if (this.hp <= 0) {
        if (this.stage === 0) {
          //explode
          SpawnSparks(this.worldX, this.worldY, this.color, 30, 5.5, 1.2);
          SpawnRing(this.worldX, this.worldY, this.color, this.drawRadius * 2.5, 0);
          SpawnRing(this.worldX, this.worldY, this.color, this.drawRadius * 3.5, 10);
          this.dead = true;
          //destroying a node also destroy the tentacle beyond it
          //any node (chainIndex greater than this one) explodes too
          boss.nodes.forEach(n => {
            if (n.tentacleIndex === this.tentacleIndex && n.chainIndex > this.chainIndex && !n.dead) {
              SpawnSparks(n.worldX, n.worldY, n.color, 18, 4, 0.8);
              SpawnRing(n.worldX, n.worldY, n.color, n.drawRadius * 2, 0);
              n.dead = true;
            }
          });
        } else {
          //drop down one stage
          this.stage--;
          this.hp = HP_PER_STAGE;
          this.maxHp = HP_PER_STAGE;
          this.sidesFrom = this.SidesForStage(this.stage + 1);
          this.sidesTo = this.SidesForStage(this.stage);
          this.morphProgress = 0;
          SpawnSparks(this.worldX, this.worldY, this.color, 14, 3.5, 0.7);
          SpawnRing(this.worldX, this.worldY, this.color, this.drawRadius * 1.8, 0);
        }
      }
    }

    Update() {
      if (this.dead)
        return;
      this.animPhase += 0.025;
      this.rotation += this.rotationSpeed;
      //advance the morph animation toward 1 (fully transitioned) at a fixed rate
      if (this.morphProgress < 1)
        this.morphProgress = Math.min(1, this.morphProgress + 0.012);
    }

    Draw() {
      if (this.dead)
        return;
      const im = this.morphProgress < 1;
      const at = gameTimer * 0.012;
      ctx.save();
      ctx.shadowColor = this.color;
      //glow is strongest while actively morphing (im) otherwise a gentle idle pulse driven by animPhase
      ctx.shadowBlur = (im ? 32 : 8 + Math.sin(this.animPhase) * 2);

      //outer body: the full morph shape at this node drawRadius
      DrawNodeShape(this.worldX, this.worldY, this.drawRadius, this.sidesFrom, this.sidesTo, this.morphProgress, this.animStyle, this.rotation, at, this.pullIndex);
      ctx.fillStyle = im ? this.color + '33' : this.color + '1e';
      ctx.fill();
      ctx.strokeStyle = this.color;
      ctx.lineWidth = im ? 2.2 : 1.8;
      ctx.stroke();
      ctx.shadowBlur = 3;

      //inner core: smaller copy of the same morph shape (48% of the radius) drawn as a faint outline
      // giving the node a "shape within a shape" look
      DrawNodeShape(this.worldX, this.worldY, this.drawRadius * 0.48, this.sidesFrom, this.sidesTo, this.morphProgress, this.animStyle, this.rotation, at, this.pullIndex);
      ctx.strokeStyle = this.color + '55';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.shadowBlur = 0;

      const aR = this.drawRadius + 7, hr = this.hp / this.maxHp;
      ctx.beginPath();
      ctx.arc(this.worldX, this.worldY, aR, 0, TAU);
      ctx.strokeStyle = '#1e2a35';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      if (hr > 0) {
        ctx.beginPath();
        ctx.arc(this.worldX, this.worldY, aR, -Math.PI / 2, -Math.PI / 2 + TAU * hr);
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 5;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  //full set of 4 tentacles x 3 nodes = 12 TentacleNode instances
  //color and animation style are picked by indexing into the color/style
  function CreateBossNodes() {
    const n = [];
    for (let ti = 0; ti < TENTACLE_COUNT; ti++)
      for (let ci = 0; ci < TENTACLE_LENGTH; ci++)
        n.push(new TentacleNode(ti, ci, NODE_COLORS[(ti * 2 + ci) % NODE_COLORS.length], NODE_ANIM_STYLES[(ti + ci * 2) % NODE_ANIM_STYLES.length], (ti + ci) % 7));
    return n;
  }

  const boss = {
    x: CANVAS_W * 0.5,
    y: -80,                           //starts off-screen
    coreRadius: Math.round(52 * TS),
    internalTimer: 0,                 //boss own frame counter
    driftStartFrame: 0,               // internalTimer value at which idle drifting began
    nodes: CreateBossNodes(),

    IsAlive() {
      return this.nodes.some(n => !n.dead);
    },

    //computes the world-space position of tentacle ti node at chain position ci
    NodeWorldPosition(ti, ci) {
      //base angles are spread between 18 and 162° (aS..aE)
      //a fan across the top half of the boss not a full circle
      //all tentacles wave roughly downward from the core and not behind it
      const aS = Math.PI * 0.1;
      const aE = Math.PI * 0.9;
      const ba = aS + (ti / (TENTACLE_COUNT - 1)) * (aE - aS);

      //each tentacle base angle slowly sways back and forth over time
      //with a phase offset per tentacle (ti * 1.3) so they don't all sway in unison
      const td = Math.sin(this.internalTimer * 0.008 + ti * 1.3) * 0.28, angle = ba + td;

      let px = this.x;
      let py = this.y;

      //walk outward one link at a time from the core to node "ci"
      //accumulating both the base directional step and a perpendicular
      //"lateral wave" wobble at each link so the tentacle looks like undulating
      for (let s = 0; s <= ci; s++) {
        const sd = TENTACLE_NODE_DISTANCES[s] || 70;
        //lateral wave amplitude grows for links further from the core (s+1 multiplier)
        //each link phase-offset from the next by 0.8 so the wave appears to propagate down the tentacle
        const lw = Math.sin(this.internalTimer * 0.04 + ti * 0.9 - s * 0.8) * 10 * (s + 1) * 0.3;

        //perpendicular direction to the tentacle main angle
        const pa = angle + Math.PI / 2;
        px += Math.cos(angle) * sd + Math.cos(pa) * lw;
        py += Math.sin(angle) * sd + Math.sin(pa) * lw;
      }
      return {x: px, y: py};
    },

    Update() {
      this.internalTimer++;
      if (gamePhase === 'bossintro') {
        //ease the boss down from off-screen (-80) to its resting height
        //using a standard ease-in-out cubic-ish curve
        const p = 1 - (bossIntroTimer / 160);
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        this.x = CANVAS_W * 0.5;
        this.y = -80 + e * (Math.round(100 * TS) + 80);
        this.driftStartFrame = this.internalTimer; //keep drift phase reference up to date until the intro finishes
      } else {
        //idle drift once in the client area
        //a slow 8-ish figure wander
        const el = this.internalTimer - this.driftStartFrame;
        this.x = CANVAS_W * 0.5 + Math.sin(el * 0.004) * Math.round(100 * TS);
        this.y = Math.round(100 * TS) + Math.sin(el * 0.006) * Math.round(22 * TS);
      }
      this.nodes.forEach(n => {
        if (n.dead) return;
        const pos = this.NodeWorldPosition(n.tentacleIndex, n.chainIndex);
        n.worldX = pos.x;
        n.worldY = pos.y;
        n.Update();
      });
    },
    Draw() {
      //central core a dark circle with a purple outline
      ctx.save();
      ctx.shadowColor = '#b07fd4';
      ctx.shadowBlur = 28;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.coreRadius, 0, TAU);
      ctx.fillStyle = '#0d1117';
      ctx.fill();
      ctx.strokeStyle = '#b07fd4';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.internalTimer * 0.012);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * TAU;
        ctx.moveTo(Math.cos(a) * 20, Math.sin(a) * 20);
        ctx.lineTo(Math.cos(a) * 40, Math.sin(a) * 40);
      }
      ctx.strokeStyle = '#b07fd422';
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = '#b07fd4aa';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#e8c8ff';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CORE', this.x, this.y);
      ctx.restore();

      [...this.nodes].sort((a, b) => b.chainIndex - a.chainIndex).forEach(n => n.Draw());
    },
  };

  //update and culls all active particles
  function UpdateParticles() {
    particles = particles.filter(p => {
      if (p.type === 'spark') {
        p.x += p.velocityX;
        p.y += p.velocityY;
        p.velocityX *= 0.94;  //simple drag
        p.velocityY *= 0.94;
        p.life -= 0.022;
        return p.life > 0;
      }
      if (p.type === 'ring') {
        if (p.delay > 0) {
          p.delay--;  //ring is waiting to start
          return true;
        }
        //ease the ring radius toward maxRadius
        p.radius = Lerp(p.radius, p.maxRadius, 0.11);
        p.life -= 0.032;
        return p.life > 0;
      }
      return false; //unknown particle type
    });
  }

  //static starfield background
  const STARS = Array.from({length: 70}, () => ({
    x: Math.random() * CANVAS_W,
    y: Math.random() * CANVAS_H,
    radius: Math.random() * 1.3 + 0.3,
    twinkle: Math.random()
  }));

  //the main game logic
  function Update() {
    gameTimer++;

    //smoothing toward the mouse target
    player.x += (player.targetX - player.x) * 0.1;
    player.y += (player.targetY - player.y) * 0.1;
    player.x = Clamp(player.x, 20, CANVAS_W - 20);
    player.y = Clamp(player.y, CANVAS_H * 0.552, CANVAS_H - 35); //keep the ship within the lower area

    player.shootCooldown--;

    if (keysDown['shoot'] && player.shootCooldown <= 0) {
      player.shootCooldown = player.shootRate;
      playerBullets.push({
        x: player.x,
        y: player.y - player.hitRadius * 0.6,
        vx: 0,
        vy: -6.4,
        radius: 5,
        life: 300,
      });
    }

    if (gamePhase === 'bossintro') {
      bossIntroTimer--;
      boss.Update();
      if (bossIntroTimer <= 0)
        gamePhase = 'boss';
    } else if (gamePhase === 'boss') {
      if (boss.IsAlive()) {
        boss.Update();
      } else if (gameState === 'play') {
        gameState = 'win';
        for (let i = 0; i < 70; i++) {
          const s = 1 + Math.random() * 7;
          SpawnSparks(boss.x + (Math.random() - 0.5) * 220, boss.y + (Math.random() - 0.5) * 100, ['#f5a623', '#3dba6b', '#5bb8d4', '#b07fd4', '#e8715a'][i % 5], 1, s, 1.8);
        }
        for (let i = 0; i < 10; i++)
          SpawnRing(boss.x, boss.y, NODE_COLORS[i % NODE_COLORS.length], 180 + i * 50, i * 7);
      }
    }

    playerBullets = playerBullets.filter(b => {
      b.x += b.vx;
      b.y += b.vy;
      b.life--;
      if (b.life <= 0 || b.y < 0)
        return false;

      if (gamePhase === 'boss' || gamePhase === 'bossintro') {
        for (const n of boss.nodes) {
          if (n.dead)
            continue;

          if ((b.x - n.worldX) ** 2 + (b.y - n.worldY) ** 2 < (n.drawRadius * 1.1) ** 2) {
            n.Hit();
            return false;
          }
        }
      }
      return true;
    });
    UpdateParticles();
  }

  function DrawBackground() {
    ctx.strokeStyle = '#151f2e';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < CANVAS_W; x += 42) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_H);
      ctx.stroke();
    }
    for (let y = 0; y < CANVAS_H; y += 42) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_W, y);
      ctx.stroke();
    }

    STARS.forEach(s => {
      // Brightness oscillates with a sine wave; each star's `twinkle` value
      // both scales the amplitude slightly and offsets the phase, so stars
      // twinkle independently rather than all pulsing together.
      const b = 0.3 + s.twinkle * 0.35 * Math.sin(gameTimer * 0.015 + s.twinkle * 10) + 0.3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${b})`;
      ctx.fill();
    });
  }

  function DrawPlayer() {
    ctx.save();
    ctx.translate(player.x, player.y);
    const sc = '#7ec8e3';
    ctx.shadowColor = sc;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(0, -player.hitRadius);
    ctx.lineTo(-player.hitRadius * 0.65, player.hitRadius * 0.78);
    ctx.lineTo(0, player.hitRadius * 0.28);
    ctx.lineTo(player.hitRadius * 0.65, player.hitRadius * 0.78);
    ctx.closePath();
    ctx.fillStyle = '#0a1e30';
    ctx.fill();
    ctx.strokeStyle = sc;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = sc + '77';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -player.hitRadius * 0.45);
    ctx.lineTo(-player.hitRadius * 0.42, player.hitRadius * 0.28);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -player.hitRadius * 0.45);
    ctx.lineTo(player.hitRadius * 0.42, player.hitRadius * 0.28);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, player.hitRadius * 0.58, 3.5, 0, TAU);
    ctx.fillStyle = '#ff7f50';
    ctx.shadowColor = '#ff7f50';
    ctx.shadowBlur = 14;
    ctx.fill();

    //thruster flame
    const fl = 8 + Math.sin(gameTimer * 0.2) * 5;
    const fg = ctx.createLinearGradient(0, player.hitRadius * 0.7, 0, player.hitRadius * 0.7 + fl);
    fg.addColorStop(0, '#ff7f50cc');
    fg.addColorStop(1, '#ff7f5000');
    ctx.beginPath();
    ctx.moveTo(-3, player.hitRadius * 0.7);
    ctx.lineTo(0, player.hitRadius * 0.7 + fl);
    ctx.lineTo(3, player.hitRadius * 0.7);
    ctx.fillStyle = fg;
    ctx.shadowBlur = 0;
    ctx.fill();
    ctx.restore();
  }

  //body is drawn as a symmetric pair of bezier curve
  function DrawBullets() {
    playerBullets.forEach(b => {
      ctx.save();
      ctx.translate(b.x, b.y);

      //rotate so the bullet petal points along its velocity
      ctx.rotate(Math.atan2(b.vy, b.vx) + Math.PI / 2);

      const R = b.radius;
      ctx.shadowColor = '#aaddff';
      ctx.shadowBlur = 14;
      const bg = ctx.createLinearGradient(0, -R * 1.1, 0, R * 2.6);
      bg.addColorStop(0, '#ffffff');
      bg.addColorStop(0.35, '#aaddffcc');
      bg.addColorStop(1, '#aaddff00');
      ctx.beginPath();
      ctx.moveTo(0, -R * 1.15);
      ctx.bezierCurveTo(R * 1.2, -R * 0.4, R * 0.95, R * 1.3, 0, R * 2.6);
      ctx.bezierCurveTo(-R * 0.95, R * 1.3, -R * 1.2, -R * 0.4, 0, -R * 1.15);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(0, -R * 0.25, R * 0.55, 0, TAU); //bright core near the tip
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
    });
  }

  function DrawParticles() {
    particles.forEach(p => {
      ctx.save();
      if (p.type === 'spark') {
        const a = Math.max(0, p.life / p.maxLife);  //alpha fades linearly with remaining life fraction
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius * a, 0, TAU);    //spark also shrinks in size as it dies, not just fades
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 9;
        ctx.fill();
      } else if (p.type === 'ring') {
        if (p.delay > 0) {
          ctx.restore();
          return; //still waiting to start expanding
        }
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, TAU);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2.5 * p.life; //ring stroke also thins out as it fades
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 12;
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  //fullscreen dark overlay with a big win headline
  function DrawWinOverlay() {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.textAlign = 'center';
    ctx.font = 'bold 44px monospace';
    ctx.fillStyle = '#349356';
    ctx.shadowColor = '#3dba6b';
    ctx.shadowBlur = 15;
    ctx.fillText('BOSS DESTROYED', CANVAS_W / 2, CANVAS_H / 2);
    ctx.restore();
  }

  function Render() {
    if (gameState !== 'win') {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      DrawBackground();
      boss.Draw();
      DrawPlayer();
      DrawBullets();
      DrawParticles();
    }

    if (gameState === 'win')
      DrawWinOverlay();
  }

  let _rafId = null;

  //main loop
  function GameLoop() {
    _rafId = requestAnimationFrame(GameLoop);
    if (gameState === 'play')
      Update();
    Render();
  }

  GameLoop();

  return {
    destroy() {
      cancelAnimationFrame(_rafId);
      document.removeEventListener('keydown', _onKeyDown);
      document.removeEventListener('keyup', _onKeyUp);
      document.removeEventListener('mouseup', _onMUp);
      canvas.removeEventListener('mousemove', _onMouseMove);
      canvas.removeEventListener('mousedown', _onMDown);
      canvas.removeEventListener('touchmove', _onTouchMove);
      canvas.removeEventListener('touchend', _onTouchEnd);
    }
  };
}
