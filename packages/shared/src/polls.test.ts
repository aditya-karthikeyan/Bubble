import { describe, expect, it } from 'vitest';
import { isPollDecided, tallyChoices } from './polls.js';

describe('isPollDecided', () => {
  it('is undecided with no votes while voters remain', () => {
    expect(isPollDecided({ thai: 0, pizza: 0 }, 3)).toEqual({
      decided: false,
      leader: null,
      margin: 0,
    });
  });
  it('decides when the lead exceeds the votes still out', () => {
    expect(isPollDecided({ thai: 3, pizza: 1 }, 1)).toMatchObject({
      decided: true,
      leader: 'thai',
      margin: 2,
    });
    expect(isPollDecided({ thai: 3, pizza: 1 }, 2)).toMatchObject({
      decided: false,
      leader: 'thai',
    });
    expect(isPollDecided({ thai: 2, pizza: 1 }, 0)).toMatchObject({
      decided: true,
      leader: 'thai',
    });
  });
  it('never decides a tie', () => {
    expect(isPollDecided({ thai: 2, pizza: 2 }, 0)).toMatchObject({ decided: false, leader: null });
  });
  it('tallies per-voter choices once per option', () => {
    expect(
      tallyChoices({ a: ['thai', 'thai'], b: ['pizza'], c: ['nope'] }, ['thai', 'pizza']),
    ).toEqual({ thai: 1, pizza: 1 });
  });
});
