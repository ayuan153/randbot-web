/**
 * PAGE world script — patches app.receive() to intercept battle protocol.
 * Injected as a <script> tag by the content script.
 * Must be self-contained (no imports from node_modules).
 */
(function randbatsBotHook() {
  const SOURCE = 'randbats-bot-hook';

  /** Poll for window.app to exist (PS loads async) */
  function waitForApp(cb: () => void) {
    const check = () => {
      if ((window as any).app?.receive) {
        cb();
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  }

  /** Parse PS condition string like "267/300 brn" or "0 fnt" */
  function parseCondition(cond: string): { hp: number; hpMax: number; status: string | null } {
    if (!cond || cond === '0 fnt') return { hp: 0, hpMax: 0, status: 'fnt' };
    const parts = cond.split(' ');
    const hpParts = parts[0].split('/');
    return {
      hp: parseInt(hpParts[0], 10),
      hpMax: parseInt(hpParts[1], 10) || 100,
      status: parts[1] || null,
    };
  }

  /** Parse details string like "Pikachu, L84, M" */
  function parseDetails(details: string): { species: string; level: number } {
    const parts = details.split(', ');
    const species = parts[0];
    let level = 100;
    for (const p of parts) {
      if (p.startsWith('L')) level = parseInt(p.slice(1), 10);
    }
    return { species, level };
  }

  /** Parse opponent active from protocol lines (fallback when battle object lags) */
  function parseOppActiveFromProtocol(lines: string[], mySideId: string): { species: string; level: number; hp: number; hpMax: number; ability: string | null } | null {
    const oppPrefix = mySideId === 'p1' ? 'p2a' : 'p1a';
    let species = '';
    let level = 100;
    let hp = 0;
    let hpMax = 0;
    let ability: string | null = null;

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const type = parts[1];
      // Match switch/drag for opponent active slot
      if ((type === 'switch' || type === 'drag') && parts[2]?.startsWith(oppPrefix + ':')) {
        const parsed = parseDetails(parts[3]);
        species = parsed.species;
        level = parsed.level;
        if (parts[4]) {
          const cond = parseCondition(parts[4]);
          hp = cond.hp;
          hpMax = cond.hpMax;
        }
      } else if (type === '-ability' && parts[2]?.startsWith(oppPrefix + ':')) {
        ability = parts[3]?.trim() || null;
      }
    }

    return species ? { species, level, hp, hpMax, ability } : null;
  }

  /** Extract side field conditions (hazards, screens) */
  function extractSideField(sideConditions: Record<string, any>) {
    return {
      spikes: sideConditions['spikes']?.[1] ?? 0,
      stealthRock: 'stealthrock' in sideConditions,
      toxicSpikes: sideConditions['toxicspikes']?.[1] ?? 0,
      stickyWeb: 'stickyweb' in sideConditions,
      reflect: sideConditions['reflect']?.[1] ?? 0,
      lightScreen: sideConditions['lightscreen']?.[1] ?? 0,
      auroraVeil: sideConditions['auroraveil']?.[1] ?? 0,
      tailwind: sideConditions['tailwind']?.[1] ?? 0,
    };
  }

  /** Extract PokemonState from a PS battle pokemon object */
  function extractPokemonState(mon: any) {
    if (!mon) {
      return {
        species: 'unknown', level: 100, hp: 0, hpMax: 0,
        status: 'fnt', boosts: {}, moves: [],
        item: null, ability: null, teraType: null, terastallized: false,
      };
    }
    return {
      species: mon.speciesForme || mon.species || 'unknown',
      level: mon.level ?? 100,
      hp: mon.hp ?? 0,
      hpMax: mon.maxhp ?? 100,
      status: mon.status || null,
      boosts: mon.boosts ? { ...mon.boosts } : {},
      moves: (mon.moveTrack || []).map((m: any) => (Array.isArray(m) ? m[0] : m)),
      item: mon.item || null,
      ability: mon.ability || null,
      teraType: mon.teraType || null,
      terastallized: mon.terastallized || false,
    };
  }

  /** Build full BattleSnapshot from a battle room */
  function extractSnapshot(roomId: string) {
    const app = (window as any).app;
    const room = app.rooms[roomId];
    if (!room?.battle || !room.request) return null;

    const battle = room.battle;
    const request = room.request;

    // Determine which side is ours
    const mySide = battle.mySide || battle.nearSide;
    const oppSide = battle.farSide || battle.yourSide;
    if (!mySide || !oppSide) return null;

    // Extract active pokemon
    const myActive = extractPokemonState(mySide.active?.[0]);
    const oppActive = extractPokemonState(oppSide.active?.[0]);

    // Fallback: if active mon is not populated from battle state, use request.side.pokemon
    const activeReqMon = request.side?.pokemon?.find((p: any) => p.active);
    if ((myActive.species === 'unknown' || myActive.hp === 0) && activeReqMon) {
      const { species, level } = parseDetails(activeReqMon.details);
      const { hp, hpMax, status } = parseCondition(activeReqMon.condition);
      myActive.species = species;
      myActive.level = level;
      myActive.hp = hp;
      myActive.hpMax = hpMax;
      myActive.status = status;
      myActive.moves = activeReqMon.moves || [];
      myActive.item = activeReqMon.item || null;
      myActive.ability = activeReqMon.ability || activeReqMon.baseAbility || null;
    }

    // Enrich our active with request data (has exact stats, moves, item)
    if (request.active?.[0]) {
      const reqMoves = request.active[0].moves || [];
      myActive.moves = reqMoves.map((m: any) => m.move || m.id);
    }

    // Extract bench from request.side.pokemon (our team with full info)
    const myBench = (request.side?.pokemon || [])
      .filter((p: any) => !p.active && !p.condition?.startsWith('0'))
      .map((p: any) => {
        const { species, level } = parseDetails(p.details);
        const { hp, hpMax, status } = parseCondition(p.condition);
        return {
          species, level, hp, hpMax, status,
          boosts: {},
          moves: p.moves || [],
          item: p.item || null,
          ability: p.ability || p.baseAbility || null,
          teraType: null,
          terastallized: false,
        };
      });

    // Extract opponent bench (only revealed pokemon)
    const oppBench = (oppSide.pokemon || [])
      .filter((p: any) => p && p !== oppSide.active?.[0] && p.hp > 0)
      .map((p: any) => extractPokemonState(p));

    // Field state
    const field = {
      weather: battle.weather || null,
      weatherTurns: battle.weatherTimeLeft ?? 0,
      terrain: battle.terrain || null,
      terrainTurns: battle.terrainTimeLeft ?? 0,
      playerSide: extractSideField(mySide.sideConditions || {}),
      opponentSide: extractSideField(oppSide.sideConditions || {}),
    };

    // Available actions from request
    const actions: any[] = [];

    // Moves
    if (request.active?.[0]?.moves) {
      for (const m of request.active[0].moves) {
        if (m.disabled) continue;
        actions.push({
          type: 'move',
          id: m.id,
          name: m.move,
          pp: m.pp,
          maxPp: m.maxpp,
          target: m.target || 'normal',
          disabled: false,
        });
      }
    }

    // Switches
    if (request.side?.pokemon) {
      request.side.pokemon.forEach((p: any, i: number) => {
        if (p.active || p.condition === '0 fnt' || p.condition?.startsWith('0')) return;
        const { species } = parseDetails(p.details);
        actions.push({ type: 'switch', species, slot: i + 1 });
      });
    }

    // Derive format from roomId (e.g., "battle-gen9randombattle-12345")
    const formatMatch = roomId.match(/battle-([a-z0-9]+)-/);
    const format = formatMatch?.[1] || 'gen9randombattle';

    return {
      roomId,
      turn: battle.turn || 0,
      format,
      player: { active: myActive, bench: myBench },
      opponent: { active: oppActive, bench: oppBench },
      field,
      availableActions: actions,
    };
  }

  /** Parse boost/unboost lines from protocol to get current boost state */
  interface BoostChange {
    ident: string;
    stat: string;
    amount: number;
    absolute: boolean;
  }

  function parseBoostsFromProtocol(lines: string[]): BoostChange[] {
    const changes: BoostChange[] = [];
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const type = parts[1];
      if (type === '-boost') {
        changes.push({ ident: parts[2], stat: parts[3], amount: parseInt(parts[4] || '1', 10), absolute: false });
      } else if (type === '-unboost') {
        changes.push({ ident: parts[2], stat: parts[3], amount: -parseInt(parts[4] || '1', 10), absolute: false });
      } else if (type === '-setboost') {
        changes.push({ ident: parts[2], stat: parts[3], amount: parseInt(parts[4] || '0', 10), absolute: true });
      } else if (type === '-clearallboost') {
        for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion']) {
          changes.push({ ident: parts[2] || '', stat, amount: 0, absolute: true });
        }
      }
    }
    return changes;
  }

  /**
   * Cumulative boost tracker — authoritative source for boosts, bypasses animation queue.
   * Key: ident (e.g. "p1a: Pikachu"), Value: stat boosts
   */
  const trackedBoosts: Record<string, Record<string, number>> = {};

  /** Update cumulative boost tracker from protocol lines */
  function updateTrackedBoosts(lines: string[]) {
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const type = parts[1];
      const ident = parts[2] || '';

      if (type === 'switch' || type === 'drag') {
        // New Pokemon on field — reset boosts for this slot
        trackedBoosts[ident] = {};
      } else if (type === '-boost' && parts.length >= 5) {
        if (!trackedBoosts[ident]) trackedBoosts[ident] = {};
        const stat = parts[3];
        const amount = parseInt(parts[4] || '1', 10);
        trackedBoosts[ident][stat] = Math.min(6, (trackedBoosts[ident][stat] || 0) + amount);
      } else if (type === '-unboost' && parts.length >= 5) {
        if (!trackedBoosts[ident]) trackedBoosts[ident] = {};
        const stat = parts[3];
        const amount = parseInt(parts[4] || '1', 10);
        trackedBoosts[ident][stat] = Math.max(-6, (trackedBoosts[ident][stat] || 0) - amount);
      } else if (type === '-setboost' && parts.length >= 5) {
        if (!trackedBoosts[ident]) trackedBoosts[ident] = {};
        trackedBoosts[ident][parts[3]] = parseInt(parts[4] || '0', 10);
      } else if (type === '-clearallboost') {
        trackedBoosts[ident] = {};
      } else if (type === '-copyboost' && parts.length >= 4) {
        const target = parts[3] || '';
        trackedBoosts[target] = { ...(trackedBoosts[ident] || {}) };
      }
    }
  }

  /** Apply tracked boosts to snapshot, overriding battle object's potentially stale values */
  function applyBoostOverrides(snapshot: any, _changes: BoostChange[], battle: any) {
    const mySide = battle.mySide || battle.nearSide;
    const myPrefix = (mySide?.sideid || 'p1') as string;
    const oppPrefix = myPrefix === 'p1' ? 'p2' : 'p1';

    for (const [ident, boosts] of Object.entries(trackedBoosts)) {
      if (ident.startsWith(myPrefix + 'a')) {
        snapshot.player.active.boosts = { ...boosts };
      } else if (ident.startsWith(oppPrefix + 'a')) {
        snapshot.opponent.active.boosts = { ...boosts };
      }
    }
  }

  waitForApp(() => {
    const app = (window as any).app;
    const origReceive = app.receive.bind(app);

    // Accumulate protocol lines per room so we can search across messages
    const roomProtocolLines: Record<string, string[]> = {};

    app.receive = function (data: string) {
      // Call original first so PS updates its state
      origReceive(data);

      // Only process battle room messages
      if (!data.startsWith('>battle-')) return;

      const newline = data.indexOf('\n');
      const roomId = data.slice(1, newline > 0 ? newline : undefined);
      const lines = data.slice(newline + 1).split('\n');

      // Accumulate lines for this room (reset on |turn| to avoid unbounded growth)
      if (!roomProtocolLines[roomId]) roomProtocolLines[roomId] = [];
      for (const l of lines) {
        if (l.startsWith('|turn|')) roomProtocolLines[roomId] = [];
        roomProtocolLines[roomId].push(l);
      }

      // Track boosts from ALL protocol messages (cumulative, resets on switch)
      updateTrackedBoosts(lines);

      // Post raw protocol for opponent model tracking
      window.postMessage({ source: SOURCE, type: 'PS_PROTOCOL_MSG', roomId, raw: data }, '*');

      // Check if this batch contains a request (turn action needed)
      const hasRequest = lines.some(l => l.startsWith('|request|'));
      if (!hasRequest) return;

      // Parse boost changes from protocol (battle object may lag due to animation queue)
      const boostOverrides = parseBoostsFromProtocol(lines);

      // Poll until both mySide AND farSide active are populated (or timeout)
      const pollStart = Date.now();
      const pollForActive = () => {
        const battle = app.rooms[roomId]?.battle;
        const bothReady = battle?.mySide?.active[0]?.speciesForme && battle?.farSide?.active[0]?.speciesForme;
        if (bothReady || Date.now() - pollStart > 500) {
          const snapshot = extractSnapshot(roomId);
          if (snapshot && snapshot.availableActions.length > 0) {
            // Apply boost overrides from protocol parsing
            applyBoostOverrides(snapshot, boostOverrides, battle);
            // Fallback: parse opponent from protocol if battle object hasn't populated farSide
            if (snapshot.opponent.active.species === 'unknown' || snapshot.opponent.active.hp === 0) {
              const request = app.rooms[roomId]?.request;
              const mySideId = request?.side?.id || 'p1';
              const parsed = parseOppActiveFromProtocol(roomProtocolLines[roomId] || lines, mySideId);
              if (parsed) {
                snapshot.opponent.active.species = parsed.species;
                snapshot.opponent.active.level = parsed.level;
                snapshot.opponent.active.hp = parsed.hp;
                snapshot.opponent.active.hpMax = parsed.hpMax;
                if (parsed.ability) snapshot.opponent.active.ability = parsed.ability;
              }
            }
            window.postMessage({ source: SOURCE, type: 'PS_TURN_REQUEST', snapshot }, '*');
          }
        } else {
          setTimeout(pollForActive, 50);
        }
      };
      pollForActive();
    };

    console.log('[randbats-bot] Hook installed');
  });
})();
