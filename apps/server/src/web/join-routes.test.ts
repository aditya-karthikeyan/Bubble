import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@bubbleworks/shared';
import { FakeMessaging } from '@bubbleworks/shared/fakes';
import { buildApp, type App } from '../app.js';
import { RuleExtractor } from '../bubbles/extract.js';
import { DbBubbleService } from '../bubbles/service.js';
import { loadConfig } from '../config.js';
import { signup } from '../messaging/signup.js';
import type { Runtime } from '../runtime.js';
import { testRuntime } from '../test-helpers.js';
import { registerJoinRoutes } from './join-routes.js';

let app: App;
let rt: Runtime;
let messaging: FakeMessaging;
let bubbles: DbBubbleService;

beforeEach(async () => {
  rt = testRuntime();
  messaging = new FakeMessaging({ print: false });
  bubbles = new DbBubbleService({
    db: rt.db,
    crews: rt.crews,
    messaging,
    extractor: new RuleExtractor(),
  });
  app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }),
    replayForToken: (t) => rt.bus.replayForToken(t),
  });
  registerJoinRoutes(app.fastify, {
    crews: rt.crews,
    signup: (raw) => signup({ crews: rt.crews, photon: null }, raw),
    bubbles,
  });
  await app.fastify.ready();
});
afterEach(async () => {
  await app.fastify.close();
  rt.close();
});

const textsTo = (userId: string): string[] =>
  messaging.sent.flatMap((s) =>
    s.kind === 'private_text' && s.input.userId === userId ? [s.input.text] : [],
  );

const postSignup = (body: Record<string, string>) =>
  app.fastify.inject({ method: 'POST', url: '/api/signup', payload: body });

/** A crew of one made by Ana, with its join code. */
async function anasCrew(): Promise<{ ana: User; code: string; crewId: string }> {
  const ana = await rt.crews.createUser({
    displayName: 'Ana',
    handle: '+19195550161',
    bubbleNumber: '+16285550100',
  });
  const crew = await rt.crews.createCrew({
    name: 'the boys',
    createdByUserId: ana.id,
    memberIds: [ana.id],
  });
  return { ana, code: crew.joinCode!, crewId: crew.id };
}

describe('POST /api/signup', () => {
  it('the bubble texts first: one greeting, and a repeat signup sends no second one', async () => {
    const body = { name: 'Dee', email: 'dee@example.com', phone: '+19195550171' };
    const res = await postSignup(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    const dee = (await rt.crews.userByHandle(body.phone))!;
    await vi.waitFor(() => expect(textsTo(dee.id)).toHaveLength(1));
    expect(textsTo(dee.id)[0]).toMatch(
      /^Hey Dee, I'm your bubble 🫧 .*\n\n1\/4 Anything you don't eat/s,
    );

    expect((await postSignup(body)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(textsTo(dee.id)).toHaveLength(1);
  });

  it('through a crew link, the greeting names the crew and the creator hears who joined', async () => {
    const { ana, code } = await anasCrew();
    const res = await postSignup({
      name: 'Eve',
      email: 'eve@example.com',
      phone: '+19195550172',
      crewCode: code,
    });
    expect(res.json()).toMatchObject({ ok: true, crewName: 'the boys' });
    const eve = (await rt.crews.userByHandle('+19195550172'))!;
    await vi.waitFor(() => expect(textsTo(ana.id)).toEqual(['Eve joined the boys.']));
    expect(textsTo(eve.id)).toHaveLength(1);
    expect(textsTo(eve.id)[0]).toMatch(/^Hey Eve, I'm your bubble 🫧 You're in the boys\./);
  });

  it('rejects a bad signup without messaging anyone', async () => {
    const res = await postSignup({ name: 'X', email: 'nope', phone: '555' });
    expect(res.statusCode).toBe(400);
    expect(messaging.sent).toHaveLength(0);
  });
});

describe('POST /api/crews/:code/join', () => {
  it('a known phone joins, hears it from their bubble, and the creator is told', async () => {
    const { ana, code, crewId } = await anasCrew();
    const bo = await rt.crews.createUser({
      displayName: 'Bo',
      handle: '+19195550181',
      bubbleNumber: '+16285550100',
    });
    // Bo finished onboarding earlier.
    for (const [i, text] of ['hi', 'none', '25', 'skip', 'skip'].entries()) {
      await bubbles.onPrivateMessage({
        messageId: `bo${i}`,
        userId: bo.id,
        text,
        at: new Date().toISOString(),
      });
    }
    expect(bubbles.isOnboarded(bo.id)).toBe(true);
    const before = textsTo(bo.id).length;

    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/crews/${code}/join`,
      payload: { phone: bo.handle },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, known: true, crewName: 'the boys' });
    expect((await rt.crews.membersOf(crewId)).map((u) => u.id)).toContain(bo.id);
    await vi.waitFor(() => expect(textsTo(ana.id)).toEqual(['Bo joined the boys.']));
    expect(textsTo(bo.id).slice(before)).toEqual([
      'You\'re in the boys 🫧 Anyone in it can text me "dinner tonight?" to start a plan.',
    ]);
  });

  it('an unknown phone gets known: false and nothing changes', async () => {
    const { code, crewId } = await anasCrew();
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/crews/${code}/join`,
      payload: { phone: '+19195550199' },
    });
    expect(res.json()).toEqual({ ok: true, known: false });
    expect(await rt.crews.membersOf(crewId)).toHaveLength(1);
    expect(messaging.sent).toHaveLength(0);
  });

  it('a bad code is a 404 and a bad phone a 400', async () => {
    const { code } = await anasCrew();
    const missing = await app.fastify.inject({
      method: 'POST',
      url: '/api/crews/nope-0000/join',
      payload: { phone: '+19195550199' },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.fastify.inject({
      method: 'POST',
      url: `/api/crews/${code}/join`,
      payload: { phone: '555' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /join/:code', () => {
  it('offers the phone-only path next to the full signup', async () => {
    const { code } = await anasCrew();
    const res = await app.fastify.inject({ url: `/join/${code}` });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('Join the boys');
    expect(html).toContain('Already have a bubble? Just your number');
    expect(html).toContain('<form id="q"');
    expect(html).toContain('id="qphone"');
    expect(html).toContain("'/api/crews/' + encodeURIComponent(code) + '/join'");
    expect(html).toContain('Your bubble is texting you now.');
    expect(html).toContain('If nothing arrives in a minute, text your bubble.');
  });

  it('has no phone-only form when the code matches no crew', async () => {
    const res = await app.fastify.inject({ url: '/join/nope-0000' });
    expect(res.body).not.toContain('<form id="q"');
  });
});
