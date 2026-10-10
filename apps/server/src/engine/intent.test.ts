import { describe, expect, it } from 'vitest';
import { parseCommand, parseIntent, parseTime } from './intent.js';

const opts = { now: new Date('2026-10-10T20:00:00Z'), timezone: 'America/New_York' };

describe('parseIntent', () => {
  it('defaults to dinner today', () => {
    expect(parseIntent('dinner tonight?', opts)).toMatchObject({
      meal: 'dinner',
      date: '2026-10-10',
      startMinutes: null,
      cuisine: null,
    });
  });
  it('reads tomorrow, a time, and a cuisine', () => {
    expect(parseIntent('tacos tomorrow at 7:30?', opts)).toMatchObject({
      meal: 'dinner',
      date: '2026-10-11',
      startMinutes: 19 * 60 + 30,
      cuisine: 'mexican',
    });
    expect(parseIntent('brunch at 11am', opts)).toMatchObject({
      meal: 'brunch',
      startMinutes: 11 * 60,
    });
    expect(parseIntent('pizza at 8', opts)).toMatchObject({
      cuisine: 'pizza',
      startMinutes: 20 * 60,
    });
  });
  it('does not read counts as times', () => {
    expect(parseTime('table for 4 tonight')).toBeNull();
    expect(parseTime('dinner with 2 friends')).toBeNull();
    expect(parseTime('6pm')).toBe(18 * 60);
  });
});

describe('parseCommand', () => {
  it('maps the five commands and nothing else', () => {
    expect(parseCommand('wait')).toBe('wait');
    expect(parseCommand('Hold on!')).toBe('wait');
    expect(parseCommand('resume')).toBe('resume');
    expect(parseCommand('cancel the plan')).toBe('cancel');
    expect(parseCommand('veto')).toBe('veto');
    expect(parseCommand('why there?')).toBe('why');
    expect(parseCommand("i'm vegetarian btw")).toBeNull();
  });
});
