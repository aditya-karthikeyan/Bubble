import { describe, expect, it } from 'vitest';
import { miniAppContent } from './transport.js';

describe('miniAppContent', () => {
  it("builds a customized Mini App card on Spectrum's iMessage extension", async () => {
    const content = (await miniAppContent({
      url: 'https://api.bubbleworks.example/t/abc.def',
      caption: 'Booked ✅',
      subcaption: 'Thai Basil',
      trailingCaption: '7:30 PM',
      trailingSubcaption: 'table for 4',
      summary: 'Booked ✅ Thai Basil, 7:30 PM, table for 4',
      image: Buffer.from([0xff, 0xd8, 0xff]),
      imageTitle: 'Thai Basil',
      imageSubtitle: '7:30 PM · party of 4',
    }).build()) as unknown as Record<string, unknown>;
    expect(content).toMatchObject({
      type: 'customized-mini-app',
      __platform: 'imessage',
      appName: 'Bubbleworks',
      teamId: 'P8XT6232SL',
      extensionBundleId: 'codes.photon.Spectrum.MessagesExtension',
      url: 'https://api.bubbleworks.example/t/abc.def',
      live: false,
      layout: {
        caption: 'Booked ✅',
        subcaption: 'Thai Basil',
        trailingCaption: '7:30 PM',
        trailingSubcaption: 'table for 4',
        summary: 'Booked ✅ Thai Basil, 7:30 PM, table for 4',
        imageTitle: 'Thai Basil',
        imageSubtitle: '7:30 PM · party of 4',
      },
    });
    const layout = content['layout'] as { image?: Uint8Array };
    expect([...layout.image!]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('leaves out the image fields when there is no picture', async () => {
    const content = (await miniAppContent({
      url: 'https://api.bubbleworks.example/t/abc.def',
      caption: 'Booked ✅',
      summary: 'Booked ✅ Thai Basil',
    }).build()) as unknown as { layout: Record<string, unknown> };
    expect(content.layout).toEqual({ caption: 'Booked ✅', summary: 'Booked ✅ Thai Basil' });
  });
});
