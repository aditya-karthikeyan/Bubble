'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/** QR code rendered in the browser, for values only known after a client action. */
export function ClientQr({ value, label }: { value: string; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then((s) => {
      if (live) setSvg(s);
    });
    return () => {
      live = false;
    };
  }, [value]);
  return svg ? (
    <div role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />
  ) : null;
}
