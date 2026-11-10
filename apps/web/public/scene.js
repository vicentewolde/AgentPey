/* AgentPey landing: the 3D market in the hero. Reads no data and writes no HTML; Three.js is served from /vendor/three.min.js (r128, MIT). */
(function () {
  var fb = document.getElementById("fallback");
  if (!window.THREE) return;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var canvas = document.getElementById("scene"), hero = document.querySelector(".hero");
  var renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true }); } catch (e) { return; }
  fb.hidden = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  var BLUE = 0x176bff, i, k;
  var scene = new THREE.Scene(); scene.background = new THREE.Color(BLUE); scene.fog = new THREE.Fog(BLUE, 28, 60);
  var cam = new THREE.PerspectiveCamera(30, 1, 0.1, 120);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0b3fb8, 0.85));
  var sun = new THREE.DirectionalLight(0xfff8ee, 1.0); sun.position.set(8, 16, 10); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); var sc = sun.shadow.camera; sc.left = -18; sc.right = 18; sc.top = 18; sc.bottom = -18; sc.near = 1; sc.far = 55; sun.shadow.bias = -0.0005; sun.shadow.radius = 3;
  scene.add(sun);
  var fill = new THREE.DirectionalLight(0x9fc2ff, 0.35); fill.position.set(-9, 6, 4); scene.add(fill);
  var world = new THREE.Group(); scene.add(world);

  function std(hex, r, m) { return new THREE.MeshStandardMaterial({ color: hex, roughness: r == null ? 0.7 : r, metalness: m || 0 }); }
  function glow(hex, e) { return new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: e == null ? 0.9 : e, roughness: 0.4 }); }
  var mWhite = std(0xffffff, 0.8), mInk = std(0x070b16, 0.55), mDark = std(0x0d1424, 0.8), mMetal = std(0xd5dcec, 0.3, 0.8);
  var mGlass = new THREE.MeshStandardMaterial({ color: 0xa9d2ff, emissive: 0x2a5fff, emissiveIntensity: 0.38, roughness: 0.08, metalness: 0.3 });
  var mWood = std(0xc9965a, 0.85), mLeaf = std(0x2fd18f, 0.8), mLeaf2 = std(0x1fb67c, 0.8);
  function box(w, h, d, mat, x, y, z, parent, cast) { var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); if (cast !== false) { m.castShadow = true; m.receiveShadow = true; } (parent || world).add(m); return m; }
  function cyl(rt, rb, h, mat, x, y, z, parent, seg) { var m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 16), mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; (parent || world).add(m); return m; }
  function ball(r, mat, x, y, z, parent) { var m = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), mat); m.position.set(x, y, z); m.castShadow = true; (parent || world).add(m); return m; }

  // ground: table, plaza, rings painted on the paving
  var ground = new THREE.Mesh(new THREE.CircleGeometry(21, 80), std(0x1259e8, 1)); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; world.add(ground);
  var plaza = new THREE.Mesh(new THREE.CircleGeometry(12.6, 72), std(0x2b72ff, 1)); plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.01; plaza.receiveShadow = true; world.add(plaza);
  [[5.9, 6.0], [8.5, 8.58], [11.4, 11.5]].forEach(function (r) { var rg = new THREE.Mesh(new THREE.RingGeometry(r[0], r[1], 96), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, side: THREE.DoubleSide })); rg.rotation.x = -Math.PI / 2; rg.position.y = 0.025; world.add(rg); });
  var grid = new THREE.GridHelper(42, 42, 0x7aaaff, 0x4f8aff); grid.position.y = 0.012; grid.material.transparent = true; grid.material.opacity = 0.18; world.add(grid);

  // shops
  var stores = [], NS = 6, ACC = [0x6df2c0, 0xffffff, 0xffb199, 0x9fd0ff, 0x6df2c0, 0xffffff];
  for (i = 0; i < NS; i++) {
    var a = (-64 + i * (128 / (NS - 1))) * Math.PI / 180, r = 9.6, px = Math.sin(a) * r, pz = -Math.cos(a) * r * 0.78;
    var g = new THREE.Group(); g.position.set(px, 0, pz); g.rotation.y = Math.atan2(-px, -pz); world.add(g);
    var h = 2.4 + (i % 3) * 0.5;
    box(2.5, h, 2.1, mWhite, 0, h / 2, 0, g); box(2.62, 0.18, 2.22, mInk, 0, 0.09, 0, g); box(2.62, 0.14, 2.22, mInk, 0, h + 0.07, 0, g);
    box(0.7, 0.34, 0.55, std(0xcfd6e6, 0.6), 0.7, h + 0.31, -0.3, g);
    [-0.92, 0.92].forEach(function (sx) { box(0.62, 0.76, 0.06, mInk, sx, 0.95, 1.06, g); box(0.5, 0.64, 0.05, mGlass, sx, 0.95, 1.09, g, false); });
    box(0.74, 1.15, 0.06, mInk, 0, 0.755, 1.06, g); box(0.5, 0.74, 0.05, mGlass, 0, 0.92, 1.09, g, false); ball(0.035, mMetal, 0.26, 0.7, 1.11, g);
    for (k = 0; k < 6; k++) { var sl = box(0.46, 0.06, 0.95, k % 2 ? mInk : mWhite, -1.15 + k * 0.46, 1.55, 1.42, g); sl.rotation.x = 0.28; }
    box(1.7, 0.34, 0.06, std(ACC[i], 0.5), 0, 1.98, 1.07, g, false).material.emissive = new THREE.Color(ACC[i]).multiplyScalar(0.22);
    var lamp = ball(0.13, glow(0x6df2c0), 0, h + 0.7, 0, g); box(0.04, 0.4, 0.04, mInk, 0, h + 0.4, 0, g, false);
    box(0.5, 0.42, 0.5, mWood, 1.6, 0.21, 1.5, g); box(0.4, 0.34, 0.4, mWood, 1.58, 0.59, 1.5, g).rotation.y = 0.5; box(0.46, 0.4, 0.46, mWood, 1.2, 0.2, 1.75, g).rotation.y = -0.3;
    cyl(0.15, 0.11, 0.24, mInk, -1.6, 0.12, 1.5, g); ball(0.23, mLeaf, -1.6, 0.44, 1.5, g); ball(0.16, mLeaf2, -1.52, 0.6, 1.55, g);
    var st = new THREE.Vector3(px, 0, pz).multiplyScalar(0.7);
    stores.push({ g: g, lamp: lamp, stand: st, pulse: 0 });
    world.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.035, 0), new THREE.Vector3(px * 0.78, 0.035, pz * 0.78)]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.38 })));
  }
  // lamp posts on the plaza
  for (i = 0; i < 8; i++) { var la = i / 8 * Math.PI * 2 + 0.2, lx = Math.sin(la) * 6.0, lz = Math.cos(la) * 6.0 * 0.9; cyl(0.04, 0.05, 2.3, mInk, lx, 1.15, lz, null, 8); ball(0.13, glow(0xfff1c9, 1.0), lx, 2.4, lz); }
  // trees behind and at the sides
  [-40, -12, 16, 42, 68, 94, 120].forEach(function (d, n) { var ta = d * Math.PI / 180, rr = 14.2 + (n % 3) * 0.9, tx = Math.sin(ta) * rr, tz = -Math.cos(ta) * rr * 0.86; cyl(0.1, 0.14, 1.0, std(0x3b2a20, 0.9), tx, 0.5, tz, null, 8); ball(0.78 + (n % 2) * 0.12, n % 2 ? mLeaf : mLeaf2, tx, 1.5, tz); ball(0.52, n % 2 ? mLeaf2 : mLeaf, tx + 0.1, 2.15, tz); });

  // vault with steps, metal bands and a lit top
  var vault = new THREE.Group(); world.add(vault);
  cyl(2.9, 3.0, 0.14, mWhite, 0, 0.07, 0, vault, 48); cyl(2.45, 2.55, 0.14, mInk, 0, 0.21, 0, vault, 48);
  cyl(1.75, 1.9, 2.0, mInk, 0, 1.28, 0, vault, 48);
  [0.55, 1.2, 1.85].forEach(function (y) { cyl(1.84, 1.86, 0.08, mMetal, 0, y + 0.3, 0, vault, 48); });
  var vdisc = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.04, 40), glow(0x6df2c0, 0.5)); vdisc.position.y = 2.3; vault.add(vdisc);
  var vring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.07, 12, 56), glow(0x6df2c0)); vring.rotation.x = Math.PI / 2; vring.position.y = 2.32; vault.add(vring);
  var vlight = new THREE.PointLight(0x6df2c0, 0.5, 10); vlight.position.set(0, 3.2, 0); world.add(vlight);
  var beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 5.2, 36, 1, true), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false })); beam.position.y = 4.8; world.add(beam);
  function ringMesh(y) { var m = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.3, metalness: 0.4 }); var t = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.09, 14, 64), m); t.rotation.x = Math.PI / 2; t.position.y = y; t.castShadow = true; world.add(t); return { m: t, mat: m, flash: 0, y: y }; }
  var ring1 = ringMesh(5.7), ring2 = ringMesh(4.4);
  var cWhite = new THREE.Color(0xffffff), cMint = new THREE.Color(0x6df2c0), cFlare = new THREE.Color(0xff5a36);
  function flashRing(rg, bad) { rg.flash = 1; rg.col = bad ? cFlare : cMint; }

  // particles (trail + bursts)
  var parts = [], pGeo = new THREE.SphereGeometry(0.07, 8, 6), pMint = glow(0x6df2c0, 1), pFlare = glow(0xff5a36, 1);
  function emit(pos, vel, life, grav, mat) { var m = new THREE.Mesh(pGeo, mat); m.position.copy(pos); world.add(m); parts.push({ m: m, v: vel, life: life, max: life, g: grav }); }

  // people with phones
  var SKIN = [0xf1c9a5, 0xd9a47e, 0xa8714a, 0x7a4b2e, 0xf6d7bd], JACK = [0x070b16, 0xffffff, 0x6df2c0, 0x1b2a55, 0xf2f5fb];
  var agents = [], NA = 5;
  function limb(g, x, y, len, rad, mat) { var p = new THREE.Group(); p.position.set(x, y, 0); var m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad * 0.9, len, 10), mat); m.position.y = -len / 2; m.castShadow = true; p.add(m); g.add(p); return p; }
  function makeAgent(n) {
    var g = new THREE.Group(), jm = std(JACK[n % 5], 0.7), sk = std(SKIN[n % 5], 0.8);
    var torso = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.31, 0.66, 16), jm); torso.position.y = 1.02; torso.castShadow = true; g.add(torso);
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 22, 16), sk); head.position.y = 1.62; head.castShadow = true; g.add(head);
    var hair = new THREE.Mesh(new THREE.SphereGeometry(0.268, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), std(n % 2 ? 0x070b16 : 0x3a2418, 0.9)); hair.position.y = 1.635; hair.rotation.x = -0.28; g.add(hair);
    var legL = limb(g, -0.13, 0.72, 0.72, 0.095, mDark), legR = limb(g, 0.13, 0.72, 0.72, 0.095, mDark);
    [legL, legR].forEach(function (l) { var s = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.09, 0.28), mWhite); s.position.set(0, -0.72, 0.05); s.castShadow = true; l.add(s); });
    var armL = limb(g, -0.37, 1.3, 0.56, 0.075, jm), armR = limb(g, 0.37, 1.3, 0.56, 0.075, jm);
    [armL, armR].forEach(function (a) { var hd = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), sk); hd.position.y = -0.58; a.add(hd); });
    var phone = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.19, 0.025), glow(0x6df2c0, 0.9)); phone.position.set(0, -0.6, 0.09); phone.rotation.x = -0.4; armR.add(phone);
    var marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), glow(0x6df2c0, 1)); marker.position.y = 2.2; g.add(marker);
    g.scale.setScalar(1.3);
    var ang = n / NA * Math.PI * 2, rad = 3.9 + (n % 2) * 1.3;
    g.position.set(Math.sin(ang) * rad, 0, Math.cos(ang) * rad * 0.9 + 1.5); world.add(g);
    return { g: g, head: head, legL: legL, legR: legR, armL: armL, armR: armR, marker: marker, target: n % NS, state: "walk", timer: 0, phase: n * 1.7, heading: 0, raise: 0 };
  }
  for (i = 0; i < NA; i++) agents.push(makeAgent(i));

  // coins
  var coins = [], coinN = 0, apex = new THREE.Vector3(0, 7.6, 0);
  var cgBase = new THREE.CylinderGeometry(0.32, 0.32, 0.07, 36), cgFace = new THREE.CylinderGeometry(0.2, 0.2, 0.09, 28);
  var cmOk = std(0xe9eefc, 0.28, 0.7), cmFaceOk = std(0x176bff, 0.4, 0.3), cmBad = std(0xff5a36, 0.35, 0.4), cmFaceBad = std(0x7a1d08, 0.5, 0.2);
  function makeCoin(bad) { var g = new THREE.Group(), b = new THREE.Mesh(cgBase, bad ? cmBad : cmOk), f = new THREE.Mesh(cgFace, bad ? cmFaceBad : cmFaceOk); b.castShadow = true; g.add(b); g.add(f); if (bad) g.scale.setScalar(1.7); return g; }
  function spawnCoin(from, store) {
    coinN++; var bad = coinN % 6 === 0 ? ((Math.floor(coinN / 6) % 2) + 1) : 0;
    var m = makeCoin(bad), p0 = from.clone(); p0.y = 2.0; m.position.copy(p0); world.add(m);
    coins.push({ m: m, p0: p0, p1: new THREE.Vector3(p0.x * 0.45, 11.8, p0.z * 0.45), phase: "arc", t: 0, bad: bad, vel: null, life: 0, tr: 0 });
    store.pulse = 1;
  }
  var pulse = 0;
  function bez(a, b, c, t, out) { var u = 1 - t; out.set(u * u * a.x + 2 * u * t * b.x + t * t * c.x, u * u * a.y + 2 * u * t * b.y + t * t * c.y, u * u * a.z + 2 * u * t * b.z + t * t * c.z); }
  var zero = new THREE.Vector3();

  function update(dt, time) {
    agents.forEach(function (ag) {
      var st = stores[ag.target], pos = ag.g.position, sw;
      if (ag.state === "walk") {
        var dx = st.stand.x - pos.x, dz = st.stand.z - pos.z, d = Math.sqrt(dx * dx + dz * dz);
        if (d < 0.12) { ag.state = "wait"; ag.timer = 1.0; spawnCoin(pos, st); }
        else {
          var sp = 2.5 * dt; pos.x += dx / d * Math.min(sp, d); pos.z += dz / d * Math.min(sp, d);
          var want = Math.atan2(dx, dz), diff = want - ag.heading; diff = Math.atan2(Math.sin(diff), Math.cos(diff)); ag.heading += diff * Math.min(1, dt * 8); ag.g.rotation.y = ag.heading;
        }
        sw = Math.sin(time * 8.5 + ag.phase);
        ag.legL.rotation.x = sw * 0.7; ag.legR.rotation.x = -sw * 0.7; ag.armL.rotation.x = -sw * 0.55;
        ag.raise += (0 - ag.raise) * Math.min(1, dt * 8); ag.armR.rotation.x = sw * 0.55 * (1 - ag.raise) - 1.25 * ag.raise;
        ag.g.position.y = Math.abs(sw) * 0.06;
      } else {
        ag.timer -= dt; ag.legL.rotation.x *= 0.8; ag.legR.rotation.x *= 0.8; ag.armL.rotation.x *= 0.8; ag.g.position.y *= 0.8;
        ag.raise += (1 - ag.raise) * Math.min(1, dt * 9); ag.armR.rotation.x = -1.25 * ag.raise;
        ag.head.rotation.y = Math.sin(time * 5 + ag.phase) * 0.3;
        if (ag.timer <= 0) { ag.head.rotation.y = 0; var nx; do { nx = Math.floor(Math.random() * NS); } while (nx === ag.target); ag.target = nx; ag.state = "walk"; }
      }
      ag.marker.position.y = 2.2 + Math.sin(time * 3 + ag.phase) * 0.07; ag.marker.rotation.y += dt * 2.2;
    });
    coins.forEach(function (c) {
      c.m.rotation.x += dt * 9; c.m.rotation.z += dt * 3; c.tr += dt;
      if (c.tr > 0.035 && c.phase !== "bounce") { c.tr = 0; emit(c.m.position, zero, 0.45, 0, c.bad ? pFlare : pMint); }
      if (c.phase === "arc") {
        c.t += dt / 1.25; bez(c.p0, c.p1, apex, Math.min(1, c.t), c.m.position);
        if (c.t >= 1) { c.phase = "fall"; c.t = 0; }
      } else if (c.phase === "fall") {
        var y0 = c.m.position.y; c.t += dt / 0.85; var q = Math.min(1, c.t), y = 7.6 - (7.6 - 2.45) * (q * q * 0.7 + q * 0.3);
        c.m.position.set(0, y, 0);
        [[ring1, 1], [ring2, 2]].forEach(function (rr) {
          if (c.phase === "fall" && y0 > rr[0].y && y <= rr[0].y) {
            if (c.bad === rr[1]) { flashRing(rr[0], true); c.phase = "bounce"; c.vel = new THREE.Vector3((Math.random() - 0.5) * 5 + 2.5, 4.5, (Math.random() - 0.5) * 5 + 3); c.life = 0; for (var b = 0; b < 8; b++) emit(c.m.position, new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4), 0.6, -9, pFlare); }
            else flashRing(rr[0], false);
          }
        });
        if (c.phase === "fall" && q >= 1) { c.phase = "done"; pulse = 1; for (var b2 = 0; b2 < 12; b2++) { var an = b2 / 12 * Math.PI * 2; emit(new THREE.Vector3(0, 2.5, 0), new THREE.Vector3(Math.cos(an) * 2.2, 2.4 + Math.random(), Math.sin(an) * 2.2), 0.7, -9, pMint); } }
      } else if (c.phase === "bounce") {
        c.vel.y -= 16 * dt; c.m.position.addScaledVector(c.vel, dt); c.life += dt;
        if (c.m.position.y < 0.25) { c.m.position.y = 0.25; c.vel.y *= -0.35; c.vel.x *= 0.6; c.vel.z *= 0.6; }
        if (c.life > 1.4) c.phase = "done";
      }
    });
    coins = coins.filter(function (c) { if (c.phase === "done") { world.remove(c.m); return false; } return true; });
    parts = parts.filter(function (p) { p.life -= dt; if (p.life <= 0) { world.remove(p.m); return false; } p.v.y += p.g * dt; p.m.position.addScaledVector(p.v, dt); var s = p.life / p.max; p.m.scale.set(s, s, s); return true; });
    [ring1, ring2].forEach(function (rg) { rg.flash = Math.max(0, rg.flash - dt * 2.6); rg.mat.emissive.copy(rg.flash > 0 ? rg.col : cWhite); rg.mat.emissiveIntensity = rg.flash > 0 ? 0.2 + rg.flash * 1.6 : 0.15; });
    pulse = Math.max(0, pulse - dt * 3); var s2 = 1 + pulse * 0.04; vault.scale.set(s2, 1 + pulse * 0.03, s2); vring.material.emissiveIntensity = 0.9 + pulse * 1.6; vdisc.material.emissiveIntensity = 0.5 + pulse * 1.2; vlight.intensity = 0.5 + pulse * 3;
    stores.forEach(function (s) { s.pulse = Math.max(0, s.pulse - dt * 2); var q2 = 1 + s.pulse * 0.9; s.lamp.scale.set(q2, q2, q2); });
  }

  var mouse = { x: 0, y: 0 }, R = 26, Hh = 15.5, shiftX = 0, shiftY = 0;
  hero.addEventListener("pointermove", function (e) { var b = hero.getBoundingClientRect(); mouse.x = (e.clientX - b.left) / b.width - 0.5; mouse.y = (e.clientY - b.top) / b.height - 0.5; });
  function size() {
    var w = hero.clientWidth, h = hero.clientHeight; renderer.setSize(w, h, false); cam.aspect = w / h;
    if (w < 760) { R = 40; Hh = 23; shiftX = 0; shiftY = -3.8; } else if (w < 1100) { R = 31; Hh = 19; shiftX = 3.2; shiftY = -0.6; } else { R = 27.5; Hh = 16.5; shiftX = 6.8; shiftY = -1; }
    world.position.set(shiftX, shiftY, 0); cam.updateProjectionMatrix();
  }
  function render(time) {
    var ang = Math.sin(time * 0.12) * 0.26 + mouse.x * 0.2;
    cam.position.set(Math.sin(ang) * R, Hh - mouse.y * 1.4, Math.cos(ang) * R); cam.lookAt(0, 1.8, 0);
    renderer.render(scene, cam);
  }
  window.addEventListener("resize", function () { size(); render(clock); });
  var clock = 0, last = 0, visible = true;
  size();
  for (var s0 = 0; s0 < 420; s0++) { clock += 1 / 60; update(1 / 60, clock); }
  render(clock);
  if (reduce) return;
  if ("IntersectionObserver" in window) new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }, { threshold: 0 }).observe(hero);
  function loop(ts) {
    var dt = Math.min(0.05, (ts - last) / 1000 || 0.016); last = ts;
    if (visible) { clock += dt; update(dt, clock); render(clock); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
