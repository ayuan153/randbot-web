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

FEATURE_DIM = 225  # Rich feature vector from net-features.ts extractFeatures()

DEFAULT_CONFIG = {
    "input_dim": FEATURE_DIM,
    "max_actions": 10,
    "batch_size": 256,
    "learning_rate": 1e-3,
    "weight_decay": 1e-4,
    "epochs": 20,
    "games_per_iter": 100,  # for future self-play
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

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


# ─── Data loading ─────────────────────────────────────────────────────────────

def load_game_data(data_path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Load training data from sim-server JSONL.

    Each line is a game: {"winner": "p1"|"p2", "numTurns": N, "turns": [...]}
    Each turn has pre-recorded p1Features/p2Features (225-dim vectors).

    Emits TWO samples per turn (perspective-symmetric):
      - sample A: p1's features, p1's policy target, p1's value
      - sample B: p2's features, p2's policy target, p2's value

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
                for player in ("p1", "p2"):
                    feats = turn_data.get(f"{player}Features")
                    if not feats or len(feats) != FEATURE_DIM:
                        continue

                    choice = turn_data.get(f"{player}Choice", "")
                    action_idx = parse_choice(choice)

                    # Policy target: MCTS visit probs if available, else one-hot
                    mcts_policy = turn_data.get(f"{player}Policy")
                    policy = np.zeros(10, dtype=np.float32)

                    if mcts_policy and isinstance(mcts_policy, dict):
                        for action_str, prob in mcts_policy.items():
                            idx = parse_choice(action_str)
                            policy[idx] += prob
                        total = policy.sum()
                        if total > 0:
                            policy /= total
                        else:
                            policy[action_idx] = 1.0
                    else:
                        policy[action_idx] = 1.0

                    states.append(np.array(feats, dtype=np.float32))
                    policies.append(policy)

                    # Value target: +1 if this player won, -1 if lost, 0 draw
                    if winner == player:
                        value = 1.0
                    elif winner == ("p2" if player == "p1" else "p1"):
                        value = -1.0
                    else:
                        value = 0.0
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

def export_onnx(model: PolicyValueNet, output_path: str, input_dim: int = FEATURE_DIM) -> None:
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
