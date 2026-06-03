/**
 * Protocol state accumulator: consumes PS protocol lines and builds BattleSnapshot.
 */
import type { BattleSnapshot, PokemonState, SideFieldState, FieldState, Action, OpponentModel } from '../src/types';
import type { BattleRequest } from './protocol';
import { isFainted, legalMoveSlots, legalSwitchSlots } from './protocol';
import { parseCondition, parseDetails } from '../src/state/snapshot';
import { getSetsForSpecies, getLevelForSpecies } from '../src/state/sets-db';
import { createOpponentModel, revealPokemon, revealMove, revealItem, revealAbility } from '../src/eval/opponent-model';
import { toID } from '../src/util/id';

interface TrackedMon {
  species: string;
  level: number;
  hp: number;
  hpMax: number;
  status: string | null;
  boosts: Record<string, number>;
  moves: string[];
  item: string | null;
  ability: string | null;
}

function emptyField(): SideFieldState {
  return { spikes: 0, stealthRock: false, toxicSpikes: 0, stickyWeb: false, reflect: 0, lightScreen: 0, auroraVeil: 0, tailwind: 0 };
}

export class BattleStateTracker {
  private username: string;
  private ourSide: 'p1' | 'p2' | null = null;
  private oppSide: 'p1' | 'p2' | null = null;

  // Opponent tracking
  private oppActive: TrackedMon | null = null;
  private oppBench: Map<string, TrackedMon> = new Map(); // keyed by species
  opponentModel: OpponentModel = createOpponentModel(6);

  // Our active boosts (request has HP/moves but not boosts)
  private ourBoosts: Record<string, number> = {};

  // Field
  private weather: string | null = null;
  private weatherTurns = 0;
  private terrain: string | null = null;
  private terrainTurns = 0;
  private playerSideField: SideFieldState = emptyField();
  private opponentSideField: SideFieldState = emptyField();

  private turn = 0;

  constructor(username: string) {
    this.username = username;
  }

  /** Feed a raw protocol line. */
  ingest(line: string): void {
    const parts = line.split('|');
    if (parts.length < 2) return;
    const cmd = parts[1];

    switch (cmd) {
      case 'player': this.handlePlayer(parts); break;
      case 'switch':
      case 'drag': this.handleSwitch(parts); break;
      case '-damage':
      case '-heal': this.handleHpChange(parts); break;
      case 'faint': this.handleFaint(parts); break;
      case '-status': this.handleStatus(parts); break;
      case '-curestatus': this.handleCureStatus(parts); break;
      case '-boost': this.handleBoost(parts, 1); break;
      case '-unboost': this.handleBoost(parts, -1); break;
      case '-setboost': this.handleSetBoost(parts); break;
      case '-clearboost':
      case '-clearallboost': this.handleClearBoost(parts); break;
      case '-weather': this.handleWeather(parts); break;
      case '-fieldstart': this.handleFieldStart(parts); break;
      case '-fieldend': this.handleFieldEnd(parts); break;
      case '-sidestart': this.handleSideStart(parts); break;
      case '-sideend': this.handleSideEnd(parts); break;
      case 'move': this.handleMove(parts); break;
      case '-item': this.handleItem(parts); break;
      case '-enditem': this.handleEndItem(parts); break;
      case '-ability': this.handleAbility(parts); break;
      case 'turn': this.turn = parseInt(parts[2], 10) || 0; break;
    }
  }

  /** Build a BattleSnapshot from the latest request + accumulated state. */
  buildSnapshot(req: BattleRequest): BattleSnapshot {
    const player = this.buildPlayerSide(req);
    const opponent = this.buildOpponentSide();
    const field: FieldState = {
      weather: this.weather,
      weatherTurns: this.weatherTurns,
      terrain: this.terrain,
      terrainTurns: this.terrainTurns,
      playerSide: { ...this.playerSideField },
      opponentSide: { ...this.opponentSideField },
    };
    const actions = this.buildActions(req);
    return {
      roomId: 'ladder',
      turn: this.turn,
      format: 'gen9randombattle',
      player,
      opponent,
      field,
      availableActions: actions,
    };
  }

  // ─── Private handlers ─────────────────────────────────────────

  private handlePlayer(parts: string[]): void {
    const side = parts[2] as 'p1' | 'p2';
    const name = parts[3];
    if (name && toID(name) === toID(this.username)) {
      this.ourSide = side;
      this.oppSide = side === 'p1' ? 'p2' : 'p1';
    }
  }

  private isOurMon(ident: string): boolean {
    if (!this.ourSide) return false;
    return ident.startsWith(this.ourSide);
  }

  private handleSwitch(parts: string[]): void {
    const ident = parts[2]; // "p1a: Species"
    const details = parts[3]; // "Species, L84, M"
    const condition = parts[4]; // "100/100" or "72/100 brn"
    if (!ident || !details) return;

    const { species, level } = parseDetails(details);
    const { hp, hpMax, status } = parseCondition(condition || '100/100');

    if (this.isOurMon(ident)) {
      this.ourBoosts = {};
    } else {
      // Opponent switch: update active + reveal
      this.oppActive = {
        species, level, hp, hpMax, status,
        boosts: {},
        moves: this.oppBench.get(species)?.moves || [],
        item: this.oppBench.get(species)?.item || null,
        ability: this.oppBench.get(species)?.ability || null,
      };
      this.oppBench.set(species, this.oppActive);
      this.opponentModel = revealPokemon(this.opponentModel, species);
    }
  }

  private handleHpChange(parts: string[]): void {
    const ident = parts[2];
    const condition = parts[3];
    if (!ident || !condition) return;
    if (!this.isOurMon(ident) && this.oppActive) {
      const { hp, hpMax, status } = parseCondition(condition);
      this.oppActive.hp = hp;
      this.oppActive.hpMax = hpMax;
      if (status) this.oppActive.status = status;
    }
  }

  private handleFaint(parts: string[]): void {
    const ident = parts[2];
    if (!ident) return;
    if (!this.isOurMon(ident) && this.oppActive) {
      this.oppActive.hp = 0;
      this.oppActive.status = 'fnt';
    }
  }

  private handleStatus(parts: string[]): void {
    const ident = parts[2];
    const status = parts[3];
    if (!ident || !status) return;
    if (!this.isOurMon(ident) && this.oppActive) {
      this.oppActive.status = status;
    } else if (this.isOurMon(ident)) {
      // Our status is tracked via request; no action needed
    }
  }

  private handleCureStatus(parts: string[]): void {
    const ident = parts[2];
    if (!ident) return;
    if (!this.isOurMon(ident) && this.oppActive) {
      this.oppActive.status = null;
    }
  }

  private handleBoost(parts: string[], direction: number): void {
    const ident = parts[2];
    const stat = parts[3];
    const amount = parseInt(parts[4], 10) || 1;
    if (!ident || !stat) return;
    if (this.isOurMon(ident)) {
      this.ourBoosts[stat] = (this.ourBoosts[stat] || 0) + direction * amount;
    } else if (this.oppActive) {
      this.oppActive.boosts[stat] = (this.oppActive.boosts[stat] || 0) + direction * amount;
    }
  }

  private handleSetBoost(parts: string[]): void {
    const ident = parts[2];
    const stat = parts[3];
    const amount = parseInt(parts[4], 10) || 0;
    if (!ident || !stat) return;
    if (this.isOurMon(ident)) {
      this.ourBoosts[stat] = amount;
    } else if (this.oppActive) {
      this.oppActive.boosts[stat] = amount;
    }
  }

  private handleClearBoost(parts: string[]): void {
    const ident = parts[2];
    if (!ident) return;
    if (this.isOurMon(ident)) {
      this.ourBoosts = {};
    } else if (this.oppActive) {
      this.oppActive.boosts = {};
    }
  }

  private handleWeather(parts: string[]): void {
    const w = parts[2];
    if (!w || w === 'none') { this.weather = null; this.weatherTurns = 0; return; }
    if (parts[3]?.includes('upkeep')) { this.weatherTurns++; return; }
    this.weather = toID(w);
    this.weatherTurns = 0;
  }

  private handleFieldStart(parts: string[]): void {
    const raw = parts[2];
    if (!raw) return;
    const id = toID(raw.replace('move: ', ''));
    if (id.includes('terrain')) { this.terrain = id.replace('terrain', ''); this.terrainTurns = 0; }
  }

  private handleFieldEnd(parts: string[]): void {
    const raw = parts[2];
    if (!raw) return;
    if (toID(raw).includes('terrain')) { this.terrain = null; this.terrainTurns = 0; }
  }

  private handleSideStart(parts: string[]): void {
    const sideIdent = parts[2]; // "p1: Username"
    const condition = parts[3];
    if (!sideIdent || !condition) return;
    const isOurs = sideIdent.startsWith(this.ourSide || '');
    const field = isOurs ? this.playerSideField : this.opponentSideField;
    this.applySideCondition(field, condition, true);
  }

  private handleSideEnd(parts: string[]): void {
    const sideIdent = parts[2];
    const condition = parts[3];
    if (!sideIdent || !condition) return;
    const isOurs = sideIdent.startsWith(this.ourSide || '');
    const field = isOurs ? this.playerSideField : this.opponentSideField;
    this.applySideCondition(field, condition, false);
  }

  private applySideCondition(field: SideFieldState, raw: string, add: boolean): void {
    const id = toID(raw.replace('move: ', ''));
    if (id === 'stealthrock') field.stealthRock = add;
    else if (id === 'spikes') field.spikes = add ? Math.min(field.spikes + 1, 3) : 0;
    else if (id === 'toxicspikes') field.toxicSpikes = add ? Math.min(field.toxicSpikes + 1, 2) : 0;
    else if (id === 'stickyweb') field.stickyWeb = add;
    else if (id === 'reflect') field.reflect = add ? 5 : 0;
    else if (id === 'lightscreen') field.lightScreen = add ? 5 : 0;
    else if (id === 'auroraveil') field.auroraVeil = add ? 5 : 0;
    else if (id === 'tailwind') field.tailwind = add ? 4 : 0;
  }

  private handleMove(parts: string[]): void {
    const ident = parts[2];
    const move = parts[3];
    if (!ident || !move) return;
    if (!this.isOurMon(ident) && this.oppActive) {
      if (!this.oppActive.moves.includes(move)) {
        this.oppActive.moves.push(move);
      }
      this.opponentModel = revealMove(this.opponentModel, this.oppActive.species, move);
    }
  }

  private handleItem(parts: string[]): void {
    const ident = parts[2];
    const item = parts[3];
    if (!ident || !item) return;
    if (!this.isOurMon(ident) && this.oppActive) {
      this.oppActive.item = item;
      this.opponentModel = revealItem(this.opponentModel, this.oppActive.species, item);
    }
  }

  private handleEndItem(parts: string[]): void {
    const ident = parts[2];
    const item = parts[3];
    if (!ident || !item) return;
    if (!this.isOurMon(ident) && this.oppActive) {
      this.oppActive.item = '(consumed)';
      this.opponentModel = revealItem(this.opponentModel, this.oppActive.species, item);
    }
  }

  private handleAbility(parts: string[]): void {
    const ident = parts[2];
    const ability = parts[3];
    if (!ident || !ability) return;
    if (!this.isOurMon(ident) && this.oppActive) {
      this.oppActive.ability = ability;
      this.opponentModel = revealAbility(this.opponentModel, this.oppActive.species, ability);
    }
  }

  // ─── Snapshot building ─────────────────────────────────────────

  private buildPlayerSide(req: BattleRequest): { active: PokemonState; bench: PokemonState[] } {
    const activeMon = req.side.pokemon.find(p => p.active);
    const active = this.reqMonToState(activeMon, true);
    const bench = req.side.pokemon
      .filter(p => !p.active && !isFainted(p.condition))
      .map(p => this.reqMonToState(p, false));
    return { active, bench };
  }

  private reqMonToState(mon: { ident: string; details: string; condition: string; active: boolean; stats?: Record<string, number>; moves?: string[]; item?: string; ability?: string; baseAbility?: string } | undefined, isActive: boolean): PokemonState {
    if (!mon) return this.emptyMon();
    const { species, level } = parseDetails(mon.details);
    const { hp, hpMax, status } = parseCondition(mon.condition);

    // Infer set data for EVs/IVs/nature
    const sets = getSetsForSpecies(species);
    let evs: Record<string, number> | undefined;
    let ivs: Record<string, number> | undefined;
    let nature: string | undefined;
    if (sets.length > 0) {
      const moves = mon.moves || [];
      const ability = mon.ability || mon.baseAbility || null;
      const item = mon.item || null;
      // Score match
      let best = sets[0];
      let bestScore = -1;
      for (const s of sets) {
        let score = 0;
        if (ability && toID(s.ability) === toID(ability)) score += 2;
        if (item && toID(s.item) === toID(item)) score += 2;
        for (const m of moves) { if (s.moves.some(sm => toID(sm) === toID(m))) score++; }
        if (score > bestScore) { bestScore = score; best = s; }
      }
      evs = Object.keys(best.evs).length > 0 ? best.evs : undefined;
      ivs = Object.keys(best.ivs).length > 0 ? best.ivs : undefined;
      nature = best.nature || undefined;
    }

    return {
      species, level, hp, hpMax, status,
      boosts: isActive ? { ...this.ourBoosts } : {},
      moves: mon.moves || [],
      item: mon.item || null,
      ability: mon.ability || mon.baseAbility || null,
      teraType: null,
      terastallized: false,
      stats: mon.stats,
      evs,
      ivs,
      nature,
    };
  }

  private buildOpponentSide(): { active: PokemonState; bench: PokemonState[] } {
    const active: PokemonState = this.oppActive
      ? {
          species: this.oppActive.species,
          level: this.oppActive.level,
          hp: this.oppActive.hp,
          hpMax: this.oppActive.hpMax,
          status: this.oppActive.status,
          boosts: { ...this.oppActive.boosts },
          moves: [...this.oppActive.moves],
          item: this.oppActive.item,
          ability: this.oppActive.ability,
          teraType: null,
          terastallized: false,
        }
      : this.emptyMon();

    const bench: PokemonState[] = [];
    for (const [species, mon] of this.oppBench) {
      if (this.oppActive && species === this.oppActive.species) continue;
      if (mon.hp <= 0) continue;
      bench.push({
        species: mon.species,
        level: mon.level,
        hp: mon.hp,
        hpMax: mon.hpMax,
        status: mon.status,
        boosts: {},
        moves: [...mon.moves],
        item: mon.item,
        ability: mon.ability,
        teraType: null,
        terastallized: false,
      });
    }
    return { active, bench };
  }

  private buildActions(req: BattleRequest): Action[] {
    const actions: Action[] = [];
    if (req.forceSwitch?.[0]) {
      // Only switches
      for (const slot of legalSwitchSlots(req)) {
        const mon = req.side.pokemon[slot - 1];
        const { species } = parseDetails(mon.details);
        actions.push({ type: 'switch', species, slot });
      }
      return actions;
    }
    if (req.active?.[0]?.moves) {
      for (const slot of legalMoveSlots(req)) {
        const m = req.active[0].moves[slot - 1];
        actions.push({
          type: 'move',
          id: m.id || toID(m.move),
          name: m.move,
          pp: m.pp,
          maxPp: m.maxpp ?? m.pp,
          target: m.target || 'normal',
          disabled: false,
        });
      }
    }
    for (const slot of legalSwitchSlots(req)) {
      const mon = req.side.pokemon[slot - 1];
      const { species } = parseDetails(mon.details);
      actions.push({ type: 'switch', species, slot });
    }
    return actions;
  }

  private emptyMon(): PokemonState {
    return {
      species: 'unknown', level: 100, hp: 0, hpMax: 0,
      status: 'fnt', boosts: {}, moves: [],
      item: null, ability: null, teraType: null, terastallized: false,
    };
  }
}
