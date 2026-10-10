/**
 * Signup: one-time registration that gives a person their bubble number.
 *
 * On Photon Pro a person must be a registered Spectrum user before their bubble can text them,
 * and registration is what assigns their bubble number. The landing page (P4) posts here; the
 * person then texts that number, which sets User.onboardedAt.
 */
import type { CrewDirectory, User } from '@bubbleworks/shared';
import { z } from 'zod';
import { splitName, type PhotonUsers } from './photon-users.js';

export const SignupInput = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'E.164, e.g. +15551234567'),
});
export type SignupInput = z.infer<typeof SignupInput>;

export interface SignupResult {
  user: User;
  /** The number to text. "terminal" when running without Photon. */
  bubbleNumber: string;
  /** sms: deep link that opens Messages to the bubble with a first message ready to send. */
  smsLink: string | null;
}

export async function signup(
  deps: { crews: CrewDirectory; photon: PhotonUsers | null },
  raw: unknown,
): Promise<SignupResult> {
  const input = SignupInput.parse(raw);
  const bubbleNumber = deps.photon
    ? (
        await deps.photon.register({
          ...splitName(input.name),
          email: input.email,
          phone: input.phone,
        })
      ).bubbleNumber
    : 'terminal';

  const existing = await deps.crews.userByHandle(input.phone);
  const user = existing
    ? await deps.crews.updateUser(existing.id, {
        displayName: input.name,
        email: input.email,
        bubbleNumber,
      })
    : await deps.crews.createUser({
        displayName: input.name,
        handle: input.phone,
        email: input.email,
        bubbleNumber,
      });

  // Text only, no link: Apple suppresses links in the first message of a conversation.
  const smsLink = deps.photon
    ? `sms:${bubbleNumber}&body=${encodeURIComponent('hi bubble')}`
    : null;
  return { user, bubbleNumber, smsLink };
}
