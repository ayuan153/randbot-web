"""Extract 206-feature vectors from replay protocol logs for training."""

import json
from pathlib import Path

import numpy as np
from tqdm import tqdm

from .battle_state import BattleState, update_state
from .type_chart import type_effectiveness

# Status encoding: maps status string to normalized float
STATUS_MAP = {"": 0.0, "brn": 1/6, "par": 2/6, "slp": 3/6, "frz": 4/6, "psn": 5/6, "tox": 1.0}
# Weather one-hot order
WEATHERS = ["SunnyDay", "RainDance", "Sandstorm", "Snow", "Desolate Land", "Primordial Sea"]
# Terrain one-hot order
TERRAINS = ["electric", "grassy", "misty", "psychic", ""]


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


def extract_features(state: BattleState, perspective: int) -> np.ndarray:
    """Extract 206-feature vector from battle state for given perspective (0=p1, 1=p2).

    Feature layout:
    - Per-Pokemon x12 (13 each) = 156
    - Matchup = 8
    - Team-level = 12
    - Field = 18
    - Tempo = 12
    Total = 206
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

    assert len(features) == 206, f"Expected 206 features, got {len(features)}"
    return np.array(features, dtype=np.float32)


def process_replay(replay_data: dict) -> list[tuple[np.ndarray, float]]:
    """Process a single replay into (features, label) pairs from both perspectives."""
    log = replay_data.get("log", "")
    if not log:
        return []

    players = {}  # "p1" -> player name, "p2" -> player name
    state = BattleState()
    samples = []

    for line in log.split("\n"):
        line = line.strip()
        if not line or not line.startswith("|"):
            continue

        parts = line.split("|")
        if len(parts) >= 3 and parts[1] == "player":
            player_id = parts[2]  # "p1" or "p2"
            if len(parts) >= 4:
                players[player_id] = parts[3]

        # Extract features at each turn boundary
        if parts[1] == "turn" and state.turn > 0:
            # We don't know winner yet, store state snapshot
            for perspective in [0, 1]:
                feat = extract_features(state, perspective)
                samples.append((feat, perspective))

        update_state(state, line)

    # Determine winner
    if not state.winner:
        return []

    winner_side = -1
    for pid, name in players.items():
        if name == state.winner:
            winner_side = 0 if pid == "p1" else 1
            break

    if winner_side == -1:
        return []

    # Assign labels
    labeled = []
    for feat, perspective in samples:
        label = 1.0 if perspective == winner_side else 0.0
        labeled.append((feat, label))

    return labeled


def extract_from_directory(input_dir: str, output_path: str):
    """Process all replay files and save as .npz."""
    input_path = Path(input_dir)
    replay_files = list(input_path.glob("*.json"))

    if not replay_files:
        print(f"No replay files found in {input_dir}")
        return

    all_features = []
    all_labels = []

    for filepath in tqdm(replay_files, desc="Extracting features"):
        try:
            data = json.loads(filepath.read_text())
            samples = process_replay(data)
            for feat, label in samples:
                all_features.append(feat)
                all_labels.append(label)
        except (json.JSONDecodeError, KeyError, ValueError):
            continue

    if not all_features:
        print("No valid samples extracted.")
        return

    features = np.stack(all_features)
    labels = np.array(all_labels, dtype=np.float32)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez(output, features=features, labels=labels)
    print(f"Saved {len(labels)} samples ({labels.mean():.2%} win rate) to {output_path}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Extract features from replay logs")
    parser.add_argument("--input", default="data/replays")
    parser.add_argument("--output", default="data/training_data.npz")
    args = parser.parse_args()
    extract_from_directory(args.input, args.output)
