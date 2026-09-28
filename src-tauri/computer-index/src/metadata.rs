use chrono::{DateTime, NaiveDateTime, Utc};
use exif::{In, Tag, Value};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Media {
    pub captured: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub camera: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
}

pub fn photo(path: &Path) -> Media {
    let mut out = Media::default();
    if let Ok(size) = imagesize::size(path) {
        out.width = u32::try_from(size.width).ok();
        out.height = u32::try_from(size.height).ok();
    }
    // Bound allocations even for corrupt RAW/HEIF files. No image pixels are decoded.
    let exif = File::open(path).ok().and_then(|file| {
        let mut bytes = Vec::new();
        file.take(16 * 1024 * 1024).read_to_end(&mut bytes).ok()?;
        exif::Reader::new()
            .read_from_container(&mut Cursor::new(bytes))
            .ok()
    });
    let Some(exif) = exif else { return out };
    let ascii = |tag| match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Ascii(v) => Some(
            String::from_utf8_lossy(v.first()?)
                .trim_end_matches('\0')
                .trim()
                .to_owned(),
        ),
        _ => None,
    };
    out.captured = ascii(Tag::DateTimeOriginal)
        .or_else(|| ascii(Tag::DateTime))
        .and_then(|s| {
            NaiveDateTime::parse_from_str(&s, "%Y:%m:%d %H:%M:%S")
                .ok()
                .map(|d| d.format("%Y-%m-%dT%H:%M:%S").to_string())
        });
    out.camera = match (ascii(Tag::Make), ascii(Tag::Model)) {
        (Some(a), Some(b)) => Some(format!("{a} {b}")),
        (a, b) => a.or(b),
    };
    let gps = |tag, reference, negative: &str| -> Option<f64> {
        let Value::Rational(v) = &exif.get_field(tag, In::PRIMARY)?.value else {
            return None;
        };
        if v.len() != 3 || v.iter().any(|r| r.denom == 0) {
            return None;
        }
        let n = v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0;
        Some(if ascii(reference)? == negative { -n } else { n })
    };
    out.lat = gps(Tag::GPSLatitude, Tag::GPSLatitudeRef, "S").filter(|n| n.abs() <= 90.0);
    out.lon = gps(Tag::GPSLongitude, Tag::GPSLongitudeRef, "W").filter(|n| n.abs() <= 180.0);
    out.width = exif
        .get_field(Tag::PixelXDimension, In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .or(out.width);
    out.height = exif
        .get_field(Tag::PixelYDimension, In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .or(out.height);
    out
}

fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(p..p + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], p: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(p..p + 8)?.try_into().ok()?))
}

pub fn video(path: &Path) -> io::Result<Media> {
    let mut file = BufReader::new(File::open(path)?);
    let len = file.get_ref().metadata()?.len();
    let mut out = Media::default();
    let mut pos = 0;
    while pos + 8 <= len {
        file.seek(SeekFrom::Start(pos))?;
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let mut head = 8;
        if size == 1 {
            let mut b = [0; 8];
            file.read_exact(&mut b)?;
            size = u64::from_be_bytes(b);
            head = 16;
        }
        if size == 0 {
            size = len - pos;
        }
        if size < head || size > len - pos {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid MP4 atom size",
            ));
        }
        if &header[4..] == b"moov" && size - head <= 16 * 1024 * 1024 {
            let mut data = vec![0; (size - head) as usize];
            file.read_exact(&mut data)?;
            atoms(&data, 0, &mut out);
        }
        pos += size;
    }
    Ok(out)
}

fn atoms(bytes: &[u8], depth: usize, out: &mut Media) {
    if depth > 12 {
        return;
    }
    let mut pos = 0;
    while pos + 8 <= bytes.len() {
        let size = u32_at(bytes, pos).unwrap() as usize;
        let kind = &bytes[pos + 4..pos + 8];
        let (size, head) = if size == 1 {
            (u64_at(bytes, pos + 8).unwrap_or(0) as usize, 16)
        } else {
            (if size == 0 { bytes.len() - pos } else { size }, 8)
        };
        if size < head || size > bytes.len() - pos {
            break;
        }
        let data = &bytes[pos + head..pos + size];
        match kind {
            b"mvhd" if data.len() >= 20 => {
                let v1 = data[0] == 1;
                let created = if v1 {
                    u64_at(data, 4)
                } else {
                    u32_at(data, 4).map(u64::from)
                };
                out.captured = created
                    .filter(|n| *n > 2_082_844_800)
                    .and_then(|n| i64::try_from(n).ok())
                    .and_then(|n| DateTime::<Utc>::from_timestamp(n - 2_082_844_800, 0))
                    .map(|d| d.to_rfc3339());
                let scale = u32_at(data, if v1 { 20 } else { 12 });
                let duration = if v1 {
                    u64_at(data, 24)
                } else {
                    u32_at(data, 16).map(u64::from)
                };
                out.duration = scale
                    .filter(|s| *s > 0)
                    .zip(duration)
                    .map(|(s, d)| d as f64 / s as f64);
            }
            b"tkhd" => {
                let offset = if data.first() == Some(&1) { 88 } else { 76 };
                if let (Some(w), Some(h)) = (u32_at(data, offset), u32_at(data, offset + 4)) {
                    if w > 0 && h > 0 {
                        out.width = Some(w >> 16);
                        out.height = Some(h >> 16);
                    }
                }
            }
            b"moov" | b"trak" | b"mdia" | b"udta" | b"ilst" => atoms(data, depth + 1, out),
            b"meta" => {
                if data.len() >= 4 {
                    atoms(&data[4..], depth + 1, out);
                }
            }
            b"\xa9xyz" => {
                if data.len() > 4 {
                    iso6709(&data[4..], out);
                }
            }
            b"data" => {
                if data.len() > 8 {
                    iso6709(&data[8..], out);
                }
            }
            // Numbered ilst entries contain data atoms (QuickTime mdta ISO6709).
            _ if depth > 0 && kind[0] == 0 => atoms(data, depth + 1, out),
            _ => {}
        }
        pos += size;
    }
}

fn iso6709(bytes: &[u8], out: &mut Media) {
    let Ok(s) = std::str::from_utf8(bytes) else {
        return;
    };
    let s = s.trim_matches('\0').trim();
    if !s.starts_with(['+', '-']) {
        return;
    }
    let Some(split) = s[1..].find(['+', '-']).map(|i| i + 1) else {
        return;
    };
    let rest = &s[split..];
    let end = rest[1..]
        .find(['+', '-', '/'])
        .map_or(rest.len(), |i| i + 1);
    if let (Ok(lat), Ok(lon)) = (s[..split].parse::<f64>(), rest[..end].parse::<f64>()) {
        if lat.abs() <= 90.0 && lon.abs() <= 180.0 {
            out.lat = Some(lat);
            out.lon = Some(lon);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_real_exif_and_mp4_container_metadata() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        let home = repo.join(format!(".tmp/metadata-fixture-{}", std::process::id()));
        if home.exists() {
            std::fs::remove_dir_all(&home).unwrap();
        }
        mod support {
            include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/support/mod.rs"));
        }
        let generated = std::process::Command::new(support::python())
            .arg(repo.join("scripts/generate-test-home.py"))
            .arg("--root")
            .arg(&home)
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let image = photo(&home.join("Pictures/IMG_0000.png"));
        assert_eq!(image.captured.as_deref(), Some("2026-07-15T12:30:00"));
        assert_eq!(image.camera.as_deref(), Some("Fixture Camera"));
        assert_eq!((image.width, image.height), (Some(32), Some(24)));
        assert!((image.lat.unwrap() - 38.722222).abs() < 0.00001);
        assert!((image.lon.unwrap() + 9.138889).abs() < 0.00001);
        let movie = video(&home.join("Movies/clip-0.mp4")).unwrap();
        assert_eq!(movie.captured.as_deref(), Some("2026-07-15T00:00:00+00:00"));
        assert_eq!(movie.duration, Some(12.0));
        assert_eq!((movie.width, movie.height), (Some(1920), Some(1080)));
        assert_eq!((movie.lat, movie.lon), (Some(38.7222), Some(-9.1389)));
    }
    #[test]
    fn rejects_invalid_gps_and_oversized_nested_atoms() {
        let mut media = Media::default();
        iso6709(b"+95.0-181.0/", &mut media);
        assert_eq!(media.lat, None);
        atoms(
            &[0xff, 0xff, 0xff, 0xff, b'm', b'v', b'h', b'd'],
            0,
            &mut media,
        );
        assert_eq!(media, Media::default());
        atoms(&[0, 0, 0, 1, b'm', b'o', b'o', b'v'], 0, &mut media);
        assert_eq!(media, Media::default());
    }
}
