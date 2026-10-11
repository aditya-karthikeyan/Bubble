/**
 * Registers people as Spectrum users. On Photon Pro (shared pool) a person must be a registered
 * user before their bubble can message them; registration assigns their bubble number.
 *
 * API: POST/GET {SPECTRUM_API_URL}/projects/{projectId}/users/ with HTTP Basic auth
 * (project id, project secret). Registering an existing phone updates that user.
 */
import { z } from 'zod';

const PhotonUser = z.object({
  id: z.string(),
  phoneNumber: z.string(),
  firstName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  assignedPhoneNumber: z.string().nullable().optional(),
});

const ListResponse = z.object({
  succeed: z.literal(true),
  data: z.object({ users: z.array(PhotonUser) }),
});

const ErrorResponse = z.object({ succeed: z.literal(false), message: z.string().optional() });

export interface PhotonUsersOptions {
  apiUrl: string;
  projectId: string;
  projectSecret: string;
  fetch?: typeof fetch;
}

export interface RegisterInput {
  firstName: string;
  lastName: string;
  /** Optional on Photon's side. */
  email?: string | null;
  /** E.164. */
  phone: string;
}

export class PhotonUsers {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PhotonUsersOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private get url(): string {
    return `${this.options.apiUrl}/projects/${this.options.projectId}/users/`;
  }

  private get auth(): string {
    const raw = `${this.options.projectId}:${this.options.projectSecret}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  /** Registers (or updates) the person and returns their bubble number. */
  async register(input: RegisterInput): Promise<{ bubbleNumber: string }> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { authorization: this.auth, 'content-type': 'application/json' },
      // Photon Pro users are "shared" (a number from the shared pool). Schema:
      // https://photon.codes/docs/api-reference/users/create-user
      body: JSON.stringify({
        type: 'shared',
        phoneNumber: input.phone,
        firstName: input.firstName,
        lastName: input.lastName,
        ...(input.email ? { email: input.email } : {}),
      }),
    });
    if (!res.ok) {
      const body = ErrorResponse.safeParse(await res.json().catch(() => null));
      throw new Error(
        `Photon user registration failed (${res.status}): ${body.success ? (body.data.message ?? '') : ''}`,
      );
    }
    const bubbleNumber = await this.bubbleNumberFor(input.phone);
    if (!bubbleNumber) throw new Error('Photon registered the user but assigned no bubble number');
    return { bubbleNumber };
  }

  /** Phone -> first name, for scripts that build a crew from registered users. */
  async firstNames(): Promise<Map<string, string>> {
    const res = await this.fetchImpl(this.url, { headers: { authorization: this.auth } });
    if (!res.ok) throw new Error(`Photon user list failed (${res.status})`);
    const body = ListResponse.parse(await res.json());
    return new Map(
      body.data.users.flatMap((u) =>
        u.firstName
          ? [
              [u.phoneNumber, u.firstName] as const,
              ...(u.email ? [[u.email.toLowerCase(), u.firstName] as const] : []),
            ]
          : [],
      ),
    );
  }

  async bubbleNumberFor(phone: string): Promise<string | null> {
    const res = await this.fetchImpl(this.url, { headers: { authorization: this.auth } });
    if (!res.ok) throw new Error(`Photon user list failed (${res.status})`);
    const body = ListResponse.parse(await res.json());
    // A handle is a phone or, for people whose iMessage runs on their Apple ID, an email.
    const handle = phone.toLowerCase();
    return (
      body.data.users.find((u) => u.phoneNumber === phone || u.email?.toLowerCase() === handle)
        ?.assignedPhoneNumber ?? null
    );
  }
}

/** "Ada Lovelace" -> { firstName: "Ada", lastName: "Lovelace" }. Photon requires both. */
export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] ?? name.trim();
  const lastName = parts.slice(1).join(' ') || '-';
  return { firstName, lastName };
}
