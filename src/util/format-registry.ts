/**
 * Format registry — extensibility hook for supporting multiple formats/gens.
 *
 * Each format provides:
 * - A sets database (how to look up possible opponent sets)
 * - A scorer (format-specific evaluation weights)
 * - Search config (depth, time limit, branching heuristics)
 *
 * Start with gen9randombattle, but any format can be added by registering a strategy.
 */

import type { EvalConfig, RandbatsSet } from '../types';

export interface SetsDatabase {
  getSets(species: string): RandbatsSet[];
}

export interface Scorer {
  evaluate(state: unknown): number;
}

export interface FormatStrategy {
  getSetsDb(): Promise<SetsDatabase>;
  getScorer(): Scorer;
  getSearchConfig(): EvalConfig;
}

const registry = new Map<string, () => FormatStrategy>();

export function registerFormat(format: string, factory: () => FormatStrategy): void {
  registry.set(format, factory);
}

export function getStrategy(format: string): FormatStrategy | null {
  const factory = registry.get(format);
  return factory ? factory() : null;
}
