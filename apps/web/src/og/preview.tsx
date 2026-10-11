/**
 * Link-preview cards (Open Graph, 1200 x 630). iMessage renders these when the bubble drops a
 * plan link or someone shares the landing page. Same look as the site: a Vista aurora desktop,
 * an Aero glass window with the message, soap bubbles drifting into the crew bubble, and the
 * taskbar. Rendered by next/og (Satori), so every element with more than one child is a flex
 * box and styling stays inline.
 */
import { ImageResponse } from 'next/og';

export const OG_SIZE = { width: 1200, height: 630 };

const INSTRUCTION = '#1b3f8f';
const ORB =
  'radial-gradient(ellipse 70% 46% at 50% 20%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.2) 64%, rgba(255,255,255,0) 66%), radial-gradient(circle at 50% 88%, #b8fbff 0%, #2ec2e0 45%, #0d7fb6 80%, #0a5f96 100%)';

/** A clear soap bubble: tinted edge, glossy cap, light pooled at the bottom. */
function Bubble({
  x,
  y,
  r,
  tint = '170,240,255',
}: {
  x: number;
  y: number;
  r: number;
  tint?: string;
}) {
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
        border: `${Math.max(2, Math.round(r / 40))}px solid rgba(255,255,255,0.82)`,
        backgroundImage: `radial-gradient(circle at 50% 50%, rgba(${tint},0.05) 50%, rgba(${tint},0.28) 76%, rgba(255,255,255,0.6) 98%)`,
        boxShadow: '0 18px 40px rgba(0, 30, 50, 0.22)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: r * 0.32,
          top: r * 0.14,
          width: r * 1.36,
          height: r * 0.7,
          borderRadius: r,
          backgroundImage:
            'linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.04) 100%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: r * 0.5,
          top: r * 1.25,
          width: r,
          height: r * 0.55,
          borderRadius: r,
          backgroundImage:
            'radial-gradient(ellipse at center, rgba(200,255,230,0.6) 0%, rgba(200,255,230,0) 70%)',
        }}
      />
    </div>
  );
}

/** One soft light ribbon of the aurora. */
function Streak({
  x,
  y,
  w,
  h,
  angle,
  color,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  color: string;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: h,
        transform: `rotate(${angle}deg)`,
        backgroundImage: `linear-gradient(90deg, rgba(255,255,255,0) 0%, ${color} 45%, rgba(255,255,255,0) 100%)`,
      }}
    />
  );
}

/** A caption button with its glyph: a bar, a box, or a cross. */
function Cap({ w, kind }: { w: number; kind: 'min' | 'max' | 'close' }) {
  const close = kind === 'close';
  const line = (style: Record<string, string | number>) => (
    <div
      style={{
        position: 'absolute',
        display: 'flex',
        backgroundColor: '#fff',
        boxShadow: '0 0 2px rgba(10,20,40,0.8)',
        ...style,
      }}
    />
  );
  return (
    <div
      style={{
        position: 'relative',
        width: w,
        height: 26,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid rgba(16,34,58,0.68)',
        borderTop: '0px solid transparent',
        backgroundImage: close
          ? 'linear-gradient(180deg, #f3c0b0 0%, #e58b72 45%, #cf4b2c 50%, #d8603f 78%, #f0a283 100%)'
          : 'linear-gradient(180deg, rgba(255,255,255,0.8) 0%, rgba(214,232,247,0.6) 45%, rgba(160,194,224,0.6) 50%, rgba(196,224,246,0.75) 100%)',
      }}
    >
      {kind === 'min' && line({ width: 12, height: 3, top: 16, left: (w - 12) / 2 })}
      {kind === 'max' && (
        <div
          style={{
            position: 'absolute',
            display: 'flex',
            width: 13,
            height: 10,
            top: 8,
            left: (w - 13) / 2,
            border: '2px solid #fff',
            borderTopWidth: 3,
            opacity: 0.6,
          }}
        />
      )}
      {close &&
        line({ width: 16, height: 3, top: 11, left: (w - 16) / 2, transform: 'rotate(45deg)' })}
      {close &&
        line({ width: 16, height: 3, top: 11, left: (w - 16) / 2, transform: 'rotate(-45deg)' })}
    </div>
  );
}

const fonts = new Map<number, ArrayBuffer | null>();

/** Open Sans (by Segoe UI's designer) from Google Fonts, cached; null falls back. */
async function openSans(weight: number): Promise<ArrayBuffer | null> {
  if (fonts.has(weight)) return fonts.get(weight)!;
  let data: ArrayBuffer | null;
  try {
    const css = await (
      await fetch(`https://fonts.googleapis.com/css2?family=Open+Sans:wght@${weight}`, {
        signal: AbortSignal.timeout(3000),
      })
    ).text();
    const url = /src:\s*url\(([^)]+)\)\s*format\('(?:opentype|truetype)'\)/.exec(css)?.[1];
    data = url
      ? await (await fetch(url, { signal: AbortSignal.timeout(3000) })).arrayBuffer()
      : null;
  } catch {
    data = null;
  }
  fonts.set(weight, data);
  return data;
}

export async function previewImage(copy: {
  title: string;
  subtitle: string;
  badge: string;
  live: boolean;
}) {
  const [regular, semibold] = await Promise.all([openSans(400), openSans(600)]);
  const loaded = [
    ...(regular
      ? [{ name: 'Open Sans', data: regular, weight: 400 as const, style: 'normal' as const }]
      : []),
    ...(semibold
      ? [{ name: 'Open Sans', data: semibold, weight: 600 as const, style: 'normal' as const }]
      : []),
  ];
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: loaded.length ? 'Open Sans' : undefined,
        backgroundImage: [
          'radial-gradient(ellipse 55% 45% at 0% 100%, #eef99a 0%, #bfe979 30%, rgba(170,225,120,0) 72%)',
          'radial-gradient(ellipse 60% 50% at 100% 95%, #c2fcff 0%, #63d6ef 32%, rgba(80,190,230,0) 72%)',
          'radial-gradient(ellipse 45% 7% at 40% 88%, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 72%)',
          'radial-gradient(ellipse 70% 60% at 100% 40%, rgba(86,160,214,0.9) 0%, rgba(86,160,214,0) 70%)',
          'linear-gradient(180deg, #275d6c 0%, #2c6677 34%, #387d92 60%, #58a5b6 80%, #93d6c6 100%)',
        ].join(', '),
      }}
    >
      {/* Aurora ribbons. */}
      <Streak x={-200} y={430} w={1700} h={10} angle={-5} color="rgba(240,255,190,0.55)" />
      <Streak x={-200} y={470} w={1700} h={4} angle={-4} color="rgba(255,255,255,0.7)" />
      <Streak x={-200} y={510} w={1700} h={14} angle={-7} color="rgba(160,245,255,0.45)" />
      <Streak x={520} y={250} w={900} h={5} angle={-38} color="rgba(210,255,140,0.75)" />
      <Streak x={540} y={262} w={900} h={3} angle={-37} color="rgba(170,240,255,0.8)" />
      <Streak x={560} y={274} w={900} h={2} angle={-36} color="rgba(220,255,170,0.7)" />

      {/* The crew drifting into one bubble. */}
      <Bubble x={940} y={300} r={150} />
      <Bubble x={736} y={150} r={40} />
      <Bubble x={720} y={470} r={52} />
      <Bubble x={1120} y={120} r={34} tint="210,255,140" />
      <Bubble x={1110} y={500} r={44} />

      {/* The Aero window with the message. */}
      <div
        style={{
          position: 'absolute',
          left: 56,
          top: 92,
          width: 600,
          display: 'flex',
          flexDirection: 'column',
          padding: '0 9px 9px',
          borderRadius: 12,
          border: '1px solid rgba(10,30,50,0.62)',
          backgroundImage:
            'linear-gradient(180deg, rgba(226,243,252,0.92) 0%, rgba(176,214,238,0.85) 18%, rgba(150,197,229,0.82) 100%)',
          boxShadow: '0 24px 60px rgba(2,22,38,0.45)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', height: 50 }}>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              border: '1px solid rgba(4,60,100,0.6)',
              backgroundImage: ORB,
              display: 'flex',
            }}
          />
          <div
            style={{
              marginLeft: 12,
              fontSize: 22,
              color: '#000',
              textShadow: '0 0 10px #fff, 0 0 10px #fff',
              display: 'flex',
            }}
          >
            {copy.live ? 'Bubbleworks · Live plan' : 'Bubbleworks'}
          </div>
          <div style={{ display: 'flex', marginLeft: 'auto', alignSelf: 'flex-start' }}>
            <Cap w={40} kind="min" />
            <Cap w={38} kind="max" />
            <Cap w={66} kind="close" />
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            padding: '30px 30px 32px',
            backgroundColor: '#ffffff',
            border: '1px solid rgba(20,40,62,0.55)',
            borderRadius: 3,
          }}
        >
          <div
            style={{
              width: 78,
              height: 78,
              flexShrink: 0,
              borderRadius: 39,
              border: '2px solid #0b2f7a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 48,
              fontWeight: 600,
              color: '#fff',
              backgroundImage:
                'radial-gradient(ellipse 72% 48% at 50% 16%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.26) 62%, rgba(255,255,255,0) 64%), radial-gradient(circle at 50% 88%, #8fd0ff 0%, #2a68d8 55%, #143a96 100%)',
            }}
          >
            i
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              marginLeft: 26,
              flex: 1,
              minWidth: 0,
            }}
          >
            <div
              style={{
                fontSize: 44,
                lineHeight: 1.15,
                color: INSTRUCTION,
                display: 'flex',
                flexWrap: 'wrap',
              }}
            >
              {copy.title}
            </div>
            <div
              style={{
                fontSize: 27,
                lineHeight: 1.35,
                color: '#4a5a66',
                marginTop: 12,
                display: 'flex',
              }}
            >
              {copy.subtitle}
            </div>
            <div
              style={{
                marginTop: 26,
                display: 'flex',
                alignItems: 'center',
                alignSelf: 'flex-start',
                padding: '9px 22px',
                borderRadius: 10,
                border: '1px solid #0567a3',
                backgroundImage:
                  'linear-gradient(180deg, #7fe3f2 0%, #2fbbe0 46%, #0096c8 50%, #0084be 84%, #19addb 100%)',
                fontSize: 24,
                fontWeight: 600,
                color: '#fff',
              }}
            >
              {copy.live && (
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 7,
                    marginRight: 12,
                    backgroundColor: '#8dff6a',
                    boxShadow: '0 0 8px #b6ff8a',
                    display: 'flex',
                  }}
                />
              )}
              {copy.badge}
            </div>
          </div>
        </div>
      </div>

      {/* Taskbar with the start orb. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 52,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 82,
          borderTop: '1px solid rgba(255,255,255,0.5)',
          backgroundImage:
            'linear-gradient(180deg, rgba(60,96,124,0.85) 0%, rgba(32,64,90,0.85) 50%, rgba(18,48,74,0.9) 51%, rgba(22,54,80,0.9) 100%)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 40,
            padding: '0 18px',
            borderRadius: 5,
            border: '1px solid rgba(0,0,0,0.45)',
            backgroundImage:
              'linear-gradient(180deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.15) 48%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.22) 100%)',
            fontSize: 20,
            color: '#fff',
          }}
        >
          bubbleworks
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 12,
          bottom: 2,
          width: 60,
          height: 60,
          borderRadius: 30,
          border: '2px solid rgba(0,20,40,0.75)',
          backgroundImage: ORB,
          display: 'flex',
        }}
      />
    </div>,
    { ...OG_SIZE, ...(loaded.length ? { fonts: loaded } : {}) },
  );
}
