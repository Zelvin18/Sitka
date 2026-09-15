# Rebuilds src/shared/placeholders.ts: a tiny blurred version of every
# photograph on the site, carried inside the code so the space a picture will
# take is filled the instant the page draws. Run after changing any picture:
#
#   cd web/public ; python ../../scripts/make-placeholders.py
#
from PIL import Image, ImageFilter
import base64, io, json, os

NAMES = ['sitka1', 'sitka2', 'sitka3', 'coach-hero', 'events-hero', 'join-hero', 'business-hero', 'education-hero', 'library-empty', 'signin', 'setup-hero']
out = {}
for n in NAMES:
    src = next((n + ext for ext in ('.png', '.jpeg', '.jpg', '.webp') if os.path.exists(n + ext)), None)
    if not src:
        print('missing', n)
        continue
    im = Image.open(src).convert('RGB')
    w = 32
    small = im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))
    buf = io.BytesIO()
    small.save(buf, 'JPEG', quality=38, optimize=True)
    out[n] = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    print(n, small.size, len(out[n]), 'chars')

header = """/**
 * The first glimpse of every photograph on the site: a thumbnail a few
 * dozen pixels wide, carried inside the code itself, blurred up to fill the
 * space the real picture will take. It is on screen the instant the words
 * are, so a page never draws with a hole in it, and the full picture fades
 * in over it a moment later. Made by scripts/make-placeholders.py; run it
 * again when a picture changes.
 */
export const PLACEHOLDERS: Record<string, string> = """
open('../../src/shared/placeholders.ts', 'w', encoding='utf-8', newline='\n').write(header + json.dumps(out, indent=2) + '\n')
print('written', sum(len(v) for v in out.values()), 'chars')
