/**
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) — required by the ZIP
 * format for every entry (M0-T3).
 *
 * WHY THIS FILE EXISTS
 * The `.stpack` container is self-built (ADR-018), so the CRC lives in our tree.
 * `docs/04` §9 requires tamper detection ("SHA-256 不匹配 / 大小不符 → 拒绝导入"),
 * and §12 item 3 requires "篡改任一字节 → 校验失败". Entry SHA-256 covers that
 * across implementations; the ZIP-level CRC-32 is what makes a *container* fault
 * (a truncated or bit-flipped deflate stream) detectable at read time instead of
 * surfacing later as a hash mismatch on one file, possibly after a partial import.
 *
 * SCOPE: pure arithmetic on `Uint8Array` — no I/O, no DOM, no Node API, no `Buffer`.
 */

/**
 * The 256-entry lookup table, built on first use (1 KiB of constants that only
 * archives pay for).
 */
let table: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (table !== undefined) return table;
  const built = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    built[index] = value >>> 0;
  }
  table = built;
  return built;
}

/**
 * CRC-32 of `bytes`, unsigned.
 *
 * `seed` continues a CRC across chunks, which is how a caller can hash a stream
 * without first materialising it.
 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  const lookup = crcTable();
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const entry = lookup[(crc ^ (bytes[index] as number)) & 0xff] as number;
    crc = ((crc >>> 8) ^ entry) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32 as lowercase hex, matching the `crc` column tools print. */
export function crc32Hex(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, '0');
}
