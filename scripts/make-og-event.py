# Draws web/public/og-event.png: the picture a shared event link shows in
# WhatsApp, iMessage and the rest, in the style of og-default.png but saying
# what an event link is for: come and join. Run from the repository root:
#
#   python scripts/make-og-event.py
#
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
im = Image.new('RGB', (W, H), '#141416')
d = ImageDraw.Draw(im)
# the faint dot grid of the default picture
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
d.text((250, 200), 'Sitka', font=bold, fill='#f2f2f4')

d.text((90, 388), "You're invited to a live event", font=head, fill='#f2f2f4')
d.text((90, 450), 'Tap to join: every word in your language, the speaker\'s screen,', font=body, fill='#a3a3aa')
d.text((90, 492), 'and your own questions answered privately.', font=body, fill='#a3a3aa')
# a small live pill at the top right
d.rounded_rectangle((1020, 64, 1120, 106), radius=21, outline='#3a3a40', width=2)
d.ellipse((1040, 78, 1054, 92), fill='#e0655a')
d.text((1064, 70), 'LIVE', font=ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 22), fill='#f2f2f4')

im.save('web/public/og-event.png', optimize=True)
print('written web/public/og-event.png')
