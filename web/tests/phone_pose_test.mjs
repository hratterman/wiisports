// node web/tests/phone_pose_test.mjs
// Unit tests for web/site/phone-pose.js: calibration frame, pointer tangents and the body pose the
// runtime uses (runtime/src/resort_wiimote_kbm.cpp StepController: pointer = tip direction
// (body -z) projected on the screen plane).
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(path.join(here, '../site/phone-pose.js'));
const P = globalThis.WsrPhonePose;
const DEG = Math.PI / 180;
let failures = 0;
const near = (a, b, eps, what) => {
  if (Math.abs(a - b) > eps) { failures++; console.log(`FAIL ${what}: ${a} vs ${b}`); }
};

// Runtime side: rotate (0,0,-1) by the body pose, project like StepController.
function runtimePointer(q, halfX, halfY) {
  const m = P.matFromQuat(q);
  const f = [-m[0][2], -m[1][2], -m[2][2]];
  return [f[0] / -f[2] / Math.tan(halfX), -f[1] / -f[2] / Math.tan(halfY), f];
}
function runtimeRoll(q) {
  const m = P.matFromQuat(q);   // columns: body axes in screen coordinates
  return Math.atan2(m[0][1], m[1][1]);
}

for (const [heading, tilt] of [[0, 0], [37, 0], [-120, 12], [200, -25]]) {
  // Calibrate: phone screen up, tip at the screen's middle (alpha = heading, beta = tilt up).
  const qCenter = P.quatFromEuler(heading, tilt, 0);
  const frame = P.screenFrame(P.tipDirection(qCenter));
  const id = P.bodyPose(frame, qCenter);
  near(id[0], 1, 1e-6, `identity at center (heading ${heading}, tilt ${tilt})`);

  // Corners at +-15 deg horizontal, +-9 deg vertical.
  const tl = P.tipDirection(P.quatFromEuler(heading + 15, tilt + 9, 0));
  const br = P.tipDirection(P.quatFromEuler(heading - 15, tilt - 9, 0));
  const half = P.screenHalfAngles(frame, tl, br);
  if (!half) { failures++; console.log(`FAIL calibration rejected (heading ${heading})`); continue; }
  near(half[0] / DEG, 15, tilt ? 1.5 : 0.01, `halfX (heading ${heading}, tilt ${tilt})`);
  // A corner 9 deg up and 15 deg aside meets a flat screen at tan(9)/cos(15) per unit depth.
  near(half[1] / DEG, Math.atan(Math.tan(9 * DEG) / Math.cos(15 * DEG)) / DEG, tilt ? 0.6 : 0.01, `halfY (heading ${heading}, tilt ${tilt})`);

  // Point 10 deg left of the middle: the runtime pointer is on the left at tan(10)/tan(halfX).
  const qLeft = P.quatFromEuler(heading + 10, tilt, 0);
  const tanLeft = P.screenTangents(frame, P.tipDirection(qLeft));
  const [px, py] = runtimePointer(P.bodyPose(frame, qLeft), half[0], half[1]);
  near(px, tanLeft[0] / Math.tan(half[0]), 1e-6, `runtime pointer x matches phone tangent (heading ${heading})`);
  if (!(px < -0.4 && px > -0.8)) { failures++; console.log(`FAIL left pointer x ${px}`); }
  near(py, 0, 0.05, `left pointer y (heading ${heading})`);

  // Point up 5 deg: pointer above the middle (runtime y is down-positive, as KPAD pos).
  const [, upY] = runtimePointer(P.bodyPose(frame, P.quatFromEuler(heading, tilt + 5, 0)), half[0], half[1]);
  if (!(upY < -0.4)) { failures++; console.log(`FAIL up pointer y ${upY} (heading ${heading})`); }

  // Roll the phone 30 deg about its long axis (gamma): pointer stays put, roll changes by 30 deg.
  const qRoll = P.quatFromEuler(heading, tilt, 30);
  const [rx, ry] = runtimePointer(P.bodyPose(frame, qRoll), half[0], half[1]);
  near(rx, 0, 1e-6, `roll keeps pointer x (heading ${heading})`);
  near(ry, 0, 1e-6, `roll keeps pointer y (heading ${heading})`);
  near(Math.abs(runtimeRoll(P.bodyPose(frame, qRoll))) / DEG, 30, 0.01, `roll angle (heading ${heading})`);
}

// A corner on the wrong side of the middle is rejected.
{
  const frame = P.screenFrame(P.tipDirection(P.quatFromEuler(0, 0, 0)));
  const bad = P.screenHalfAngles(frame, P.tipDirection(P.quatFromEuler(-15, 9, 0)), P.tipDirection(P.quatFromEuler(15, -9, 0)));
  if (bad !== null) { failures++; console.log('FAIL swapped corners accepted'); }
}

console.log(failures ? `${failures} failure(s)` : 'PASS');
process.exit(failures ? 1 : 0);
