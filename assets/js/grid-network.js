/* A tiny network living on the home grid.
 *
 * Intersections become hosts, a few of them privileged. Requests travel
 * between hosts along the grid lines, warming up every segment they cross.
 * Most of them get denied on arrival. A few get an ACK. Least privilege.
 *
 * Geometry matches the CSS grid in custom.css: 48px cells, centered
 * horizontally, starting at the top, same radial mask.
 */
(function () {
  'use strict';

  var main = document.querySelector('.main');
  if (!main) return;
  var canvas = document.createElement('canvas');
  if (!canvas.getContext) return;
  canvas.className = 'grid-pulses';
  canvas.setAttribute('aria-hidden', 'true');
  main.insertBefore(canvas, main.firstChild);

  // calmer everywhere except the home page, so it never competes with reading
  var calm = !document.querySelector('.home-wrapper');

  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var CELL = 48;
  var AMBER = '227, 179, 65';
  var STEEL = '139, 145, 155';
  var DENY = '201, 92, 92';

  var W = 0, H = 0, x0 = 0, cols = 0, rows = 0;
  var nodes = [], packets = [], rings = [], heat = new Map();
  var maxPackets = 4, nextSpawn = 0, bootAt = 0;
  var last = 0, raf = 0, visible = true;
  var pointer = { x: 0, y: 0, tx: 0, ty: 0, a: 0, ta: 0 };

  function rand(a, b) { return a + Math.random() * (b - a); }
  function px(gx) { return x0 + gx * CELL + 0.5; }
  function py(gy) { return gy * CELL + 0.5; }

  // How visible a point is under the CSS mask: radial-gradient(ellipse 70% 80% at 50% 0%, #000 0%, transparent 75%)
  function maskAt(x, y) {
    var dx = (x - W / 2) / (0.7 * W), dy = y / (0.8 * H);
    return Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 0.75);
  }

  function layout() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    x0 = (((W - CELL) / 2) % CELL + CELL) % CELL;
    cols = Math.floor((W - x0) / CELL);
    rows = Math.floor(H / CELL);
    maxPackets = calm ? (W < 640 ? 1 : 2) : (W < 640 ? 2 : 4);

    // pick hosts among the clearly visible intersections, spread out a bit
    var candidates = [];
    for (var gx = 0; gx <= cols; gx++) {
      for (var gy = 1; gy <= rows; gy++) {
        var v = maskAt(px(gx), py(gy));
        if (v > 0.3) candidates.push({ gx: gx, gy: gy, v: v });
      }
    }
    candidates.sort(function () { return Math.random() - 0.5; });
    var want = Math.max(calm ? 4 : 5, Math.min(W < 640 ? 7 : (calm ? 9 : 14), Math.round(candidates.length / 6)));
    nodes = [];
    for (var i = 0; i < candidates.length && nodes.length < want; i++) {
      var c = candidates[i];
      var crowded = nodes.some(function (n) { return Math.abs(n.gx - c.gx) + Math.abs(n.gy - c.gy) < 3; });
      if (crowded) continue;
      nodes.push({
        gx: c.gx, gy: c.gy, v: c.v,
        privileged: false, flash: 0, deny: 0,
        phase: rand(0, Math.PI * 2),
        born: nodes.length * 90 // staggered boot
      });
    }
    // a few privileged hosts
    nodes.slice().sort(function () { return Math.random() - 0.5; })
      .slice(0, Math.max(1, Math.round(nodes.length / 5)))
      .forEach(function (n) { n.privileged = true; });

    packets = []; rings = []; heat.clear();
  }

  // Manhattan route along the grid, randomly horizontal-first or vertical-first
  function route(a, b) {
    var path = [{ gx: a.gx, gy: a.gy }], gx = a.gx, gy = a.gy;
    var hFirst = Math.random() < 0.5;
    function walkX() { while (gx !== b.gx) { gx += gx < b.gx ? 1 : -1; path.push({ gx: gx, gy: gy }); } }
    function walkY() { while (gy !== b.gy) { gy += gy < b.gy ? 1 : -1; path.push({ gx: gx, gy: gy }); } }
    if (hFirst) { walkX(); walkY(); } else { walkY(); walkX(); }
    return path;
  }

  function spawn() {
    if (nodes.length < 2) return;
    var from = nodes[Math.floor(Math.random() * nodes.length)], to;
    do { to = nodes[Math.floor(Math.random() * nodes.length)]; } while (to === from);
    var path = route(from, to);
    if (path.length < 3) return;
    packets.push({
      path: path, seg: 0, t: 0,
      speed: rand(1.4, 2.2),           // cells per second
      target: to,
      allowed: to.privileged ? Math.random() < 0.5 : Math.random() < 0.15,
      trail: [], done: false, fade: 1
    });
  }

  function edgeKey(a, b) {
    return a.gx < b.gx || a.gy < b.gy
      ? a.gx + ',' + a.gy + ',' + b.gx + ',' + b.gy
      : b.gx + ',' + b.gy + ',' + a.gx + ',' + a.gy;
  }

  function update(dt, now) {
    if (now > nextSpawn && packets.length < maxPackets && now > bootAt + 900) {
      spawn();
      nextSpawn = now + (calm ? rand(1600, 3600) : rand(700, 2000));
    }

    packets.forEach(function (p) {
      if (p.done) { p.fade -= dt / 0.5; return; }
      var end = p.path.length - 1;
      // denied packets stop half a cell short of the target
      var stopAt = p.allowed ? end : end - 0.5;
      p.t += p.speed * dt;
      while (p.t >= 1 && p.seg < Math.floor(stopAt)) {
        heat.set(edgeKey(p.path[p.seg], p.path[p.seg + 1]), 1);
        p.t -= 1; p.seg++;
      }
      if (p.seg + p.t >= stopAt) {
        p.seg = Math.floor(stopAt); p.t = stopAt - p.seg;
        if (p.t === 0 && p.seg > 0) heat.set(edgeKey(p.path[p.seg - 1], p.path[p.seg]), 1);
        p.done = true;
        var n = p.target, hx = px(n.gx), hy = py(n.gy);
        if (p.allowed) {
          n.flash = 1;
          rings.push({ x: hx, y: hy, r: 2, life: 1, rgb: AMBER, max: 22 });
        } else {
          n.deny = 1;
          var pos = position(p);
          rings.push({ x: pos.x, y: pos.y, r: 1, life: 1, rgb: DENY, max: 10 });
        }
      }
      var pos2 = position(p);
      p.trail.push(pos2);
      if (p.trail.length > 26) p.trail.shift();
    });
    packets = packets.filter(function (p) { return p.fade > 0; });

    heat.forEach(function (h, k) {
      h -= dt / 1.8;
      if (h <= 0) heat.delete(k); else heat.set(k, h);
    });

    rings.forEach(function (r) { r.life -= dt / 0.9; r.r += (r.max - r.r) * Math.min(1, dt * 4); });
    rings = rings.filter(function (r) { return r.life > 0; });

    nodes.forEach(function (n) {
      n.flash = Math.max(0, n.flash - dt / 1.2);
      n.deny = Math.max(0, n.deny - dt / 0.6);
    });

    // pointer easing
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 8);
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 8);
    pointer.a += (pointer.ta - pointer.a) * Math.min(1, dt * 4);
  }

  function position(p) {
    var a = p.path[p.seg], b = p.path[Math.min(p.seg + 1, p.path.length - 1)];
    return { x: px(a.gx + (b.gx - a.gx) * p.t), y: py(a.gy + (b.gy - a.gy) * p.t) };
  }

  function drawFlashlight() {
    if (pointer.a < 0.01) return;
    var R = 170;
    var g = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, R);
    g.addColorStop(0, 'rgba(' + AMBER + ',' + 0.16 * pointer.a + ')');
    g.addColorStop(1, 'rgba(' + AMBER + ',0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var minX = pointer.x - R, maxX = pointer.x + R, minY = Math.max(0, pointer.y - R), maxY = pointer.y + R;
    for (var gx = Math.ceil((minX - x0) / CELL); px(gx) <= maxX; gx++) {
      ctx.moveTo(px(gx), minY); ctx.lineTo(px(gx), maxY);
    }
    for (var gy = Math.ceil(minY / CELL); py(gy) <= maxY; gy++) {
      ctx.moveTo(minX, py(gy)); ctx.lineTo(maxX, py(gy));
    }
    ctx.stroke();
  }

  function drawHeat() {
    ctx.lineWidth = 1;
    heat.forEach(function (h, k) {
      var c = k.split(',').map(Number);
      ctx.strokeStyle = 'rgba(' + AMBER + ',' + 0.28 * h * h + ')';
      ctx.beginPath();
      ctx.moveTo(px(c[0]), py(c[1]));
      ctx.lineTo(px(c[2]), py(c[3]));
      ctx.stroke();
    });
  }

  function drawNodes(now) {
    nodes.forEach(function (n) {
      var boot = Math.min(1, Math.max(0, (now - bootAt - n.born) / 400));
      if (boot <= 0) return;
      var x = px(n.gx), y = py(n.gy);
      var near = pointer.a * Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / 170);
      var breathe = n.privileged ? 0.5 + 0.5 * Math.sin(now / 1400 + n.phase) : 0;

      if (n.privileged || n.flash > 0) {
        var glow = (n.privileged ? 0.10 + 0.08 * breathe : 0) + 0.35 * n.flash + 0.15 * near;
        var g = ctx.createRadialGradient(x, y, 0, x, y, 14);
        g.addColorStop(0, 'rgba(' + AMBER + ',' + glow * boot + ')');
        g.addColorStop(1, 'rgba(' + AMBER + ',0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - 14, y - 14, 28, 28);
      }

      var base = n.privileged ? AMBER : STEEL;
      var alpha = (n.privileged ? 0.55 + 0.25 * breathe : 0.35) + 0.4 * near + 0.5 * n.flash;
      ctx.fillStyle = 'rgba(' + base + ',' + Math.min(1, alpha) * boot + ')';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);

      if (n.deny > 0) {
        ctx.fillStyle = 'rgba(' + DENY + ',' + 0.6 * n.deny + ')';
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    });
  }

  function drawPackets() {
    packets.forEach(function (p) {
      var tr = p.trail, n = tr.length;
      for (var i = 1; i < n; i++) {
        ctx.strokeStyle = 'rgba(' + AMBER + ',' + (i / n) * 0.55 * p.fade + ')';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
        ctx.lineTo(tr[i].x, tr[i].y);
        ctx.stroke();
      }
      var head = tr[n - 1];
      if (!head) return;
      var g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 10);
      g.addColorStop(0, 'rgba(' + AMBER + ',' + 0.45 * p.fade + ')');
      g.addColorStop(1, 'rgba(' + AMBER + ',0)');
      ctx.fillStyle = g;
      ctx.fillRect(head.x - 10, head.y - 10, 20, 20);
      ctx.fillStyle = 'rgba(255, 236, 190,' + 0.95 * p.fade + ')';
      ctx.beginPath();
      ctx.arc(head.x, head.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawRings() {
    rings.forEach(function (r) {
      ctx.strokeStyle = 'rgba(' + r.rgb + ',' + 0.5 * r.life * r.life + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    });
  }

  function render(now) {
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    drawFlashlight();
    drawHeat();
    drawPackets();
    drawRings();
    drawNodes(now);
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    update(dt, now);
    render(now);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf || reduceMotion || !visible || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  // --- wiring ---------------------------------------------------------------
  layout();
  bootAt = performance.now();

  if (reduceMotion) {
    // static network, no motion
    bootAt = -1e6;
    render(0);
    return;
  }

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { layout(); bootAt = performance.now() - 1e4; }, 150);
  });

  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      visible ? start() : stop();
    }).observe(canvas);
  }

  if (window.matchMedia('(pointer: fine)').matches) {
    window.addEventListener('pointermove', function (e) {
      var r = canvas.getBoundingClientRect();
      pointer.tx = e.clientX - r.left;
      pointer.ty = e.clientY - r.top;
      var inside = pointer.ty >= 0 && pointer.ty <= H && pointer.tx >= 0 && pointer.tx <= W;
      if (inside && pointer.a < 0.01) { pointer.x = pointer.tx; pointer.y = pointer.ty; }
      pointer.ta = inside ? 1 : 0;
    }, { passive: true });
    document.addEventListener('pointerleave', function () { pointer.ta = 0; });
  }

  start();
})();
