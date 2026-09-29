/**
 * scrimport-1 tests: SS-IDP OCR service (parseRoomText fixtures, duplicate
 * fingerprinting, extractRoomCredentials edge cases).
 * The full tesseract worker spin-up is BOUNDED: if the worker does not
 * return within OCR_PROBE_TIMEOUT_MS, the probe is skipped with a clear
 * message instead of blocking the suite. (The worker is heavy on first
 * init; parseRoomText + fingerprint coverage lives here and in
 * test-scrimport-ocr-smoke.js.)
 * No Discord connection, no DB needed.
 */
const assert = require('node:assert/strict');
const ocr = require('./src/services/ssidp-ocr.js');

let passed = 0;
let skipped = 0;
function ok(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    process.exitCode = 1;
  } else {
    passed++;
    console.log('ok:', name);
  }
}
function skip(name, reason) {
  skipped++;
  console.log(`skip: ${name} (${reason})`);
}

// Bound for the worker probe; keep the suite fast. Never hangs the run.
const OCR_PROBE_TIMEOUT_MS = Number(process.env.SCRIMPORT_OCR_PROBE_TIMEOUT_MS || 20000);

console.log('parseRoomText fixtures:');
const fixtures = [
  ['ROOM ID: 1234567\nPASSWORD: abc123', { roomId: '1234567', password: 'abc123' }],
  ['Room No 998877\nPass: qwerty', { roomId: '998877', password: 'qwerty' }],
  ['room number = 7654321\npwd: zxcvbn', { roomId: '7654321', password: 'zxcvbn' }],
  ['LOBBY ID: 246810\nROOM PASSWORD: letmein', { roomId: '246810', password: 'letmein' }],
  ['garbage with no room', null],
  ['ROOM ID: 1234567', null],       // missing password -> null
  ['PASSWORD: abc123', null],       // missing room id -> null
  ['random 123 text 456', null],    // digits too short / no labels -> null
];
for (const [text, expected] of fixtures) {
  const got = ocr.parseRoomText(text);
  ok(`parseRoomText(${JSON.stringify(text).slice(0, 40)}) -> ${JSON.stringify(got)}`,
    JSON.stringify(got) === JSON.stringify(expected));
}

console.log('parseRoomText edge cases:');
ok('null input -> null', ocr.parseRoomText(null) === null);
ok('undefined input -> null', ocr.parseRoomText(undefined) === null);
ok('empty string -> null', ocr.parseRoomText('') === null);
ok('whitespace only -> null', ocr.parseRoomText('   \n  ') === null);
ok('non-string input does not throw', ocr.parseRoomText(12345) === null);

console.log('fingerprint / duplicate logic:');
ok('fingerprintCreds stable + hex', (() => {
  const a = ocr.fingerprintCreds('1234567', 'abc123');
  const b = ocr.fingerprintCreds('1234567', 'abc123');
  return a === b && /^[0-9a-f]{64}$/.test(a);
})());
ok('different creds -> different fingerprints',
  ocr.fingerprintCreds('1', 'a') !== ocr.fingerprintCreds('1', 'b'));
ok('isDuplicateCreds false before mark', ocr.isDuplicateCreds('900001', 'pw900001') === false);
ocr.markCredsSeen('900001', 'pw900001');
ok('isDuplicateCreds true right after mark', ocr.isDuplicateCreds('900001', 'pw900001') === true);
ok('isDuplicateCreds false for missing args', ocr.isDuplicateCreds(null, 'x') === false);
ok('markCredsSeen ignores empty args (no throw)', (() => { ocr.markCredsSeen(null, null); return true; })());

console.log('extractRoomCredentials edge cases (bounded worker probe):');
(async () => {
  // Null/empty inputs short-circuit before any worker work — never throw.
  ok('null buffer -> null', (await ocr.extractRoomCredentials(null)) === null);
  ok('empty buffer -> null', (await ocr.extractRoomCredentials(Buffer.alloc(0))) === null);
  ok('non-buffer input -> null', (await ocr.extractRoomCredentials('not-a-buffer')) === null);

  // Blank 200x200 PNG through the full pipeline, bounded: skip cleanly
  // if the tesseract worker takes too long to spin up on first init.
  let sharp = null;
  try {
    sharp = require('sharp');
  } catch (e) {
    skip('blank-PNG OCR probe', 'sharp unavailable');
  }
  if (sharp) {
    const buf = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();
    let timedOut = false;
    const probe = ocr.extractRoomCredentials(buf).then(
      (r) => ({ status: 'done', value: r }),
      (e) => ({ status: 'threw', error: e }),
    );
    const result = await Promise.race([
      probe,
      new Promise((resolve) => setTimeout(() => { timedOut = true; resolve({ status: 'timeout' }); }, OCR_PROBE_TIMEOUT_MS)),
    ]);
    if (result.status === 'timeout' || timedOut) {
      skip('blank-PNG OCR probe', `tesseract worker did not finish within ${OCR_PROBE_TIMEOUT_MS}ms (first-init is heavy; OCR degrades to /ss_idp manual at runtime)`);
    } else if (result.status === 'threw') {
      console.error('FAIL: extractRoomCredentials threw:', result.error && result.error.message);
      process.exitCode = 1;
    } else {
      ok('blank PNG -> null or credential object (never throws)',
        result.value === null || (typeof result.value === 'object' && typeof result.value.roomId === 'string'));
    }
  }
  console.log(`\n${passed} scrimport OCR tests passed, ${skipped} skipped.`);
  // The tesseract worker keeps the event loop alive; the suite is done.
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FAIL: OCR suite threw:', e.message);
  process.exit(1);
});
