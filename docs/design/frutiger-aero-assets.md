# Frutiger Aero artwork

The site is styled as a Windows Vista / 7 desktop. Everything is drawn in code, so there are no image assets.

- Desktop (`Desktop` in `apps/web/app/aero.tsx`): layered CSS gradients for the teal sky with lime and cyan glows, plus three SVG layers of aurora ribbons (curtains, horizon sweeps, and the feather bundle). It also has bokeh, sparkles, and small rising bubbles. Ribbon coordinates are percentages of the screen, so the composition holds in portrait and landscape. The layers animate with transforms only.
- Windows (`AeroWindow`): a glass frame with diagonal sheen streaks, a black title with a white glow, Win7 caption buttons (maximize is always disabled, as on a fixed dialog), a white client area, and an optional address-bar row.
- Taskbar (`Taskbar`): dark glass, a start orb that links home, task buttons, and a tray with the clock.
- Arena orbs (`apps/web/src/live/arena.tsx`): soap bubbles with a clear centre, a hue-tinted edge, light pooled at the bottom, and a thin-film rainbow rim. Venues carry a fork-and-knife glyph.

## Typography

Segoe UI where it exists (Windows), and Open Sans everywhere else. Open Sans comes from Google Fonts with display=swap and is by Segoe UI's designer. Large titles use the light weight, as Vista did.
