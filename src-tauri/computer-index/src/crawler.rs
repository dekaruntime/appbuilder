use crate::metadata::{self, Media};
use file_id::FileId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub key: String,
    pub name: String,
    pub path: String,
    pub volume: String,
    pub file_id: String,
    pub fingerprint: String,
    pub size: u64,
    pub mtime: u64,
    pub offline: bool,
    #[serde(default)]
    pub kind: String,
}

fn raw_identity(path: &Path) -> io::Result<(String, String)> {
    let (volume, file) = match file_id::get_file_id(path)? {
        FileId::Inode {
            device_id,
            inode_number,
        } => (format!("dev:{device_id}"), inode_number.to_string()),
        FileId::LowRes {
            volume_serial_number,
            file_index,
        } => (
            format!("vol:{volume_serial_number}"),
            file_index.to_string(),
        ),
        FileId::HighRes {
            volume_serial_number,
            file_id,
        } => (format!("vol:{volume_serial_number}"), file_id.to_string()),
    };
    Ok((volume, file))
}

pub fn identity(path: &Path) -> io::Result<(String, String)> {
    let (volume, file) = raw_identity(path)?;
    #[cfg(target_os = "macos")]
    let volume = volume_uuid(path).unwrap_or(volume);
    #[cfg(target_os = "linux")]
    let volume = linux_volume_uuid(&volume).unwrap_or(volume);
    Ok((volume, file))
}

#[cfg(target_os = "macos")]
fn volume_uuid(path: &Path) -> Option<String> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // ATTR_VOL_UUID | ATTR_VOL_INFO, from the macOS SDK sys/attr.h.
    let mut attrs = libc::attrlist {
        bitmapcount: 5,
        reserved: 0,
        commonattr: 0,
        volattr: 0x8004_0000,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut bytes = [0u8; 20];
    // SAFETY: a NUL-terminated path and writable buffers of the declared size.
    let status = unsafe {
        libc::getattrlist(
            path.as_ptr(),
            &mut attrs as *mut _ as *mut libc::c_void,
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            0,
        )
    };
    if status != 0 || bytes[4..].iter().all(|b| *b == 0) {
        return None;
    }
    Some(format!(
        "uuid:{}",
        bytes[4..]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}

#[cfg(target_os = "linux")]
fn linux_volume_uuid(device: &str) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let device: u64 = device.strip_prefix("dev:")?.parse().ok()?;
    // Read device metadata only, never block-device contents. /dev/disk may be
    // absent in containers; the native device identity remains the fallback.
    fs::read_dir("/dev/disk/by-uuid")
        .ok()?
        .filter_map(|e| e.ok())
        .find_map(|entry| {
            (fs::metadata(entry.path()).ok()?.rdev() == device)
                .then(|| format!("uuid:{}", entry.file_name().to_string_lossy()))
        })
}

fn local_volume(path: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: statfs initializes the supplied buffer on success.
        if unsafe { libc::statfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let stat = unsafe { stat.assume_init() };
        #[cfg(target_os = "macos")]
        {
            Ok(stat.f_flags & libc::MNT_LOCAL as u32 != 0)
        }
        #[cfg(target_os = "linux")]
        {
            Ok(!matches!(
                stat.f_type as u64,
                0x6969 | 0xff534d42 | 0xfe534d42 | 0x65735546 | 0x517b
            ))
        }
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let drive = match path.components().next() {
            Some(Component::Prefix(p)) => match p.kind() {
                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => d,
                _ => return Ok(false),
            },
            _ => return Ok(false),
        };
        let root = [drive as u16, b':' as u16, b'\\' as u16, 0];
        // SAFETY: root is a NUL-terminated UTF-16 drive root.
        Ok(
            unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(root.as_ptr()) }
                != windows_sys::Win32::System::WindowsProgramming::DRIVE_REMOTE,
        )
    }
}

/// iCloud is never indexed (desktop#45). Anything iCloud manages (Desktop
/// and Documents when they sync, iCloud Drive) is skipped without being
/// opened: opening a placeholder makes macOS download it, which is what made
/// scans take 1–2 s per item and pulled people's files down from iCloud.
#[cfg(target_os = "macos")]
pub fn icloud(path: &Path) -> bool {
    use std::os::macos::fs::MetadataExt;
    // An evicted placeholder ("Optimize Mac Storage"), from a plain stat
    // that never triggers a download.
    const SF_DATALESS: u32 = 0x4000_0000;
    let Ok(meta) = fs::symlink_metadata(path) else { return false };
    if meta.st_flags() & SF_DATALESS != 0 {
        return true;
    }
    // Asking Foundation costs up to a millisecond, so only folders are asked:
    // an iCloud folder is skipped whole, and a file in a local folder is local.
    if !meta.is_dir() {
        return false;
    }
    let Some(text) = path.to_str() else { return false };
    objc2::rc::autoreleasepool(|_| {
        let url = objc2_foundation::NSURL::fileURLWithPath(&objc2_foundation::NSString::from_str(text));
        let mut value = None;
        // SAFETY: NSURLIsUbiquitousItemKey is a Foundation constant, and its
        // value is an NSNumber (checked by the downcast below).
        let found = unsafe { url.getResourceValue_forKey_error(&mut value, objc2_foundation::NSURLIsUbiquitousItemKey) };
        found.is_ok()
            && value
                .and_then(|value| value.downcast::<objc2_foundation::NSNumber>().ok())
                .is_some_and(|number| number.boolValue())
    })
}

#[cfg(not(target_os = "macos"))]
pub fn icloud(_path: &Path) -> bool {
    false
}

pub fn visible(path: &Path) -> bool {
    path.file_name().is_some_and(|n| {
        let n = n.to_string_lossy().to_ascii_lowercase();
        !n.starts_with('.')
            && !matches!(
                n.as_str(),
                "node_modules"
                    | "library"
                    | "appdata"
                    | "windows"
                    | "system"
                    | "system32"
                    | "programdata"
                    | "cache"
                    | "caches"
                    | "__pycache__"
                    | "target"
                    | "$recycle.bin"
                    | "system volume information"
                    | "credentials"
                    | "secrets"
                    | "id_rsa"
                    | "id_ed25519"
            )
    })
}

pub fn record(path: &Path, app_root: bool) -> io::Result<(Record, Media)> {
    record_cached(path, app_root, &mut std::collections::HashMap::new(), None)
}

pub fn record_cached(
    path: &Path,
    app_root: bool,
    volumes: &mut std::collections::HashMap<String, String>,
    cached: Option<&Record>,
) -> io::Result<(Record, Media)> {
    if path.to_str().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "path is not UTF-8",
        ));
    }
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 6 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "hidden/system file",
            ));
        }
    }
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file or directory",
        ));
    }
    let (device, file_id) = raw_identity(path)?;
    let volume = if let Some(volume) = volumes.get(&device) {
        volume.clone()
    } else {
        if !local_volume(path)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "network filesystems are not indexed",
            ));
        }
        #[cfg(target_os = "macos")]
        let volume = volume_uuid(path).unwrap_or_else(|| device.clone());
        #[cfg(target_os = "linux")]
        let volume = linux_volume_uuid(&device).unwrap_or_else(|| device.clone());
        #[cfg(windows)]
        let volume = device.clone();
        volumes.insert(device, volume.clone());
        volume
    };
    let mtime = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(i64::MAX as u128) as u64;
    let size = if metadata.is_dir() { 0 } else { metadata.len() };
    if let Some(cached) = cached.filter(|r| {
        r.volume == volume && r.file_id == file_id && r.size == size && r.mtime == mtime
    }) {
        let mut record = cached.clone();
        record.offline = false;
        return Ok((record, Media::default()));
    }
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let kind = if (metadata.is_dir() && extension == "app")
        || (app_root && matches!(extension.as_str(), "desktop" | "exe" | "lnk" | "appref-ms"))
    {
        "App"
    } else if metadata.is_dir() {
        "Folder"
    } else if matches!(
        extension.as_str(),
        "jpg"
            | "jpeg"
            | "heic"
            | "heif"
            | "png"
            | "tif"
            | "tiff"
            | "dng"
            | "cr2"
            | "nef"
            | "arw"
            | "orf"
            | "rw2"
            | "raf"
            | "cr3"
    ) {
        "Photo"
    } else if matches!(extension.as_str(), "mp4" | "mov" | "m4v") {
        "Video"
    } else {
        "File"
    };
    let fingerprint = if metadata.is_dir() {
        "directory".to_owned()
    } else {
        fingerprint(path, size)?
    };
    let key = format!("{volume}:{file_id}:{fingerprint}");
    let media = match kind {
        "Photo" => metadata::photo(path),
        "Video" => metadata::video(path).unwrap_or_default(),
        _ => Media::default(),
    };
    Ok((
        Record {
            key,
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: path.to_string_lossy().into_owned(),
            volume,
            file_id,
            fingerprint,
            size,
            mtime,
            offline: false,
            kind: kind.to_owned(),
        },
        media,
    ))
}

fn fingerprint(path: &Path, size: u64) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    hash.update(size.to_le_bytes());
    let mut buf = [0; 4096];
    let n = file.read(&mut buf)?;
    hash.update(&buf[..n]);
    if size > 4096 {
        file.seek(SeekFrom::Start(size.saturating_sub(4096)))?;
        let n = file.read(&mut buf)?;
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[derive(Clone, Debug)]
pub struct Root {
    pub path: PathBuf,
    pub apps: bool,
}

/// Uses filesystem volume identity, not existence of the scope directory: a
/// deleted folder on a mounted drive is different from an unmounted drive.
pub fn volume_present(record: &Record) -> bool {
    Path::new(&record.path)
        .ancestors()
        .any(|p| identity(p).is_ok_and(|(volume, _)| volume == record.volume))
}

#[cfg(all(test, target_os = "macos"))]
mod icloud_tests {
    #[test]
    fn local_files_and_folders_are_not_icloud() {
        let dir = std::env::temp_dir().join(format!("zega-icloud-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/file.txt"), "local").unwrap();
        assert!(!super::icloud(&dir));
        assert!(!super::icloud(&dir.join("sub/file.txt")));
        std::fs::remove_dir_all(dir).ok();
    }
}
