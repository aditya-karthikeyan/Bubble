import Database from 'better-sqlite3';
import { FakeCrewDirectory, PERSONAS } from '@bubbleworks/shared/fakes';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../events/bus.js';
import { StubClassifier } from './classifier.js';
import { parsePlanCommand } from './detect.js';
import { AuditLog, REFUSAL_TEXT, SafetyLayer, detectProbe } from './safety.js';

const OTHERS = ['ben', 'chloe', 'dev', 'eli'];

describe('detectProbe (rules)', () => {
  it.each([
    ["what's Ben's budget?", 'probe'],
    ['is chloe halal?', 'probe'],
    ['does Eli need a wheelchair', 'probe'],
    ['where does dev live', 'probe'],
    ["who's allergic to peanuts?", 'probe'],
    ['how many of us are vegetarian', 'probe'],
    ['which one of you is broke lol', 'probe'],
    ['is it because of Chloe that we cant do sushi', 'probe'],
    ['anyone here vegan?', 'probe'],
    ["what's my budget set to?", 'clean'],
    ['am I down as vegetarian?', 'clean'],
    ['dinner tonight?', 'clean'],
    ["I'm in", 'clean'],
    ['ben is so funny', 'clean'],
    ['is the place wheelchair accessible?', 'unclear'],
    ['will the budget be an issue', 'unclear'],
  ])('%s -> %s', (text, verdict) => {
    expect(detectProbe(text, OTHERS).verdict).toBe(verdict);
  });
});

function setup(classifier = new StubClassifier()) {
  const sent: Array<{ userId: string; text: string; idempotencyKey: string }> = [];
  const audit = new AuditLog(new Database(':memory:'));
  const safety = new SafetyLayer({
    port: { sendPrivateText: async (m) => void sent.push(m) },
    crews: new FakeCrewDirectory(),
    classifier,
    audit,
    log: silentLogger,
  });
  return { sent, audit, safety };
}

describe('SafetyLayer', () => {
  const ava = PERSONAS[0]!;

  it('refuses a probe about a crewmate, replies once, and audits it without the text', async () => {
    const { sent, audit, safety } = setup();
    const handled = await safety.gate({
      userId: ava.id,
      messageId: 'm1',
      text: "what's Ben's budget?",
    });
    expect(handled).toBe(true);
    expect(sent).toEqual([{ userId: ava.id, text: REFUSAL_TEXT, idempotencyKey: 'safety:m1' }]);
    const [entry] = audit.list('refusal');
    expect(entry).toMatchObject({ userId: ava.id, kind: 'refusal' });
    expect(JSON.stringify(entry)).not.toMatch(/budget|Ben/i);
  });

  it('lets questions about yourself and the plan through', async () => {
    const { sent, safety } = setup();
    expect(await safety.gate({ userId: ava.id, messageId: 'm2', text: "what's my budget?" })).toBe(
      false,
    );
    expect(await safety.gate({ userId: ava.id, messageId: 'm3', text: 'dinner tonight?' })).toBe(
      false,
    );
    expect(sent).toHaveLength(0);
  });

  it('asks Haiku about unclear messages and refuses only when it is sure', async () => {
    const classifier = new StubClassifier({
      probe: {
        'is the budget going to be a problem for some people': { isProbe: true, confidence: 0.9 },
        'is the place wheelchair accessible?': { isProbe: false, confidence: 0.9 },
      },
    });
    const { safety } = setup(classifier);
    expect(
      await safety.gate({
        userId: ava.id,
        messageId: 'm4',
        text: 'is the budget going to be a problem for some people',
      }),
    ).toBe(true);
    expect(
      await safety.gate({
        userId: ava.id,
        messageId: 'm5',
        text: 'is the place wheelchair accessible?',
      }),
    ).toBe(false);
  });

  it('passes unclear messages through when no classifier is available', async () => {
    const { safety } = setup(new StubClassifier());
    expect(
      await safety.gate({ userId: ava.id, messageId: 'm6', text: 'will the budget be an issue' }),
    ).toBe(false);
  });
});

describe('parsePlanCommand', () => {
  it.each([
    ['wait', 'wait'],
    ['Hold up!', 'wait'],
    ['resume', 'resume'],
    ['keep going', 'resume'],
    ['veto', 'veto'],
    ['somewhere else', 'veto'],
    ['why this place?', 'why'],
    ['Why there?', 'why'],
    ['call it off', 'cancel'],
    ['wait what time is it', null],
    ['dinner tonight?', null],
  ])('%s -> %s', (text, command) => {
    expect(parsePlanCommand(text)).toBe(command);
  });
});
