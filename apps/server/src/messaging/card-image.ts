/**
 * Plan cards as images: Satori (layout -> SVG) -> resvg (SVG -> PNG) -> sharp (PNG -> JPEG).
 * Glossy, Frutiger Aero look to match the live page. Group-level facts only: venue, time,
 * party size, address, walk time. Never anyone's diet, budget, or location.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import sharp from 'sharp';

export interface TicketData {
  /** "Booked" or "Locked". */
  status: string;
  venueName: string;
  cuisine: string;
  /** "7:30 PM" in the crew's timezone. */
  timeText: string;
  partySize: number;
  address: string | null;
  walkMinutes: number | null;
  backupName?: string | null;
}

const WIDTH = 1080;
const HEIGHT = 1080;

const require = createRequire(import.meta.url);
let fonts: Array<{ name: string; data: Buffer; weight: 400 | 700; style: 'normal' }> | null = null;
function loadFonts() {
  if (fonts) return fonts;
  const file = (weight: number) =>
    readFileSync(require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`));
  fonts = [
    { name: 'Inter', data: file(400), weight: 400, style: 'normal' },
    { name: 'Inter', data: file(700), weight: 700, style: 'normal' },
  ];
  return fonts;
}

type Node = { type: string; props: Record<string, unknown> & { children?: unknown } };
const el = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
  type,
  props: { style: { display: 'flex', ...style }, children },
});

/** A glossy bubble: radial highlight over a soft tinted sphere. */
function bubble(size: number, left: number, top: number, tint: string): Node {
  return el('div', {
    position: 'absolute',
    left,
    top,
    width: size,
    height: size,
    borderRadius: size,
    background: `radial-gradient(circle at 30% 28%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.35) 22%, ${tint} 70%)`,
    border: '3px solid rgba(255,255,255,0.7)',
  });
}

export function ticketTree(t: TicketData): Node {
  const facts = [
    t.timeText,
    `Party of ${t.partySize}`,
    ...(t.walkMinutes !== null ? [`${t.walkMinutes} min walk`] : []),
  ];
  return el(
    'div',
    {
      position: 'relative',
      width: WIDTH,
      height: HEIGHT,
      flexDirection: 'column',
      justifyContent: 'flex-end',
      padding: 80,
      fontFamily: 'Inter',
      color: '#06324a',
      background: 'linear-gradient(160deg, #e9fbff 0%, #a8e4ff 45%, #5cc6f2 100%)',
    },
    [
      bubble(420, 560, -60, 'rgba(120, 214, 255, 0.55)'),
      bubble(220, 120, 170, 'rgba(160, 238, 200, 0.55)'),
      bubble(140, 380, 300, 'rgba(255, 255, 255, 0.45)'),
      el(
        'div',
        {
          position: 'absolute',
          left: 80,
          top: 70,
          fontSize: 34,
          fontWeight: 700,
          color: '#06324a',
          letterSpacing: 1,
        },
        'Bubbleworks',
      ),
      el(
        'div',
        {
          // Satori ignores `bottom` on absolute children, so the card is anchored from the top.
          position: 'absolute',
          left: 80,
          top: t.backupName ? 430 : 470,
          flexDirection: 'column',
          // Satori adds padding outside the width, so subtract it to keep an 80 px margin.
          width: WIDTH - 160 - 112,
          padding: 56,
          borderRadius: 48,
          background: 'rgba(255,255,255,0.78)',
          border: '3px solid rgba(255,255,255,0.95)',
          boxShadow: '0 20px 60px rgba(6,50,74,0.18)',
        },
        [
          el(
            'div',
            { fontSize: 34, fontWeight: 700, letterSpacing: 4, color: '#0a8fc4' },
            t.status.toUpperCase(),
          ),
          el(
            'div',
            { fontSize: 78, fontWeight: 700, marginTop: 12, lineHeight: 1.05 },
            t.venueName,
          ),
          el('div', { fontSize: 36, marginTop: 10, color: '#2a5d75' }, cap(t.cuisine)),
          el(
            'div',
            { fontSize: 44, fontWeight: 700, marginTop: 36, gap: 28, flexWrap: 'wrap' },
            facts.map((f) => el('div', {}, f)),
          ),
          ...(t.address
            ? [el('div', { fontSize: 32, marginTop: 20, color: '#2a5d75' }, t.address)]
            : []),
          ...(t.backupName
            ? [
                el(
                  'div',
                  { fontSize: 28, marginTop: 14, color: '#4f7f94' },
                  `Backup: ${t.backupName}`,
                ),
              ]
            : []),
        ],
      ),
    ],
  );
}

export async function renderTicket(t: TicketData): Promise<Buffer> {
  const svg = await satori(ticketTree(t) as never, {
    width: WIDTH,
    height: HEIGHT,
    fonts: loadFonts(),
  });
  const png = new Resvg(svg).render().asPng();
  return sharp(png).jpeg({ quality: 86 }).toBuffer();
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Straight-line walking estimate at 80 m per minute, rounded up. */
export function walkMinutes(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
  const meters = 2 * r * Math.asin(Math.sqrt(a));
  return Math.max(1, Math.ceil((meters * 1.25) / 80));
}
