/**
 * tools/read/binary.js — INTERNAL helper of the `read` tool (never a
 * tool itself: the scan is not recursive). Content-based binary
 * detection — NO mime maps and NO file extensions, only the bytes:
 *
 *   1. all bytes ≤ 127 → TEXT (plain ASCII);
 *   2. otherwise, bytes above 127 are text when the content decodes
 *      as valid UTF-8, or as valid UTF-16 (LE or BE, for Unicode
 *      text saved with wide encoding — detected by a BOM or NUL
 *      alternation, then strictly decoded);
 *   3. anything else carrying bytes above 127 → BINARY.
 *
 * Empty files are text. The scan caps at 64 KiB — enough to judge
 * any text file, cheap for huge ones.
 */

const SCAN_LIMIT = 64 * 1024;

/** Bytes to examine: the whole buffer, or its first SCAN_LIMIT. */
function sample(buffer) {
  return buffer.length > SCAN_LIMIT ? buffer.subarray(0, SCAN_LIMIT) : buffer;
}

function hasHighBytes(bytes) {
  for (const b of bytes) if (b > 127) return true;
  return false;
}

/** Strict whole-buffer UTF-8 validation (overlongs, surrogates, ranges). */
function isUtf8(bytes) {
  const n = bytes.length;
  for (let i = 0; i < n;) {
    const b = bytes[i];
    if (b <= 0x7f) { i += 1; continue; }
    if (b < 0xc2) return false; // 0x80–0xBF stray continuation, 0xC0/0xC1 overlong
    let length, code;
    if (b < 0xe0) { length = 2; code = b & 0x1f; }
    else if (b < 0xf0) { length = 3; code = b & 0x0f; }
    else if (b <= 0xf4) { length = 4; code = b & 0x07; }
    else return false; // 0xF5–0xFF can never start UTF-8
    if (i + length > n) return false;
    for (let j = 1; j < length; j++) {
      const c = bytes[i + j];
      if ((c & 0xc0) !== 0x80) return false;
      code = (code << 6) | (c & 0x3f);
    }
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
    i += length;
  }
  return true;
}

/**
 * Decode every 16-bit unit with the given byte order; the units must
 * form valid Unicode scalar values (lone surrogates reject).
 */
function utf16UnitsValid(bytes, littleEndian) {
  if (bytes.length % 2 !== 0) return false;
  for (let i = 0; i < bytes.length; i += 2) {
    const unit = littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 3 >= bytes.length) return false; // a lone high surrogate
      const low = littleEndian ? bytes[i + 2] | (bytes[i + 3] << 8) : (bytes[i + 2] << 8) | bytes[i + 3];
      if (low < 0xdc00 || low > 0xdfff) return false;
      i += 2; // consume the low surrogate as well
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false; // a lone low surrogate
  }
  return true;
}

/** A UTF-16 file alternates NULs on one side of its ASCII content. */
function nulRatio(bytes, littleEndian) {
  const pairs = Math.floor(bytes.length / 2);
  if (pairs === 0) return 0;
  let nuls = 0;
  const offset = littleEndian ? 1 : 0;
  for (let i = offset; i < 2 * pairs; i += 2) if (bytes[i] === 0) nuls++;
  return nuls / pairs;
}

function isUtf16(bytes) {
  let order = null;
  let start = 0;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { order = true; start = 2; } // LE BOM
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { order = false; start = 2; } // BE BOM
  else if (nulRatio(bytes, true) > 0.3) order = true;
  else if (nulRatio(bytes, false) > 0.3) order = false;
  else return false; // no BOM and no NUL alternation: not UTF-16
  return utf16UnitsValid(bytes.subarray(start), order);
}

/**
 * Heuristic text/binary judgment from content alone.
 * @param {Buffer|Uint8Array} buffer
 * @returns {boolean} true when the content should be treated as binary
 */
export function isBinary(buffer) {
  const bytes = sample(buffer);
  if (!hasHighBytes(bytes)) return false; // ASCII (or empty): always text
  if (isUtf8(bytes)) return false;
  return !isUtf16(bytes);
}
