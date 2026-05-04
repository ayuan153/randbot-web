// ─── Battle State ───────────────────────────────────────────────

export interface BattleSnapshot {
  roomId: string;
  turn: number;
  format: string;
  player: SideState;
  opponent: SideState;
  field: FieldState;
  availableActions: Action[];
}

export interface SideState {
  active: PokemonState;
  bench: PokemonState[];
}

export interface PokemonState {
  species: string;
  level: number;
  hp: number;
  hpMax: number;
  status: string | null;
  boosts: Record<string, number>;
  moves: string[]; // revealed moves
  item: string | null;
  ability: string | null;
  teraType: string | null;
  terastallized: boolean;
}

export interface FieldState {
  weather: string | null;
  weatherTurns: number;
  terrain: string | null;
  terrainTurns: number;
  playerSide: SideFieldState;
  opponentSide: SideFieldState;
}

export interface SideFieldState {
  spikes: number;
  stealthRock: boolean;
  toxicSpikes: number;
  stickyWeb: boolean;
  reflect: number;
  lightScreen: number;
  auroraVeil: number;
  tailwind: number;
}

// ─── Actions ────────────────────────────────────────────────────

export interface MoveAction {
  type: 'move';
  id: string;
  name: string;
  pp: number;
  maxPp: number;
  target: string;
  disabled: boolean;
}

export interface SwitchAction {
  type: 'switch';
  species: string;
  slot: number;
}

export type Action = MoveAction | SwitchAction;

// ─── Opponent Model ─────────────────────────────────────────────

export interface OpponentModel {
  pokemon: OpponentPokemonModel[];
  unrevealed: number;
}

export interface OpponentPokemonModel {
  species: string;
  possibleSets: WeightedSet[];
  revealedMoves: string[];
  revealedItem: string | null;
  revealedAbility: string | null;
}

export interface RandbatsSet {
  ability: string;
  item: string;
  moves: string[];
  evs: Record<string, number>;
  ivs: Record<string, number>;
  nature: string;
  teraType?: string;
}

export interface WeightedSet {
  set: RandbatsSet;
  probability: number;
}

// ─── Eval Engine ────────────────────────────────────────────────

export interface EvalRequest {
  snapshot: BattleSnapshot;
  opponentModel: OpponentModel;
  config: EvalConfig;
}

export interface EvalConfig {
  depth: number;
  topN: number;
  timeLimitMs: number;
  evalMode: 'heuristic' | 'ml';
}

export interface EvalResult {
  roomId: string;
  turn: number;
  options: ScoredOption[];
  elapsedMs: number;
}

export interface ScoredOption {
  action: Action;
  score: number; // normalized 0–1
  breakdown: ScoreBreakdown;
  principalVariation: string[];
}

export interface ScoreBreakdown {
  damage: number;
  koProbability: number;
  statusValue: number;
  hazardValue: number;
  switchInValue: number;
  speedAdvantage: number;
  positionalScore: number;
}

// ─── Messages ───────────────────────────────────────────────────

export type InjectMessage =
  | { type: 'PS_PROTOCOL_MSG'; roomId: string; raw: string }
  | { type: 'PS_TURN_REQUEST'; snapshot: BattleSnapshot };

export type ExtensionMessage =
  | { type: 'EVAL_REQUEST'; payload: EvalRequest }
  | { type: 'EVAL_RESULT'; payload: EvalResult }
  | { type: 'AUTO_PLAY_CMD'; roomId: string; choice: string };
