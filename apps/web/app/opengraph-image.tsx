import { OG_SIZE, previewImage } from '../src/og/preview';

export const alt = 'Bubbleworks: get your bubble';
export const size = OG_SIZE;
export const contentType = 'image/png';

/** The card for the landing page and the QR poster. */
export default function Image() {
  return previewImage({
    title: 'Get your bubble',
    subtitle: 'A private agent in iMessage that plans dinner with your crew.',
    badge: 'Text it on iMessage',
    live: false,
  });
}
