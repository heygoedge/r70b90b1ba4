/* HeyGo 3D 滑行回放原型。数据由 export.py 生成（window.REPLAY_DATA[name]）。
 * 坐标：three.js x=东, y=上, z=−北。板局部系：X=板头, Y=板面法向, Z=板右侧（regular 的前刃侧）。 */
(() => {
const T3 = window.THREE;
const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const names = window.REPLAY_LIST.filter((n) => window.REPLAY_DATA && window.REPLAY_DATA[n]);
const qs = new URLSearchParams(location.search);

// ---------------------------------------------------------------- three 基础
const canvas = $('c3d');
const renderer = new T3.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new T3.Scene();
scene.background = new T3.Color(0xcfd8e6);
scene.fog = new T3.Fog(0xcfd8e6, 60, 260);
const camera = new T3.PerspectiveCamera(50, 1, 0.1, 2000);
const controls = new T3.OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new T3.HemisphereLight(0xffffff, 0x8899aa, 1.6));
const sun = new T3.DirectionalLight(0xffffff, 1.6); sun.position.set(30, 60, 20); scene.add(sun);

let D = null, world = null;
const st = { t: 0, playing: false, rate: 1, last: performance.now(), voff: 0, camMode: 'chase', bodyMode: 'auto' };

// ---------------------------------------------------------------- 工具
const v3 = (a) => new T3.Vector3(a[0], a[1], a[2]);
function idxAt(t) { const f = Math.max(0, Math.min(D.t.length - 1.001, t * D.meta.fs)); const i = Math.floor(f); return [i, f - i]; }
function num(arr, t) { const [i, a] = idxAt(t); return arr[i] * (1 - a) + arr[i + 1] * a; }
function ang(arr, t) { const [i, a] = idxAt(t); let d = arr[i + 1] - arr[i]; d = ((d + 540) % 360) - 180; return arr[i] + d * a; }
function vec(arr, t) { const [i, a] = idxAt(t); return v3(arr[i]).lerp(v3(arr[i + 1]), a); }
function quat(arr, t) { const [i, a] = idxAt(t); const q0 = new T3.Quaternion(...arr[i]); const q1 = new T3.Quaternion(...arr[i + 1]); return q0.slerp(q1, a); }
function bearingVec(b, n) { const v = new T3.Vector3(Math.sin(b * DEG), 0, -Math.cos(b * DEG)); return v.sub(n.clone().multiplyScalar(v.dot(n))).normalize(); }
function planeY(x, z) { const c = D.meta.plane_coef; return c.a * x + c.b * (-z) + c.c; }
function mat(color, opts = {}) { return new T3.MeshStandardMaterial(Object.assign({ color, roughness: 0.7, metalness: 0.05 }, opts)); }
function edgeColor(roll, k = 1) {
  const a = Math.min(1, Math.abs(roll) / 45) * k;
  const base = new T3.Color(0xb8c2d3), c = new T3.Color(roll > 0 ? 0x1f9e8f : 0xe0732f);
  return base.lerp(c, 0.25 + 0.75 * a);
}

// ---------------------------------------------------------------- 场景构建
function clearWorld() {
  if (!world) return;
  scene.remove(world.root);
  world.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  world = null;
}
function build() {
  clearWorld();
  const root = new T3.Group(); scene.add(root);
  const n = v3(D.meta.plane_normal_three).normalize();
  const P = D.pos.map((p, i) => new T3.Vector3(p[0], D.plane_y[i], p[2]));
  // 坡面：按轨迹包围盒铺一块带网格的平面（平面方程来自轨迹+气压高度拟合）
  const xs = P.map((p) => p.x), zs = P.map((p) => p.z);
  const x0 = Math.min(...xs) - 40, x1 = Math.max(...xs) + 40, z0 = Math.min(...zs) - 40, z1 = Math.max(...zs) + 40;
  const NX = 60, NZ = 60, g = new T3.BufferGeometry(), pos = [], idx = [];
  for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) { const x = x0 + (x1 - x0) * i / NX, z = z0 + (z1 - z0) * j / NZ; pos.push(x, planeY(x, z) - 0.01, z); }
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i; idx.push(a, a + NX + 1, a + 1, a + 1, a + NX + 1, a + NX + 2); }
  g.setAttribute('position', new T3.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  root.add(new T3.Mesh(g, mat(0xf4f7fb, { roughness: 0.95 })));
  const grid = new T3.LineSegments(new T3.WireframeGeometry(g), new T3.LineBasicMaterial({ color: 0xc9d3e2, transparent: true, opacity: 0.55 }));
  grid.position.copy(n.clone().multiplyScalar(0.005)); root.add(grid);
  // 滚落线箭头
  const fb = D.meta.fall_bearing, mid = P[Math.floor(P.length / 2)];
  const fall = bearingVec(fb, n);
  root.add(new T3.ArrowHelper(fall, mid.clone().add(n.clone().multiplyScalar(0.3)).add(fall.clone().cross(n).multiplyScalar(-14)), 8, 0x6c7a92, 1.2, 0.6));

  // 轨迹带：按板立刃着色（青=后刃，橙=前刃，越深立刃越大）
  const rb = new T3.BufferGeometry(), rp = [], rc = [];
  for (let i = 0; i < P.length - 1; i++) {
    const d = P[i + 1].clone().sub(P[i]); if (d.lengthSq() < 1e-6) d.set(1, 0, 0);
    const side = d.clone().cross(n).normalize().multiplyScalar(0.28);
    const lift = n.clone().multiplyScalar(0.02);
    const a = P[i].clone().add(lift), b = P[i + 1].clone().add(lift);
    const c = edgeColor(D.roll[i]);
    for (const p of [a.clone().add(side), a.clone().sub(side), b.clone().add(side), a.clone().sub(side), b.clone().sub(side), b.clone().add(side)]) { rp.push(p.x, p.y, p.z); rc.push(c.r, c.g, c.b); }
  }
  rb.setAttribute('position', new T3.Float32BufferAttribute(rp, 3)); rb.setAttribute('color', new T3.Float32BufferAttribute(rc, 3));
  root.add(new T3.Mesh(rb, new T3.MeshBasicMaterial({ vertexColors: true, side: T3.DoubleSide, transparent: true, opacity: 0.85 })));
  // 每 0.4 s 画一道"板长轴"短线：线和轨迹的夹角就是侧滑
  const tk = [], step = Math.round(0.4 * D.meta.fs);
  for (let i = 0; i < P.length; i += step) {
    const u = bearingVec(D.bear_nose[i], n).multiplyScalar(0.75), p = P[i].clone().add(n.clone().multiplyScalar(0.04));
    tk.push(...p.clone().add(u).toArray(), ...p.clone().sub(u).toArray());
  }
  const tg = new T3.BufferGeometry(); tg.setAttribute('position', new T3.Float32BufferAttribute(tk, 3));
  root.add(new T3.LineSegments(tg, new T3.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.55 })));
  // GPS 原始点
  if (D.gps && D.gps.length) {
    const gg = new T3.SphereGeometry(0.18, 8, 6), gm = new T3.MeshBasicMaterial({ color: D.meta.gps_ok ? 0x3b6fd8 : 0xb04a4a, transparent: true, opacity: 0.7 });
    for (const q of D.gps) { const m = new T3.Mesh(gg, gm); m.position.set(q[1], planeY(q[1], q[2]) + 0.15, q[2]); root.add(m); }
  }

  // 雪板：圆头圆尾的挤出形状
  const L = 1.56, W = 0.27, R = 0.12, sh = new T3.Shape();
  sh.moveTo(-L / 2 + R, -W / 2); sh.lineTo(L / 2 - R, -W / 2); sh.quadraticCurveTo(L / 2 + 0.02, -W / 2, L / 2 + 0.02, 0); sh.quadraticCurveTo(L / 2 + 0.02, W / 2, L / 2 - R, W / 2);
  sh.lineTo(-L / 2 + R, W / 2); sh.quadraticCurveTo(-L / 2 - 0.02, W / 2, -L / 2 - 0.02, 0); sh.quadraticCurveTo(-L / 2 - 0.02, -W / 2, -L / 2 + R, -W / 2);
  const bg = new T3.ExtrudeGeometry(sh, { depth: 0.02, bevelEnabled: false }); bg.rotateX(-Math.PI / 2); bg.translate(0, -0.01, 0); // 形状 xy → 板 XZ
  const board = new T3.Group(); root.add(board);
  board.add(new T3.Mesh(bg, mat(0x1d2433)));
  // 板头标记 + 刃色条
  const nose = new T3.Mesh(new T3.SphereGeometry(0.035, 12, 8), new T3.MeshBasicMaterial({ color: 0xff3355 })); nose.position.set(L / 2 - 0.05, 0.02, 0); board.add(nose);
  const toeBar = new T3.Mesh(new T3.BoxGeometry(L * 0.8, 0.012, 0.02), new T3.MeshBasicMaterial({ color: 0xe0732f })); toeBar.position.set(0, 0.012, (W / 2 - 0.015) * D.stanceSign); board.add(toeBar);
  const heelBar = new T3.Mesh(new T3.BoxGeometry(L * 0.8, 0.012, 0.02), new T3.MeshBasicMaterial({ color: 0x1f9e8f })); heelBar.position.set(0, 0.012, -(W / 2 - 0.015) * D.stanceSign); board.add(heelBar);
  // 方向箭头（世界系）：蓝=行进方向（GPS/融合），红=板头
  const aTravel = new T3.ArrowHelper(new T3.Vector3(1, 0, 0), new T3.Vector3(), 2.2, 0x2f6fe4, 0.35, 0.18);
  const aNose = new T3.ArrowHelper(new T3.Vector3(1, 0, 0), new T3.Vector3(), 1.6, 0xff3355, 0.3, 0.15);
  root.add(aTravel, aNose);

  // 骨架小人（板局部系）
  const rider = new T3.Group(); board.add(rider);
  const jm = mat(0xf0f3f8), bm = { leg: mat(0x3a4a66), torso: mat(0xd9733b), arm: mat(0xd9733b), head: mat(0x222831) };
  const J = {};
  const JN = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'LHip', 'LKnee', 'LAnkle', 'RHip', 'RKnee', 'RAnkle', 'LShoulder', 'LElbow', 'LWrist', 'RShoulder', 'RElbow', 'RWrist'];
  for (const k of JN) { const m = new T3.Mesh(new T3.SphereGeometry(k === 'Head' ? 0.11 : 0.035, 14, 10), k === 'Head' ? bm.head : jm); rider.add(m); J[k] = m; }
  const BONES = [['Hips', 'Spine', 'torso', 0.085], ['Spine', 'Chest', 'torso', 0.095], ['Chest', 'Neck', 'torso', 0.06], ['Neck', 'Head', 'head', 0.03],
    ['LHip', 'RHip', 'leg', 0.05], ['LHip', 'LKnee', 'leg', 0.055], ['LKnee', 'LAnkle', 'leg', 0.045], ['RHip', 'RKnee', 'leg', 0.055], ['RKnee', 'RAnkle', 'leg', 0.045],
    ['LShoulder', 'RShoulder', 'torso', 0.05], ['LShoulder', 'LElbow', 'arm', 0.035], ['LElbow', 'LWrist', 'arm', 0.03], ['RShoulder', 'RElbow', 'arm', 0.035], ['RElbow', 'RWrist', 'arm', 0.03]];
  const cyl = new T3.CylinderGeometry(1, 1, 1, 10);
  const bones = BONES.map(([a, b, m, r]) => { const o = new T3.Mesh(cyl, bm[m]); o.userData = { a, b, r }; rider.add(o); return o; });
  // 靴子
  const boots = [0, 1].map(() => { const o = new T3.Mesh(new T3.BoxGeometry(0.13, 0.12, 0.3), mat(0x2b2f38)); rider.add(o); return o; });
  world = { root, board, rider, J, bones, boots, aTravel, aNose, n, P };
  drawTimeline();
}

// ---------------------------------------------------------------- 小人姿态（板局部系里算关节点）
const TH = 0.44, SH = 0.44; // 大腿、小腿
function legIK(hip, ankle, pole) {
  const d = ankle.clone().sub(hip); let L = d.length(); const dir = d.clone().normalize();
  L = Math.min(L, TH + SH - 0.005);
  const a = (TH * TH - SH * SH + L * L) / (2 * L), h = Math.sqrt(Math.max(0, TH * TH - a * a));
  const p = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  return hip.clone().add(dir.multiplyScalar(a)).add(p.multiplyScalar(h));
}
function solveBody(t) {
  const s = D.stanceSign;                         // regular=+1：左脚在板头侧、面朝 +Z
  const X = new T3.Vector3(1, 0, 0), Y = new T3.Vector3(0, 1, 0), F = new T3.Vector3(0, 0, s);
  const footMid = new T3.Vector3(0, 0.1, 0);
  const lead = X.clone();                         // 前脚方向=板头
  const leftSide = X.clone().multiplyScalar(s);   // 左脚所在的板长方向
  const LA = new T3.Vector3(0.27 * s, 0.1, 0), RA = new T3.Vector3(-0.27 * s, 0.1, 0);
  // 比力方向（脚上 IMU 测的，板系）：稳态下身体重心落在这条线上 → 用来定整体倾斜（估算）
  let f = vec(D.f_loc, t); if (f.length() < 0.3) f.set(0, 1, 0); f.normalize();
  const tilt = Math.acos(Math.max(-1, Math.min(1, f.dot(Y))));
  if (tilt > 55 * DEG) f = Y.clone().lerp(f, 55 * DEG / tilt).normalize();
  const mode = currentBodyMode();
  let up, chestQ = null;
  if (mode === 'chest') {
    chestQ = quat(D.phone.chest_delta, t);       // 手机相对参考时刻的转动（板系）
    up = Y.clone();
  } else up = f;
  // 骨盆：沿"上方向"抬 0.78 m，略向后坐（脚跟侧）
  const pelvisQ = chestQ ? new T3.Quaternion().slerp(chestQ, 0.35) : new T3.Quaternion();
  const P0 = footMid.clone().add(up.clone().multiplyScalar(0.78)).add(F.clone().multiplyScalar(-0.05));
  const hips = chestQ ? footMid.clone().add(P0.clone().sub(footMid).applyQuaternion(pelvisQ)) : P0;
  const hipAxis = leftSide.clone().applyQuaternion(pelvisQ);
  const LH = hips.clone().add(hipAxis.clone().multiplyScalar(0.11)), RH = hips.clone().add(hipAxis.clone().multiplyScalar(-0.11));
  const pole = F.clone().add(up.clone().multiplyScalar(0.1));
  const LK = legIK(LH, LA, pole.clone().add(leftSide.clone().multiplyScalar(0.25)));
  const RK = legIK(RH, RA, pole.clone().add(leftSide.clone().multiplyScalar(-0.25)));
  // 躯干：默认站姿 = 上方向 + 向前（脚尖侧）弯 18°，肩线朝板头打开 15°
  let U = up.clone().applyAxisAngle(lead, 18 * DEG * s).normalize();
  let W = leftSide.clone().applyAxisAngle(up, 15 * DEG * s).normalize();
  if (chestQ) { U = new T3.Vector3(0, 1, 0).applyAxisAngle(lead, 18 * DEG * s).applyQuaternion(chestQ); W = leftSide.clone().applyAxisAngle(Y, 15 * DEG * s).applyQuaternion(chestQ); }
  const Fw = U.clone().cross(W).multiplyScalar(-s).normalize(); // 胸口朝向
  const spine = hips.clone().add(U.clone().multiplyScalar(0.2)), chest = hips.clone().add(U.clone().multiplyScalar(0.4));
  const neck = hips.clone().add(U.clone().multiplyScalar(0.55)), head = hips.clone().add(U.clone().multiplyScalar(0.7));
  const LS = neck.clone().add(W.clone().multiplyScalar(0.19)).add(U.clone().multiplyScalar(-0.05));
  const RS = neck.clone().add(W.clone().multiplyScalar(-0.19)).add(U.clone().multiplyScalar(-0.05));
  // 手臂：没有传感器，跟胸走的默认平衡姿势（前手指向板头、后手略后）
  const LE = LS.clone().add(U.clone().multiplyScalar(-0.2)).add(W.clone().multiplyScalar(0.14)).add(Fw.clone().multiplyScalar(0.06));
  const LW = LE.clone().add(U.clone().multiplyScalar(-0.08)).add(W.clone().multiplyScalar(0.2)).add(Fw.clone().multiplyScalar(0.1));
  const RE = RS.clone().add(U.clone().multiplyScalar(-0.22)).add(W.clone().multiplyScalar(-0.12)).add(Fw.clone().multiplyScalar(0.05));
  const RW = RE.clone().add(U.clone().multiplyScalar(-0.12)).add(W.clone().multiplyScalar(-0.14)).add(Fw.clone().multiplyScalar(0.08));
  const left = { LHip: LH, LKnee: LK, LAnkle: LA, LShoulder: LS, LElbow: LE, LWrist: LW };
  const right = { RHip: RH, RKnee: RK, RAnkle: RA, RShoulder: RS, RElbow: RE, RWrist: RW };
  return Object.assign({ Hips: hips, Spine: spine, Chest: chest, Neck: neck, Head: head }, left, right, { _tilt: Math.acos(Math.max(-1, Math.min(1, U.dot(Y)))) / DEG });
}
function currentBodyMode() {
  if (st.bodyMode === 'chest' && D.phone.available) return 'chest';
  if (st.bodyMode === 'lean') return 'lean';
  return (D.phone.available && D.phone.placement === 'chest') ? 'chest' : 'lean';
}
const Yaxis = new T3.Vector3(0, 1, 0);
const CORNERS = []; for (const x of [-0.78, -0.5, 0, 0.5, 0.78]) for (const z of [-0.135, 0.135]) CORNERS.push(new T3.Vector3(x, -0.01, z));
function placeBody(t) {
  const P = solveBody(t), w = world;
  for (const k in w.J) w.J[k].position.copy(P[k]);
  for (const o of w.bones) {
    const a = P[o.userData.a], b = P[o.userData.b], d = b.clone().sub(a), L = d.length();
    o.position.copy(a).add(b).multiplyScalar(0.5);
    o.quaternion.setFromUnitVectors(Yaxis, d.clone().normalize());
    o.scale.set(o.userData.r, L, o.userData.r);
  }
  const s = D.stanceSign;
  [['LAnkle', 1], ['RAnkle', -1]].forEach(([k, sg], i) => {
    const b = w.boots[i]; b.position.copy(P[k]).add(new T3.Vector3(0, -0.04, 0.04 * s));
    b.rotation.set(0, sg * s * 0.25, 0);          // 固定器角度示意（前脚 +15° 左右）
  });
  return P._tilt;
}

// ---------------------------------------------------------------- 每帧
function frame(t) {
  const w = world, n = w.n;
  const p = vec(D.pos, t); p.y = num(D.plane_y, t);
  const roll = num(D.roll, t);
  const q = quat(D.q_board, t);
  w.board.quaternion.copy(q);
  // 立刃时整块板绕刃抬起，使低的那条刃贴地
  // 接地：把板最低的角点抬到坡面上（板姿态是测的，坡面是拟合的，两者不一致时只平移不改姿态，同 Trackk groundBoard）
  let low = 1e9;
  for (const c of CORNERS) { const v = c.clone().applyQuaternion(q); low = Math.min(low, v.dot(n)); }
  w.board.position.copy(p).add(n.clone().multiplyScalar(-low + 0.004));
  const bt = ang(D.bear_travel, t), bn = ang(D.bear_nose, t);
  const top = w.board.position.clone().add(n.clone().multiplyScalar(0.05));
  w.aTravel.position.copy(top); w.aTravel.setDirection(bearingVec(bt, n));
  w.aNose.position.copy(top); w.aNose.setDirection(bearingVec(bn, n));
  const tilt = placeBody(t);
  // 镜头
  const trv = bearingVec(bt, n), side = trv.clone().cross(n).normalize();
  let camPos = null;
  if (st.camMode === 'chase') camPos = p.clone().add(trv.clone().multiplyScalar(-4.2)).add(n.clone().multiplyScalar(1.9));
  else if (st.camMode === 'side') camPos = p.clone().add(side.clone().multiplyScalar(-4.5)).add(n.clone().multiplyScalar(1.4)).add(trv.clone().multiplyScalar(0.8));
  else if (st.camMode === 'top') camPos = p.clone().add(new T3.Vector3(0, 22, 0.01));
  const target = p.clone().add(n.clone().multiplyScalar(0.8));
  if (camPos) { camera.position.lerp(camPos, st.snap ? 1 : 0.12); controls.target.lerp(target, st.snap ? 1 : 0.2); st.snap = false; }
  else { const dlt = target.clone().sub(controls.target); controls.target.add(dlt); camera.position.add(dlt); }
  // 仪表
  const spd = num(D.speed, t) * 3.6;
  $('gSpd').textContent = spd.toFixed(1);
  $('gSpdS').textContent = D.meta.gps_ok ? 'GPS + 脚 IMU 融合' : '主链路 IMU 速度模型';
  $('gRoll').textContent = Math.abs(roll).toFixed(0);
  const edge = Math.abs(roll) < 3 ? '平板' : roll > 0 ? '后刃' : '前刃';
  $('gEdge').innerHTML = `<b style="color:${roll > 0 ? 'var(--heel)' : 'var(--toe)'}">${edge}</b> · 身体倾斜 ${tilt.toFixed(0)}°（${currentBodyMode() === 'chest' ? '手机' : '估算'}）`;
  if (D.sideslip) {
    const slip = num(D.sideslip, t), sw = D.switch && D.switch[idxAt(t)[0]];
    $('gSlip').textContent = (slip > 0 ? '+' : '') + slip.toFixed(0);
    $('gSlipS').textContent = sw ? '板尾在前（switch）' : slip > 0 ? '板头偏向行进方向右侧' : '板头偏向行进方向左侧';
  } else { $('gSlip').textContent = '不可用'; $('gSlipS').textContent = '室内无 GPS：轨迹沿板航向积分，侧滑按定义=0，不编'; }
  const tu = D.turns.find((x) => t >= x.t0 && t < x.t1);
  $('gTurn').textContent = tu ? `${tu.id.replace('turn', 'T')} · ${tu.edge === 'heel' ? '后刃' : '前刃'}` : '—';
  $('gTurnS').textContent = tu ? `${tu.tech === 'carving' ? '走刃' : tu.tech === 'skidding' ? '搓雪' : tu.tech || ''} · 最大立刃 ${tu.max_roll}° ${tu.status !== 'valid' ? '(' + tu.status + ')' : ''}` : '';
  $('tlabel').textContent = `${t.toFixed(2)} / ${D.meta.duration.toFixed(1)} s · ${new Date((D.meta.t0_epoch + t) * 1000 + 8 * 3600e3).toISOString().slice(11, 22)} 北京时间`;
}

// ---------------------------------------------------------------- 时间轴
function drawTimeline() {
  const c = $('tl'), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const g = c.getContext('2d', { willReadFrequently: true }); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, dur = D.meta.duration, X = (t) => 40 + (W - 50) * t / dur;
  g.clearRect(0, 0, W, H); g.font = '11px -apple-system, PingFang SC'; g.fillStyle = '#8d97ab';
  // 弯带
  for (const tu of D.turns) { g.fillStyle = tu.edge === 'heel' ? 'rgba(47,181,163,.55)' : 'rgba(240,138,75,.55)'; g.fillRect(X(Math.max(0, tu.t0)), 2, Math.max(1, X(Math.min(dur, tu.t1)) - X(Math.max(0, tu.t0)) - 1), 10); }
  for (const b of D.blocks) { g.fillStyle = '#8d97ab'; g.fillText(`${b.scene === 'carving' ? '走刃块' : b.scene === 'skidding' ? '搓雪块' : b.scene || ''}`, X(Math.max(0, b.t0)) + 2, 24); }
  // 视频覆盖
  if (D.meta.video && st.vdur) { const a = D.meta.video.t0_epoch - D.meta.t0_epoch - st.voff; g.fillStyle = 'rgba(120,140,255,.35)'; g.fillRect(X(Math.max(0, a)), 13, Math.max(0, X(Math.min(dur, a + st.vdur)) - X(Math.max(0, a))), 3); }
  const y0 = 66, sc = 0.55;
  g.strokeStyle = '#2a3447'; g.beginPath(); g.moveTo(40, y0); g.lineTo(W - 10, y0); g.stroke();
  g.fillStyle = '#8d97ab'; g.fillText('立刃', 4, y0 - 26); if (D.sideslip) g.fillText('侧滑', 4, y0 + 30);
  // 立刃（上=后刃）
  g.lineWidth = 1.5; g.strokeStyle = '#c5cedf'; g.beginPath();
  D.roll.forEach((v, i) => { const x = X(D.t[i]), y = y0 - v * sc; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
  // 侧滑
  g.lineWidth = 1; g.strokeStyle = '#e6b84a'; g.beginPath();
  (D.sideslip || []).forEach((v, i) => { const x = X(D.t[i]), y = y0 - Math.max(-60, Math.min(60, v)) * 0.6; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
  for (let s = 0; s <= dur; s += 5) { g.fillStyle = '#5e6a80'; g.fillText(`${s}s`, X(s) - 6, H - 2); }
  st.tlX = X;
  st.tlImg = g.getImageData(0, 0, c.width, c.height);
}
function drawCursor() {
  const c = $('tl'), g = c.getContext('2d', { willReadFrequently: true }); if (!st.tlImg) return;
  g.putImageData(st.tlImg, 0, 0);
  const dpr = window.devicePixelRatio || 1; g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = st.tlX(st.t); g.strokeStyle = '#ff3355'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke();
}
$('tl').addEventListener('click', (e) => { const r = e.target.getBoundingClientRect(); const t = (e.clientX - r.left - 40) / (r.width - 50) * D.meta.duration; seek(Math.max(0, Math.min(D.meta.duration, t))); });

// ---------------------------------------------------------------- 视频同步
const vid = $('vid');
function videoTimeFor(t) { return D.meta.t0_epoch + t - D.meta.video.t0_epoch + st.voff; }
function syncVideo(force) {
  if (!D.meta.video) return;
  const vt = videoTimeFor(st.t), inside = vt >= 0 && vt <= (vid.duration || 1e9);
  vid.style.opacity = inside ? 1 : 0.35;
  if (!inside) { if (!vid.paused) vid.pause(); return; }
  vid.playbackRate = st.rate;
  if (st.playing) { if (vid.paused) vid.play().catch(() => {}); if (Math.abs(vid.currentTime - vt) > 0.25 || force) vid.currentTime = vt; }
  else { if (!vid.paused) vid.pause(); if (Math.abs(vid.currentTime - vt) > 0.02 || force) vid.currentTime = vt; }
}

// ---------------------------------------------------------------- 加载数据集
function legendHtml() {
  const m = D.meta, ph = D.phone, mode = currentBodyMode();
  const measured = [
    `<span class="m">测</span> 立刃角 = AI_SkiMetric 主链路形变模型输出的雪板 Roll（双脚 IMU + 在线校准 OC 推出）`,
    `<span class="m">测</span> 板头朝向 = 双脚 IMU 校准后四元数的板长轴水平朝向（两脚取圆均值）`,
    `<span class="m">测</span> 弯切分 / 前后刃 / 走刃搓雪 = 主链路 turns + block scene`,
    m.gps_ok ? `<span class="m">测</span> 轨迹/行进方向 = GPS 1Hz（位置+多普勒速度）与脚 IMU 加速度融合；绝对朝向用 GPS 加速度对齐` : `<span class="e">估</span> 轨迹 = 主链路板航向 Yaw × IMU 速度模型积分（与弯型图同法），整段转到起点→终点朝下；室内无 GPS，绝对方位和位置漂移不可校`,
    `<span class="m">测</span> 高度 = 气压计；坡面 = 轨迹+高度拟合的平面（不是 DEM）`];
  const est = [
    m.gps_ok ? `<span class="e">估</span> 侧滑角 = 板头朝向 − GPS 融合行进方向。依赖 GPS 时延与对齐，绝对值误差约 ±5°` : `<span class="e">无</span> 侧滑角：轨迹本身沿板航向积分，没有独立的行进方向，不显示`,
    mode === 'chest' ? `<span class="m">测</span> 胸口转动 = 手机陀螺+加速度（VQF 6 轴）相对参考时刻的增量；<span class="e">估</span> 参考时刻默认人在标准站姿；骨盆=0.35×胸` : `<span class="e">估</span> 身体整体倾斜 = 脚上测到的比力方向（假设人始终在平衡线上）；手臂/头/下蹲全是默认姿势`,
    `<span class="e">估</span> 双脚钉在板上、膝盖两段 IK、骨盆高度固定 0.78 m：下蹲/起伏不可测`];
  const phoneLine = ph.available ? `<details open><summary>手机放置判断：${({chest:'胸口（贴身）',chest_loose:'胸前口袋但晃动（不采用）',thigh_pocket:'大腿/裤兜'})[ph.placement] || ph.placement}</summary><ul>${ph.evidence.map((e) => `<li>${e}</li>`).join('')}</ul></details>` : '<div>本段没有手机 IMU</div>';
  return `<details id="lgd"><summary><b>数据来源：哪些是测的、哪些是估的</b></summary><h3>${m.title}</h3><div style="color:var(--dim)">session ${m.session} · ${m.t0_utc} UTC 起 ${m.duration}s · ${m.stance === 'regular' ? '正脚 regular' : '反脚 goofy'}</div>
  <ul>${measured.map((x) => `<li>${x}</li>`).join('')}${est.map((x) => `<li>${x}</li>`).join('')}</ul>
  <div style="margin-top:4px">图例：轨迹带 <span style="color:var(--heel)">青=后刃</span> / <span style="color:var(--toe)">橙=前刃</span>（深=立刃大）；灰短线=每 0.4 s 板长轴；<span style="color:#2f6fe4">蓝箭头=行进方向</span>，<span style="color:#ff3355">红箭头/红点=板头</span>；蓝点=GPS 原始点</div>
  ${phoneLine}<details><summary>处理日志（export.py）</summary><ul>${m.notes.map((x) => `<li>${x}</li>`).join('')}</ul></details></details>`;
}
function load(name) {
  D = window.REPLAY_DATA[name];
  D.stanceSign = D.meta.stance === 'goofy' ? -1 : 1;
  st.t = 0; st.snap = true;
  $('title').textContent = D.meta.title;
  const mode = currentBodyMode();
  $('bodytag').textContent = mode === 'chest' ? 'BODY：手机驱动胸口（其余估算）' : 'BODY：估算（默认站姿 + 比力倾斜）';
  $('trajtag').textContent = D.meta.gps_ok ? '轨迹：GPS 融合（实测）' : '轨迹：航位推算（估算）';
  $('trajtag').className = 'tag ' + (D.meta.gps_ok ? 'ok' : 'est');
  $('legend').innerHTML = legendHtml();
  if (D.meta.video) {
    $('vidwrap').classList.remove('hidden'); vid.src = D.meta.video.file; st.voff = D.meta.video.default_offset || 0;
    $('voff').value = st.voff; $('voffv').textContent = st.voff.toFixed(2) + 's'; $('vnote').textContent = D.meta.video.note || '';
    vid.onloadedmetadata = () => { st.vdur = vid.duration; drawTimeline(); syncVideo(true); };
  } else { $('vidwrap').classList.add('hidden'); vid.removeAttribute('src'); }
  resize(); build(); frame(0); syncVideo(true);
}
function resize() { const r = $('view').getBoundingClientRect(); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); if (D) drawTimeline(); }
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- 控件
const ds = $('ds'); names.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = window.REPLAY_DATA[n].meta.title; ds.appendChild(o); });
ds.onchange = () => load(ds.value);
$('play').onclick = () => setPlaying(!st.playing);
$('rate').onchange = (e) => { st.rate = +e.target.value; syncVideo(true); };
$('cam').onchange = (e) => { st.camMode = e.target.value; st.snap = true; };
$('bodymode').onchange = (e) => { st.bodyMode = e.target.value; load(ds.value); };
$('voff').oninput = (e) => { st.voff = +e.target.value; $('voffv').textContent = st.voff.toFixed(2) + 's'; drawTimeline(); syncVideo(true); };
window.addEventListener('keydown', (e) => { if (e.code === 'Space') { setPlaying(!st.playing); e.preventDefault(); } if (e.code === 'ArrowRight') seek(st.t + (e.shiftKey ? 1 : 0.04)); if (e.code === 'ArrowLeft') seek(st.t - (e.shiftKey ? 1 : 0.04)); });
function setPlaying(p) { st.playing = p; $('play').textContent = p ? '⏸ 暂停' : '▶ 播放'; st.last = performance.now(); syncVideo(true); }
function seek(t) { st.t = Math.max(0, Math.min(D.meta.duration, t)); st.snap = true; syncVideo(true); }
// 给截图脚本用
window.replay = { seek: (t) => { seek(t); frame(st.t); controls.update(); renderer.render(scene, camera); drawCursor(); }, load: (n) => { ds.value = n; load(n); }, setCam: (m) => { st.camMode = m; st.snap = true; $('cam').value = m; }, setBody: (m) => { st.bodyMode = m; $('bodymode').value = m; load(ds.value); }, openLegend: (o) => { const e = document.getElementById('lgd'); if (e) e.open = o; }, get t() { return st.t; }, data: () => D };

function loop(now) {
  const dt = (now - st.last) / 1000; st.last = now;
  if (st.playing) { st.t += dt * st.rate; if (st.t >= D.meta.duration) { st.t = D.meta.duration; setPlaying(false); } syncVideo(false); }
  frame(st.t); controls.update(); renderer.render(scene, camera); drawCursor();
  requestAnimationFrame(loop);
}
const first = qs.get('ds') && names.includes(qs.get('ds')) ? qs.get('ds') : names[0];
ds.value = first; load(first);
if (qs.get('cam')) window.replay.setCam(qs.get('cam'));
requestAnimationFrame(loop);
window.__ready = true;
})();
