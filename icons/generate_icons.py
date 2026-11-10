import os
from PIL import Image, ImageDraw

def create_cute_icon(size):
    # Scale up for antialiasing
    scale = 4
    img_size = size * scale
    img = Image.new("RGBA", (img_size, img_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    center_x = img_size / 2
    center_y = img_size / 2
    radius = img_size * 0.42

    # Draw Cat Ears
    ear_w = radius * 0.48
    ear_h = radius * 0.58
    # Left ear
    left_ear = [
        (center_x - radius * 0.75, center_y - radius * 0.3),
        (center_x - radius * 0.45, center_y - radius * 1.05),
        (center_x - radius * 0.15, center_y - radius * 0.6)
    ]
    draw.polygon(left_ear, fill=(255, 107, 139, 255))
    # Left inner ear
    left_inner = [
        (center_x - radius * 0.68, center_y - radius * 0.35),
        (center_x - radius * 0.45, center_y - radius * 0.95),
        (center_x - radius * 0.22, center_y - radius * 0.6)
    ]
    draw.polygon(left_inner, fill=(255, 209, 220, 255))

    # Right ear
    right_ear = [
        (center_x + radius * 0.15, center_y - radius * 0.6),
        (center_x + radius * 0.45, center_y - radius * 1.05),
        (center_x + radius * 0.75, center_y - radius * 0.3)
    ]
    draw.polygon(right_ear, fill=(255, 107, 139, 255))
    # Right inner ear
    right_inner = [
        (center_x + radius * 0.22, center_y - radius * 0.6),
        (center_x + radius * 0.45, center_y - radius * 0.95),
        (center_x + radius * 0.68, center_y - radius * 0.35)
    ]
    draw.polygon(right_inner, fill=(255, 209, 220, 255))

    # Main Face / Body Circle (Soft pink)
    bbox = [center_x - radius, center_y - radius * 0.85, center_x + radius, center_y + radius * 1.05]
    draw.ellipse(bbox, fill=(255, 133, 161, 255))

    # Inner soft glow
    inner_bbox = [center_x - radius * 0.9, center_y - radius * 0.75, center_x + radius * 0.9, center_y + radius * 0.95]
    draw.ellipse(inner_bbox, fill=(255, 154, 178, 255))

    # Cute Play Triangle in the center (White)
    play_size = radius * 0.55
    play_x_offset = center_x - play_size * 0.25
    play_triangle = [
        (play_x_offset, center_y + radius * 0.08 - play_size * 0.6),
        (play_x_offset + play_size * 0.9, center_y + radius * 0.08),
        (play_x_offset, center_y + radius * 0.08 + play_size * 0.6)
    ]
    draw.polygon(play_triangle, fill=(255, 255, 255, 255))

    # Blush circles (Kawaii Cheeks)
    blush_r = radius * 0.18
    # Left blush
    draw.ellipse([
        center_x - radius * 0.75, center_y + radius * 0.25,
        center_x - radius * 0.75 + blush_r * 2, center_y + radius * 0.25 + blush_r * 1.2
    ], fill=(255, 80, 120, 200))
    # Right blush
    draw.ellipse([
        center_x + radius * 0.75 - blush_r * 2, center_y + radius * 0.25,
        center_x + radius * 0.75, center_y + radius * 0.25 + blush_r * 1.2
    ], fill=(255, 80, 120, 200))

    # Sparkle / Star in top corner
    star_x = center_x + radius * 0.55
    star_y = center_y - radius * 0.45
    sr = radius * 0.12
    draw.ellipse([star_x - sr, star_y - sr, star_x + sr, star_y + sr], fill=(255, 255, 255, 240))

    # Resize with High Quality Lanczos filter
    final_img = img.resize((size, size), Image.Resampling.LANCZOS)
    return final_img

out_dir = r"C:\Users\asus\.gemini\antigravity\scratch\cute-anime-video-downloader\icons"
for s in [16, 48, 128]:
    im = create_cute_icon(s)
    path = os.path.join(out_dir, f"icon{s}.png")
    im.save(path)
    print(f"Generated {path}")
