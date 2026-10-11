import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { siteUrl } from './site';

export const metadata: Metadata = {
  // Link previews (iMessage, Slack) need absolute image URLs.
  metadataBase: new URL(siteUrl()),
  title: 'Bubbleworks',
  description: 'Text your bubble. It plans dinner with your crew.',
  openGraph: {
    siteName: 'Bubbleworks',
    type: 'website',
    title: 'Get your bubble',
    description: 'A private agent in iMessage that plans dinner with your crew.',
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
