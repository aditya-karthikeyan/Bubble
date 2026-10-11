import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Bubbleworks',
  description: 'Watch your crew’s bubbles plan dinner, live.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          background: '#eaf6ff',
          color: '#0b2a3d',
        }}
      >
        {children}
      </body>
    </html>
  );
}
