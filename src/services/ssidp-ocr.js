/**
 * SS-IDP OCR service (Agent I — scrimport-1).
 *
 * Ports the Black Raven source's ssIdpService OCR pipeline:
 * screenshot -> sharp crop/enhance of the upper-left lobby header -> tesseract
 * OCR -> regex extraction of Room ID + Password.
 *
 * SHA-256 duplicate fingerprinting keeps a transient in-memory cache so the
 * same room details are not reposted within SS_IDP_DUP_MINUTES (default 30).
 * This is a transient dedupe cache, not multi-step form state — acceptable
 * in-memory per the scrimport plan (form state stays in ScrimFormSession).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let sharp = null;
let tesseract = null;
try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
} catch (err) {
  console.warn('[ssidp-ocr] sharp is not available — OCR degraded to manual /ss_idp:', err.message);
}
try {
  // eslint-disable-next-line global-require
  tesseract = require('tesseract.js');
} catch (err) {
  console.warn('[ssidp-ocr] tesseract.js is not available — OCR degraded to manual /ss_idp:', err.message);
}

const DUP_MINUTES = Number(process.env.SS_IDP_DUP_MINUTES || 30);
const OCR_TIMEOUT_MS = Number(process.env.SS_IDP_OCR_TIMEOUT_MS || 60000);

// sha256(roomId:password) -> timestamp (ms). Pruned to the last hour on write.
const recentFingerprints = new Map();

/**
 * Pure text parser: extract { roomId, password } from OCR text.
 * Room ID: typically 5-6+ digits near "Room"/"ID". Password: near "Password"/"Pwd".
 * Returns null when either is missing.
 */
function parseRoomText(text) {
  const normalized = String(text || '').replace(/\r/g, '\n');
  const roomId =
    /(?:room\s*(?:id|no|number)?|lobby\s*(?:id|no|number)?)\s*[:#=-]?\s*([0-9]{5,15})/i.exec(normalized)?.[1] ||
    /\bid\s*[:#=-]?\s*([0-9]{5,15})/i.exec(normalized)?.[1] ||
    /\b([0-9]{5,15})\b/.exec(normalized)?.[1] ||
    null;
  const password =
    /(?:password|pass|pwd)\s*[:#=-]?\s*([a-z0-9]{3,20})/i.exec(normalized)?.[1] || null;
  if (!roomId || !password) return null;
  return { roomId, password };
}

function fingerprintCreds(roomId, password) {
  return crypto.createHash('sha256').update(`${roomId}:${password}`).digest('hex');
}

function isDuplicateCreds(roomId, password) {
  if (!roomId || !password) return false;
  const prev = recentFingerprints.get(fingerprintCreds(roomId, password));
  return Boolean(prev && Date.now() - prev < DUP_MINUTES * 60000);
}

function markCredsSeen(roomId, password) {
  if (!roomId || !password) return;
  recentFingerprints.set(fingerprintCreds(roomId, password), Date.now());
  const cutoff = Date.now() - 3600000;
  for (const [key, ts] of recentFingerprints) {
    if (ts < cutoff) recentFingerprints.delete(key);
  }
}

/** Directory holding eng.traineddata, or null when the bundled file is missing. */
function traineddataDir() {
  try {
    const dir = path.join(__dirname, '..', '..', 'assets');
    if (fs.existsSync(path.join(dir, 'eng.traineddata'))) return dir;
  } catch (err) {
    console.warn('[ssidp-ocr] traineddata check failed:', err.message);
  }
  return null;
}

let workerPromise = null;
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const OEM = tesseract.OEM || { LSTM_ONLY: 1 };
      const dir = traineddataDir();
      if (dir) {
        console.log('[ssidp-ocr] using local eng.traineddata from', dir);
        // gzip:false — the bundled file is not gzipped; tesseract.js otherwise
        // looks for eng.traineddata.gz.
        return tesseract.createWorker('eng', OEM.LSTM_ONLY, { langPath: dir, gzip: false });
      }
      console.log('[ssidp-ocr] local eng.traineddata missing — falling back to tesseract.js default fetch');
      return tesseract.createWorker('eng', OEM.LSTM_ONLY);
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function recognize(buffer) {
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer);
  return (data && data.text) || '';
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run the full OCR pipeline on an image buffer.
 * @param {Buffer} imageBuffer
 * @returns {Promise<{roomId:string,password:string}|null>} creds or null when
 *   unreadable / either field missing / deps unavailable. Never throws.
 */
async function extractRoomCredentials(imageBuffer) {
  if (!sharp || !tesseract) {
    console.warn('[ssidp-ocr] OCR deps missing — degraded to /ss_idp manual');
    return null;
  }
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null;
  try {
    const meta = await sharp(imageBuffer).metadata();
    const w = Number(meta.width || 0);
    const h = Number(meta.height || 0);
    if (!w || !h) return null;

    // PUBG/BGMI lobby header: Room ID + Room Password sit in the upper-left
    // header area; the player grid below/right is full of distracting numbers.
    const crop = {
      left: Math.max(0, Math.floor(w * Number(process.env.SS_IDP_CROP_LEFT || 0.02))),
      top: Math.max(0, Math.floor(h * Number(process.env.SS_IDP_CROP_TOP || 0.0))),
      width: Math.min(w, Math.max(1, Math.floor(w * Number(process.env.SS_IDP_CROP_WIDTH || 0.45)))),
      height: Math.min(h, Math.max(1, Math.floor(h * Number(process.env.SS_IDP_CROP_HEIGHT || 0.28)))),
    };
    const header = await sharp(imageBuffer)
      .extract(crop)
      .grayscale()
      .normalize()
      .resize({ width: Math.min(1600, crop.width * 2) })
      .png()
      .toBuffer();
    const headerText = await withTimeout(recognize(header), OCR_TIMEOUT_MS, 'SS-IDP OCR (header crop)');
    const creds = parseRoomText(headerText);
    if (creds) return creds;

    // Fallback: whole image, in case the lobby layout differs.
    const full = await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .resize({ width: Math.min(1800, w) })
      .png()
      .toBuffer();
    const fullText = await withTimeout(recognize(full), OCR_TIMEOUT_MS, 'SS-IDP OCR (full image)');
    return parseRoomText(`${headerText}\n${fullText}`);
  } catch (err) {
    console.error('[ssidp-ocr] extractRoomCredentials failed:', err.message);
    return null;
  }
}

module.exports = {
  extractRoomCredentials,
  parseRoomText,
  fingerprintCreds,
  isDuplicateCreds,
  markCredsSeen,
};
