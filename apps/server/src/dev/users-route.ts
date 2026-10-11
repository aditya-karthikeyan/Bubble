/**
 * Dev-only people view for rehearsals: every user with their crews and facts, and one user with
 * their bubble state. Registered from registerDevRoutes, so the x-dev-secret hook guards it.
 * Fact values are exposed on purpose; this never runs without DEV_ROUTES_SECRET.
 */
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { bubbleState, facts, users } from '../db/schema.js';
import type { Runtime } from '../runtime.js';

type UserRow = typeof users.$inferSelect;

async function describeUser(runtime: Runtime, user: UserRow) {
  const crews = await runtime.crews.crewsOf(user.id);
  const crewViews = await Promise.all(
    crews.map(async (c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      joinCode: c.joinCode ?? null,
      members: (await runtime.crews.membersOf(c.id)).map((m) => ({
        id: m.id,
        displayName: m.displayName,
      })),
    })),
  );
  const factRows = runtime.db
    .select({
      id: facts.id,
      type: facts.type,
      value: facts.value,
      hard: facts.hard,
      confirmed: facts.confirmed,
      source: facts.source,
      expiresAt: facts.expiresAt,
    })
    .from(facts)
    .where(eq(facts.userId, user.id))
    .orderBy(asc(facts.createdAt))
    .all();
  return {
    id: user.id,
    displayName: user.displayName,
    handle: user.handle,
    bubbleNumber: user.bubbleNumber,
    onboardedAt: user.onboardedAt,
    crews: crewViews,
    facts: factRows,
  };
}

export function registerDevUserRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.get('/api/dev/users', async () => {
    const rows = runtime.db.select().from(users).orderBy(asc(users.createdAt)).all();
    return { ok: true, users: await Promise.all(rows.map((u) => describeUser(runtime, u))) };
  });

  app.get<{ Params: { userId: string } }>('/api/dev/users/:userId', async (request, reply) => {
    const user = runtime.db.select().from(users).where(eq(users.id, request.params.userId)).get();
    if (!user) return reply.code(404).send({ ok: false, error: 'no such user' });
    const state = runtime.db
      .select()
      .from(bubbleState)
      .where(eq(bubbleState.userId, user.id))
      .get();
    return {
      ok: true,
      user: {
        ...(await describeUser(runtime, user)),
        bubble: state
          ? {
              onboardingStep: state.onboardingStep,
              onboardingStartedAt: state.onboardingStartedAt,
              onboardingCompletedAt: state.onboardingCompletedAt,
              pending: state.pending,
              presence: state.presence,
              presenceUntil: state.presenceUntil,
              pin:
                state.pinLat !== null && state.pinLng !== null
                  ? { lat: state.pinLat, lng: state.pinLng, at: state.pinAt }
                  : null,
              updatedAt: state.updatedAt,
            }
          : null,
      },
    };
  });
}
