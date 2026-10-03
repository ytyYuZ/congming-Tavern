/**
 * Handing the user a file (M1-A4).
 *
 * WHY THIS IS ITS OWN MODULE AND ITS OWN FILE
 * `Blob`, `URL.createObjectURL` and a synthetic `<a>` are the only browser-only things in the
 * pack layer. Keeping them here means everything above can be tested in `node` — the export
 * function returns bytes and this function is what turns bytes into something a person can
 * save. It is also the whole reason no dependency was needed: an object URL plus one click is
 * the platform's own download, and a library would be a second way to do the same thing.
 *
 * WHY THE OBJECT URL IS REVOKED
 * An object URL pins its blob in memory until the document that created it goes away. A user
 * who exports five times should not be holding five packages, so the URL is released as soon
 * as the click has been dispatched.
 */
import { PACK_EXTENSION } from './pack-export';

/** The container's media type: a `.stpack` is a ZIP, and saying so helps a file manager. */
export const PACK_MIME = 'application/zip';

/** Save `bytes` under `fileName`. The one impure, browser-only step of the export path. */
export function downloadBytes(bytes: Uint8Array, fileName: string): void {
  // A `Uint8Array` is a view onto an `ArrayBufferLike`, which is wider than `BlobPart`: a view
  // onto a `SharedArrayBuffer` is not something a blob can hold. This library always produces a
  // plain `ArrayBuffer`, but the type does not say so, and a fresh array — whose buffer the
  // constructor really does allocate — says it without a cast.
  const part = new Uint8Array(bytes.byteLength);
  part.set(bytes);
  const url = URL.createObjectURL(new Blob([part], { type: PACK_MIME }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName.endsWith(PACK_EXTENSION) ? fileName : `${fileName}${PACK_EXTENSION}`;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}
