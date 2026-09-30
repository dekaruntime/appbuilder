//! Thumbnails for search results on macOS: Quick Look's QLThumbnailGenerator,
//! the same previews Finder shows (PDF first pages, images, video frames,
//! Keynote and Numbers documents), falling back to the file's icon when a
//! type has no preview. Generated on this Mac only, for results on screen.

use base64::{engine::general_purpose::STANDARD, Engine};
use block2::RcBlock;
use objc2::AnyThread;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
use objc2_core_foundation::CGSize;
use objc2_foundation::{NSDictionary, NSError, NSString, NSURL};
use objc2_quick_look_thumbnailing::{
    QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes, QLThumbnailGenerator,
    QLThumbnailRepresentation, QLThumbnailRepresentationType,
};
use std::{sync::mpsc, time::Duration};

/// The rows draw icons at 28 points; @2x keeps them sharp on Retina.
const POINTS: f64 = 28.0;
const SCALE: f64 = 2.0;
/// Quick Look usually answers in milliseconds; a stuck generator must never
/// hold a result row.
const TIMEOUT: Duration = Duration::from_secs(3);

/// A PNG data URL for `path`: its preview, or its icon when the type has no
/// preview. None when Quick Look has nothing for it.
pub fn thumbnail(path: &str) -> Option<String> {
    let (png, _) = generate(path)?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

/// The PNG bytes and which kind of image Quick Look produced.
fn generate(path: &str) -> Option<(Vec<u8>, QLThumbnailRepresentationType)> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    // SAFETY: a valid file URL, a positive size and scale, and a defined
    // representation-types mask, as the initializer requires.
    let request = unsafe {
        QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
            QLThumbnailGenerationRequest::alloc(),
            &url,
            CGSize::new(POINTS, POINTS),
            SCALE,
            QLThumbnailGenerationRequestRepresentationTypes::All,
        )
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let handler = RcBlock::new(move |representation: *mut QLThumbnailRepresentation, _error: *mut NSError| {
        // SAFETY: Quick Look passes either a valid representation or null.
        let image = unsafe { representation.as_ref() }.and_then(|representation| {
            // SAFETY: a valid representation, read inside its handler.
            let kind = unsafe { representation.r#type() };
            png(representation).map(|png| (png, kind))
        });
        let _ = sender.try_send(image);
    });
    // SAFETY: the request and handler outlive the call; the handler runs on
    // Quick Look's queue and only sends on a channel.
    unsafe {
        QLThumbnailGenerator::sharedGenerator().generateBestRepresentationForRequest_completionHandler(&request, &handler);
    }
    receiver.recv_timeout(TIMEOUT).ok().flatten()
}

fn png(representation: &QLThumbnailRepresentation) -> Option<Vec<u8>> {
    // SAFETY: the representation is valid for the duration of the handler.
    let image = unsafe { representation.CGImage() };
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
    // SAFETY: PNG with no properties is a valid encoding request.
    let data = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pdf_gets_a_real_preview_of_its_page_not_just_an_icon() {
        // A PDF this test writes itself: Quick Look renders its first page.
        let dir = std::env::temp_dir().join(format!("zega-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pdf = dir.join("page.pdf");
        std::fs::write(&pdf, MINIMAL_PDF).unwrap();
        let (png, kind) = generate(pdf.to_str().unwrap()).expect("Quick Look answered for a PDF");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "the bytes are a PNG");
        assert_ne!(kind, QLThumbnailRepresentationType::Icon, "a PDF gets a preview of its page, not the generic icon");
        let url = thumbnail(pdf.to_str().unwrap()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_file_without_a_preview_falls_back_to_its_icon_quickly() {
        // Quick Look answers from the extension alone when there is no file:
        // the generic icon, which is better than a text badge. It never hangs.
        let started = std::time::Instant::now();
        let (_, kind) = generate("/nonexistent/zega/nothing-here.pdf").expect("an icon for the type");
        assert_eq!(kind, QLThumbnailRepresentationType::Icon);
        assert!(started.elapsed() < TIMEOUT);
    }

    const MINIMAL_PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 48 Tf 20 90 Td (zega) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
}
