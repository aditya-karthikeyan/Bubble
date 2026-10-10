import QRCode from 'qrcode';

/** Server-rendered QR code as inline SVG. */
export async function QrCode({ value, label }: { value: string; label: string }) {
  const svg = await QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  return <div role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}
