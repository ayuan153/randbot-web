import { describe, it, expect } from 'vitest';
import { computeMoveBlock, FEATURE_COUNT, extractFeatures } from './features';

describe('computeMoveBlock parity with Python _move_features', () => {
  /**
   * Ground truth produced by running training/features helpers directly.
   * Python: get_move_type_power, type_effectiveness, get_types, PRIORITY_MOVES, _move_id.
   */

  // Case 0: Dragonite vs Kingambit — exercises priority (Extreme Speed), STAB (Dragon Dance/Roost),
  // status (bp=0), and resisted matchups.
  const case0Expected = [
    0.125, 0.0, 1.0, 0.0, 1.0,           // Dragon Dance: Dragon/0 vs Dark/Steel
    0.5, 0.6666666666666666, 0.0, 0.0, 0.0, // Earthquake: Ground/100 vs Dark/Steel
    0.125, 0.5333333333333333, 0.0, 1.0, 0.0, // Extreme Speed: Normal/80 vs Dark/Steel
    0.125, 0.0, 1.0, 0.0, 1.0,           // Roost: Flying/0 vs Dark/Steel
  ];

  // Case 2: Toxapex vs Great Tusk — exercises Toxic (status+STAB), Surf (super-effective+STAB),
  // Haze (status, Ice vs Ground=super-eff), Recover (status, no STAB).
  const case2Expected = [
    0.5, 0.0, 1.0, 0.0, 0.0,             // Haze: Ice/0 vs Ground/Fighting
    0.25, 0.0, 1.0, 0.0, 0.0,            // Recover: Normal/0 vs Ground/Fighting
    0.5, 0.6, 0.0, 0.0, 1.0,             // Surf: Water/90 vs Ground/Fighting
    0.125, 0.0, 1.0, 0.0, 1.0,           // Toxic: Poison/0 vs Ground/Fighting
  ];

  // Case 3: <4 distinct moves → all zeros
  const case3Expected = new Array(20).fill(0);

  function assertClose(actual: number[], expected: number[]) {
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(Math.abs(actual[i] - expected[i])).toBeLessThan(1e-6);
    }
  }

  it('case 0: Dragonite vs Kingambit', () => {
    const result = computeMoveBlock(
      'Dragonite',
      ['Extreme Speed', 'Earthquake', 'Dragon Dance', 'Roost'],
      'Kingambit',
    );
    assertClose(result, case0Expected);
  });

  // Case 1: Great Tusk vs Gholdengo — now fully correct after regenerating Python tables from @pkmn/data.
  // Headlong Rush = Ground/120, Close Combat = Fighting/120, Rapid Spin = Normal/50, Knock Off = Dark/65.
  // Gholdengo = Steel/Ghost.  Great Tusk = Ground/Fighting.
  const case1Expected = [
    0.0, 0.8, 0.0, 0.0, 1.0,                     // Close Combat: Fighting/120 vs Steel/Ghost → immune=0
    0.5, 0.8, 0.0, 0.0, 1.0,                      // Headlong Rush: Ground/120 vs Steel/Ghost → 2×1=2 → 0.5
    0.5, 0.43333333333333335, 0.0, 0.0, 0.0,      // Knock Off: Dark/65 vs Steel/Ghost → 1×2=2 → 0.5
    0.0, 0.3333333333333333, 0.0, 0.0, 0.0,       // Rapid Spin: Normal/50 vs Steel/Ghost → 1×0=0
  ];

  it('case 1: Great Tusk vs Gholdengo', () => {
    const result = computeMoveBlock(
      'Great Tusk',
      ['Headlong Rush', 'Close Combat', 'Rapid Spin', 'Knock Off'],
      'Gholdengo',
    );
    assertClose(result, case1Expected);
  });

  it('case 2: Toxapex vs Great Tusk', () => {
    const result = computeMoveBlock(
      'Toxapex',
      ['Toxic', 'Recover', 'Haze', 'Surf'],
      'Great Tusk',
    );
    assertClose(result, case2Expected);
  });

  it('case 3: <4 distinct moves returns zeros', () => {
    const result = computeMoveBlock(
      'Toxapex',
      ['Surf', 'Surf', 'Recover'],
      'Great Tusk',
    );
    assertClose(result, case3Expected);
  });
});

describe('FEATURE_COUNT', () => {
  it('equals 265', () => {
    expect(FEATURE_COUNT).toBe(265);
  });
});
