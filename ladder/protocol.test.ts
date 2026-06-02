import { describe, it, expect } from 'vitest';
import {
  isFainted, legalSwitchSlots, legalMoveSlots, policyMoveOrder, chooseDefault,
  parseLoginResponse, parseLadderRating, type BattleRequest,
} from './protocol';

const req = (over: Partial<BattleRequest> = {}): BattleRequest => ({
  side: {
    name: 'Bot', id: 'p1', pokemon: [
      { ident: 'p1: A', details: 'A', condition: '100/100', active: true },
      { ident: 'p1: B', details: 'B', condition: '80/100', active: false },
      { ident: 'p1: C', details: 'C', condition: '0 fnt', active: false },
    ],
  },
  active: [{ moves: [
    { move: 'Thunderbolt', id: 'thunderbolt', pp: 24 },
    { move: 'Volt Switch', id: 'voltswitch', pp: 0 },
    { move: 'Surf', id: 'surf', pp: 16, disabled: true },
    { move: 'Ice Beam', id: 'icebeam', pp: 8 },
  ] }],
  rqid: 7,
  ...over,
});

describe('ladder protocol', () => {
  it('detects fainted from condition', () => {
    expect(isFainted('0 fnt')).toBe(true);
    expect(isFainted('100/100')).toBe(false);
    expect(isFainted('45/200 brn')).toBe(false);
  });

  it('enumerates legal switch slots (benched, not fainted)', () => {
    expect(legalSwitchSlots(req())).toEqual([2]); // slot1 active, slot3 fainted
  });

  it('enumerates legal move slots (pp>0, not disabled)', () => {
    expect(legalMoveSlots(req())).toEqual([1, 4]); // voltswitch pp0, surf disabled
  });

  it('orders policy move slots by normalized id', () => {
    // icebeam, surf, thunderbolt, voltswitch -> request indices 3,2,0,1
    expect(policyMoveOrder(req())).toEqual([3, 2, 0, 1]);
  });

  it('chooseDefault clicks first legal move', () => {
    expect(chooseDefault(req())).toBe('move 1');
  });

  it('chooseDefault switches when forced', () => {
    expect(chooseDefault(req({ forceSwitch: [true] }))).toBe('switch 2');
  });

  it('chooseDefault returns null on wait', () => {
    expect(chooseDefault(req({ wait: true }))).toBeNull();
  });

  it('parses login response with leading ]', () => {
    expect(parseLoginResponse(']{"assertion":"abc","actionsuccess":true}')).toEqual({ assertion: 'abc' });
    expect(parseLoginResponse(']{"assertion":""}')).toBeNull();
    expect(parseLoginResponse(']{"assertion":";;error"}')).toBeNull();
  });

  it('parses gen9randombattle ladder rating', () => {
    const r = parseLadderRating({ ratings: { gen9randombattle: { elo: 1500, gxe: 73.3, rpr: 1696, w: 42, l: 18 } } });
    expect(r).toEqual({ elo: 1500, gxe: 73.3, rpr: 1696, w: 42, l: 18 });
    expect(parseLadderRating({ ratings: {} })).toBeNull();
  });
});
