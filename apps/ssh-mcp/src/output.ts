/**
 * Remote output decoding.
 *
 * Windows tooling can transcode UTF-8 emitted by a remote program through an
 * OEM code page. The classic failure is PowerShell's built-in `help`, which
 * pipes Get-Help output through `more.com`; that tool writes OEM code page 936
 * and replaces bytes it cannot represent with `?`. A UTF-8 BOM therefore
 * arrives as `EF BB 3F`, which is not valid UTF-8, so a naive decoder falls
 * back to GBK and renders Chinese as mojibake.
 *
 * Only short damaged runs that end in `?` are treated as OEM damage, so an
 * intact UTF-8 document stays UTF-8 while a genuine GBK stream stays GBK.
 */

const DAMAGED_BOM = [0xef, 0xbb, 0x3f] as const;
const MAX_DAMAGE_RUN = 3;

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8 = new TextDecoder("utf-8");

let gbkDecoder: TextDecoder | null | undefined;

function gbk(): TextDecoder | null {
  if (gbkDecoder === undefined) {
    try {
      gbkDecoder = new TextDecoder("gbk");
    } catch {
      gbkDecoder = null;
    }
  }
  return gbkDecoder;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    fatalUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function utf8SequenceLength(byte: number): number | null {
  if (byte <= 0x7f) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return null;
}

/** Decode remote command output that may be UTF-8, GBK, or OEM-damaged UTF-8. */
export function decodeOutput(bytes: Uint8Array): string {
  if (isValidUtf8(bytes)) return lossyUtf8.decode(bytes);

  const candidate = repairDamagedBom(bytes) ?? bytes;
  if (allLinesRepairable(candidate)) return lossyUtf8.decode(candidate);

  return gbk()?.decode(bytes) ?? lossyUtf8.decode(bytes);
}

/** Length of the longest valid UTF-8 prefix, advancing by whole sequences. */
export function scanUtf8Prefix(bytes: Uint8Array): number {
  let offset = 0;
  while (offset < bytes.length) {
    const length = utf8SequenceLength(bytes[offset]!);
    if (length === null) break;
    if (offset + length > bytes.length) break;
    if (!isValidUtf8(bytes.subarray(offset, offset + length))) break;
    offset += length;
  }
  return offset;
}

/** Restore a BOM that an OEM code page turned into `EF BB 3F`. */
export function repairDamagedBom(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 3) return null;
  if (bytes[0] !== DAMAGED_BOM[0] || bytes[1] !== DAMAGED_BOM[1] || bytes[2] !== DAMAGED_BOM[2]) {
    return null;
  }
  const repaired = bytes.slice();
  repaired[2] = 0xbf;
  return repaired;
}

/** Whether a line's invalid UTF-8 is only short OEM damage ending in `?`. */
export function lineIsRepairableDamage(line: Uint8Array): boolean {
  let offset = 0;
  while (offset < line.length) {
    const byte = line[offset]!;
    if (byte < 0x80) {
      offset += 1;
      continue;
    }
    const length = utf8SequenceLength(byte);
    if (length === null) return false;
    if (offset + length > line.length) return true;
    if (isValidUtf8(line.subarray(offset, offset + length))) {
      offset += length;
      continue;
    }
    if (length > MAX_DAMAGE_RUN || line[offset + length - 1] !== 0x3f) return false;
    offset += length;
  }
  return true;
}

function allLinesRepairable(bytes: Uint8Array): boolean {
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === 0x0a) {
      if (!lineIsRepairableDamage(bytes.subarray(start, index))) return false;
      start = index + 1;
    }
  }
  return true;
}
