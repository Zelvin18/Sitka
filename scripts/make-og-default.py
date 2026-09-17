# Draws web/public/og-default.png: the picture a shared recap link shows in
# WhatsApp, iMessage and the rest. Run from the repository root:
#
#   python scripts/make-og-default.py
#
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
im = Image.new('RGB', (W, H), '#141416')
d = ImageDraw.Draw(im)
# the faint dot grid
for y in range(0, H, 24):
    for x in range(0, W, 24):
        d.point((x, y), fill='#1c1c1f')

bold = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 84)
head = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 40)
body = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 30)

# the mark: a ring with a dot at its upper right
cx, cy, r = 150, 250, 56
d.ellipse((cx - r, cy - r, cx + r, cy + r), outline='#f2f2f4', width=16)
d.ellipse((cx + 26, cy - 62, cx + 66, cy - 22), fill='#f2f2f4')
d.text((250, 200), 'Sitca', font=bold, fill='#f2f2f4')

d.text((90, 388), 'Session recap', font=head, fill='#f2f2f4')
d.text((90, 450), 'The recording, the moments that mattered,', font=body, fill='#a3a3aa')
d.text((90, 492), 'and Sitca to ask about any of it.', font=body, fill='#a3a3aa')

im.save('web/public/og-default.png', optimize=True)
print('written web/public/og-default.png')
