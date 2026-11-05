import math
import struct
import zlib
import os

def make_png(width, height, get_pixel):
    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0)
        for x in range(width):
            r, g, b, a = get_pixel(x, y)
            raw_data.extend([int(r), int(g), int(b), int(a)])
    compressed = zlib.compress(bytes(raw_data), 9)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    return png

def make_ico(png_list):
    header = struct.pack('<HHH', 0, 1, len(png_list))
    entries = b''
    data_offset = 6 + len(png_list) * 16
    data = b''
    for w, h, p_bytes in png_list:
        bw = 0 if w >= 256 else w
        bh = 0 if h >= 256 else h
        entry = struct.pack('<BBBBHHII', bw, bh, 0, 0, 1, 32, len(p_bytes), data_offset + len(data))
        entries += entry
        data += p_bytes
    return header + entries + data

def render_favicon(size):
    scale = size / 32.0
    cx = (size - 1) / 2.0
    cy = (size - 1) / 2.0
    hx = 13.5 * scale
    hy = 9.8 * scale
    r = 4.8 * scale

    # Triangle vertices
    t_p0 = ((13.2 - 16.0) * scale, (10.6 - 16.0) * scale)
    t_p1 = ((21.0 - 16.0) * scale, (16.0 - 16.0) * scale)
    t_p2 = ((13.2 - 16.0) * scale, (21.4 - 16.0) * scale)

    def sd_box(px, py):
        qx = abs(px) - (hx - r)
        qy = abs(py) - (hy - r)
        dx = max(qx, 0.0)
        dy = max(qy, 0.0)
        out_dist = math.hypot(dx, dy)
        in_dist = min(max(qx, qy), 0.0)
        return out_dist + in_dist - r

    def pt_in_tri(px, py):
        def sign(p1, p2, p3):
            return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
        d1 = sign((px, py), t_p0, t_p1)
        d2 = sign((px, py), t_p1, t_p2)
        d3 = sign((px, py), t_p2, t_p0)
        has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        return not (has_neg and has_pos)

    # 4x supersampling
    sub = [-0.375, -0.125, 0.125, 0.375]
    def get_pixel(x, y):
        red_sum = 0
        white_sum = 0
        for sx in sub:
            for sy in sub:
                px = (x + sx) - cx
                py = (y + sy) - cy
                box_d = sd_box(px, py)
                if box_d <= 0:
                    if pt_in_tri(px, py):
                        white_sum += 1
                    else:
                        red_sum += 1
        total_samples = 16.0
        alpha_red = red_sum / total_samples
        alpha_white = white_sum / total_samples
        total_alpha = alpha_red + alpha_white
        if total_alpha <= 0:
            return (0, 0, 0, 0)
        # Light blue pill gradient: slightly brighter top (#38bdf8), deeper bottom (#0284c7)
        t_y = (y / float(size))
        pill_r = int(56 * (1.0 - t_y) + 2 * t_y)
        pill_g = int(189 * (1.0 - t_y) + 132 * t_y)
        pill_b = int(248 * (1.0 - t_y) + 199 * t_y)
        
        r = int((255 * alpha_white + pill_r * alpha_red) / total_alpha)
        g = int((255 * alpha_white + pill_g * alpha_red) / total_alpha)
        b = int((255 * alpha_white + pill_b * alpha_red) / total_alpha)
        a = int(min(255, total_alpha * 255))
        return (r, g, b, a)

    return make_png(size, size, get_pixel)

def render_apple_touch_icon(size=180):
    cx = (size - 1) / 2.0
    cy = (size - 1) / 2.0
    # Center pill: width ~120, height ~84, rx ~20
    hx = 60.0
    hy = 42.0
    r = 21.0

    t_p0 = (57.0 - 90.0, 66.0 - 90.0)
    t_p1 = (95.0 - 90.0, 90.0 - 90.0)
    t_p2 = (57.0 - 90.0, 114.0 - 90.0)

    def sd_box(px, py):
        qx = abs(px) - (hx - r)
        qy = abs(py) - (hy - r)
        dx = max(qx, 0.0)
        dy = max(qy, 0.0)
        return math.hypot(dx, dy) + min(max(qx, qy), 0.0) - r

    def pt_in_tri(px, py):
        def sign(p1, p2, p3):
            return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
        d1 = sign((px, py), t_p0, t_p1)
        d2 = sign((px, py), t_p1, t_p2)
        d3 = sign((px, py), t_p2, t_p0)
        return not (((d1 < 0) or (d2 < 0) or (d3 < 0)) and ((d1 > 0) or (d2 > 0) or (d3 > 0)))

    sub = [-0.375, -0.125, 0.125, 0.375]
    def get_pixel(x, y):
        red_sum = 0
        white_sum = 0
        for sx in sub:
            for sy in sub:
                px = (x + sx) - cx
                py = (y + sy) - cy
                box_d = sd_box(px, py)
                if box_d <= 0:
                    if pt_in_tri(px, py):
                        white_sum += 1
                    else:
                        red_sum += 1
        total_samples = 16.0
        alpha_red = red_sum / total_samples
        alpha_white = white_sum / total_samples
        
        # Background: sleek dark #0f0f0f
        bg_r, bg_g, bg_b = 15, 15, 15
        t_y = (y / float(size))
        pill_r = int(56 * (1.0 - t_y) + 2 * t_y)
        pill_g = int(189 * (1.0 - t_y) + 132 * t_y)
        pill_b = int(248 * (1.0 - t_y) + 199 * t_y)
        white_r, white_g, white_b = 255, 255, 255

        # Blend pill over bg
        r = bg_r * (1.0 - alpha_red - alpha_white) + pill_r * alpha_red + white_r * alpha_white
        g = bg_g * (1.0 - alpha_red - alpha_white) + pill_g * alpha_red + white_g * alpha_white
        b = bg_b * (1.0 - alpha_red - alpha_white) + pill_b * alpha_red + white_b * alpha_white

        return (int(r), int(g), int(b), 255)

    return make_png(size, size, get_pixel)

public_dir = os.path.join(os.path.dirname(__file__), '..', 'public')

# 1. Generate PNGs
p16 = render_favicon(16)
p32 = render_favicon(32)
p48 = render_favicon(48)
p192 = render_favicon(192)
p512 = render_favicon(512)
apple_icon = render_apple_touch_icon(180)

with open(os.path.join(public_dir, 'favicon-16x16.png'), 'wb') as f:
    f.write(p16)
with open(os.path.join(public_dir, 'favicon-32x32.png'), 'wb') as f:
    f.write(p32)
with open(os.path.join(public_dir, 'favicon-48x48.png'), 'wb') as f:
    f.write(p48)
with open(os.path.join(public_dir, 'favicon-192x192.png'), 'wb') as f:
    f.write(p192)
with open(os.path.join(public_dir, 'favicon-512x512.png'), 'wb') as f:
    f.write(p512)
with open(os.path.join(public_dir, 'apple-touch-icon.png'), 'wb') as f:
    f.write(apple_icon)

# 2. Generate favicon.ico
ico_data = make_ico([(16, 16, p16), (32, 32, p32), (48, 48, p48)])
with open(os.path.join(public_dir, 'favicon.ico'), 'wb') as f:
    f.write(ico_data)

print("Icons generated successfully!")
