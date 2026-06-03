/**
 * Pure Pokémon Showdown protocol helpers for the ladder client (no I/O, so they
 * are unit-testable). Parsing the |request| JSON, enumerating legal actions,
 * building a /choose command, and reading GXE from the users API.
 */

export interface RequestMove {
  move: string;
  id: string;
  pp: number;
  maxpp?: number;
  target?: string;
  disabled?: boolean;
}

export interface RequestActive {
  moves: RequestMove[];
  canTerastallize?: string | null;
  trapped?: boolean;
  maybeTrapped?: boolean;
}

export interface RequestSidePokemon {
  ident: string;
  details: string;
  condition: string; // "CUR/MAX", "CUR/MAX brn", or "0 fnt"
  active: boolean;
  stats?: Record<string, number>;
  moves?: string[];
  item?: string;
  ability?: string;
  baseAbility?: string;
}

export interface BattleRequest {
  active?: RequestActive[];
  side: { name: string; id: string; pokemon: RequestSidePokemon[] };
  forceSwitch?: boolean[];
  wait?: boolean;
  rqid?: number;
}

/** A Pokémon is fainted when its current HP is 0 (condition "0 fnt"). */
export function isFainted(condition: string): boolean {
  return condition.endsWith(' fnt') || condition === '0 fnt' || condition.split('/')[0].trim() === '0';
}

/** Switch target slots (1-indexed; slot 1 is the active mon) that are legal:
 *  benched (not active) and not fainted. */
export function legalSwitchSlots(req: BattleRequest): number[] {
  return req.side.pokemon
    .map((p, i) => ({ p, slot: i + 1 }))
    .filter(({ p }) => !p.active && !isFainted(p.condition))
    .map(({ slot }) => slot);
}

/** Move slots (1-indexed) that are legal: have PP and are not disabled. */
export function legalMoveSlots(req: BattleRequest): number[] {
  const active = req.active?.[0];
  if (!active) return [];
  return active.moves
    .map((m, i) => ({ m, slot: i + 1 }))
    .filter(({ m }) => !m.disabled && (m.pp === undefined || m.pp > 0))
    .map(({ slot }) => slot);
}

/** Request move indices (0-based) ordered by normalized move id — the canonical
 *  policy action order (matches the replay label extraction in extract_features.py),
 *  so a policy head's move slots 0-3 map back to live request move slots. */
export function policyMoveOrder(req: BattleRequest): number[] {
  const active = req.active?.[0];
  if (!active) return [];
  return active.moves
    .map((m, i) => ({ id: m.id || m.move.toLowerCase().replace(/[^a-z0-9]/g, ''), i }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ i }) => i);
}

/** A chosen action, as the bare argument to |/choose (the client appends rqid). */
export type Choice = string;

/**
 * Default heuristic selector: validates the ladder loop end-to-end before a
 * trained net is wired in (Track 2). Switches when forced; otherwise clicks the
 * first legal move; falls back to `default` (server auto-picks) when stuck.
 */
export function chooseDefault(req: BattleRequest): Choice | null {
  if (req.wait) return null;
  if (req.forceSwitch?.[0]) {
    const slots = legalSwitchSlots(req);
    return slots.length ? `switch ${slots[0]}` : 'default';
  }
  const moves = legalMoveSlots(req);
  if (moves.length) return `move ${moves[0]}`;
  const slots = legalSwitchSlots(req);
  return slots.length ? `switch ${slots[0]}` : 'default';
}

/** Parse the leading-`]`-prefixed JSON the login action server returns. */
export function parseLoginResponse(body: string): { assertion: string } | null {
  const json = body.startsWith(']') ? body.slice(1) : body;
  try {
    const data = JSON.parse(json);
    if (data && typeof data.assertion === 'string' && data.assertion && !data.assertion.startsWith(';')) {
      return { assertion: data.assertion };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export interface LadderRating {
  elo?: number;
  gxe?: number;
  rpr?: number;
  w?: number;
  l?: number;
}

/** Extract the gen9randombattle rating block from a users/<id>.json payload. */
export function parseLadderRating(usersJson: unknown): LadderRating | null {
  const ratings = (usersJson as { ratings?: Record<string, LadderRating> })?.ratings;
  const r = ratings?.['gen9randombattle'];
  if (!r) return null;
  return { elo: r.elo, gxe: r.gxe, rpr: r.rpr, w: r.w, l: r.l };
}
