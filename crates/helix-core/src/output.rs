//! Remote output decoding.
//!
//! Windows tooling can transcode UTF-8 emitted by a remote program through an
//! OEM code page. The classic failure is PowerShell's built-in `help`, which
//! pipes Get-Help output through `more.com`; that tool writes OEM code page 936
//! and replaces bytes it cannot represent with `?`. A UTF-8 BOM at the start of
//! the document therefore arrives as `EF BB 3F` instead of `EF BB BF`, which is
//! not valid UTF-8, so a naive decoder falls back to GBK and renders Chinese as
//! mojibake.
//!
//! The decoder below only treats *short* damaged runs that end in `?` as OEM
//! damage. A genuinely intact UTF-8 document therefore stays UTF-8, while a
//! genuine GBK stream still decodes as GBK.

const DAMAGED_BOM: [u8; 3] = [0xEF, 0xBB, 0x3F];
const MAX_DAMAGE_RUN: usize = 3;

/// Decode remote command output that may be UTF-8, GBK, or UTF-8 damaged by an
/// OEM code page.
pub fn decode_remote_output(bytes: &[u8]) -> String {
    if std::str::from_utf8(bytes).is_ok() {
        return String::from_utf8_lossy(bytes).into_owned();
    }

    let repaired = repair_damaged_bom(bytes);
    let candidate: &[u8] = repaired.as_deref().unwrap_or(bytes);
    if candidate
        .split(|byte| *byte == b'\n')
        .all(line_is_repairable_damage)
    {
        return String::from_utf8_lossy(candidate).into_owned();
    }

    decode_gbk(bytes)
}

/// Length of the longest valid UTF-8 prefix, advancing by whole sequences.
pub fn scan_utf8_prefix(bytes: &[u8]) -> usize {
    let mut offset = 0;
    while offset < bytes.len() {
        let Some(length) = utf8_sequence_len(bytes[offset]) else {
            break;
        };
        if offset + length > bytes.len()
            || std::str::from_utf8(&bytes[offset..offset + length]).is_err()
        {
            break;
        }
        offset += length;
    }
    offset
}

/// Restore a BOM that an OEM code page turned into `EF BB 3F`.
pub fn repair_damaged_bom(bytes: &[u8]) -> Option<Vec<u8>> {
    if !bytes.starts_with(&DAMAGED_BOM) {
        return None;
    }
    let mut repaired = bytes.to_vec();
    repaired[2] = 0xBF;
    Some(repaired)
}

/// Whether a single line's invalid UTF-8 consists solely of short OEM damage
/// runs that end in `?` (or an incomplete multi-byte sequence at end of line).
pub fn line_is_repairable_damage(line: &[u8]) -> bool {
    let mut offset = 0;
    while offset < line.len() {
        let byte = line[offset];
        if byte < 0x80 {
            offset += 1;
            continue;
        }
        let Some(length) = utf8_sequence_len(byte) else {
            // A byte that can never start a UTF-8 sequence is not OEM damage.
            return false;
        };
        if offset + length > line.len() {
            // The line ends mid-sequence: truncated output, still UTF-8.
            return true;
        }
        if std::str::from_utf8(&line[offset..offset + length]).is_ok() {
            offset += length;
            continue;
        }
        let run_ends_with_question_mark =
            length <= MAX_DAMAGE_RUN && line[offset + length - 1] == b'?';
        if !run_ends_with_question_mark {
            return false;
        }
        offset += length;
    }
    true
}

fn utf8_sequence_len(byte: u8) -> Option<usize> {
    match byte {
        0x00..=0x7F => Some(1),
        0xC2..=0xDF => Some(2),
        0xE0..=0xEF => Some(3),
        0xF0..=0xF4 => Some(4),
        _ => None,
    }
}

fn decode_gbk(bytes: &[u8]) -> String {
    let (text, _, _) = encoding_rs::GBK.decode(bytes);
    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_a_bom_damaged_by_oem_replacement() {
        let mut input = vec![0xEF, 0xBB, 0x3F];
        input.extend_from_slice("名称".as_bytes());
        let decoded = decode_remote_output(&input);
        assert!(decoded.contains("名称"), "decoded: {decoded:?}");
        assert!(!decoded.starts_with('\u{FFFD}'), "decoded: {decoded:?}");
    }

    #[test]
    fn decodes_a_genuine_gbk_stream_as_gbk() {
        // "名称" in GBK.
        let input = [0xC3, 0xFB, 0xB3, 0xC6];
        assert_eq!(decode_remote_output(&input), "名称");
    }

    #[test]
    fn leaves_valid_utf8_untouched() {
        let input = "hello 世界\nsecond line\n".as_bytes();
        assert_eq!(decode_remote_output(input), "hello 世界\nsecond line\n");
    }

    #[test]
    fn repairs_short_replacement_runs_that_end_in_a_question_mark() {
        let mut line = b"abc ".to_vec();
        line.extend_from_slice(&[0xEF, 0xBB, 0x3F]);
        line.extend_from_slice(b" def");
        let decoded = decode_remote_output(&line);
        assert!(decoded.starts_with("abc "), "decoded: {decoded:?}");
        assert!(decoded.ends_with(" def"), "decoded: {decoded:?}");
    }

    #[test]
    fn keeps_a_mostly_intact_utf8_document_as_utf8() {
        let mut input = vec![0xEF, 0xBB, 0x3F];
        input.extend_from_slice("名称\n".as_bytes());
        input.extend_from_slice("描述\n".as_bytes());
        let decoded = decode_remote_output(&input);
        assert!(decoded.contains("名称"), "decoded: {decoded:?}");
        assert!(decoded.contains("描述"), "decoded: {decoded:?}");
    }

    #[test]
    fn does_not_repair_long_corrupt_sequences() {
        assert!(!line_is_repairable_damage(&[0x81, 0x80, 0x81, 0x80, 0x81]));
        assert!(!line_is_repairable_damage(&[0xC3, 0xFB, 0xB3, 0xC6]));
    }

    #[test]
    fn recognizes_a_short_question_mark_run() {
        assert!(line_is_repairable_damage(b"abc \xEF\xBB? def"));
    }

    #[test]
    fn prefix_scan_advances_by_utf8_sequence() {
        // "中" is three bytes; the trailing 0x81 is an invalid start byte.
        assert_eq!(scan_utf8_prefix(&[0xE4, 0xB8, 0xAD, 0x81]), 3);
        assert_eq!(scan_utf8_prefix("世界".as_bytes()), 6);
    }

    #[test]
    fn truncated_multibyte_tail_is_not_treated_as_gbk() {
        let decoded = decode_remote_output(b"abc\xE4\xB8");
        assert!(decoded.starts_with("abc"), "decoded: {decoded:?}");
        assert_eq!(
            decoded.matches('\u{FFFD}').count(),
            1,
            "decoded: {decoded:?}"
        );
    }

    #[test]
    fn damaged_bom_is_repaired_without_a_replacement_char() {
        let repaired = repair_damaged_bom(&[0xEF, 0xBB, 0x3F, b'x']);
        assert_eq!(repaired.as_deref(), Some(&[0xEF, 0xBB, 0xBF, b'x'][..]));
        assert_eq!(repair_damaged_bom(b"plain"), None);
    }
}
