import { describe, expect, it } from 'vitest';
import { detectPlan, parseRsvp, parseStartMinutes, stanceFromEmoji } from './detect.js';

describe('detectPlan', () => {
  it.each([
    ['dinner today?', 'strong', 'dinner'],
    ['anyone down for lunch', 'strong', 'lunch'],
    ['brunch tomorrow at 11?', 'strong', 'brunch'],
    ['lets get drinks tonight', 'strong', 'drinks'],
    ['grab food later?', 'weak', null],
    ['so hungry', 'weak', null],
    ['I already ate dinner lol', 'weak', 'dinner'],
    ['I am vegetarian btw', 'none', null],
    ['how was the midterm', 'none', null],
  ])('%s -> %s', (text, level, meal) => {
    const d = detectPlan(text);
    expect(d.level).toBe(level);
    expect(d.meal).toBe(meal);
  });

  it('reads tomorrow and a start time', () => {
    expect(detectPlan('lunch tomorrow at 1?')).toMatchObject({
      dayOffset: 1,
      startMinutes: 13 * 60,
    });
    expect(detectPlan('dinner at 7:30?').startMinutes).toBe(19 * 60 + 30);
  });
});

describe('parseStartMinutes', () => {
  it('assumes pm for meals without am/pm, except breakfast and brunch', () => {
    expect(parseStartMinutes('at 7', 'dinner')).toBe(19 * 60);
    expect(parseStartMinutes('at 9', 'breakfast')).toBe(9 * 60);
    expect(parseStartMinutes('8pm', null)).toBe(20 * 60);
    expect(parseStartMinutes('12am', null)).toBe(0);
    expect(parseStartMinutes('no time here', 'dinner')).toBeNull();
  });
});

describe('parseRsvp', () => {
  it.each([
    ["I'm in", 'in'],
    ['in', 'in'],
    ["I'm down", 'in'],
    ['down', 'in'],
    ['yes!', 'in'],
    ['count me in', 'in'],
    ["can't tonight", 'out'],
    ["I'm out", 'out'],
    ['nope', 'out'],
    ['busy tonight sorry', 'out'],
    ['not coming', 'out'],
    ['depends what time', 'unclear'],
    ['where?', 'unclear'],
    ['what are we eating', 'unclear'],
    ['are we going to thai?', 'unclear'],
  ])('%s -> %s', (text, stance) => {
    expect(parseRsvp(text)).toBe(stance);
  });

  it('maps tapbacks', () => {
    expect(stanceFromEmoji('👍')).toBe('in');
    expect(stanceFromEmoji('❤️')).toBe('in');
    expect(stanceFromEmoji('👎')).toBe('out');
    expect(stanceFromEmoji('😂')).toBe('unclear');
  });
});
