/* =========================================================
   RoomView — "View in Room".

   Each instance combines a photo-backed WebGL room with true-scale,
   independently draggable artwork overlays, environment and lighting
   controls, and a scale figure. Visitors can curate up to four works on
   one wall while one active work drives the purchase or inquiry panel.

   The default instance renders in the lightbox. RoomView.create() makes
   independent rooms, including the persistent landing-page room.

   Public API:
     RoomView.mount(viewerEl, panelEl, sizesEl) — once, builds the DOM
     RoomView.show(workIndex)                   — on every render
     RoomView.create()                          — independent instance
   ========================================================= */
(function () {
  function createRoomView(options) {
  options = options || {};
  var experience = options.mode === 'standalone' ? 'standalone' : 'lightbox';
  var isStandalone = experience === 'standalone';
  var works = window.WORKS || [];
  window.__roomViewInstanceSerial = (window.__roomViewInstanceSerial || 0) + 1;
  var roomInstanceId = window.__roomViewInstanceSerial;

  /* ---------- helpers ---------- */
  /* Dimension strings are "H × W" (height first — museum convention, see
     works.js). */
  function parseDims(str) {
    var m = String(str).match(/(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)/);
    if (!m) return null;
    return { h: parseFloat(m[1]), w: parseFloat(m[2]) };
  }

  /* ---------- shaders ---------- */
  var VERT =
    'attribute vec2 a_pos;' +
    'void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }';

  var FRAG = [
    'precision highp float;',
    'uniform vec2  u_res;',        // canvas px
    'uniform float u_ppi;',        // px per inch
    'uniform vec2  u_origin;',     // px of world (0,0): x=0 left wall edge, y=0 floor line
    'uniform vec4  u_paint;',      // x,y (center, inches), w,h (inches)
    'uniform vec2  u_person;',     // cx (inches), height (inches)
    'uniform vec3  u_couch;',      // cx, width, height (inches)
    'uniform vec2  u_light;',      // draggable light, position in inches
    'uniform vec3  u_lcol;',       // light colour (from temperature slider)
    'uniform float u_lint;',       // light intensity / brightness
    'uniform float u_amb;',        // ambient fill (base room light)
    'uniform vec3  u_wallTop;',    // wall colour, ceiling edge
    'uniform vec3  u_wallBot;',    // wall colour, floor edge
    'uniform vec3  u_floorTop;',   // floor colour, near wall
    'uniform vec3  u_floorBot;',   // floor colour, foreground
    'uniform float u_env;',        // 0 dining, 1 office, 2 entryway
    'uniform float u_lightMode;',  // 0 default, 1 daylight, 2 lamp, 3 gallery, 4 sunset
    'uniform sampler2D u_bg;',
    'uniform float u_texReady;',
    '',
    'float sdRoundBox(vec2 p, vec2 b, float r){',
    '  vec2 q = abs(p) - b + r;',
    '  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;',
    '}',
    'float sdCircle(vec2 p, float r){ return length(p) - r; }',
    'float sdEllipse(vec2 p, vec2 ab){',
    '  p = abs(p); float k0 = length(p / ab); float k1 = length(p / (ab * ab));',
    '  return k0 * (k0 - 1.0) / k1;',
    '}',
    'float sdCapsule(vec2 p, vec2 a, vec2 b, float r){',
    '  vec2 pa = p - a, ba = b - a;',
    '  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);',
    '  return length(pa - ba * t) - r;',
    '}',
    'float smin(float a, float b, float k){',
    '  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);',
    '  return mix(b, a, h) - k * h * (1.0 - h);',
    '}',
    '/* capsule whose radius tapers from r1 (at origin) to r2 (at height h) — iq */',
    'float sdUnevenCapsule(vec2 p, float r1, float r2, float h){',
    '  p.x = abs(p.x);',
    '  float b = (r1 - r2) / h;',
    '  float a = sqrt(1.0 - b * b);',
    '  float k = dot(p, vec2(-b, a));',
    '  if (k < 0.0) return length(p) - r1;',
    '  if (k > a * h) return length(p - vec2(0.0, h)) - r2;',
    '  return dot(p, vec2(a, b)) - r1;',
    '}',
    '',
    '/* person silhouette, feet at y=0, centered on cx — traced from',
    '   images/Person.svg (circle head, capsule torso, tapered lower body,',
    '   with the same small gaps between the three pieces). */',
    'float sdPerson(vec2 w, float cx, float H){',
    '  vec2 p = vec2(w.x - cx, w.y);',
    '  float d = sdCircle(p - vec2(0.0, 0.9427 * H), 0.0574 * H);',                         // head
    '  d = min(d, sdCapsule(p, vec2(0.0, 0.6257 * H), vec2(0.0, 0.7617 * H), 0.0918 * H));', // torso
    '  d = min(d, sdUnevenCapsule(p - vec2(0.0, 0.0386 * H), 0.0373 * H, 0.0549 * H, 0.4087 * H));', // legs
    '  return d;',
    '}',
    '',
    '/* couch silhouette, floor at y=0, centered on cx */',
    'float sdCouch(vec2 w, float cx, float W, float H){',
    '  vec2 p = vec2(w.x - cx, w.y);',
    '  float legH = H * 0.10;',
    '  float seatT = H * 0.28;',
    '  float armW = W * 0.09;',
    '  float back = sdRoundBox(p - vec2(0.0, legH + H*0.45), vec2(W*0.5 - armW*0.4, H*0.45), 2.0);',
    '  float seat = sdRoundBox(p - vec2(0.0, legH + seatT*0.9), vec2(W*0.5 - armW*0.8, seatT), 2.5);',
    '  float armL = sdRoundBox(p - vec2(-(W*0.5 - armW*0.5), legH + H*0.34), vec2(armW*0.5, H*0.34), 2.5);',
    '  float armR = sdRoundBox(p - vec2( (W*0.5 - armW*0.5), legH + H*0.34), vec2(armW*0.5, H*0.34), 2.5);',
    '  float d = smin(back, seat, 1.0);',
    '  d = smin(d, armL, 1.0);',
    '  d = smin(d, armR, 1.0);',
    '  float lgL = sdRoundBox(p - vec2(-(W*0.5 - armW), legH*0.5), vec2(0.8, legH*0.5), 0.4);',
    '  float lgR = sdRoundBox(p - vec2( (W*0.5 - armW), legH*0.5), vec2(0.8, legH*0.5), 0.4);',
    '  return min(d, min(lgL, lgR));',
    '}',
    '',
    'void main(){',
    '  vec2 frag = gl_FragCoord.xy;',
    '  vec2 w = (frag - u_origin) / u_ppi;',
    '  float aa = 1.5 / u_ppi;',
    '  if (u_texReady > 0.5){',
    '    vec2 uv = vec2(frag.x / u_res.x, 1.0 - frag.y / u_res.y);',
    '    vec3 photo = texture2D(u_bg, uv).rgb;',
    '    float vigPhoto = smoothstep(0.82, 0.22, length(uv - vec2(0.5)));',
    '    photo *= mix(0.86, 1.02, vigPhoto);',
    '    float spotX = (w.x - u_paint.x) / max(u_paint.z * 1.7, 28.0);',
    '    float spotY = (w.y - u_paint.y) / max(u_paint.w * 2.2, 38.0);',
    '    float artWash = exp(-(spotX*spotX + spotY*spotY) * 2.0);',
    '    float modeStrength = 0.05;',
    '    if (u_lightMode > 2.5 && u_lightMode < 3.5) modeStrength = 0.24;',
    '    if (u_lightMode > 3.5) modeStrength = 0.16;',
    '    photo *= u_amb + u_lint * 0.22;',
    '    photo = mix(photo, photo * u_lcol, 0.12 + 0.20 * u_lint);',
    '    photo += u_lcol * artWash * modeStrength;',
    '    gl_FragColor = vec4(photo, 1.0);',
    '    return;',
    '  }',
    '',
    '  /* room: warm mid-tone wall + floor — an elegant, already-lit space',
    '     (not a dark box). Slightly warm (r > g > b), gently darker toward',
    '     the ceiling and into the floor. */',
    '  vec3 wall  = mix(u_wallTop, u_wallBot, clamp(w.y / 110.0, 0.0, 1.0));',
    '  float vig = smoothstep(1.45, 0.30, length((frag / u_res) - 0.5));',
    '  wall *= mix(0.86, 1.0, vig);',
    '  vec3 floorC = mix(u_floorTop, u_floorBot, clamp(-w.y / 26.0, 0.0, 1.0));',
    '  vec3 col = (w.y > 0.0) ? wall : floorC;',
    '  col = mix(col, vec3(0.20, 0.188, 0.172), (1.0 - smoothstep(0.0, 0.5, abs(w.y))) * 0.5);',
    '  /* architectural depth: baseboard, wall panels, and perspective floor seams */',
    '  if (w.y > 0.0 && w.y < 2.0) col *= 0.66;',
    '  float seam = abs(fract((w.x + 140.0) / 18.0) - 0.5);',
    '  if (w.y < 0.0) col *= 1.0 - (1.0 - smoothstep(0.475, 0.5, seam)) * 0.11;',
    '  if (u_env < 0.5 && w.y > 4.0){',
    '    float panelX = abs(fract((w.x + 120.0) / 34.0) - 0.5);',
    '    col *= 1.0 - (1.0 - smoothstep(0.47, 0.5, panelX)) * 0.12;',
    '  }',
    '  if (u_env > 0.5 && u_env < 1.5 && w.y > 10.0){',
    '    float shelf = min(abs(w.y - 62.0), abs(w.y - 78.0));',
    '    if (shelf < 0.8 && w.x < 34.0) col *= 0.68;',
    '  }',
    '  if (u_env > 1.5){',
    '    float reveal = abs(w.x - 18.0);',
    '    if (reveal < 1.1 && w.y > 0.0) col *= 0.62;',
    '  }',
    '  /* Sunset opens a luminous architectural window, with visible mullions. */',
    '  if (u_lightMode > 3.5){',
    '    vec2 winP = w - vec2(18.0, 59.0);',
    '    float win = sdRoundBox(winP, vec2(13.5, 25.0), 0.4);',
    '    vec3 sky = mix(vec3(0.94,0.30,0.12), vec3(0.20,0.12,0.32), clamp((winP.y+25.0)/50.0,0.0,1.0));',
    '    col = mix(sky, col, smoothstep(-aa, aa, win));',
    '    if (win < 0.0 && (abs(winP.x) < 0.7 || abs(winP.y) < 0.7)) col = vec3(0.07);',
    '  }',
    '',
    '  /* contact shadows on floor — pushed away from the light so they',
    '     follow it as it\'s dragged */',
    '  float soxC = clamp((u_couch.x - u_light.x) * 0.10, -7.0, 7.0);',
    '  float soxP = clamp((u_person.x - u_light.x) * 0.10, -5.0, 5.0);',
    '  float shC = 1.0 - smoothstep(0.0, u_couch.y * 0.62, length(vec2((w.x - u_couch.x - soxC) * 0.9, (w.y + 1.5) * 5.0)));',
    '  float shP = 1.0 - smoothstep(0.0, u_person.y * 0.16, length(vec2((w.x - u_person.x - soxP) * 1.4, (w.y + 1.0) * 5.5)));',
    '  if (w.y < 0.5){ col *= 1.0 - 0.55 * max(shC, shP); }',
    '',
    '  /* Environment-specific furniture: dining table, executive desk, or entry console. */',
    '  float dc;',
    '  if (u_env < 0.5){',
    '    float top = sdRoundBox(w - vec2(u_couch.x, u_couch.z * 0.78), vec2(u_couch.y * 0.50, 2.2), 1.1);',
    '    float legL = sdCapsule(w, vec2(u_couch.x-u_couch.y*.34,0.0), vec2(u_couch.x-u_couch.y*.30,u_couch.z*.72), 1.5);',
    '    float legR = sdCapsule(w, vec2(u_couch.x+u_couch.y*.34,0.0), vec2(u_couch.x+u_couch.y*.30,u_couch.z*.72), 1.5);',
    '    dc = min(top, min(legL, legR));',
    '  } else if (u_env < 1.5){',
    '    float desk = sdRoundBox(w - vec2(u_couch.x, u_couch.z*.72), vec2(u_couch.y*.50, 2.0), .6);',
    '    float pedestal = sdRoundBox(w - vec2(u_couch.x-u_couch.y*.40,u_couch.z*.34), vec2(3.2,u_couch.z*.34), .5);',
    '    float chair = sdRoundBox(w - vec2(u_couch.x+u_couch.y*.28,u_couch.z*.30), vec2(8.0,u_couch.z*.30), 2.5);',
    '    dc = min(desk, min(pedestal, chair));',
    '  } else {',
    '    float console = sdRoundBox(w - vec2(u_couch.x, u_couch.z*.82), vec2(u_couch.y*.46, 1.6), .5);',
    '    float legL = sdRoundBox(w - vec2(u_couch.x-u_couch.y*.39,u_couch.z*.39), vec2(1.1,u_couch.z*.39), .4);',
    '    float legR = sdRoundBox(w - vec2(u_couch.x+u_couch.y*.39,u_couch.z*.39), vec2(1.1,u_couch.z*.39), .4);',
    '    dc = min(console, min(legL, legR));',
    '  }',
    '  vec3 couchC = mix(vec3(0.055,0.050,0.045), vec3(0.24,0.205,0.165), clamp(w.y/max(u_couch.z,1.0),0.0,1.0));',
    '  col = mix(couchC, col, smoothstep(-aa, aa, dc));',
    '',
    '  /* person — same material ramp as the couch (dark at the floor,',
    '     lighter up top) so the two read as one furniture set */',
    '  float dp = sdPerson(w, u_person.x, u_person.y);',
    '  vec3 personC = mix(vec3(0.150, 0.145, 0.138), vec3(0.212, 0.205, 0.193), clamp(w.y / max(u_person.y, 1.0), 0.0, 1.0));',
    '  col = mix(personC, col, smoothstep(-aa, aa, dp));',
    '',
    '  /* painting: soft wall shadow, thin frame, artwork texture */',
    '  vec2 pc = w - u_paint.xy;',
    '  vec2 half_ = u_paint.zw * 0.5;',
    '  float dsh = sdRoundBox(pc - vec2(0.6, -0.9), half_, 0.2);',
    '  col *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 3.0, dsh));',
    '  float dfr = sdRoundBox(pc, half_ + vec2(0.7), 0.15);',
    '  col = mix(vec3(0.05), col, smoothstep(-aa, aa, dfr));',
    '  /* canvas backing — the artwork itself is an <img> overlaid by JS at',
    '     this exact rect (plain-image path renders reliably everywhere) */',
    '  float dpt = sdRoundBox(pc, half_, 0.05);',
    '  col = mix(vec3(0.10), col, smoothstep(-aa, aa, dpt));',
    '  /* Physical lighting fixtures make each selected light source legible. */',
    '  if (u_lightMode > 1.5 && u_lightMode < 2.5){',
    '    float stem = sdCapsule(w, vec2(u_light.x,0.0), vec2(u_light.x,u_light.y-5.0), .65);',
    '    float base = sdEllipse(w-vec2(u_light.x,1.0), vec2(6.0,1.2));',
    '    vec2 shadeP = w-vec2(u_light.x,u_light.y);',
    '    float shade = sdRoundBox(shadeP, vec2(7.0,4.5), 1.3);',
    '    float fixture = min(stem,min(base,shade));',
    '    col = mix(vec3(.08,.065,.05), col, smoothstep(-aa,aa,fixture));',
    '  }',
    '  if (u_lightMode > 2.5 && u_lightMode < 3.5){',
    '    float track = sdRoundBox(w-vec2(u_paint.x,u_paint.y+u_paint.w*.72), vec2(18.0,.7), .3);',
    '    float neck = sdCapsule(w, vec2(u_paint.x,u_paint.y+u_paint.w*.72), vec2(u_paint.x,u_paint.y+u_paint.w*.63), .65);',
    '    col = mix(vec3(.06), col, smoothstep(-aa,aa,min(track,neck)));',
    '  }',
    '',
    '  /* lighting: a bright ambient fill (the room already reads as an',
    '     elegant, evenly-lit space) plus a soft, broad accent from the',
    '     draggable light — a gentle wash, not a hard spotlight. The whole',
    '     room is tinted toward the light colour so warmth/coolness reads',
    '     everywhere, not just in a pool. */',
    '  float ld = length(w - u_light);',
    '  float falloff = exp(-ld * ld * 0.00013);',                       // broader, softer pool
    '  float lit = u_amb + u_lint * falloff;',
    '  col *= lit;',
    '  col = mix(col, col * u_lcol, 0.32 + falloff * 0.33);',           // global colour cast, stronger near the light
    '  col += u_lcol * 0.10 * u_lint * exp(-ld * ld * 0.0009);',        // faint halo in the light colour
    '  float bulb = 1.0 - smoothstep(1.1, 2.0, ld);',
    '  col = mix(col, u_lcol * 0.5 + 0.5, bulb);',                      // the bulb glows in its own colour
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ---------- state ---------- */
  var viewerHost = null, panelHost = null, slidersHost = null;
  var roomRow = null, roomHeader = null;
  var cameraLayer = null, canvas = null, artLayer = null, artImg = null, figureImg = null, figureShadow = null, scaleReference = null;
  var gl = null, prog = null, bgTexture = null;
  var PERSON_SVG_ASPECT = 41 / 220;     // images/Person.svg proportions (shader person is traced from it)
  var glBroken = false;                 // remember init failure across opens
  var mounted = false;
  var uni = {};
  var cur = null;                       // { w, h, title, estimated }
  var person = { height: 66 };          // inches (5'6")
  var couch  = { width: 84, height: 33 };
  var environment = 0;                  // dining room, office, entryway
  var lightMode = 2;
  var lightingScene = 'evening';
  var paintingOffset = { x: 0, y: 0 };  // alias of the active wall item's offset
  var placedArts = [], activeArt = null, nextArtId = 1;
  var MAX_WALL_ARTS = 4;
  var dragHint = null, resetButton = null, artRemoveButton = null;
  var paintingMoved = false, figureMoved = false, hintDismissed = false;
  var purchaseVisible = false, purchaseLocked = false, purchaseHideTimer = 0, panelVisibilityTimer = 0;
  var tuning = {
    panelWidth: 292,
    panelGap: 14,
    panelOpacity: 0.94,
    panelRadius: 16,
    panelTransition: 200,
    hideDelay: 280,
    mobileInset: 12,
    artworkLift: 2
  };
  var figure = { visible: true, height: 67, fx: 0.83 };
  var textureReady = false;
  var ENVIRONMENTS = [
    { name: 'Dining room', sources: { day: 'images/rooms/dining-day.jpg', evening: 'images/rooms/dining-evening.jpg', gallery: 'images/rooms/dining.jpg' }, x: 0.50, y: 0.61, minX: 0.22, maxX: 0.78, minY: 0.24, maxY: 0.91, figureX: 0.83, figureBase: 0.035, camera: { x: -1.4, y: 1.8, scale: 1.055 } },
    { name: 'Office', sources: { day: 'images/rooms/office-day.jpg', evening: 'images/rooms/office-evening.jpg', gallery: 'images/rooms/office.jpg' }, x: 0.50, y: 0.62, minX: 0.27, maxX: 0.77, minY: 0.27, maxY: 0.91, figureX: 0.82, figureBase: 0.035, camera: { x: 1.8, y: 1.2, scale: 1.065 } },
    { name: 'Entryway', sources: { day: 'images/rooms/entryway-day.jpg', evening: 'images/rooms/entryway-evening.jpg', gallery: 'images/rooms/entryway.jpg' }, x: 0.50, y: 0.62, minX: 0.33, maxX: 0.70, minY: 0.27, maxY: 0.91, figureX: 0.24, figureBase: 0.035, camera: { x: -1.8, y: 1.5, scale: 1.07 } }
  ];
  var cameraScale = 1;
  var cameraTransitionToken = 0;
  var cameraSettleTimer = 0;
  var raf = 0;
  var HANG_GAP = 8;                     // inches, couch top → painting bottom edge
  var unit = 'in';                      // 'in' | 'cm' — display units for the readouts
  function t(key) { return (window.I18N && window.I18N.t) ? window.I18N.t(key) : key; }

  function clampValue(value, min, max, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }

  function applyTuning() {
    if (!viewerHost) return;
    viewerHost.style.setProperty('--room-purchase-width', tuning.panelWidth + 'px');
    viewerHost.style.setProperty('--room-purchase-opacity', tuning.panelOpacity);
    viewerHost.style.setProperty('--room-purchase-radius', tuning.panelRadius + 'px');
    viewerHost.style.setProperty('--room-purchase-transition', tuning.panelTransition + 'ms');
    viewerHost.style.setProperty('--room-mobile-inset', tuning.mobileInset + 'px');
    viewerHost.style.setProperty('--room-art-hover-lift', tuning.artworkLift + 'px');
  }

  function setTuning(next) {
    next = next || {};
    tuning.panelWidth = clampValue(next.panelWidth, 248, 320, tuning.panelWidth);
    tuning.panelGap = clampValue(next.panelGap, 4, 40, tuning.panelGap);
    tuning.panelOpacity = clampValue(next.panelOpacity, 0.72, 1, tuning.panelOpacity);
    tuning.panelRadius = clampValue(next.panelRadius, 16, 24, tuning.panelRadius);
    tuning.panelTransition = clampValue(next.panelTransition, 80, 500, tuning.panelTransition);
    tuning.hideDelay = clampValue(next.hideDelay, 100, 1400, tuning.hideDelay);
    tuning.mobileInset = clampValue(next.mobileInset, 8, 32, tuning.mobileInset);
    tuning.artworkLift = clampValue(next.artworkLift, 0, 8, tuning.artworkLift);
    applyTuning();
    render();
  }

  function getTuning() {
    return Object.assign({}, tuning);
  }

  function syncCycleControls() {
    if (!slidersHost) return;
    var roomValue = slidersHost.querySelector('.room-environment-value');
    var lightValue = slidersHost.querySelector('.room-light-value');
    var figureValue = slidersHost.querySelector('.room-figure-value');
    if (roomValue) roomValue.textContent = ENVIRONMENTS[environment].name;
    if (lightValue) lightValue.textContent = t('room.' + lightingScene);
    if (figureValue) figureValue.textContent = figure.visible ? fmtFtIn(figure.height) : 'Off';
  }

  function syncRoomState() {
    if (!roomRow) return;
    roomRow.classList.toggle('has-selection', !!activeArt);
  }
  /* Draggable light — position stored as fractions of the scene so it stays
     put (relatively) when sliders resize the scene. `temp` is 0 (warm 2700K
     lamp) → 1 (cool 6500K daylight); `intensity` is the directional strength;
     `ambient` is the base room fill. Defaults to a warm evening lamp, upper
     right. Presets (see LIGHT_PRESETS) set all of these together. */
  var light = { fx: 0.74, fy: 0.86, temp: 0.30, intensity: 0.55, ambient: 0.82 };
  var layout = null;                    // px↔inches mapping cached by render()

  function originalDimsFor(w) {
    var dims = parseDims(w && (w.roomDimensions || w.dimensions));
    if (dims) return { w: dims.w, h: dims.h, title: w.title, estimated: false };
    return w && w.orientation === 'landscape'
      ? { w: 36, h: 27, title: w.title, estimated: true }
      : { w: 27, h: 36, title: w ? w.title : '', estimated: true };
  }

  function wallOffsets(count) {
    if (count <= 1) return [{ x: 0, y: 0 }];
    if (count === 2) return [{ x: -34, y: 0 }, { x: 34, y: 0 }];
    if (count === 3) return [{ x: -48, y: 0 }, { x: 0, y: 0 }, { x: 48, y: 0 }];
    return [{ x: -40, y: 18 }, { x: 40, y: 18 }, { x: -40, y: -24 }, { x: 40, y: -24 }];
  }

  function arrangePlacedArts() {
    var offsets = wallOffsets(placedArts.length);
    placedArts.forEach(function (item, index) {
      item.offset.x = offsets[index].x;
      item.offset.y = offsets[index].y;
    });
    if (activeArt) paintingOffset = activeArt.offset;
  }

  function createPlacedArt(workIndex) {
    var w = works[workIndex];
    if (!w || !artLayer) return null;
    var img = document.createElement('img');
    var item = {
      id: nextArtId++, workIndex: workIndex, work: w,
      dims: originalDimsFor(w), offset: { x: 0, y: 0 }, sizeIndex: -1, img: img
    };
    img.className = 'room-art';
    img.src = w.imagePath;
    img.alt = w.title + ', ' + w.year;
    img.draggable = false;
    img.dataset.wallArtId = item.id;
    img.setAttribute('tabindex', '0');
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', w.title + '. Drag to reposition on the wall' +
      (isStandalone ? ', or select to choose a print size.' : '.'));
    if (isStandalone) {
      img.addEventListener('pointerenter', function () { showContextualPurchase(item); });
      img.addEventListener('pointerleave', function () { hideContextualPurchase(false); });
      img.addEventListener('focus', function () { showContextualPurchase(item); });
      img.addEventListener('blur', function () { hideContextualPurchase(false); });
    }
    artLayer.appendChild(img);
    placedArts.push(item);
    return item;
  }

  function updateResetState() {
    if (resetButton) resetButton.disabled = !(paintingMoved || figureMoved);
  }

  function dismissDragHint() {
    if (hintDismissed || !dragHint) return;
    hintDismissed = true;
    dragHint.classList.add('is-dismissed');
  }

  function wallItemById(id) {
    id = parseInt(id, 10);
    return placedArts.filter(function (item) { return item.id === id; })[0] || null;
  }

  function updateCuratorUI() {
    if (!panelHost) return;
    slidersHost.querySelectorAll('.room-artwork-toggle').forEach(function (button) {
      var workIndex = parseInt(button.dataset.workIndex, 10);
      var existing = placedArts.some(function (item) { return item.workIndex === workIndex; });
      button.classList.toggle('is-added', existing);
      button.setAttribute('aria-pressed', existing ? 'true' : 'false');
      button.setAttribute('aria-label', (existing ? 'Remove from wall: ' : 'Add to wall: ') + works[workIndex].title);
      button.disabled = !existing && placedArts.length >= MAX_WALL_ARTS;
    });
    var showPurchase = !!activeArt && (!isStandalone || purchaseVisible);
    panelHost.classList.toggle('has-selection', showPurchase);
    var selectionPanel = panelHost.querySelector('.room-selection-panel');
    var selectionHint = panelHost.querySelector('.room-selection-hint');
    if (selectionPanel) selectionPanel.hidden = !showPurchase;
    if (selectionHint) selectionHint.hidden = isStandalone || !!activeArt;
    if (isStandalone) {
      window.clearTimeout(panelVisibilityTimer);
      if (showPurchase) {
        panelHost.hidden = false;
        requestAnimationFrame(function () {
          if (purchaseVisible) panelHost.classList.add('is-visible');
        });
      } else {
        panelHost.classList.remove('is-visible');
        panelVisibilityTimer = window.setTimeout(function () {
          if (!purchaseVisible) panelHost.hidden = true;
        }, tuning.panelTransition);
      }
    }
    if (viewerHost) viewerHost.classList.toggle('has-art-selection', !!activeArt);
    if (viewerHost) viewerHost.classList.toggle('has-purchase-popover', showPurchase);
    syncRoomState();
  }

  function cancelPurchaseHide() {
    window.clearTimeout(purchaseHideTimer);
  }

  function hasPersistentPurchasePanel() {
    return window.matchMedia('(max-width: 900px), (hover: none), (pointer: coarse)').matches;
  }

  function showContextualPurchase(item) {
    if (!isStandalone || !item) return;
    cancelPurchaseHide();
    purchaseVisible = true;
    activatePlacedArt(item, true);
  }

  function hideContextualPurchase(immediate) {
    if (!isStandalone) return;
    /* Touch devices do not have a stable hover boundary. Keep the purchase
       controls open after a tap and let the explicit close button dismiss
       them; synthetic pointerleave/focusout events otherwise hide the panel
       before a visitor can choose a size. */
    if (!immediate && hasPersistentPurchasePanel()) return;
    if (purchaseLocked && !immediate) return;
    cancelPurchaseHide();
    var hide = function () {
      purchaseVisible = false;
      updateCuratorUI();
    };
    if (immediate) hide();
    else purchaseHideTimer = window.setTimeout(hide, tuning.hideDelay);
  }

  function clearActiveArt() {
    if (!activeArt) return;
    cancelPurchaseHide();
    purchaseVisible = false;
    purchaseLocked = false;
    activeArt = null;
    artImg = null;
    placedArts.forEach(function (placed) {
      placed.img.classList.remove('is-active');
      placed.img.setAttribute('aria-pressed', 'false');
    });
    updateCuratorUI();
    render();
  }

  function activatePlacedArt(item, configurePurchase) {
    if (!item) return;
    activeArt = item;
    curWork = item.work;
    cur = item.dims;
    paintingOffset = item.offset;
    artImg = item.img;
    placedArts.forEach(function (placed) {
      placed.img.classList.toggle('is-active', placed === item);
      placed.img.setAttribute('aria-pressed', placed === item ? 'true' : 'false');
    });
    updateCuratorUI();
    if (configurePurchase !== false) configureActivePurchase(item);
    render();
  }

  function addPlacedWork(workIndex) {
    var existing = placedArts.filter(function (item) { return item.workIndex === workIndex; })[0];
    if (existing) { activatePlacedArt(existing, true); return existing; }
    if (placedArts.length >= MAX_WALL_ARTS) return null;
    var item = createPlacedArt(workIndex);
    if (!item) return null;
    if (isStandalone) purchaseVisible = false;
    arrangePlacedArts();
    hintDismissed = false;
    if (dragHint) dragHint.classList.remove('is-dismissed');
    window.setTimeout(dismissDragHint, 5000);
    activatePlacedArt(item, true);
    return item;
  }

  function removeActiveWork() {
    if (!activeArt) return;
    cancelPurchaseHide();
    purchaseVisible = false;
    if (artRemoveButton) artRemoveButton.hidden = true;
    if (dragHint) dragHint.hidden = true;
    var index = placedArts.indexOf(activeArt);
    activeArt.img.remove();
    placedArts.splice(index, 1);
    arrangePlacedArts();
    var fallback = placedArts[Math.min(index, placedArts.length - 1)];
    activeArt = null;
    artImg = null;
    if (fallback) activatePlacedArt(fallback, true);
    else {
      curWork = null;
      cur = null;
      updateCuratorUI();
      render();
    }
  }

  /* Colour-temperature ramp: warm tungsten → neutral → cool daylight.
     A small piecewise lerp across three stops keyed by light.temp (0..1). */
  function tempColor(t) {
    var warm = [1.00, 0.78, 0.55];      // ~2700K incandescent / lamp
    var neut = [1.00, 0.93, 0.85];      // ~4000K soft white LED
    var cool = [0.86, 0.93, 1.00];      // ~6500K north-window daylight
    var a, b, f;
    if (t < 0.5) { a = warm; b = neut; f = t / 0.5; }
    else         { a = neut; b = cool; f = (t - 0.5) / 0.5; }
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  /* One-tap moods — each sets temperature, brightness, ambient fill, and the
     light's position together, so people don't have to dial in sliders. */
  var LIGHT_PRESETS = {
    day:     { scene: 'day', temp: 0.92, intensity: 0.14, ambient: 0.99, fx: 0.80, fy: 0.92, mode: 1 },
    evening: { scene: 'evening', temp: 0.30, intensity: 0.20, ambient: 0.98, fx: 0.74, fy: 0.86, mode: 2 },
    gallery: { scene: 'gallery', temp: 0.52, intensity: 0.50, ambient: 0.92, fx: 0.50, fy: 0.95, mode: 3 }
  };

  /* Wall + floor paint swatches — each is the same four-tone shape as the
     original hardcoded room (wall top/bottom, floor top/bottom), just
     re-colored. Tuned to read as paint colors people actually have (a
     modern greige, a soft white, sage, terracotta, and a wearable
     charcoal — not near-black, which used to swallow the furniture),
     each paired with a floor tone that wouldn't look out of place with it. */
  var WALL_PRESETS = [
    { key: 'warm',   wallTop: [0.345, 0.325, 0.300], wallBot: [0.255, 0.240, 0.220], floorTop: [0.255, 0.238, 0.215], floorBot: [0.170, 0.158, 0.145] },
    { key: 'white',  wallTop: [0.880, 0.870, 0.845], wallBot: [0.780, 0.770, 0.745], floorTop: [0.520, 0.430, 0.335], floorBot: [0.370, 0.300, 0.230] },
    { key: 'sage',   wallTop: [0.520, 0.560, 0.490], wallBot: [0.410, 0.450, 0.395], floorTop: [0.310, 0.240, 0.185], floorBot: [0.205, 0.160, 0.125] },
    { key: 'clay',   wallTop: [0.555, 0.400, 0.335], wallBot: [0.450, 0.320, 0.265], floorTop: [0.300, 0.220, 0.165], floorBot: [0.195, 0.140, 0.105] },
    { key: 'char',   wallTop: [0.340, 0.340, 0.350], wallBot: [0.250, 0.250, 0.260], floorTop: [0.220, 0.195, 0.175], floorBot: [0.140, 0.125, 0.115] }
  ];
  var wallIdx = 0;

  /* ---------- WebGL setup ---------- */
  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  function initGL() {
    gl = canvas.getContext('webgl', { antialias: true }) ||
         canvas.getContext('experimental-webgl', { antialias: true });
    if (!gl) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    bgTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bgTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    ['u_res','u_ppi','u_origin','u_paint','u_person','u_couch','u_light','u_lcol','u_lint','u_amb',
     'u_wallTop','u_wallBot','u_floorTop','u_floorBot','u_env','u_lightMode','u_bg','u_texReady'].forEach(function (n) {
      uni[n] = gl.getUniformLocation(prog, n);
    });
    gl.uniform1i(uni.u_bg, 0);
    return true;
  }

  var environmentLoadToken = 0;

  function preloadEnvironment(idx) {
    var env = ENVIRONMENTS[idx];
    if (!env) return;
    Object.keys(env.sources).forEach(function (key) {
      var preload = new Image();
      preload.src = env.sources[key];
    });
  }

  function loadEnvironment(idx, onReady) {
    var env = ENVIRONMENTS[idx];
    if (!env || !gl) return;
    var requestToken = ++environmentLoadToken;
    textureReady = false;
    viewerHost.classList.add('is-changing-room');
    viewerHost.setAttribute('aria-busy', 'true');
    var img = new Image();
    img.decoding = 'async';
    img.onload = function () {
      if (requestToken !== environmentLoadToken) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bgTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      textureReady = true;
      viewerHost.classList.remove('is-changing-room');
      viewerHost.setAttribute('aria-busy', 'false');
      render();
      preloadEnvironment(idx);
      if (onReady) onReady(true);
    };
    img.onerror = function () {
      if (requestToken !== environmentLoadToken) return;
      viewerHost.classList.remove('is-changing-room');
      viewerHost.setAttribute('aria-busy', 'false');
      if (onReady) onReady(false);
    };
    img.src = env.sources[lightingScene] || env.sources.gallery;
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function applyCameraTarget(idx) {
    if (!cameraLayer) return;
    var target = ENVIRONMENTS[idx].camera;
    cameraScale = target.scale;
    cameraLayer.style.setProperty('--room-camera-x', target.x + '%');
    cameraLayer.style.setProperty('--room-camera-y', target.y + '%');
    cameraLayer.style.setProperty('--room-camera-scale', String(target.scale));
  }

  /* Room changes play as a small camera edit: ease away from the current
     composition while the next photograph loads, then focus and settle into
     that room's art-directed crop. The token makes rapid choices interruptible. */
  function transitionToEnvironment(idx) {
    var transitionToken = ++cameraTransitionToken;
    window.clearTimeout(cameraSettleTimer);
    viewerHost.classList.remove('is-camera-focusing');

    if (prefersReducedMotion()) {
      viewerHost.classList.remove('is-camera-pullback');
      applyCameraTarget(idx);
      loadEnvironment(idx);
      return;
    }

    viewerHost.classList.add('is-camera-pullback');
    viewerHost.getBoundingClientRect();
    var startedAt = performance.now();
    loadEnvironment(idx, function () {
      var wait = Math.max(0, 320 - (performance.now() - startedAt));
      cameraSettleTimer = window.setTimeout(function () {
        if (transitionToken !== cameraTransitionToken) return;
        applyCameraTarget(idx);
        viewerHost.classList.add('is-camera-focusing');
        viewerHost.getBoundingClientRect();
        viewerHost.classList.remove('is-camera-pullback');
        cameraSettleTimer = window.setTimeout(function () {
          if (transitionToken === cameraTransitionToken) {
            viewerHost.classList.remove('is-camera-focusing');
          }
        }, 1150);
      }, wait);
    });
  }

  function positionContextualPanel() {
    if (!isStandalone || !panelHost) return;
    var compact = window.matchMedia('(max-width: 900px)').matches;
    if (compact && panelHost.parentNode !== roomRow) roomRow.appendChild(panelHost);
    if (!compact && panelHost.parentNode !== viewerHost) viewerHost.appendChild(panelHost);
    if (!purchaseVisible || !activeArt || panelHost.hidden) return;
    if (compact) {
      panelHost.style.top = '';
      panelHost.style.bottom = '';
      panelHost.style.left = '';
      panelHost.style.right = '';
      panelHost.style.width = '';
      return;
    }
    var viewerBounds = viewerHost.getBoundingClientRect();
    var inset = tuning.mobileInset;
    panelHost.style.top = 'auto';
    panelHost.style.bottom = inset + 'px';
    panelHost.style.width = Math.min(Math.max(520, tuning.panelWidth), viewerBounds.width - inset * 2) + 'px';
    panelHost.style.right = 'auto';
    var panelWidth = panelHost.offsetWidth;
    panelHost.style.left = Math.max(inset, (viewerBounds.width - panelWidth) / 2) + 'px';
  }

  /* ---------- layout + render ---------- */
  function render() {
    raf = 0;
    if (!gl || !cur) {
      if (artRemoveButton) artRemoveButton.hidden = true;
      if (dragHint) dragHint.hidden = true;
      return;
    }

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw; canvas.height = ch;
      gl.viewport(0, 0, cw, ch);
    }

    /* A fixed 15-foot-wide wall gives the photographic rooms a consistent
       physical coordinate system, keeping painting scale meaningful. */
    var sceneW = 180;
    var sceneH = 101.25;
    var tallest = sceneH;
    var ppi = Math.min(cw / sceneW, ch / sceneH);
    if (isStandalone && scaleReference) {
      scaleReference.style.width = (36 * ppi / dpr) + 'px';
    }
    var originX = (cw - sceneW * ppi) / 2;
    var originY = (ch - sceneH * ppi) / 2;
    var env = ENVIRONMENTS[environment];
    function positionedArt(item) {
      var itemCur = item && item.dims ? item.dims : cur;
      var itemOffset = item && item.offset ? item.offset : paintingOffset;
      var cx = env.x * sceneW + itemOffset.x;
      var cy = env.y * sceneH + itemOffset.y;
      cx = Math.min(env.maxX * sceneW - itemCur.w / 2, Math.max(env.minX * sceneW + itemCur.w / 2, cx));
      cy = Math.min(env.maxY * sceneH - itemCur.h / 2, Math.max(env.minY * sceneH + itemCur.h / 2, cy));
      return { cx: cx, cy: cy, dims: itemCur };
    }
    var activePosition = positionedArt(activeArt);
    var paintCx = activePosition.cx;
    var paintCy = activePosition.cy;
    var couchCx = sceneW * 0.5;
    var personCx = sceneW * 0.86;

    gl.uniform2f(uni.u_res, cw, ch);
    gl.uniform1f(uni.u_ppi, ppi);
    gl.uniform2f(uni.u_origin, originX, originY);
    gl.uniform4f(uni.u_paint, paintCx, paintCy, cur.w, cur.h);
    gl.uniform2f(uni.u_person, personCx, person.height);
    gl.uniform3f(uni.u_couch, couchCx, couch.width, couch.height);
    gl.uniform2f(uni.u_light, light.fx * sceneW, light.fy * tallest);
    var lc = tempColor(light.temp);
    gl.uniform3f(uni.u_lcol, lc[0], lc[1], lc[2]);
    gl.uniform1f(uni.u_lint, light.intensity);
    gl.uniform1f(uni.u_amb, light.ambient);
    gl.uniform1f(uni.u_env, environment);
    gl.uniform1f(uni.u_lightMode, lightMode);
    gl.uniform1f(uni.u_texReady, textureReady ? 1 : 0);
    var wp = WALL_PRESETS[wallIdx];
    gl.uniform3f(uni.u_wallTop, wp.wallTop[0], wp.wallTop[1], wp.wallTop[2]);
    gl.uniform3f(uni.u_wallBot, wp.wallBot[0], wp.wallBot[1], wp.wallBot[2]);
    gl.uniform3f(uni.u_floorTop, wp.floorTop[0], wp.floorTop[1], wp.floorTop[2]);
    gl.uniform3f(uni.u_floorBot, wp.floorBot[0], wp.floorBot[1], wp.floorBot[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* Each artwork is a DOM image aligned to the room's physical coordinate
       system. The active work also drives the WebGL frame and purchase panel. */
    placedArts.forEach(function (item) {
      var pos = positionedArt(item);
      var leftPx = (originX + (pos.cx - pos.dims.w / 2) * ppi) / dpr;
      var topPx  = (ch - (originY + (pos.cy + pos.dims.h / 2) * ppi)) / dpr;
      item.img.style.left = leftPx + 'px';
      item.img.style.top = topPx + 'px';
      item.img.style.width = (pos.dims.w * ppi / dpr) + 'px';
      item.img.style.height = (pos.dims.h * ppi / dpr) + 'px';
      item.img.style.visibility = 'visible';
      item.img.classList.toggle('is-active', item === activeArt);
      item.img.style.zIndex = item === activeArt ? '2' : '1';
    });
    var selectedViewerBounds = activeArt ? viewerHost.getBoundingClientRect() : null;
    var selectedArtBounds = activeArt ? activeArt.img.getBoundingClientRect() : null;
    if (artRemoveButton) {
      var canRemoveActive = !!activeArt;
      artRemoveButton.hidden = !canRemoveActive;
      if (canRemoveActive) {
        artRemoveButton.style.left = (selectedArtBounds.right - selectedViewerBounds.left - 18) + 'px';
        artRemoveButton.style.top = (selectedArtBounds.top - selectedViewerBounds.top - 18) + 'px';
        artRemoveButton.setAttribute('aria-label', 'Remove ' + activeArt.work.title + ' from wall');
      }
    }
    if (dragHint) {
      var showNudge = !!activeArt && !hintDismissed;
      dragHint.hidden = !showNudge;
      if (showNudge) {
        var hintWidth = selectedArtBounds.width;
        var hintHeight = selectedArtBounds.height;
        dragHint.style.left = (selectedArtBounds.left - selectedViewerBounds.left) + 'px';
        dragHint.style.top = (selectedArtBounds.top - selectedViewerBounds.top) + 'px';
        dragHint.style.width = hintWidth + 'px';
        dragHint.style.height = hintHeight + 'px';
        var hintSvg = dragHint.querySelector('svg');
        var hintRect = dragHint.querySelector('rect');
        hintSvg.setAttribute('viewBox', '0 0 ' + hintWidth + ' ' + hintHeight);
        hintRect.setAttribute('width', Math.max(0, hintWidth - 2));
        hintRect.setAttribute('height', Math.max(0, hintHeight - 2));
      }
    }
    positionContextualPanel();
    var figureHeightPx = figure.height * ppi / dpr;
    var figureBasePx = env.figureBase * ch / dpr;
    var figureSceneX = figure.fx * sceneW;
    var figureFacesRight = figureSceneX <= paintCx;
    figureImg.style.left = (figure.fx * cw / dpr) + 'px';
    figureImg.style.bottom = figureBasePx + 'px';
    figureImg.style.height = figureHeightPx + 'px';
    figureImg.style.setProperty('--figure-facing', figureFacesRight ? '1' : '-1');
    figureImg.dataset.facing = figureFacesRight ? 'right' : 'left';
    figureImg.style.visibility = 'visible';
    figureImg.hidden = !figure.visible;
    figureShadow.style.left = (figure.fx * cw / dpr) + 'px';
    figureShadow.style.bottom = Math.max(0, figureBasePx - 2) + 'px';
    figureShadow.style.width = (figureHeightPx * 0.22) + 'px';
    figureShadow.style.visibility = 'visible';
    figureShadow.hidden = !figure.visible;
    figureImg.style.filter = lightMode === 1
      ? 'brightness(1.01) saturate(.82) contrast(1.03) drop-shadow(0 1px 1px rgba(0,0,0,.16))'
      : (lightMode === 2
        ? 'brightness(.72) sepia(.13) saturate(.78) contrast(1.08) drop-shadow(0 2px 2px rgba(0,0,0,.34))'
        : 'brightness(.91) saturate(.72) contrast(1.09) drop-shadow(0 2px 2px rgba(0,0,0,.28))');

    /* cache the layout so pointer events can map screen px → scene inches
       (used for dragging the light source) */
    layout = { sceneW: sceneW, tallest: tallest, ppi: ppi, paintCx: paintCx, paintCy: paintCy,
               originX: originX, originY: originY, dpr: dpr, cw: cw, ch: ch };
  }

  function requestRender() { if (!raf) raf = requestAnimationFrame(render); }

  /* ---------- DOM ---------- */
  function fmtFtIn(inches) {
    var ft = Math.floor(inches / 12), inc = Math.round(inches % 12);
    if (inc === 12) { ft++; inc = 0; }
    return ft + '′' + (inc ? inc + '″' : '');
  }
  /* Unit-aware length: cm mode rounds to the nearest cm; in mode uses ft/in
     for tall spans (person, couch width) and plain inches for short ones. */
  function fmtLen(inches, useFtIn) {
    if (unit === 'cm') return Math.round(inches * 2.54) + ' cm';
    return useFtIn ? fmtFtIn(inches) : (Math.round(inches) + '″');
  }

  /* Prints only — no "Original" chip/CTA. The room still previews the
     original's true size by default (see show()), it's just not a
     purchasable, clickable option here. */
  var GROUPS_HTML =
    '<div class="lb-size-groups" role="group" aria-label="Choose a print size" data-i18n-aria="room.chooseSize">' +
      '<div class="lb-size-group" data-group="prints"><div class="room-size-heading">' +
        '<span class="lb-size-label" data-i18n="room.sizeLabel">Size:</span>' +
        '<div class="room-units" role="group" aria-label="Display units">' +
          '<button type="button" class="room-unit is-active" data-unit="in" aria-pressed="true" aria-label="Inches" data-i18n-aria="room.inches">in.</button>' +
          '<button type="button" class="room-unit" data-unit="cm" aria-pressed="false" aria-label="Centimeters" data-i18n-aria="room.centimeters">cm</button>' +
        '</div>' +
      '</div>' +
        '<div class="lb-size-chips" data-chips="prints"></div></div>' +
    '</div>';

  /* Builds the room UI into three hosts inside the lightbox, all below the
     artwork; nothing shows until the visitor scrolls down to this section:
     - viewerHost: the canvas room preview.
     - panelHost: beside the preview; print-size chips + buy CTA (revealed
       only after a size is picked).
     - slidersHost: the header controls, including artwork selectors, room,
       lighting, figure height, and reset. Called once. */
  function mount(viewerEl, panelEl, slidersEl) {
    if (mounted) return;
    mounted = true;
    viewerHost = viewerEl;
    panelHost = panelEl;
    slidersHost = slidersEl;
    viewerHost.dataset.roomExperience = experience;
    viewerHost.classList.add('room-viewer--' + experience);
    panelHost.classList.add('room-panel--' + experience);
    viewerHost.setAttribute('tabindex', '-1');
    viewerHost.setAttribute('role', 'region');
    viewerHost.setAttribute('aria-label', t('room.viewerLabel'));
    viewerHost.setAttribute('data-i18n-aria', 'room.viewerLabel');
    roomRow = viewerHost.closest('.lb-room-row');
    var roomTitle = roomRow && roomRow.querySelector('.lb-room-title');
    if (roomRow && roomTitle) {
      roomHeader = document.createElement('div');
      roomHeader.className = 'room-header';
      roomRow.insertBefore(roomHeader, roomTitle);
      roomHeader.appendChild(roomTitle);
      roomHeader.appendChild(slidersHost);
    }

    viewerHost.innerHTML =
      '<div class="room-camera">' +
        '<canvas class="room-canvas"></canvas>' +
        '<div class="room-art-layer"></div>' +
        '<div class="room-figure-shadow" hidden></div>' +
        '<img class="room-figure" src="images/rooms/figure.png?v=2" alt="Scale figure" draggable="false" tabindex="0" role="button" aria-label="Scale figure. Drag left or right to reposition." title="Drag figure left or right">' +
        (isStandalone ? '<div class="room-scale-reference" role="img" aria-label="Scale reference: three feet"><span>3 ft</span><i aria-hidden="true"></i></div>' : '') +
      '</div>' +
      '<div class="room-art-nudge" aria-hidden="true" hidden><svg preserveAspectRatio="none"><rect x="1" y="1" rx="1" ry="1"></rect></svg></div>';
    /* The purchase panel keeps a single visual destination: checkout. Size
       selection and the chosen variant are supporting information; artwork
       and scene controls live together in the section header. */
    panelHost.innerHTML =
      '<p class="room-selection-hint" data-i18n="room.selectHint">Select a painting in the room to see its details and purchase options.</p>' +
      '<div class="room-selection-panel" hidden>' +
        '<div class="room-selection-head">' +
          '<span class="room-selection-label" data-i18n="room.selectedArtwork">Selected artwork</span>' +
          '<div class="room-selection-actions">' +
            '<button type="button" class="room-done" aria-label="Close controls" title="Close controls"><span aria-hidden="true">&times;</span></button>' +
          '</div>' +
        '</div>' +
        '<div class="room-buy-card">' +
          '<header class="room-buy-head">' +
            '<a class="room-view-details" href="#" aria-label="View artwork details">' +
              '<h4 class="room-buy-title">' +
                '<span class="room-buy-title-text"></span>' +
                '<span class="room-buy-year"></span>' +
                '<span class="room-see-more">View artwork</span>' +
              '</h4>' +
            '</a>' +
          '</header>' +
          '<div class="room-purchase-stage">' +
            GROUPS_HTML +
            '<div class="room-buy-summary" aria-live="polite" hidden>' +
              '<span data-i18n="room.originalSize">Original size</span>' +
              '<strong class="room-buy-selection">&#8212;</strong>' +
            '</div>' +
            '<div class="room-purchase-actions" hidden>' +
              '<button type="button" class="room-size-back" aria-label="Choose another print size" title="Choose another size"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg></button>' +
              '<a class="btn btn--primary room-buy" hidden>' +
                '<span class="room-buy-label" data-i18n="room.purchasePrint">Purchase print</span>' +
                '<span class="room-buy-price"></span>' +
              '</a>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    if (isStandalone) {
      viewerHost.appendChild(panelHost);
      panelHost.hidden = true;
      applyTuning();
    }
    slidersHost.innerHTML =
      '<div class="room-box">' +
        '<div class="room-artwork-rail">' +
          '<div class="room-artwork-strip" role="group" aria-label="Add or remove artwork from the wall"></div>' +
          '<button type="button" class="room-artwork-next" aria-label="Show more artwork choices" hidden>' +
            '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg>' +
          '</button>' +
        '</div>' +
        '<div class="room-scene-controls">' +
          '<div class="room-control-group">' +
            '<button type="button" class="room-cycle-control room-environment-cycle" aria-label="Change room. Current: Dining room">' +
              '<span class="room-ctl-label">Room</span><strong class="room-cycle-value room-environment-value">Dining room</strong>' +
            '</button>' +
          '</div>' +
          '<div class="room-control-group">' +
            '<button type="button" class="room-cycle-control room-light-cycle" aria-label="Change lighting. Current: Evening">' +
              '<span class="room-ctl-label" data-i18n="room.lighting">Light</span><strong class="room-cycle-value room-light-value">Evening</strong>' +
            '</button>' +
          '</div>' +
          '<div class="room-control-group room-figure-settings">' +
            '<button type="button" class="room-cycle-control room-figure-cycle" aria-label="Change figure height. Current: 5 feet 7 inches">' +
              '<span class="room-ctl-label">Figure height</span><strong class="room-cycle-value room-figure-value">5&#8242;7&#8243;</strong>' +
            '</button>' +
          '</div>' +
          '<button type="button" class="room-reset" aria-label="Reset room positions" title="Reset room positions" disabled>&#8634;</button>' +
        '</div>' +
      '</div>';
    /* This panel is only built once, the first time a lightbox opens — if
       that happens after a language switch, sweep it into the current
       language right away instead of waiting for the next switch. */
    if (window.I18N && window.I18N.sweep) window.I18N.sweep();
    syncCycleControls();

    panelHost.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    if (isStandalone) {
      panelHost.addEventListener('pointerenter', cancelPurchaseHide);
      panelHost.addEventListener('pointerleave', function () { hideContextualPurchase(false); });
      panelHost.addEventListener('focusin', cancelPurchaseHide);
      panelHost.addEventListener('focusout', function () { hideContextualPurchase(false); });
    }
    slidersHost.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

    cameraLayer = viewerHost.querySelector('.room-camera');
    scaleReference = viewerHost.querySelector('.room-scale-reference');
    canvas = viewerHost.querySelector('.room-canvas');
    artLayer = viewerHost.querySelector('.room-art-layer');
    artRemoveButton = document.createElement('button');
    artRemoveButton.type = 'button';
    artRemoveButton.className = 'room-art-remove';
    artRemoveButton.setAttribute('aria-label', 'Remove selected work from wall');
    artRemoveButton.title = 'Remove selected work';
    artRemoveButton.innerHTML = '&times;';
    artRemoveButton.hidden = true;
    viewerHost.appendChild(artRemoveButton);
    figureImg = viewerHost.querySelector('.room-figure');
    figureShadow = viewerHost.querySelector('.room-figure-shadow');
    applyCameraTarget(environment);
    dragHint = viewerHost.querySelector('.room-art-nudge');
    resetButton = slidersHost.querySelector('.room-reset');
    artRemoveButton.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    artRemoveButton.addEventListener('click', function (e) {
      e.stopPropagation();
      removeActiveWork();
    });
    var artworkRail = slidersHost.querySelector('.room-artwork-rail');
    var artworkStrip = slidersHost.querySelector('.room-artwork-strip');
    var artworkNext = slidersHost.querySelector('.room-artwork-next');
    var artworkScrollDirection = 1;
    var artworkMaxScroll = 0;

    function getArtworkStripWidth() {
      var buttons = artworkStrip.querySelectorAll('.room-artwork-toggle');
      var stripStyle = window.getComputedStyle(artworkStrip);
      var gap = parseFloat(stripStyle.columnGap || stripStyle.gap) || 0;
      var width = (parseFloat(stripStyle.paddingLeft) || 0) +
        (parseFloat(stripStyle.paddingRight) || 0);
      Array.prototype.forEach.call(buttons, function (button) {
        width += button.getBoundingClientRect().width;
      });
      return width + Math.max(0, buttons.length - 1) * gap;
    }

    function updateArtworkRail() {
      if (!artworkRail || !artworkStrip || !artworkNext) return;
      var compact = window.matchMedia('(max-width: 1400px)').matches;
      artworkMaxScroll = Math.max(0, getArtworkStripWidth() - artworkStrip.clientWidth);
      var overflowing = compact && artworkMaxScroll > 2;
      artworkRail.classList.toggle('has-overflow', overflowing);
      artworkNext.hidden = !overflowing;
      if (!overflowing) {
        artworkScrollDirection = 1;
        artworkStrip.scrollLeft = 0;
      } else {
        var atStart = artworkStrip.scrollLeft <= 2;
        var atEnd = artworkStrip.scrollLeft >= artworkMaxScroll - 2;
        if (atEnd) artworkScrollDirection = -1;
        else if (atStart) artworkScrollDirection = 1;
      }
      artworkNext.classList.toggle('is-back', artworkScrollDirection < 0);
      artworkNext.setAttribute('aria-label', artworkScrollDirection < 0
        ? 'Show previous artwork choices'
        : 'Show more artwork choices');
    }

    artworkNext.addEventListener('click', function () {
      var page = Math.max(48, artworkStrip.clientWidth - 48);
      var destination = Math.min(
        artworkMaxScroll,
        Math.max(0, artworkStrip.scrollLeft + artworkScrollDirection * page)
      );
      artworkStrip.scrollTo({
        left: destination,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
      });
    });
    artworkStrip.addEventListener('scroll', updateArtworkRail, { passive: true });
    window.addEventListener('resize', updateArtworkRail);
    if (window.ResizeObserver) {
      new ResizeObserver(updateArtworkRail).observe(artworkRail);
    }
    works.forEach(function (w, index) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'room-artwork-toggle';
      button.dataset.workIndex = index;
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', 'Add to wall: ' + w.title);
      button.title = w.title;
      var image = document.createElement('img');
      image.src = w.imagePath;
      image.alt = '';
      image.loading = 'lazy';
      var details = document.createElement('span');
      details.className = 'room-artwork-tooltip';
      var title = document.createElement('strong');
      title.textContent = w.title;
      var meta = document.createElement('small');
      meta.textContent = w.year + ' · ' + w.medium;
      details.appendChild(title);
      details.appendChild(meta);
      button.appendChild(image);
      button.appendChild(details);
      button.addEventListener('click', function () {
        var toggleIndex = parseInt(button.dataset.workIndex, 10);
        var existing = placedArts.filter(function (item) { return item.workIndex === toggleIndex; })[0];
        if (existing) {
          activatePlacedArt(existing, false);
          removeActiveWork();
        } else {
          addPlacedWork(toggleIndex);
        }
      });
      artworkStrip.appendChild(button);
    });
    requestAnimationFrame(updateArtworkRail);
    syncRoomState();
    window.setTimeout(dismissDragHint, 5000);

    /* ---- draggable painting ---- */
    var draggingPainting = false;
    var draggingArtItem = null;
    var dragStart = null;
    viewerHost.addEventListener('pointerdown', function (e) {
      var target = e.target.closest('.room-art');
      if (!target) {
        if (!e.target.closest('.room-figure')) clearActiveArt();
        return;
      }
      if (!layout) return;
      var item = wallItemById(target.dataset.wallArtId);
      if (!item) return;
      activatePlacedArt(item, true);
      draggingPainting = true;
      draggingArtItem = item;
      dragStart = { x: e.clientX, y: e.clientY, ox: item.offset.x, oy: item.offset.y, moved: false };
      target.setPointerCapture(e.pointerId);
      viewerHost.classList.add('is-moving-art');
      e.preventDefault();
    });
    viewerHost.addEventListener('pointermove', function (e) {
      if (!draggingPainting || !draggingArtItem || !layout) return;
      var cssPpi = layout.ppi / layout.dpr;
      draggingArtItem.offset.x = dragStart.ox + (e.clientX - dragStart.x) / (cssPpi * cameraScale);
      draggingArtItem.offset.y = dragStart.oy - (e.clientY - dragStart.y) / (cssPpi * cameraScale);
      paintingOffset = draggingArtItem.offset;
      if (Math.abs(e.clientX - dragStart.x) + Math.abs(e.clientY - dragStart.y) > 3) {
        dragStart.moved = true;
        dismissDragHint();
        paintingMoved = true;
        updateResetState();
      }
      render();
    });
    function endPaintingDrag(e) {
      if (!draggingPainting) return;
      var selectedItem = draggingArtItem;
      var wasTap = e.type === 'pointerup' && dragStart && !dragStart.moved && selectedItem;
      draggingPainting = false;
      draggingArtItem = null;
      dragStart = null;
      viewerHost.classList.remove('is-moving-art');
      if (wasTap && isStandalone) {
        showContextualPurchase(selectedItem);
      } else if (wasTap && viewerHost && !viewerHost.closest('.lightbox') && window.ArtworkDetails && window.ArtworkDetails.open) {
        window.ArtworkDetails.open(selectedItem.workIndex, viewerHost);
      }
    }
    viewerHost.addEventListener('pointerup', endPaintingDrag);
    viewerHost.addEventListener('pointercancel', endPaintingDrag);
    viewerHost.addEventListener('keydown', function (e) {
      var target = e.target.closest('.room-art');
      if (target && (e.key === 'Enter' || e.key === ' ') && !viewerHost.closest('.lightbox')) {
        var openItem = wallItemById(target.dataset.wallArtId);
        if (openItem && isStandalone) {
          showContextualPurchase(openItem);
          var firstSize = panelHost.querySelector('.room-size');
          if (firstSize) firstSize.focus({ preventScroll: true });
        } else if (openItem && window.ArtworkDetails && window.ArtworkDetails.open) {
          window.ArtworkDetails.open(openItem.workIndex, viewerHost);
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!target || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      var item = wallItemById(target.dataset.wallArtId);
      if (!item) return;
      activatePlacedArt(item, true);
      if (e.key === 'ArrowLeft') item.offset.x -= 2;
      if (e.key === 'ArrowRight') item.offset.x += 2;
      if (e.key === 'ArrowUp') item.offset.y += 2;
      if (e.key === 'ArrowDown') item.offset.y -= 2;
      paintingMoved = true;
      updateResetState();
      dismissDragHint();
      render();
      e.preventDefault();
      e.stopPropagation();
    });

    /* The scale figure stays grounded: visitors can move it sideways only. */
    var draggingFigure = false;
    var figureDragStart = null;
    figureImg.addEventListener('pointerdown', function (e) {
      if (!layout || !figure.visible) return;
      draggingFigure = true;
      figureDragStart = { x: e.clientX, fx: figure.fx };
      figureImg.setPointerCapture(e.pointerId);
      viewerHost.classList.add('is-moving-figure');
      e.preventDefault();
    });
    figureImg.addEventListener('pointermove', function (e) {
      if (!draggingFigure || !layout) return;
      var viewerWidth = Math.max(1, viewerHost.getBoundingClientRect().width);
      figure.fx = Math.min(0.90, Math.max(0.10, figureDragStart.fx + (e.clientX - figureDragStart.x) / (viewerWidth * cameraScale)));
      if (Math.abs(e.clientX - figureDragStart.x) > 3) {
        figureMoved = true;
        updateResetState();
      }
      render();
    });
    function endFigureDrag() {
      if (!draggingFigure) return;
      draggingFigure = false;
      viewerHost.classList.remove('is-moving-figure');
    }
    figureImg.addEventListener('pointerup', endFigureDrag);
    figureImg.addEventListener('pointercancel', endFigureDrag);
    figureImg.addEventListener('keydown', function (e) {
      if (!figure.visible || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      figure.fx = Math.min(0.90, Math.max(0.10, figure.fx + (e.key === 'ArrowLeft' ? -0.02 : 0.02)));
      figureMoved = true;
      updateResetState();
      render();
      e.preventDefault();
      e.stopPropagation();
    });

    /* Print chips + live checkout */
    panelHost.addEventListener('click', function (e) {
      if (e.target.closest('.room-done')) { clearActiveArt(); return; }
      if (e.target.closest('.room-size-back')) {
        var groups = panelHost.querySelector('.lb-size-groups');
        var actions = panelHost.querySelector('.room-purchase-actions');
        var summary = panelHost.querySelector('.room-buy-summary');
        var card = panelHost.querySelector('.room-buy-card');
        if (groups) groups.hidden = false;
        if (actions) actions.hidden = true;
        if (summary) summary.hidden = true;
        if (card) card.classList.remove('has-purchase-action');
        purchaseLocked = false;
        var selectedChip = panelHost.querySelector('.room-size.is-selected');
        if (selectedChip) selectedChip.focus({ preventScroll: true });
        return;
      }
      var unitButton = e.target.closest('.room-unit');
      if (unitButton) { setDisplayUnit(unitButton.dataset.unit); return; }
      var chip = e.target.closest('.room-size');
      if (chip) { selectSize(parseInt(chip.dataset.idx, 10)); return; }
      var buy = e.target.closest('.room-buy');
      if (buy && buy.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
      if (buy && buy.dataset.variantId && window.Shop) {
        e.preventDefault();
        var label = buy.querySelector('.room-buy-label').textContent;
        var price = buy.querySelector('.room-buy-price').textContent;
        setBuyButtonContent(buy, t('room.openingCheckout'), price);
        window.Shop.buyVariant(buy.dataset.variantId).then(function (ok) {
          if (!ok) {
            setBuyButtonContent(buy, label, price);
            alert(t('room.checkoutError'));
          }
        });
      }
    });
    viewerHost.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && activeArt) {
        clearActiveArt();
        viewerHost.focus({ preventScroll: true });
        e.preventDefault();
        e.stopPropagation();
      }
    });

    slidersHost.querySelector('.room-environment-cycle').addEventListener('click', function (e) {
      var nextEnvironment = (environment + 1) % ENVIRONMENTS.length;
      environment = nextEnvironment;
      arrangePlacedArts();
      figure.fx = ENVIRONMENTS[environment].figureX;
      paintingMoved = false;
      figureMoved = false;
      updateResetState();
      syncCycleControls();
      e.currentTarget.setAttribute('aria-label', 'Change room. Current: ' + ENVIRONMENTS[environment].name);
      transitionToEnvironment(environment);
    });

    /* Lighting presets — set warmth, brightness, ambient + light position */
    slidersHost.querySelector('.room-light-cycle').addEventListener('click', function (e) {
      var scenes = ['day', 'evening', 'gallery'];
      var nextScene = scenes[(scenes.indexOf(lightingScene) + 1) % scenes.length];
      var p = LIGHT_PRESETS[nextScene];
      if (!p) return;
      light.temp = p.temp; light.intensity = p.intensity; light.ambient = p.ambient;
      light.fx = p.fx; light.fy = p.fy;
      lightMode = p.mode;
      lightingScene = p.scene;
      syncCycleControls();
      e.currentTarget.setAttribute('aria-label', 'Change lighting. Current: ' + t('room.' + lightingScene));
      loadEnvironment(environment);
    });

    slidersHost.querySelector('.room-figure-cycle').addEventListener('click', function (e) {
      var heights = [0, 62, 67, 72];
      var currentHeight = figure.visible ? figure.height : 0;
      var height = heights[(heights.indexOf(currentHeight) + 1) % heights.length];
      figure.visible = height > 0;
      if (figure.visible) figure.height = height;
      syncCycleControls();
      e.currentTarget.setAttribute('aria-label', 'Change figure height. Current: ' + (figure.visible ? fmtFtIn(figure.height) : 'Off'));
      render();
    });

    resetButton.addEventListener('click', function () {
      arrangePlacedArts();
      figure.fx = ENVIRONMENTS[environment].figureX;
      paintingMoved = false;
      figureMoved = false;
      updateResetState();
      render();
    });

    window.addEventListener('resize', requestRender);
  }

  function syncOutputs() {
    var hang = slidersHost.querySelector('[data-hang]');
    if (hang) {
      hang.textContent = t('room.dragNote');
    }
  }

  /* ---------- sizes (original + prints) ---------- */
  var curWork = null, sizeOptions = [], sizeIndex = 0;

  /* Display text normally comes straight from the parsed H×W dims, but a
     print can carry its own `displayLabel` (from works.js `label:`) to show
     different text than the dims that actually drive the room's scale. */
  function dispHW(opt) {
    var dims = opt.dims;
    if (opt.displayLabel) {
      var m = parseDims(opt.displayLabel);
      if (m) dims = m;
    }
    if (unit === 'cm') {
      return Math.round(dims.h * 2.54) + ' × ' + Math.round(dims.w * 2.54) + ' cm';
    }
    return dims.h + ' × ' + dims.w + ' in.';
  }
  function dispIN(opt) {
    return opt.displayLabel || (opt.dims.h + ' × ' + opt.dims.w + ' in');
  }

  function originalSizeLabel() {
    var dims = curWork && parseDims(curWork.dimensions);
    return dims ? dispHW({ dims: dims }) : '\u2014';
  }

  function setDisplayUnit(nextUnit) {
    if (nextUnit !== 'in' && nextUnit !== 'cm') return;
    unit = nextUnit;
    panelHost.querySelectorAll('.room-unit').forEach(function (button) {
      var selected = button.dataset.unit === unit;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    panelHost.querySelectorAll('.room-size').forEach(function (button) {
      var opt = sizeOptions[parseInt(button.dataset.idx, 10)];
      if (opt) button.textContent = dispHW(opt) + (opt.estimated ? ' (est.)' : '');
    });
    var selection = panelHost.querySelector('.room-buy-selection');
    var selected = sizeOptions[sizeIndex];
    if (selection) selection.textContent = originalSizeLabel();
    var buy = panelHost.querySelector('.room-buy');
    if (buy && selected && selected.kind === 'print' && !buy.hidden && !buy.hasAttribute('aria-disabled')) {
      setBuyButtonContent(buy, buyPrintLabel(selected), buy.querySelector('.room-buy-price').textContent);
    }
  }

  function buildSizes(w) {
    var dims = parseDims(w.roomDimensions || w.dimensions);
    var estimated = !dims;
    if (!dims) {                                  // graceful default until real dims exist
      dims = (w.orientation === 'landscape') ? { h: 27, w: 36 } : { h: 36, w: 27 };
    }
    /* sizeOptions[0] stays the original for the lightbox's true-size preview.
       The standalone room starts with the largest available print selected.
       The original never gets a buy CTA; only prints are purchasable here. */
    sizeOptions = [{ kind: 'original', label: 'Original', dims: dims, estimated: estimated }];
    (w.prints || []).forEach(function (p) {
      var d = parseDims(p.size);
      if (d) sizeOptions.push({ kind: 'print', label: p.size.replace(/\s*in$/, '″'),
                                dims: d, displayLabel: p.label || '',
                                variant: p.variant || '', url: p.url || '', price: p.price || '' });
    });

    var printRow = panelHost.querySelector('[data-chips="prints"]');
    printRow.innerHTML = '';
    /* Largest first — collect print indices, then sort by area (not just
       array position, so it's correct even if a work's prints aren't
       listed smallest-to-largest in works.js) before rendering chips. */
    var printIdxs = [];
    sizeOptions.forEach(function (opt, idx) { if (opt.kind === 'print') printIdxs.push(idx); });
    printIdxs.sort(function (a, b) {
      var areaA = sizeOptions[a].dims.h * sizeOptions[a].dims.w;
      var areaB = sizeOptions[b].dims.h * sizeOptions[b].dims.w;
      return areaB - areaA;
    });
    printIdxs.forEach(function (idx, rank) {
      var opt = sizeOptions[idx];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'room-size ' + (rank === 0 ? 'room-size--primary' : 'room-size--secondary');
      b.dataset.idx = idx;
      b.textContent = dispHW(opt) + (opt.estimated ? ' (est.)' : '');
      b.setAttribute('aria-pressed', 'false');
      printRow.appendChild(b);
    });
    /* hide the whole prints group when a work has no prints at all */
    panelHost.querySelector('[data-group="prints"]').hidden = sizeOptions.length < 2;
  }

  function mailtoFor(w, sizeText) {
    return 'mailto:' + ((window.SITE && window.SITE.contactEmail) || '') +
      '?subject=' + encodeURIComponent('Inquiry: ' + w.title + ' — ' + sizeText);
  }

  function setBuyButtonContent(buy, label, price) {
    if (!buy) return;
    var labelNode = buy.querySelector('.room-buy-label');
    var priceNode = buy.querySelector('.room-buy-price');
    if (labelNode) labelNode.textContent = label || '';
    if (priceNode) priceNode.textContent = price || '';
    buy.classList.toggle('has-price', !!price);
    buy.setAttribute('aria-label', price ? label + ', ' + price : label);
  }

  function buyPrintLabel(opt) {
    return dispHW(opt);
  }

  function selectSize(idx, explicitChoice) {
    sizeIndex = idx;
    var opt = sizeOptions[idx];
    if (!opt || opt.kind !== 'print') return;      // only prints are selectable/purchasable
    if (isStandalone) {
      purchaseLocked = explicitChoice !== false;
      cancelPurchaseHide();
    }
    cur = { w: opt.dims.w, h: opt.dims.h, title: curWork.title, estimated: !!opt.estimated };
    if (activeArt) {
      activeArt.dims = cur;
      activeArt.sizeIndex = idx;
      if (explicitChoice !== false) activeArt.sizeExplicit = true;
    }

    panelHost.querySelectorAll('.room-size').forEach(function (b) {
      var selected = parseInt(b.dataset.idx, 10) === idx;
      b.classList.toggle('is-selected', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });

    /* Keep checkout out of the decision until a print size is chosen. */
    var buy = panelHost.querySelector('.room-buy');
    var summary = panelHost.querySelector('.room-buy-summary');
    var buyCard = panelHost.querySelector('.room-buy-card');
    var purchaseActions = panelHost.querySelector('.room-purchase-actions');
    var sizeGroups = panelHost.querySelector('.lb-size-groups');
    buy.hidden = false;
    summary.hidden = false;
    if (purchaseActions) purchaseActions.hidden = false;
    if (isStandalone && sizeGroups) sizeGroups.hidden = true;
    buyCard.classList.add('has-purchase-action');
    buy.classList.remove('room-buy--revealed');
    summary.classList.remove('room-buy-summary--revealed');
    void buy.offsetWidth;
    buy.classList.add('room-buy--revealed');
    summary.classList.add('room-buy-summary--revealed');
    buy.classList.remove('room-buy--pending');
    buy.removeAttribute('aria-disabled');
    var sizeText = dispIN(opt);
    delete buy.dataset.variantId;                 // reset live-checkout wiring
    buy.dataset.artworkTitle = curWork.title;
    buy.dataset.artworkSlug = curWork.slug || '';
    buy.dataset.printSize = sizeText;
    buy.dataset.shopifyVariant = opt.variant || '';

    panelHost.querySelector('.room-buy-selection').textContent = originalSizeLabel();
    setBuyButtonContent(buy, buyPrintLabel(opt), opt.price || '');
    /* Cart permalink from the variant id → Shopify-hosted checkout */
    var shopDomain = (window.SITE && window.SITE.shopify && window.SITE.shopify.domain) || '';
    var shopUrl = '';
    if (opt.variant && shopDomain) {
      shopUrl = 'https://' + shopDomain + '/cart/' + opt.variant + ':1';
    } else {
      shopUrl = opt.url || (window.SITE && window.SITE.printsUrl) || '';
    }
    if (shopUrl) {
      buy.href = shopUrl;
      buy.setAttribute('target', '_blank'); buy.setAttribute('rel', 'noopener');
    } else {
      buy.href = mailtoFor(curWork, 'Print, ' + sizeText);
      buy.removeAttribute('target'); buy.removeAttribute('rel');
    }

    // Shared demos must never create real orders until explicitly configured.
    if (!window.SITE || window.SITE.checkoutEnabled !== true || !shopUrl) {
      buy.removeAttribute('href');
      buy.removeAttribute('target');
      buy.removeAttribute('rel');
      buy.setAttribute('aria-disabled', 'true');
      buy.setAttribute('title', 'Checkout is disabled in this demo');
      render();
      return;
    }
    buy.removeAttribute('title');

    /* Shopify: resolve the live variant for this work + size; when found,
       upgrade the button to real price + direct Shopify-hosted checkout. */
    if (window.Shop && window.Shop.ready) {
      var reqWork = curWork, reqIdx = idx, reqArt = activeArt;
      window.Shop.findVariant(reqWork, sizeText).then(function (v) {
        if (!v || curWork !== reqWork || activeArt !== reqArt || sizeIndex !== reqIdx) return;
        if (!v.available) {
          setBuyButtonContent(buy, t('room.soldOut'), '');
          buy.classList.add('room-buy--pending');
          buy.setAttribute('aria-disabled', 'true');
          buy.removeAttribute('href');
          return;
        }
        panelHost.querySelector('.room-buy-selection').textContent = originalSizeLabel();
        setBuyButtonContent(buy, buyPrintLabel(opt), v.price);
        buy.dataset.variantId = v.id;
        buy.dataset.shopifyVariant = String(v.id).split('/').pop();
        buy.href = '#';
        buy.removeAttribute('target'); buy.removeAttribute('rel');
      });
    }
    render();
  }

  function ensureGL() {
    if (glBroken) return false;
    if (gl) return true;
    try { if (initGL()) return true; } catch (e) {}
    glBroken = true;
    return false;
  }

  function configureActivePurchase(item) {
    if (!item || !panelHost) return;
    purchaseLocked = false;
    var w = item.work;
    curWork = w;
    cur = item.dims;
    sizeIndex = item.sizeIndex;
    buildSizes(w);
    var titleNode = panelHost.querySelector('.room-buy-title-text');
    titleNode.textContent = w.title;
    var yearNode = panelHost.querySelector('.room-buy-year');
    if (yearNode) yearNode.textContent = w.year ? ', ' + w.year : '';
    panelHost.querySelector('.room-buy-title').title = w.title + ', ' + w.year;
    var detailsLink = panelHost.querySelector('.room-view-details');
    if (detailsLink) {
      detailsLink.href = '#artwork-' + (w.slug || '');
      detailsLink.dataset.workIndex = works.indexOf(w);
      detailsLink.setAttribute('aria-label', 'View details for ' + w.title);
      detailsLink.title = 'View details for ' + w.title;
    }
    panelHost.querySelector('.room-buy-selection').textContent = '\u2014';
    var summary = panelHost.querySelector('.room-buy-summary');
    var buyCard = panelHost.querySelector('.room-buy-card');
    var purchaseActions = panelHost.querySelector('.room-purchase-actions');
    var sizeGroups = panelHost.querySelector('.lb-size-groups');
    var sizeBack = panelHost.querySelector('.room-size-back');
    if (summary) {
      summary.hidden = true;
      summary.classList.remove('room-buy-summary--revealed');
    }
    if (purchaseActions) purchaseActions.hidden = true;
    if (sizeGroups) sizeGroups.hidden = false;
    if (sizeBack) sizeBack.hidden = false;
    if (buyCard) buyCard.classList.remove('has-purchase-action');
    panelHost.querySelectorAll('.room-size').forEach(function (b) {
      b.classList.remove('is-selected');
      b.setAttribute('aria-pressed', 'false');
    });
    var buy = panelHost.querySelector('.room-buy');
    if (buy) {                            // selectSize() reveals it after an explicit choice
      buy.hidden = true;
      buy.classList.remove('room-buy--revealed');
      buy.classList.add('room-buy--pending');
      buy.setAttribute('aria-disabled', 'true');
      setBuyButtonContent(buy, t('room.purchasePrint'), '');
      buy.removeAttribute('href');
      delete buy.dataset.variantId;
    }
    var preferredIdx = item.sizeIndex;
    var largestIdx = -1, largestArea = -1;
    sizeOptions.forEach(function (opt, idx) {
      if (opt.kind !== 'print') return;
      var area = opt.dims.h * opt.dims.w;
      if (area > largestArea) { largestArea = area; largestIdx = idx; }
    });
    if (preferredIdx > 0 && sizeOptions[preferredIdx] && sizeOptions[preferredIdx].kind === 'print') {
      selectSize(preferredIdx, item.sizeExplicit === true);
    } else if (largestIdx >= 0 && isStandalone) {
      selectSize(largestIdx, false);
    } else if (largestIdx >= 0) {
      var preview = sizeOptions[0];
      cur = { w: preview.dims.w, h: preview.dims.h, title: w.title, estimated: !!preview.estimated };
      item.dims = cur;
      item.sizeIndex = 0;
      sizeIndex = 0;
      panelHost.querySelector('.room-buy-selection').textContent = originalSizeLabel();
    } else {
      var orig = sizeOptions[0];
      cur = { w: orig.dims.w, h: orig.dims.h, title: w.title, estimated: !!orig.estimated };
      item.dims = cur;
      item.sizeIndex = 0;
      sizeIndex = 0;
      panelHost.querySelector('.room-buy-selection').textContent = originalSizeLabel();
      summary.hidden = false;
      summary.classList.add('room-buy-summary--revealed');
      if (purchaseActions) purchaseActions.hidden = false;
      if (isStandalone && sizeGroups) sizeGroups.hidden = true;
      if (sizeBack) sizeBack.hidden = true;
      buy.hidden = false;
      buy.classList.add('room-buy--revealed');
      buyCard.classList.add('has-purchase-action');
      buy.classList.remove('room-buy--pending');
      buy.removeAttribute('aria-disabled');
      setBuyButtonContent(buy, t('room.inquireWork'), '');
      buy.href = mailtoFor(w, 'Original artwork');
      render();
    }
    updateCuratorUI();
  }

  /* ---------- show (called on every lightbox render) ---------- */
  function show(i) {
    var w = works[i];
    if (!w || !panelHost) return false;
    var row = viewerHost && viewerHost.closest('.lb-room-row');
    if (!ensureGL()) {
      if (row) row.hidden = true;
      if (slidersHost) slidersHost.hidden = true;
      return false;
    }
    if (row) row.hidden = false;
    if (slidersHost) slidersHost.hidden = false;

    ++cameraTransitionToken;
    window.clearTimeout(cameraSettleTimer);
    viewerHost.classList.remove('is-camera-pullback', 'is-camera-focusing');
    applyCameraTarget(environment);
    syncOutputs();
    if (!textureReady) loadEnvironment(environment);

    placedArts.forEach(function (item) { item.img.remove(); });
    placedArts = [];
    activeArt = null;
    paintingMoved = false;
    hintDismissed = false;
    if (dragHint) dragHint.classList.remove('is-dismissed');
    updateResetState();
    var item = createPlacedArt(i);
    if (!item) return false;
    arrangePlacedArts();
    window.setTimeout(dismissDragHint, 5000);
    activatePlacedArt(item, true);
    return true;
  }

  /* Language switch: static labels (Lighting, Couch width, presets, etc.)
     are picked up automatically by i18n.js's [data-i18n] sweep. The
     readouts and buy-button text are rebuilt per interaction, so refresh
     them explicitly — only while the room view is actually mounted and
     showing a work. */
  document.addEventListener('langchange', function (e) {
    if (!mounted || !cur) return;
    /* English readers expect inches; everyone else expects centimeters —
       switch automatically so the numbers make sense without an extra
       click. Still fully overridable via the Inches/Centimeters toggle
       afterward. */
    syncCycleControls();
    if (activeArt) configureActivePurchase(activeArt);
  });

  /* refresh() re-measures + repaints. The lightbox calls it the moment the
     Purchase tab becomes visible: a hidden panel has no layout, so the
     canvas was sized against a 0-width box. Deliberately synchronous
     (not requestRender) — the caller has just un-hidden the panel, so
     reading layout now forces it to flush and gives real dimensions. */
  return {
    mount: mount,
    show: show,
    refresh: function () { render(); },
    setTuning: setTuning,
    getTuning: getTuning,
    mode: experience
  };
  }

  var defaultRoomView = createRoomView({ mode: 'lightbox' });
  defaultRoomView.create = createRoomView;
  window.RoomView = defaultRoomView;
})();
