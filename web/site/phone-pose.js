// Absolute pointing for the phone-as-Wii-Remote: turns the browser's fused device orientation into
// the virtual remote's pose relative to the screen, the way a sensor bar gives a real remote a
// fixed reference. Plain script (window.WsrPhonePose); pure math, unit-tested in web/tests.
//
// Frames (all right-handed):
//   device  x right, y towards the top edge, z out of the screen (DeviceOrientation's frame)
//   earth   x east, y north, z up; heading reference is whatever the browser uses
//   screen  x right, y up, z towards the player; the screen's middle is straight ahead (-z)
//   body    the virtual remote: x right, y out of the phone's face, z towards the player
//           (its tip is -z), runtime/include/web_phone.h Orientation()
// The remote's tip is the phone's top edge, held screen up.
(function (root) {
  const DEG = Math.PI / 180;

  // W3C DeviceOrientation: R = Rz(alpha) Rx(beta) Ry(gamma), device -> earth.
  function quatFromEuler(alpha, beta, gamma) {
    const x = beta * DEG / 2, y = gamma * DEG / 2, z = alpha * DEG / 2;
    const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
    const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    return [
      cX * cY * cZ - sX * sY * sZ,
      sX * cY * cZ - cX * sY * sZ,
      cX * sY * cZ + sX * cY * sZ,
      cX * cY * sZ + sX * sY * cZ,
    ];
  }

  // Rotation matrix (rows) of unit quaternion [w, x, y, z].
  function matFromQuat(q) {
    const [w, x, y, z] = q;
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ];
  }

  function quatFromMat(m) {
    const t = m[0][0] + m[1][1] + m[2][2];
    let w, x, y, z;
    if (t > 0) {
      const s = Math.sqrt(t + 1) * 2;
      w = 0.25 * s; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s;
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
      const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
      w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
    } else if (m[1][1] > m[2][2]) {
      const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
      w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s;
    } else {
      const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
      w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s;
    }
    const n = Math.hypot(w, x, y, z);
    return w < 0 ? [-w / n, -x / n, -y / n, -z / n] : [w / n, x / n, y / n, z / n];
  }

  const mul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  const apply = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v) => { const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; };

  // Body -> device: body x = device x, body y = device z (face), body z = -device y (tip is device +y).
  const BODY_TO_DEVICE = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];

  // Where the phone's tip points, in earth coordinates.
  function tipDirection(qDevice) {
    const m = matFromQuat(qDevice);
    return [m[0][1], m[1][1], m[2][1]];
  }

  // Earth -> screen rotation (rows are the screen axes in earth coordinates) for a tip direction
  // that points at the screen's middle. Up stays the earth's up, so a tilted calibration cannot
  // tilt the screen.
  function screenFrame(centerTip) {
    const f = norm(centerTip);
    let right = cross(f, [0, 0, 1]);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-3) right = [1, 0, 0]; // pointing straight up/down
    right = norm(right);
    const back = [-f[0], -f[1], -f[2]];      // screen +z points from the screen to the player
    const up = cross(back, right);
    return [right, up, back];
  }

  // Tangent of the pointing angle from the screen's middle: [right, up] per unit of depth, or null
  // when the tip points away from the screen.
  function screenTangents(frame, tip) {
    const v = apply(frame, tip);
    if (v[2] > -0.05) return null;
    return [v[0] / -v[2], v[1] / -v[2]];
  }

  // The remote's pose for the runtime: body -> screen quaternion.
  function bodyPose(frame, qDevice) {
    return quatFromMat(mul(mul(frame, matFromQuat(qDevice)), BODY_TO_DEVICE));
  }

  // Half-angles of the screen from two calibration points (top-left and bottom-right tips).
  function screenHalfAngles(frame, tipTopLeft, tipBottomRight) {
    const a = screenTangents(frame, tipTopLeft), b = screenTangents(frame, tipBottomRight);
    if (!a || !b) return null;
    const tx = (Math.abs(a[0]) + Math.abs(b[0])) / 2, ty = (Math.abs(a[1]) + Math.abs(b[1])) / 2;
    // A corner pointed on the wrong side of the middle is a missed step, not a tiny screen.
    if (a[0] > 0 || b[0] < 0 || a[1] < 0 || b[1] > 0 || tx < Math.tan(2 * DEG) || ty < Math.tan(2 * DEG)) return null;
    return [Math.atan(tx), Math.atan(ty)];
  }

  root.WsrPhonePose = { quatFromEuler, matFromQuat, quatFromMat, tipDirection, screenFrame, screenTangents, bodyPose, screenHalfAngles };
})(typeof window !== 'undefined' ? window : globalThis);
