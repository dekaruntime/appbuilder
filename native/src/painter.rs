// Scene painter adapter from Deka native renderer fd8e705, Apache-2.0.
use deka_native_ui::scene::Scene;
use gpui::*;
use std::{collections::HashMap, sync::Arc};
/// Shared desktop painter for UI scenes and the portfolio-world example.
pub(crate) fn paint_scene(
    bounds: Bounds<Pixels>,
    scene: &Scene,
    window: &mut Window,
    cache: &mut HashMap<String, Arc<RenderImage>>,
) {
    window.paint_quad(fill(bounds, rgb(scene.background)));
    // Opacity is applied to cached glyph alpha because GPUI's canvas image API
    // takes opacity from private element state. Keep only this frame's variants.
    let mut used = std::collections::HashSet::new();
    for paint in &scene.paint {
        if paint.opacity <= 0. {
            continue;
        }
        let rect = Bounds {
            origin: bounds.origin + point(px(paint.rect.x), px(paint.rect.y)),
            size: size(px(paint.rect.width), px(paint.rect.height)),
        };
        let c = paint.clip;
        let mask = ContentMask {
            bounds: Bounds {
                origin: bounds.origin + point(px(c.x), px(c.y)),
                size: size(px(c.width), px(c.height)),
            },
        };
        window.with_content_mask(Some(mask), |window| {
            if let Some(id) = &paint.image {
                let alpha = (paint.opacity * 255.).round() as u8;
                let key = format!("{id}@{alpha}");
                used.insert(key.clone());
                if let Some(glyph) = scene.images.iter().find(|g| &g.id == id) {
                    let image = cache.entry(key).or_insert_with(|| {
                        let mut bgra = glyph.rgba.clone();
                        for pixel in bgra.chunks_exact_mut(4) {
                            pixel.swap(0, 2);
                            pixel[3] = (u16::from(pixel[3]) * u16::from(alpha) / 255) as u8;
                        }
                        let rgba = image::RgbaImage::from_raw(
                            glyph.width as u32,
                            glyph.height as u32,
                            bgra,
                        )
                        .expect("glyph dimensions");
                        Arc::new(RenderImage::new(vec![image::Frame::new(rgba)]))
                    });
                    let _ = window.paint_image(rect, Corners::default(), image.clone(), 0, false);
                }
            } else {
                window.paint_quad(
                    fill(
                        rect,
                        rgba((paint.color << 8) | (paint.opacity * 255.).round() as u32),
                    )
                    .corner_radii(px(paint.radius)),
                );
            }
        });
    }
    cache.retain(|id, _| used.contains(id));
}
