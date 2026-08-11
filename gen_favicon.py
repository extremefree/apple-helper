"""生成 苹果 favicon.ico —— 红苹果 + 绿叶 + 茎 + 高光"""
from PIL import Image, ImageDraw


def draw_apple(size: int) -> Image.Image:
    """在指定尺寸下绘制苹果图标，返回 RGBA 图像"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx = size / 2
    cy = size * 0.56
    r = size * 0.36

    # 苹果主体(红)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(205, 35, 40, 255))

    # 顶部凹陷: 用透明椭圆擦出
    nw = size * 0.13
    d.ellipse(
        [cx - nw, cy - r - nw * 0.55, cx + nw, cy - r + nw * 0.55],
        fill=(0, 0, 0, 0),
    )

    # 茎(棕)
    sw = size * 0.03
    d.rectangle(
        [cx - sw, cy - r - size * 0.05, cx + sw, cy - r + size * 0.04],
        fill=(90, 55, 30, 255),
    )

    # 叶子(绿) —— 茎右侧倾斜椭圆
    lx = cx + size * 0.04
    ly = cy - r - size * 0.02
    lw = size * 0.20
    lh = size * 0.10
    d.ellipse([lx, ly - lh, lx + lw, ly + lh], fill=(70, 165, 70, 255))

    # 高光(白)
    hr = size * 0.085
    hx = cx - size * 0.14
    hy = cy - size * 0.14
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=(255, 255, 255, 170))

    return img


def main():
    sizes = [16, 32, 48, 64, 128, 256]
    images = [draw_apple(s) for s in sizes]
    primary = images[-1]  # 256 作为主图
    primary.save(
        "favicon.ico",
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=images[:-1],
    )
    primary.save("favicon.png")
    print("Generated: favicon.ico, favicon.png (apple)")


if __name__ == "__main__":
    main()
