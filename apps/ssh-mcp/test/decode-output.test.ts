import { describe, expect, it } from "vitest";
import {
  decodeOutput,
  lineIsRepairableDamage,
  repairDamagedBom,
  scanUtf8Prefix,
} from "../src/output.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("decodeOutput", () => {
  it("repairs a UTF-8 BOM damaged by an OEM code page", () => {
    const input = new Uint8Array([0xef, 0xbb, 0x3f, ...utf8("名称")]);
    const decoded = decodeOutput(input);
    expect(decoded).toContain("名称");
    expect(decoded.startsWith("\uFFFD")).toBe(false);
  });

  it("keeps genuine GBK output decoded as GBK", () => {
    const input = new Uint8Array([0xc3, 0xfb, 0xb3, 0xc6]);
    expect(decodeOutput(input)).toBe("名称");
  });

  it("leaves valid UTF-8 unchanged", () => {
    expect(decodeOutput(utf8("hello 世界\nsecond line\n"))).toBe("hello 世界\nsecond line\n");
  });

  it("repairs only short question-mark-terminated damage", () => {
    const input = new Uint8Array([...utf8("abc "), 0xef, 0xbb, 0x3f, ...utf8(" def")]);
    const decoded = decodeOutput(input);
    expect(decoded.startsWith("abc ")).toBe(true);
    expect(decoded.endsWith(" def")).toBe(true);
  });

  it("keeps a mostly intact UTF-8 document as UTF-8", () => {
    const input = new Uint8Array([0xef, 0xbb, 0x3f, ...utf8("名称\n描述\n")]);
    const decoded = decodeOutput(input);
    expect(decoded).toContain("名称");
    expect(decoded).toContain("描述");
  });

  it("does not treat a truncated multibyte tail as GBK", () => {
    const decoded = decodeOutput(new Uint8Array([...utf8("abc"), 0xe4, 0xb8]));
    expect(decoded.startsWith("abc")).toBe(true);
    expect(decoded.split("\uFFFD").length - 1).toBe(1);
  });
});

describe("lineIsRepairableDamage", () => {
  it("rejects long corrupt runs and genuine GBK", () => {
    expect(lineIsRepairableDamage(new Uint8Array([0x81, 0x80, 0x81, 0x80, 0x81]))).toBe(false);
    expect(lineIsRepairableDamage(new Uint8Array([0xc3, 0xfb, 0xb3, 0xc6]))).toBe(false);
  });

  it("recognizes a short question-mark run", () => {
    expect(lineIsRepairableDamage(new Uint8Array([...utf8("abc "), 0xef, 0xbb, 0x3f, ...utf8(" def")]))).toBe(true);
  });
});

describe("scanUtf8Prefix", () => {
  it("advances by UTF-8 sequence, not by byte", () => {
    expect(scanUtf8Prefix(new Uint8Array([0xe4, 0xb8, 0xad, 0x81]))).toBe(3);
    expect(scanUtf8Prefix(utf8("世界"))).toBe(6);
  });
});

describe("repairDamagedBom", () => {
  it("restores EF BB BF and returns null otherwise", () => {
    expect(repairDamagedBom(new Uint8Array([0xef, 0xbb, 0x3f, 0x78]))).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf, 0x78]),
    );
    expect(repairDamagedBom(utf8("plain"))).toBeNull();
  });
});
