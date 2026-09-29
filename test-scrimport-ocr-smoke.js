// test-scrimport-ocr-smoke.js — pure-logic coverage for the SS-IDP OCR parsing
// layer (src/services/ssidp-ocr.js). No tesseract worker is spun up here; the
// full pipeline smoke test was done by the OCR module author. Run: node test-scrimport-ocr-smoke.js
'use strict';
const assert = require('node:assert/strict');
const { parseRoomText, fingerprintCreds, isDuplicateCreds, markCredsSeen } = require('./src/services/ssidp-ocr.js');

let ok = 0;
function check(name, fn) {
  fn();
  ok++;
  console.log('  ✓', name);
}

// --- parseRoomText: room id + password variants ---
check('labeled lines', () => {
  const r = parseRoomText('ROOM ID: 4829137\nPASSWORD: tiger99');
  assert.equal(r.roomId, '4829137');
  assert.equal(r.password, 'tiger99');
});

check('colon variants and case', () => {
  const r = parseRoomText('Room: 12345\nPass : abcDEF');
  assert.equal(r.roomId, '12345');
  assert.equal(r.password, 'abcDEF');
});

check('room/password on one line', () => {
  const r = parseRoomText('ROOM 777888 PASS xyz123');
  assert.equal(r.roomId, '777888');
  assert.equal(r.password, 'xyz123');
});

check('garbage in -> null, never throws', () => {
  assert.equal(parseRoomText('hello world\nno credentials here'), null);
});

check('null/undefined/empty input -> null', () => {
  assert.equal(parseRoomText(null), null);
  assert.equal(parseRoomText(undefined), null);
  assert.equal(parseRoomText(''), null);
});

check('OCR spacing noise degrades gracefully', () => {
  const r = parseRoomText('R O O M   I D : 9 8 7 6 5 4\nP A S S W O R D : q w e r t y');
  assert.ok(r === null || typeof r.roomId === 'string'); // spaced digits can't parse — returns null, never throws
});

// --- duplicate fingerprinting ---
check('duplicate suppression round-trip', () => {
  markCredsSeen('111', 'aaa');
  assert.equal(isDuplicateCreds('111', 'aaa'), true);
  assert.equal(isDuplicateCreds('222', 'bbb'), false);
});

check('fingerprintCreds is stable + opaque', () => {
  const a = fingerprintCreds('1', 'p');
  const b = fingerprintCreds('1', 'p');
  assert.equal(a, b);
  assert.ok(a.length === 64 && !a.includes('p'), 'sha256 hex, must not leak the password');
});

console.log(`\n${ok} scrimport OCR smoke tests passed.`);
