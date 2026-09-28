//! Windows' app catalogue supplies launchable desktop/Store apps and display names.
//! Icons come from the Shell image factory, never by executing the target.
use base64::Engine;
use windows::{
    core::HSTRING,
    Win32::{
        Foundation::SIZE,
        Graphics::Gdi::*,
        System::Com::*,
        UI::{Shell::*, WindowsAndMessaging::SW_SHOWNORMAL},
    },
};

struct Apartment;
impl Apartment {
    fn enter() -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| e.to_string())?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

unsafe fn name(item: &IShellItem, kind: SIGDN) -> Result<String, String> {
    let value = item.GetDisplayName(kind).map_err(|e| e.to_string())?;
    let result = value.to_string().map_err(|e| e.to_string());
    CoTaskMemFree(Some(value.0.cast()));
    result
}

pub fn discover() -> Result<Vec<(String, String)>, String> {
    let _apartment = Apartment::enter()?;
    unsafe {
        let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)
            .map_err(|e| e.to_string())?;
        let items: IEnumShellItems = folder
            .BindToHandler(None::<&IBindCtx>, &BHID_EnumItems)
            .map_err(|e| e.to_string())?;
        let mut apps = Vec::new();
        loop {
            let mut next = [None];
            let mut fetched = 0;
            items
                .Next(&mut next, Some(&mut fetched))
                .map_err(|e| e.to_string())?;
            if fetched == 0 {
                break;
            }
            let item = next[0]
                .take()
                .ok_or("Windows returned an empty app entry")?;
            let label = name(&item, SIGDN_NORMALDISPLAY)?;
            let id = name(&item, SIGDN_PARENTRELATIVEPARSING)?;
            if !label.is_empty() && !id.is_empty() {
                apps.push((label, format!("shell:AppsFolder\\{id}")));
            }
        }
        apps.sort();
        let mut targets = std::collections::HashSet::new();
        apps.retain(|(_, target)| targets.insert(target.clone()));
        Ok(apps)
    }
}

pub fn open(target: &str) -> Result<(), String> {
    if !target.starts_with("shell:AppsFolder\\") {
        return Err("Invalid registered app".into());
    }
    let _apartment = Apartment::enter()?;
    let target = HSTRING::from(target);
    unsafe {
        let result = ShellExecuteW(
            None,
            windows::core::w!("open"),
            &target,
            None,
            None,
            SW_SHOWNORMAL,
        );
        if result.0 as isize <= 32 {
            return Err("Windows could not open this app; it may have been uninstalled".into());
        }
    }
    Ok(())
}

struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0.into());
        }
    }
}
struct Dc(HDC);
impl Drop for Dc {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}

pub fn icon(path: &str) -> Result<String, String> {
    let _apartment = Apartment::enter()?;
    let path = HSTRING::from(path);
    unsafe {
        let item: IShellItemImageFactory =
            SHCreateItemFromParsingName(&path, None::<&IBindCtx>).map_err(|e| e.to_string())?;
        let bitmap = Bitmap(
            item.GetImage(SIZE { cx: 32, cy: 32 }, SIIGBF_ICONONLY)
                .map_err(|e| e.to_string())?,
        );
        let mut object = BITMAP::default();
        if GetObjectW(
            bitmap.0.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some((&mut object as *mut BITMAP).cast()),
        ) == 0
        {
            return Err("Windows icon bitmap unavailable".into());
        }
        let (width, height) = (object.bmWidth, object.bmHeight);
        if !(1..=256).contains(&width) || !(1..=256).contains(&height) {
            return Err("Invalid icon size".into());
        }
        let dc = Dc(CreateCompatibleDC(None));
        if dc.0 .0.is_null() {
            return Err("Windows icon conversion unavailable".into());
        }
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        if GetDIBits(
            dc.0,
            bitmap.0,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        ) != height
        {
            return Err("Windows could not read the icon".into());
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            if pixel[3] > 0 && pixel[3] < 255 {
                for channel in 0..3 {
                    pixel[channel] =
                        ((u32::from(pixel[channel]) * 255 / u32::from(pixel[3])).min(255)) as u8;
                }
            }
        }
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(&pixels)
            .map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_catalogue_supplies_display_names_and_native_icons() {
        let apps = discover().unwrap();
        assert!(!apps.is_empty());
        assert!(apps
            .iter()
            .all(|(name, target)| !name.is_empty() && target.starts_with("shell:AppsFolder\\")));
        let image = apps
            .iter()
            .find_map(|(_, target)| icon(target).ok())
            .expect("at least one installed app must have a Shell icon");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let frame = reader.next_frame(&mut pixels).unwrap();
        assert!(
            pixels[..frame.buffer_size()]
                .chunks_exact(4)
                .any(|pixel| pixel[3] > 0),
            "the Shell icon must have visible pixels"
        );
        println!(
            "Windows Shell catalogue: {} launchable entries; native PNG icon extracted",
            apps.len()
        );
    }
}
