/**
 * P3 Phase 0 spike: Find My location and Focus state through Photon Advanced iMessage (Pro).
 * Pro has one shared endpoint for every bubble number; the token is minted from the project
 * credentials and lasts about 900 s. Read-only calls need no LINE LOCK.
 */
import { createGrpcClient } from '@photon-ai/advanced-imessage/grpc';
import { cloud } from 'spectrum-ts';

const PRO_ADDRESS = 'imessage.spectrum.photon.codes:443';

export type LocationProbe =
  | {
      ok: true;
      ageSeconds: number | null;
      locationType: string;
      hasCoords: boolean;
      shortAddress: string | null;
      ms: number;
    }
  | { ok: false; reason: string };

export type PresenceProbe =
  { ok: true; focusSilenced: boolean; ms: number } | { ok: false; reason: string };

const errText = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

async function mintToken(): Promise<string> {
  const id = process.env['SPECTRUM_PROJECT_ID'];
  const secret = process.env['SPECTRUM_PROJECT_SECRET'];
  if (!id || !secret) throw new Error('SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET not set');
  const data = await cloud.issueImessageTokens(id, secret);
  if (data.type !== 'shared') throw new Error(`expected a shared iMessage token, got ${data.type}`);
  return data.token;
}

/**
 * `address` is the person's own registered phone (E.164). Find My works once that person
 * shares location with their own bubble number.
 */
export async function probeSignals(
  address: string | undefined,
): Promise<{ location: LocationProbe; presence: PresenceProbe }> {
  if (!address) {
    const reason = 'P3_TEST_ADDRESS not set';
    return { location: { ok: false, reason }, presence: { ok: false, reason } };
  }
  let token: string;
  try {
    token = await mintToken();
  } catch (err) {
    const reason = errText(err);
    return { location: { ok: false, reason }, presence: { ok: false, reason } };
  }
  // Focus checks take 5 to 8 s on Pro, so the spike allows 30 s. Production reads a cache.
  const im = createGrpcClient({ address: PRO_ADDRESS, token, tls: true, timeout: 30_000 });
  try {
    let location: LocationProbe;
    try {
      const t0 = performance.now();
      const loc = await im.locations.get(address);
      const ms = Math.round(performance.now() - t0);
      const ts = loc.locationTimestamp ? new Date(loc.locationTimestamp).getTime() : null;
      location = {
        ok: true,
        ageSeconds: ts === null ? null : Math.round((Date.now() - ts) / 1000),
        locationType: String(loc.locationType),
        hasCoords: loc.latitude !== undefined && loc.longitude !== undefined,
        shortAddress: loc.shortAddress ?? null,
        ms,
      };
    } catch (err) {
      location = { ok: false, reason: errText(err) };
    }

    let presence: PresenceProbe;
    try {
      const t0 = performance.now();
      const focusSilenced = await im.addresses.isFocusSilenced(address);
      presence = { ok: true, focusSilenced, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      presence = { ok: false, reason: errText(err) };
    }
    return { location, presence };
  } finally {
    await im.close();
  }
}
