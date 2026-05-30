"""
alphazero_loop.py — AlphaZero-style training loop for the PolicyValueNet.

Initial version: trains from game data (JSONL from sim-server).
Future: will use MCTS self-play to generate training data.

Loss: L = -π·log(p) + (z - v)²
  - π: MCTS visit probabilities (target policy)
  - p: model policy output
  - z: game outcome (+1 win, -1 loss)
  - v: model value output

Usage:
    python alphazero_loop.py --data games.jsonl --epochs 20 --output model.onnx
"""

import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset
from tqdm import tqdm

from policy_value_net import PolicyValueNet

# ─── Config ───────────────────────────────────────────────────────────────────

DEFAULT_CONFIG = {
    "input_dim": 20,
    "max_actions": 10,
    "batch_size": 256,
    "learning_rate": 1e-3,
    "weight_decay": 1e-4,
    "epochs": 20,
    "games_per_iter": 100,  # for future self-play
}


# ─── Feature extraction ───────────────────────────────────────────────────────

FEATURE_DIM = 20  # Fixed feature vector size for self-play training


def parse_hp_fraction(condition: str) -> float:
    """Parse PS condition string like '248/300' or '0 fnt' to HP fraction."""
    if not condition or 'fnt' in condition:
        return 0.0
    parts = condition.split('/')
    if len(parts) < 2:
        return 0.0
    try:
        hp = int(parts[0])
        maxhp = int(parts[1].split()[0])
        return hp / maxhp if maxhp > 0 else 0.0
    except (ValueError, IndexError):
        return 0.0


def parse_choice(choice: str) -> int:
    """Parse PS choice string to action index 0-9.
    move 1-4 → 0-3, switch 2-6 → 4-8, switch 1 → 9 (rare, but possible)
    """
    if not choice:
        return 0
    parts = choice.strip().split()
    if len(parts) < 2:
        return 0
    action_type, num = parts[0], int(parts[1])
    if action_type == 'move':
        return min(num - 1, 3)  # move 1-4 → 0-3
    elif action_type == 'switch':
        # switch 1-6 → indices 4-9
        return min(num - 1 + 4, 9)
    return 0


def get_action_mask(request: dict) -> np.ndarray:
    """Build action mask from request's available moves/switches."""
    mask = np.zeros(10, dtype=np.float32)
    # Moves
    active = request.get('active', [{}])
    if active:
        moves = active[0].get('moves', [])
        for i, m in enumerate(moves[:4]):
            if not m.get('disabled', False):
                mask[i] = 1.0
    # Switches
    for mon in request.get('side', {}).get('pokemon', []):
        if mon.get('active'):
            continue
        if 'fnt' in mon.get('condition', ''):
            continue
        # Find slot index (1-based position in team)
        team = request['side']['pokemon']
        idx = team.index(mon)
        mask[min(idx + 4, 9)] = 1.0
    # If forced switch (no active moves available), only switches are legal
    if request.get('forceSwitch'):
        mask[:4] = 0.0
    return mask


def extract_features_from_request(request: dict, opp_request: dict, turn_num: int) -> np.ndarray:
    """Extract 20-dim feature vector from PS request objects.

    Features:
      0-5:  My 6 mons HP fraction
      6-11: Opp 6 mons HP fraction
      12:   My alive count / 6
      13:   Opp alive count / 6
      14:   My active HP fraction
      15:   Opp active HP fraction
      16:   Num moves available / 4
      17:   Turn number / 100
      18:   Is forced switch
      19:   Padding (0)
    """
    features = np.zeros(FEATURE_DIM, dtype=np.float32)

    # My team HP fractions
    my_team = request.get('side', {}).get('pokemon', [])
    my_alive = 0
    for i, mon in enumerate(my_team[:6]):
        hp = parse_hp_fraction(mon.get('condition', '0 fnt'))
        features[i] = hp
        if hp > 0:
            my_alive += 1

    # Opp team HP fractions
    opp_team = opp_request.get('side', {}).get('pokemon', [])
    opp_alive = 0
    for i, mon in enumerate(opp_team[:6]):
        hp = parse_hp_fraction(mon.get('condition', '0 fnt'))
        features[6 + i] = hp
        if hp > 0:
            opp_alive += 1

    features[12] = my_alive / 6.0
    features[13] = opp_alive / 6.0

    # Active HP (first mon marked active, or index 0)
    features[14] = features[0]
    for i, mon in enumerate(my_team[:6]):
        if mon.get('active'):
            features[14] = features[i]
            break
    features[15] = features[6]
    for i, mon in enumerate(opp_team[:6]):
        if mon.get('active'):
            features[15] = features[6 + i]
            break

    # Moves available
    active = request.get('active', [{}])
    if active:
        moves = [m for m in active[0].get('moves', []) if not m.get('disabled')]
        features[16] = len(moves) / 4.0

    features[17] = min(turn_num / 100.0, 1.0)
    features[18] = 1.0 if request.get('forceSwitch') else 0.0

    return features


# ─── Data loading ─────────────────────────────────────────────────────────────

def load_game_data(data_path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Load training data from sim-server JSONL.

    Each line is a game: {"winner": "p1"|"p2", "numTurns": N, "turns": [...]}
    Each turn: {"turn": N, "p1Request": {...}, "p2Request": {...}, "p1Choice": "...", "p2Choice": "..."}

    Returns: (states, policies, values) as numpy arrays
    """
    states, policies, values = [], [], []

    with open(data_path) as f:
        for line in f:
            if not line.strip():
                continue
            game = json.loads(line)
            winner = game.get("winner", "")
            turns = game.get("turns", [])

            for turn_data in turns:
                turn_num = turn_data.get("turn", 0)

                # Generate samples from both players' perspectives
                for player in ("p1", "p2"):
                    opp = "p2" if player == "p1" else "p1"
                    request = turn_data.get(f"{player}Request")
                    opp_request = turn_data.get(f"{opp}Request")
                    choice = turn_data.get(f"{player}Choice", "")

                    if not request or not opp_request or not choice:
                        continue

                    # Features
                    feats = extract_features_from_request(request, opp_request, turn_num)
                    states.append(feats)

                    # Policy target: use MCTS visit probs if available, else one-hot from choice
                    mcts_policy = turn_data.get(f"{player}Policy")
                    action_idx = parse_choice(choice)
                    policy = np.zeros(10, dtype=np.float32)

                    if mcts_policy and isinstance(mcts_policy, dict):
                        # Map MCTS action probs to the 10-action index space
                        for action_str, prob in mcts_policy.items():
                            idx = parse_choice(action_str)
                            policy[idx] += prob
                        # Renormalize in case of rounding
                        total = policy.sum()
                        if total > 0:
                            policy /= total
                        else:
                            policy[action_idx] = 1.0
                    else:
                        # Fallback: one-hot with uniform baseline over legal actions
                        mask = get_action_mask(request)
                        if mask.sum() > 0:
                            policy = mask / mask.sum()  # uniform baseline
                        policy[action_idx] = 1.0
                        policy /= policy.sum()  # renormalize
                    policies.append(policy)

                    # Value target
                    value = 1.0 if winner == player else -1.0
                    values.append(value)

    if not states:
        raise ValueError(f"No training samples extracted from {data_path}")

    return (
        np.array(states, dtype=np.float32),
        np.array(policies, dtype=np.float32),
        np.array(values, dtype=np.float32).reshape(-1, 1),
    )


def generate_synthetic_data(num_samples: int = 1000) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Generate synthetic training data for testing the pipeline."""
    states = np.random.randn(num_samples, FEATURE_DIM).astype(np.float32)
    policies = np.zeros((num_samples, 10), dtype=np.float32)
    policies[:, :6] = 1.0 / 6.0
    values = np.random.choice([-1.0, 1.0], size=(num_samples, 1)).astype(np.float32)
    return states, policies, values


# ─── Training ─────────────────────────────────────────────────────────────────

def train_model(
    model: PolicyValueNet,
    states: np.ndarray,
    policies: np.ndarray,
    values: np.ndarray,
    config: dict,
) -> list[float]:
    """
    Train the model on collected data.

    Returns list of per-epoch losses.
    """
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}", flush=True)
    model = model.to(device)
    model.train()

    dataset = TensorDataset(
        torch.from_numpy(states),
        torch.from_numpy(policies),
        torch.from_numpy(values),
    )
    loader = DataLoader(dataset, batch_size=config["batch_size"], shuffle=True)

    optimizer = optim.Adam(
        model.parameters(),
        lr=config["learning_rate"],
        weight_decay=config["weight_decay"],
    )

    epoch_losses = []

    for epoch in range(config["epochs"]):
        total_loss = 0.0
        num_batches = 0

        for batch_states, batch_policies, batch_values in tqdm(
            loader, desc=f"Epoch {epoch + 1}/{config['epochs']}", leave=False
        ):
            batch_states = batch_states.to(device)
            batch_policies = batch_policies.to(device)
            batch_values = batch_values.to(device)

            # Forward
            pred_policy, pred_value = model(batch_states)

            # Policy loss: cross-entropy  -π·log(p)
            policy_loss = -torch.sum(batch_policies * torch.log(pred_policy + 1e-8)) / batch_states.size(0)

            # Value loss: MSE  (z - v)²
            value_loss = nn.functional.mse_loss(pred_value, batch_values)

            loss = policy_loss + value_loss

            # Backward
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            total_loss += loss.item()
            num_batches += 1

        avg_loss = total_loss / max(num_batches, 1)
        epoch_losses.append(avg_loss)
        print(f"  Epoch {epoch + 1}: loss = {avg_loss:.4f}")

    return epoch_losses


# ─── Export ───────────────────────────────────────────────────────────────────

def export_onnx(model: PolicyValueNet, output_path: str, input_dim: int = 245) -> None:
    """Export trained model to ONNX format for browser inference."""
    model = model.to("cpu")
    model.eval()
    dummy_input = torch.randn(1, input_dim)

    torch.onnx.export(
        model,
        dummy_input,
        output_path,
        input_names=["features"],
        output_names=["policy", "value"],
        dynamic_axes={
            "features": {0: "batch"},
            "policy": {0: "batch"},
            "value": {0: "batch"},
        },
        opset_version=17,
    )
    print(f"Exported ONNX model to {output_path}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="AlphaZero training loop")
    parser.add_argument("--data", type=str, help="Path to JSONL training data")
    parser.add_argument("--synthetic", action="store_true", help="Use synthetic data for testing")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--output", type=str, default="policy_value_net.onnx")
    parser.add_argument("--checkpoint", type=str, default="checkpoint.pt")
    args = parser.parse_args()

    config = {**DEFAULT_CONFIG, "epochs": args.epochs, "batch_size": args.batch_size, "learning_rate": args.lr}

    # Load data
    if args.data:
        print(f"Loading data from {args.data}...")
        states, policies, values = load_game_data(args.data)
    elif args.synthetic:
        print("Generating synthetic data for pipeline test...")
        states, policies, values = generate_synthetic_data(2000)
    else:
        parser.error("Provide --data or --synthetic")

    print(f"Training data: {states.shape[0]} samples, {states.shape[1]} features")

    # Train
    model = PolicyValueNet(input_dim=config["input_dim"], max_actions=config["max_actions"])
    losses = train_model(model, states, policies, values, config)

    # Save checkpoint
    torch.save({"model_state_dict": model.state_dict(), "losses": losses}, args.checkpoint)
    print(f"Saved checkpoint to {args.checkpoint}")

    # Export ONNX
    export_onnx(model, args.output, input_dim=config["input_dim"])


if __name__ == "__main__":
    main()
