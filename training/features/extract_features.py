"""Extract 245-feature vectors from replay protocol logs for training.

Feature layout (245 total):
  [0-155]   Per-Pokemon (12 mons x 13 features)
  [156-163] Matchup (8)
  [164-175] Team-level (12)
  [176-193] Field (18)
  [194-205] Tempo (12)
  --- NEW (appended at 206+) ---
  [206-211] A. Speed-related (6)
  [212-216] B. Type matchup (5)
  [217-219] C. Turns-to-KO (3)
  [220-223] D. Team composition (4)
  [224-226] E. Momentum (3)
  [227-233] F. Setup threat (7)
  [234-241] G. Stall/wall (8)
  [242-244] H. Futility (3)
"""

import json
from pathlib import Path

import numpy as np
from tqdm import tqdm

from .battle_state import BattleState, update_state, parse_pokemon_ident
from .type_chart import type_effectiveness
from .base_stats import (
    get_types, get_move_type_power, estimate_speed, MOVE_BASE_POWERS,
)

# Move category sets
PRIORITY_MOVES = {"Mach Punch", "Aqua Jet", "Bullet Punch", "Extreme Speed", "Ice Shard",
                  "Shadow Sneak", "Sucker Punch", "Quick Attack", "Accelerock", "Grassy Glide", "Jet Punch"}
SETUP_MOVES = {"Calm Mind", "Swords Dance", "Dragon Dance", "Nasty Plot", "Quiver Dance",
               "Iron Defense", "Bulk Up", "Shell Smash", "Shift Gear", "Coil", "Agility",
               "Rock Polish", "Autotomize", "Belly Drum", "Tail Glow", "Growth", "Work Up"}
RECOVERY_MOVES = {"Recover", "Roost", "Synthesis", "Moonlight", "Morning Sun",
                  "Soft-Boiled", "Slack Off", "Shore Up", "Strength Sap"}
PHAZE_MOVES = {"Roar", "Whirlwind", "Dragon Tail", "Circle Throw"}
HAZE_MOVES = {"Haze", "Clear Smog"}
PROTECT_MOVES = {"Protect", "Detect", "Baneful Bunker", "King's Shield", "Spiky Shield"}
TOXIC_MOVES = {"Toxic"}
SUBSTITUTE_MOVES = {"Substitute"}
PHYSICAL_MOVES_THRESHOLD = 80  # base power threshold for "physical attacker" heuristic

# Status encoding: maps status string to normalized float
STATUS_MAP = {"": 0.0, "brn": 1/6, "par": 2/6, "slp": 3/6, "frz": 4/6, "psn": 5/6, "tox": 1.0}
# Weather one-hot order
WEATHERS = ["SunnyDay", "RainDance", "Sandstorm", "Snow", "Desolate Land", "Primordial Sea"]
# Terrain one-hot order
TERRAINS = ["electric", "grassy", "misty", "psychic", ""]

# Policy action space (size 5): 0-3 = move slots (moves sorted by normalized id, so
# the index matches the live |request| which lists all 4 moves), 4 = switch (any
# target). Switch TARGET is not recoverable from replays (no |request|; mons are
# revealed in play-order, not the team's fixed roster order) so it is deferred to
# value-net lookahead at inference. -1 = no/ambiguous label (masked in the CE loss).
ACTION_DIM = 5
SWITCH_ACTION = 4
NO_ACTION = -1       # no action captured this turn -> excluded from policy loss
MOVE_UNKNOWN = -2    # known to be a move (not switch) but exact slot unresolved
                     # (mon never revealed all 4 moves) -> "not-switch" marginal loss


def _move_id(name: str) -> str:
    """Normalize a move display name to its showdown id (lowercase alphanumerics),
    matching request.active[].moves[].id so train/infer move ordering agree."""
    return "".join(c for c in name.lower() if c.isalnum())


def _pokemon_features(mon) -> list[float]:
    """13 features per pokemon: hp, active, alive, status, boosts(5), item, moves_known, ability_known, tera_type_known."""
    feats = [
        mon.hp_fraction(),
        0.0,  # is_active placeholder, set by caller
        1.0 if mon.is_alive else 0.0,
        STATUS_MAP.get(mon.status, 0.0),
    ]
    # Boosts normalized to [-1, 1]
    for stat in ["atk", "def", "spa", "spd", "spe"]:
        feats.append(mon.boosts.get(stat, 0) / 6.0)
    feats.append(1.0 if mon.has_item else 0.0)
    feats.append(min(len(mon.moves_known), 4) / 4.0)
    feats.append(1.0 if mon.ability else 0.0)
    feats.append(1.0 if mon.tera_type else 0.0)
    return feats  # 13 features


def _matchup_features(our_side, their_side) -> list[float]:
    """8 matchup features between active pokemon."""
    our_mon = our_side.active
    their_mon = their_side.active
    our_types = our_mon.types if our_mon.types else ["Normal"]
    their_types = their_mon.types if their_mon.types else ["Normal"]

    # Best type effectiveness we can hit them with
    best_eff = max(type_effectiveness(t, their_types) for t in our_types)
    their_best_eff = max(type_effectiveness(t, our_types) for t in their_types)

    # Speed advantage (from boosts)
    our_spe_boost = our_mon.boosts.get("spe", 0)
    their_spe_boost = their_mon.boosts.get("spe", 0)
    speed_adv = (our_spe_boost - their_spe_boost) / 6.0

    # Simplified turns-to-KO estimates based on HP
    our_ttko = max(1.0, 1.0 / max(0.01, 1.0 - their_mon.hp_fraction())) if their_mon.is_alive else 0.0
    their_ttko = max(1.0, 1.0 / max(0.01, 1.0 - our_mon.hp_fraction())) if our_mon.is_alive else 0.0

    can_ohko = 1.0 if best_eff >= 2.0 and their_mon.hp_fraction() < 0.5 else 0.0
    they_can_ohko = 1.0 if their_best_eff >= 2.0 and our_mon.hp_fraction() < 0.5 else 0.0

    matchup_score = (best_eff - their_best_eff) / 4.0 + speed_adv * 0.5

    return [best_eff / 4.0, their_best_eff / 4.0, speed_adv,
            min(our_ttko, 5.0) / 5.0, min(their_ttko, 5.0) / 5.0,
            can_ohko, they_can_ohko, np.clip(matchup_score, -1, 1)]


def _team_features(our_side, their_side) -> list[float]:
    """12 team-level features."""
    our_alive = sum(1 for m in our_side.pokemon if m.is_alive and m.species)
    their_alive = sum(1 for m in their_side.pokemon if m.is_alive and m.species)
    our_hp = sum(m.hp_fraction() for m in our_side.pokemon if m.species) / max(1, sum(1 for m in our_side.pokemon if m.species))
    their_hp = sum(m.hp_fraction() for m in their_side.pokemon if m.species) / max(1, sum(1 for m in their_side.pokemon if m.species))

    # Hazard damage estimate (fraction of HP lost on switch)
    our_hazard_dmg = our_side.hazards["stealthrock"] * 0.125 + our_side.hazards["spikes"] * 0.083
    their_hazard_dmg = their_side.hazards["stealthrock"] * 0.125 + their_side.hazards["spikes"] * 0.083

    # Type coverage (number of unique types in known moves)
    our_coverage = len(set(m.tera_type for m in our_side.pokemon if m.tera_type)) / 18.0
    their_coverage = len(set(m.tera_type for m in their_side.pokemon if m.tera_type)) / 18.0

    our_fainted = sum(1 for m in our_side.pokemon if not m.is_alive and m.species)
    their_fainted = sum(1 for m in their_side.pokemon if not m.is_alive and m.species)
    our_statused = sum(1 for m in our_side.pokemon if m.status and m.species)
    their_statused = sum(1 for m in their_side.pokemon if m.status and m.species)

    return [our_alive / 6.0, their_alive / 6.0, our_hp, their_hp,
            our_hazard_dmg, their_hazard_dmg, our_coverage, their_coverage,
            our_fainted / 6.0, their_fainted / 6.0, our_statused / 6.0, their_statused / 6.0]


def _field_features(state: BattleState, our_side_idx: int) -> list[float]:
    """18 field features."""
    # Weather one-hot (6)
    weather_vec = [0.0] * 6
    for i, w in enumerate(WEATHERS):
        if state.weather == w:
            weather_vec[i] = 1.0
            break

    # Terrain one-hot (5)
    terrain_vec = [0.0] * 5
    for i, t in enumerate(TERRAINS):
        if state.terrain == t:
            terrain_vec[i] = 1.0
            break

    our_side = state.sides[our_side_idx]
    their_side = state.sides[1 - our_side_idx]

    # Screens (4): our reflect, our lightscreen, their reflect, their lightscreen
    screens = [
        1.0 if our_side.screens["reflect"] > 0 else 0.0,
        1.0 if our_side.screens["lightscreen"] > 0 else 0.0,
        1.0 if their_side.screens["reflect"] > 0 else 0.0,
        1.0 if their_side.screens["lightscreen"] > 0 else 0.0,
    ]

    # Tailwind (2)
    tailwind = [
        1.0 if our_side.tailwind > 0 else 0.0,
        1.0 if their_side.tailwind > 0 else 0.0,
    ]

    # Trick room (1)
    trick_room = [1.0 if state.trick_room else 0.0]

    return weather_vec + terrain_vec + screens + tailwind + trick_room


def _tempo_features(state: BattleState, our_side_idx: int) -> list[float]:
    """12 tempo features."""
    our_side = state.sides[our_side_idx]
    their_side = state.sides[1 - our_side_idx]

    # Setup progress: sum of positive boosts
    our_setup = sum(max(0, v) for v in our_side.active.boosts.values()) / 30.0
    their_setup = sum(max(0, v) for v in their_side.active.boosts.values()) / 30.0

    # KO threats: count of mons that could be KO'd (hp < 30%)
    our_threats = sum(1 for m in their_side.pokemon if m.is_alive and m.hp_fraction() < 0.3) / 6.0
    their_threats = sum(1 for m in our_side.pokemon if m.is_alive and m.hp_fraction() < 0.3) / 6.0

    # Momentum: positive if we have more alive + higher HP
    our_total = sum(m.hp_fraction() for m in our_side.pokemon if m.is_alive and m.species)
    their_total = sum(m.hp_fraction() for m in their_side.pokemon if m.is_alive and m.species)
    momentum = np.clip((our_total - their_total) / 6.0, -1, 1)

    # Switch pressure: how many of their mons are low HP
    switch_pressure = sum(1 for m in their_side.pokemon if m.is_alive and m.hp_fraction() < 0.5 and m.species) / 6.0

    return [
        our_setup, their_setup, our_threats, their_threats,
        momentum, switch_pressure,
        1.0 if our_side.tera_available else 0.0,
        1.0 if their_side.tera_available else 0.0,
        1.0 if our_side.tera_used else 0.0,
        1.0 if their_side.tera_used else 0.0,
        min(state.turn, 50) / 50.0,  # turn number normalized
        0.0,  # forced_switch placeholder
    ]


def _effectiveness_to_scale(mult: float) -> float:
    """Map raw effectiveness multiplier to normalized scale."""
    if mult == 0: return 0.0
    if mult <= 0.25: return 0.25
    if mult <= 0.5: return 0.5
    if mult <= 1.0: return 0.75
    if mult <= 2.0: return 1.0
    return 1.25


def _best_stab_eff(mon_types: list[str], moves_known: list[str], def_types: list[str]) -> float:
    """Best STAB effectiveness from known moves or types against defender."""
    best = 0.0
    # Check known moves that match STAB
    for move in moves_known:
        mtype, bp = get_move_type_power(move)
        if bp > 0 and mtype in mon_types:
            eff = type_effectiveness(mtype, def_types)
            best = max(best, eff)
    # Also check raw STAB types
    for t in mon_types:
        eff = type_effectiveness(t, def_types)
        best = max(best, eff)
    return best


def _estimate_best_damage_pct(mon_types: list[str], moves_known: list[str], def_types: list[str]) -> float:
    """Rough damage proxy: base_power * effectiveness * stab / 200, capped at 1.0."""
    best = 0.0
    for move in moves_known:
        mtype, bp = get_move_type_power(move)
        if bp == 0:
            continue
        eff = type_effectiveness(mtype, def_types)
        stab = 1.5 if mtype in mon_types else 1.0
        dmg = bp * eff * stab / 200.0
        best = max(best, dmg)
    # Fallback: assume 80bp STAB move
    if not moves_known:
        for t in mon_types:
            eff = type_effectiveness(t, def_types)
            best = max(best, 80 * eff * 1.5 / 200.0)
    return min(best, 1.0)


def _speed_features(our_side, their_side) -> list[float]:
    """A. Speed-related (6 features)."""
    our_mon = our_side.active
    their_mon = their_side.active
    my_speed = estimate_speed(our_mon.species) if our_mon.species else 80.0
    opp_speed = estimate_speed(their_mon.species) if their_mon.species else 80.0

    # Apply paralysis
    if their_mon.status == "par":
        opp_speed *= 0.5

    total = my_speed + opp_speed
    speed_ratio = my_speed / total if total > 0 else 0.5

    priority = 1.0 if any(m in PRIORITY_MOVES for m in our_mon.moves_known) else 0.0

    # Scarf possible: check if opponent has item and could be scarfed
    # We approximate: if opponent still has item and outspeeds expectations, scarf is possible
    scarf_possible = 1.0 if their_mon.has_item else 0.0

    paralysis = 1.0 if their_mon.status == "par" else 0.0

    return [
        min(my_speed / 500.0, 1.0),
        min(opp_speed / 500.0, 1.0),
        speed_ratio,
        priority,
        scarf_possible,
        paralysis,
    ]


def _type_matchup_features(our_side, their_side) -> list[float]:
    """B. Type matchup (5 features)."""
    our_mon = our_side.active
    their_mon = their_side.active
    my_types = get_types(our_mon.species) if our_mon.species else ["Normal"]
    opp_types = get_types(their_mon.species) if their_mon.species else ["Normal"]

    best_stab = _effectiveness_to_scale(_best_stab_eff(my_types, our_mon.moves_known, opp_types))
    their_best_stab = _effectiveness_to_scale(_best_stab_eff(opp_types, their_mon.moves_known, my_types))

    # Primary STAB type of opponent
    opp_primary_stab = opp_types[0] if opp_types else "Normal"

    resists = 0
    weak = 0
    for mon in our_side.pokemon:
        if not mon.is_alive or not mon.species:
            continue
        mt = get_types(mon.species)
        eff = type_effectiveness(opp_primary_stab, mt)
        if eff < 1.0:
            resists += 1
        elif eff > 1.0:
            weak += 1

    # Immunity check for active
    immune = 1.0 if type_effectiveness(opp_primary_stab, my_types) == 0.0 else 0.0

    return [best_stab, their_best_stab, resists / 6.0, weak / 6.0, immune]


def _ttko_features(our_side, their_side) -> list[float]:
    """C. Turns-to-KO (3 features)."""
    our_mon = our_side.active
    their_mon = their_side.active
    my_types = get_types(our_mon.species) if our_mon.species else ["Normal"]
    opp_types = get_types(their_mon.species) if their_mon.species else ["Normal"]

    my_dmg = _estimate_best_damage_pct(my_types, our_mon.moves_known, opp_types)
    their_dmg = _estimate_best_damage_pct(opp_types, their_mon.moves_known, my_types)

    my_ttko = min(1.0 / my_dmg, 5.0) / 5.0 if my_dmg > 0 else 1.0
    their_ttko = min(1.0 / their_dmg, 5.0) / 5.0 if their_dmg > 0 else 1.0

    ko_diff = np.clip((their_ttko - my_ttko) / 1.0, -1, 1)  # already normalized

    return [my_ttko, their_ttko, ko_diff]


def _team_comp_features(our_side, their_side) -> list[float]:
    """D. Team composition (4 features)."""
    phys_attackers = 0
    spec_attackers = 0
    walls = 0

    for mon in our_side.pokemon:
        if not mon.is_alive or not mon.species:
            continue
        # Physical: has physical moves with decent BP
        has_phys = any(get_move_type_power(m)[1] >= 70 and m not in SETUP_MOVES | RECOVERY_MOVES
                       for m in mon.moves_known)
        has_spec = any(m in ("Thunderbolt", "Ice Beam", "Flamethrower", "Hydro Pump",
                             "Fire Blast", "Moonblast", "Shadow Ball", "Psychic",
                             "Energy Ball", "Dark Pulse", "Focus Blast", "Draco Meteor",
                             "Leaf Storm", "Surf", "Scald", "Thunder", "Blizzard",
                             "Flash Cannon", "Aura Sphere", "Hurricane", "Psyshock")
                       for m in mon.moves_known)
        has_recovery = any(m in RECOVERY_MOVES for m in mon.moves_known)

        if has_phys:
            phys_attackers += 1
        if has_spec:
            spec_attackers += 1
        if has_recovery:
            walls += 1

    # Unrevealed opponents
    opp_unrevealed = sum(1 for m in their_side.pokemon if not m.species)

    return [phys_attackers / 6.0, spec_attackers / 6.0, opp_unrevealed / 6.0, walls / 6.0]


def _momentum_features(state: BattleState, our_side, their_side, our_side_idx: int) -> list[float]:
    """E. Momentum (3 features)."""
    # Consecutive KOs: approximate from faint count difference over recent turns
    our_fainted = sum(1 for m in our_side.pokemon if not m.is_alive and m.species)
    their_fainted = sum(1 for m in their_side.pokemon if not m.is_alive and m.species)
    consec_kos = min(max(their_fainted - our_fainted, 0), 3) / 3.0

    # Last move was switch: approximate from active mon having 0 boosts and full HP
    last_switch = 0.0  # Can't reliably determine from state alone, default 0

    # Entry hazard layers on opponent's side
    opp_hazards = their_side.hazards
    hazard_layers = (opp_hazards.get("stealthrock", 0) +
                     opp_hazards.get("spikes", 0) +
                     opp_hazards.get("toxicspikes", 0))
    return [consec_kos, last_switch, min(hazard_layers, 6) / 6.0]


def _setup_features(our_side, their_side) -> list[float]:
    """F. Setup threat (7 features)."""
    their_mon = their_side.active
    our_mon = our_side.active

    opp_has_setup = 1.0 if any(m in SETUP_MOVES for m in their_mon.moves_known) else 0.0

    opp_boost_total = sum(max(0, v) for v in their_mon.boosts.values()) / 12.0
    my_boost_total = sum(max(0, v) for v in our_mon.boosts.values()) / 12.0

    # Approximate setup turns from boost total
    opp_setup_turns = min(sum(max(0, v) for v in their_mon.boosts.values()), 3) / 3.0

    can_phaze = 1.0 if any(m in PHAZE_MOVES for m in our_mon.moves_known) else 0.0
    can_haze = 1.0 if any(m in HAZE_MOVES for m in our_mon.moves_known) else 0.0

    # Unaware on team
    unaware = 1.0 if any(m.ability == "Unaware" for m in our_side.pokemon if m.is_alive) else 0.0

    return [opp_has_setup, opp_boost_total, my_boost_total, opp_setup_turns,
            can_phaze, can_haze, unaware]


def _stall_features(our_side, their_side) -> list[float]:
    """G. Stall/wall (8 features)."""
    their_mon = their_side.active
    our_mon = our_side.active
    my_types = get_types(our_mon.species) if our_mon.species else ["Normal"]
    opp_types = get_types(their_mon.species) if their_mon.species else ["Normal"]

    opp_recovery = 1.0 if any(m in RECOVERY_MOVES for m in their_mon.moves_known) else 0.0
    opp_toxic = 1.0 if any(m in TOXIC_MOVES for m in their_mon.moves_known) else 0.0
    opp_sub = 1.0 if any(m in SUBSTITUTE_MOVES for m in their_mon.moves_known) else 0.0
    opp_protect = 1.0 if any(m in PROTECT_MOVES for m in their_mon.moves_known) else 0.0

    my_best_dmg = _estimate_best_damage_pct(my_types, our_mon.moves_known, opp_types)
    dmg_vs_recovery = np.clip(my_best_dmg - 0.25, -1.0, 1.0)

    toxic_on_me = 1.0 if our_mon.status == "tox" else 0.0
    # Approximate toxic turns from HP lost (rough heuristic)
    toxic_turns = 0.0
    if our_mon.status == "tox":
        hp_lost = 1.0 - our_mon.hp_fraction()
        toxic_turns = min(hp_lost * 8, 8) / 8.0  # rough estimate

    return [opp_recovery, opp_toxic, opp_sub, opp_protect,
            my_best_dmg, dmg_vs_recovery, toxic_on_me, toxic_turns]


def _futility_features(our_side, their_side) -> list[float]:
    """H. Futility (3 features)."""
    our_mon = our_side.active
    their_mon = their_side.active
    my_types = get_types(our_mon.species) if our_mon.species else ["Normal"]
    opp_types = get_types(their_mon.species) if their_mon.species else ["Normal"]

    my_best_dmg = _estimate_best_damage_pct(my_types, our_mon.moves_known, opp_types)
    their_best_dmg = _estimate_best_damage_pct(opp_types, their_mon.moves_known, my_types)

    walled = 1.0 if my_best_dmg < 0.20 else 0.0
    they_walled = 1.0 if their_best_dmg < 0.20 else 0.0

    opp_recovery = any(m in RECOVERY_MOVES for m in their_mon.moves_known)
    futility = 1.0 if walled == 1.0 and opp_recovery else 0.0

    return [walled, they_walled, futility]


def extract_features(state: BattleState, perspective: int) -> np.ndarray:
    """Extract 245-feature vector from battle state for given perspective (0=p1, 1=p2).

    Feature layout:
    - Per-Pokemon x12 (13 each) = 156
    - Matchup = 8
    - Team-level = 12
    - Field = 18
    - Tempo = 12
    - A. Speed = 6
    - B. Type matchup = 5
    - C. Turns-to-KO = 3
    - D. Team composition = 4
    - E. Momentum = 3
    - F. Setup threat = 7
    - G. Stall/wall = 8
    - H. Futility = 3
    Total = 245
    """
    our_side = state.sides[perspective]
    their_side = state.sides[1 - perspective]

    features = []

    # Per-pokemon features (our 6 + their 6 = 12 * 13 = 156)
    for side in [our_side, their_side]:
        for i, mon in enumerate(side.pokemon):
            pf = _pokemon_features(mon)
            # Fix is_active flag (index 1)
            pf[1] = 1.0 if i == side.active_idx and mon.species else 0.0
            features.extend(pf)

    # Matchup (8)
    features.extend(_matchup_features(our_side, their_side))

    # Team-level (12)
    features.extend(_team_features(our_side, their_side))

    # Field (18)
    features.extend(_field_features(state, perspective))

    # Tempo (12)
    features.extend(_tempo_features(state, perspective))

    # --- NEW FEATURES (appended at index 206+) ---
    # A. Speed (6)
    features.extend(_speed_features(our_side, their_side))
    # B. Type matchup (5)
    features.extend(_type_matchup_features(our_side, their_side))
    # C. Turns-to-KO (3)
    features.extend(_ttko_features(our_side, their_side))
    # D. Team composition (4)
    features.extend(_team_comp_features(our_side, their_side))
    # E. Momentum (3)
    features.extend(_momentum_features(state, our_side, their_side, perspective))
    # F. Setup threat (7)
    features.extend(_setup_features(our_side, their_side))
    # G. Stall/wall (8)
    features.extend(_stall_features(our_side, their_side))
    # H. Futility (3)
    features.extend(_futility_features(our_side, their_side))

    assert len(features) == 245, f"Expected 245 features, got {len(features)}"
    return np.array(features, dtype=np.float32)


# Alias for backward compatibility
extract_features_from_state = extract_features


def _resolve_action(sample: dict, state: BattleState) -> int:
    """Map a captured decision to an action index in [0,4], or NO_ACTION (-1).

    Move slot = rank of the chosen move's id among the active mon's full revealed
    moveset (sorted by id). Switch = SWITCH_ACTION regardless of target."""
    action = sample["action"]
    if action is None:
        return NO_ACTION
    if action[0] == "switch":
        return SWITCH_ACTION
    move_name = action[1]
    side = state.sides[sample["perspective"]]
    mon = next((m for m in side.pokemon if m.species == sample["active"]), None)
    if mon is None:
        return NO_ACTION
    move_ids = sorted({_move_id(m) for m in mon.moves_known})
    # Exact slot needs the full 4-move set (ranking among <4 revealed would not match
    # the live |request|). If unknown, still record that it WAS a move (not a switch).
    if len(move_ids) != 4:
        return MOVE_UNKNOWN
    mid = _move_id(move_name)
    if mid not in move_ids:
        return MOVE_UNKNOWN
    return move_ids.index(mid)


def process_replay(replay_data: dict) -> list[tuple[np.ndarray, float, int]]:
    """Process a replay into (features, win_label, action_index) triples from both
    perspectives. action_index is NO_ACTION (-1) when the chosen action can't be
    resolved (e.g. the side made no move that turn, or the move id is ambiguous)."""
    log = replay_data.get("log", "")
    if not log:
        return []

    players = {}  # "p1"/"p2" -> player name
    state = BattleState()
    samples = []
    pending = {}  # perspective -> sample awaiting this turn's chosen action

    for line in log.split("\n"):
        line = line.strip()
        if not line or not line.startswith("|"):
            continue

        parts = line.split("|")
        if len(parts) >= 4 and parts[1] == "player":
            players[parts[2]] = parts[3]

        # Emit features at each turn boundary (state BEFORE the turn's actions run);
        # the chosen action is captured from the |move|/|switch| lines that follow.
        if parts[1] == "turn" and state.turn > 0:
            pending = {}
            for perspective in [0, 1]:
                feat = extract_features(state, perspective)
                s = {"feat": feat, "perspective": perspective,
                     "active": state.sides[perspective].active.species, "action": None}
                samples.append(s)
                pending[perspective] = s

        # Capture each side's FIRST action this turn = its start-of-turn decision.
        if parts[1] in ("move", "switch") and len(parts) >= 3:
            side_idx, _ = parse_pokemon_ident(parts[2])
            s = pending.get(side_idx)
            if s is not None and s["action"] is None:
                if parts[1] == "move" and len(parts) >= 4:
                    s["action"] = ("move", parts[3])
                elif parts[1] == "switch":
                    s["action"] = ("switch",)

        update_state(state, line)

    if not state.winner:
        return []

    winner_side = -1
    for pid, name in players.items():
        if name == state.winner:
            winner_side = 0 if pid == "p1" else 1
            break
    if winner_side == -1:
        return []

    out = []
    for s in samples:
        label = 1.0 if s["perspective"] == winner_side else 0.0
        out.append((s["feat"], label, _resolve_action(s, state)))
    return out


def extract_from_directory(input_dir: str, output_path: str):
    """Process all replay files and save as .npz."""
    input_path = Path(input_dir)
    replay_files = list(input_path.glob("*.json"))

    if not replay_files:
        print(f"No replay files found in {input_dir}")
        return

    all_features = []
    all_labels = []
    all_actions = []

    for filepath in tqdm(replay_files, desc="Extracting features"):
        try:
            data = json.loads(filepath.read_text())
            samples = process_replay(data)
            for feat, label, action in samples:
                all_features.append(feat)
                all_labels.append(label)
                all_actions.append(action)
        except (json.JSONDecodeError, KeyError, ValueError):
            continue

    if not all_features:
        print("No valid samples extracted.")
        return

    features = np.stack(all_features)
    labels = np.array(all_labels, dtype=np.float32)
    actions = np.array(all_actions, dtype=np.int64)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez(output, features=features, labels=labels, actions=actions)
    captured = actions != NO_ACTION
    is_switch = actions == SWITCH_ACTION
    move_known = (actions >= 0) & (actions < 4)
    move_unknown = actions == MOVE_UNKNOWN
    print(f"Saved {len(labels)} samples ({labels.mean():.2%} win rate) to {output_path}")
    print(f"  actions captured: {captured.mean():.1%}; of captured -> "
          f"switch {is_switch.sum()/max(1,captured.sum()):.1%}, "
          f"move {(move_known|move_unknown).sum()/max(1,captured.sum()):.1%} "
          f"(slot-resolved {move_known.sum()/max(1,(move_known|move_unknown).sum()):.1%})")
    print(f"  move-slot dist (0-3): {np.bincount(actions[move_known], minlength=4).tolist()}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Extract features from replay logs")
    parser.add_argument("--input", default="data/replays")
    parser.add_argument("--output", default="data/training_data.npz")
    args = parser.parse_args()
    extract_from_directory(args.input, args.output)
