/**
 * Link-preview cards (Open Graph, 1200 x 630). iMessage renders these when the bubble drops a
 * plan link or someone shares the landing page: glossy glass bubbles drifting into a green
 * consensus bubble, the same look as the live page. Rendered by next/og (Satori), so every
 * element with more than one child is a flex box and styling stays inline.
 */
import { ImageResponse } from 'next/og';

export const OG_SIZE = { width: 1200, height: 630 };

type Hue = 'fits' | 'stretch' | 'rep' | 'done';

const HUES: Record<Hue, [string, string, string]> = {
  fits: ['#d6f1ff', '#43a9f0', '#1468b8'],
  stretch: ['#fff0d2', '#f5ad45', '#c06a10'],
  rep: ['#ede5ff', '#9e8be6', '#5a45b0'],
  done: ['#e2fff0', '#36c278', '#147a45'],
};

function Orb({ x, y, r, hue }: { x: number; y: number; r: number; hue: Hue }) {
  const [hi, mid, lo] = HUES[hue];
  return (
    <div
      style={{
        position: 'absolute',
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        display: 'flex',
        backgroundImage: `radial-gradient(circle at 36% 30%, ${hi} 0%, ${mid} 50%, ${lo} 100%)`,
        border: `${Math.max(2, Math.round(r / 22))}px solid rgba(255,255,255,0.85)`,
        boxShadow: '0 18px 44px rgba(10, 70, 120, 0.28)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: r * 0.3,
          top: r * 0.2,
          width: r * 0.8,
          height: r * 0.48,
          borderRadius: r,
          backgroundImage:
            'radial-gradient(ellipse at center, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0) 70%)',
        }}
      />
    </div>
  );
}

function Bokeh({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        backgroundImage:
          'radial-gradient(circle at 38% 38%, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 70%)',
      }}
    />
  );
}

let nunito: ArrayBuffer | null | undefined;

/** Nunito ExtraBold from Google Fonts, cached; null falls back to the built-in font. */
async function loadNunito(): Promise<ArrayBuffer | null> {
  if (nunito !== undefined) return nunito;
  try {
    const css = await (
      await fetch('https://fonts.googleapis.com/css2?family=Nunito:wght@800', {
        signal: AbortSignal.timeout(3000),
      })
    ).text();
    const url = /src:\s*url\(([^)]+)\)\s*format\('(?:opentype|truetype)'\)/.exec(css)?.[1];
    nunito = url
      ? await (await fetch(url, { signal: AbortSignal.timeout(3000) })).arrayBuffer()
      : null;
  } catch {
    nunito = null;
  }
  return nunito;
}

export async function previewImage(copy: {
  title: string;
  subtitle: string;
  badge: string;
  live: boolean;
}) {
  const font = await loadNunito();
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        backgroundImage: 'linear-gradient(180deg, #8fd3ff 0%, #d9f2ff 58%, #b8ecd9 100%)',
        fontFamily: font ? 'Nunito' : undefined,
      }}
    >
      <Bokeh x={140} y={110} r={120} />
      <Bokeh x={1120} y={70} r={90} />
      <Bokeh x={980} y={600} r={170} />
      <Bokeh x={420} y={590} r={110} />

      {/* The crew drifting into the consensus bubble. */}
      <Orb x={880} y={318} r={160} hue="done" />
      <Orb x={640} y={176} r={44} hue="rep" />
      <Orb x={600} y={468} r={54} hue="fits" />
      <Orb x={712} y={548} r={34} hue="stretch" />
      <Orb x={1102} y={150} r={40} hue="fits" />
      <Orb x={1110} y={498} r={48} hue="fits" />

      <div
        style={{
          position: 'absolute',
          left: 72,
          top: 120,
          width: 520,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ fontSize: 26, letterSpacing: 4, color: '#2a6f97', display: 'flex' }}>
          BUBBLEWORKS
        </div>
        <div
          style={{
            fontSize: 66,
            lineHeight: 1.05,
            color: '#0b2a3d',
            marginTop: 18,
            display: 'flex',
          }}
        >
          {copy.title}
        </div>
        <div
          style={{
            fontSize: 32,
            lineHeight: 1.3,
            color: '#3d6178',
            marginTop: 22,
            display: 'flex',
          }}
        >
          {copy.subtitle}
        </div>
        <div
          style={{
            marginTop: 34,
            display: 'flex',
            alignItems: 'center',
            alignSelf: 'flex-start',
            padding: '10px 22px',
            borderRadius: 999,
            backgroundColor: 'rgba(255,255,255,0.7)',
            border: '2px solid rgba(255,255,255,0.95)',
            fontSize: 26,
            color: '#0b2a3d',
          }}
        >
          {copy.live && (
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                backgroundColor: '#2fb37a',
                marginRight: 12,
                display: 'flex',
              }}
            />
          )}
          {copy.badge}
        </div>
      </div>
    </div>,
    {
      ...OG_SIZE,
      ...(font
        ? {
            fonts: [{ name: 'Nunito', data: font, weight: 800 as const, style: 'normal' as const }],
          }
        : {}),
    },
  );
}
