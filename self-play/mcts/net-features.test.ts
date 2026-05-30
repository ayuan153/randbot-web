import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {describe, it, expect} from 'vitest';
import {extractFeatures20, BattleRequest} from './net-features.ts';

const dir = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(dir, '__fixtures__', 'feature-parity.json'), 'utf8')) as Array<{
  request: BattleRequest;
  oppRequest: BattleRequest;
  turn: number;
  expected: number[];
}>;

describe('extractFeatures20 parity with Python', () => {
  cases.forEach((c, idx) => {
    it(`case ${idx}: turn ${c.turn}`, () => {
      const result = extractFeatures20(c.request, c.oppRequest, c.turn);
      expect(result.length).toBe(20);
      for (let k = 0; k < 20; k++) {
        expect(result[k]).toBeCloseTo(c.expected[k], 5);
      }
    });
  });
});
