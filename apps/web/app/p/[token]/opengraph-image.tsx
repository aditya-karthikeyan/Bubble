import { OG_SIZE, previewImage } from '../../../src/og/preview';

export const alt = 'Bubbleworks: your crew is planning dinner, live';
export const size = OG_SIZE;
export const contentType = 'image/png';

/** The card iMessage shows when a bubble drops a plan's live link. */
export default function Image() {
  return previewImage({
    title: 'Your crew is planning dinner',
    subtitle: 'Watch the bubbles decide, live.',
    badge: 'LIVE',
    live: true,
  });
}
