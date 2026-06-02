"""Train a value network to predict win probability from battle state features."""

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path


class ValueNet(nn.Module):
    """MLP value network: 206 features -> win probability."""

    def __init__(self, input_dim: int = 206):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 256),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(256, 128),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
            nn.Sigmoid(),
        )

    def forward(self, x):
        return self.net(x)


# Policy action space (must match training/features/extract_features.py)
ACTION_DIM = 5
SWITCH_ACTION = 4
NO_ACTION = -1
MOVE_UNKNOWN = -2


class DualNet(nn.Module):
    """Shared-backbone value + policy net. value=win prob, policy=logits over
    [move0..3, switch] (size 5). Imitation prior from human replays."""

    def __init__(self, input_dim: int = 245, action_dim: int = ACTION_DIM):
        super().__init__()
        self.backbone = nn.Sequential(
            nn.Linear(input_dim, 256), nn.ReLU(), nn.Dropout(0.2),
            nn.Linear(256, 128), nn.ReLU(), nn.Dropout(0.1),
        )
        self.value_head = nn.Sequential(
            nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, 1), nn.Sigmoid())
        self.policy_head = nn.Sequential(
            nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, action_dim))

    def forward(self, x):
        h = self.backbone(x)
        return self.value_head(h), self.policy_head(h)


def policy_loss(logits: torch.Tensor, actions: torch.Tensor) -> torch.Tensor:
    """Cross-entropy over resolved actions (0-4) + a 'not-switch' marginal for
    MOVE_UNKNOWN (-2) samples (we know it was a move but not which slot). NO_ACTION
    (-1) is ignored. Returns mean over policy-relevant samples (0 if none)."""
    logp = F.log_softmax(logits, dim=1)
    resolved = actions >= 0
    mu = actions == MOVE_UNKNOWN
    total = torch.zeros((), device=logits.device)
    n = 0
    if resolved.any():
        total = total - logp[resolved].gather(1, actions[resolved].unsqueeze(1)).sum()
        n += int(resolved.sum())
    if mu.any():
        # log P(move) = logsumexp(move logits) - logsumexp(all logits)
        logp_move = (torch.logsumexp(logits[mu, :SWITCH_ACTION], dim=1)
                     - torch.logsumexp(logits[mu], dim=1))
        total = total - logp_move.sum()
        n += int(mu.sum())
    return total / n if n else total


def train(data_path: str, output_path: str, epochs: int = 50, batch_size: int = 512,
          lr: float = 1e-3, policy_weight: float = 0.5):
    """Train DualNet (value + policy) on extracted features.

    npz keys: 'features' [N,D], 'labels' [N] (win 0/1), 'actions' [N] (0-4, or -2
    move-unknown, -1 none). If 'actions' is absent, trains value-only (policy idle).
    Saves the BEST net by (val win-acc + val move-top1).
    """
    data = np.load(data_path)
    X, y = data["features"], data["labels"]
    a = data["actions"].astype(np.int64) if "actions" in data else np.full(len(X), NO_ACTION, np.int64)
    print(f"Loaded {len(X)} samples, {X.shape[1]} features, {y.mean():.2%} win rate, "
          f"{(a != NO_ACTION).mean():.1%} policy-labeled")

    # Train/val split (90/10)
    idx = np.random.permutation(len(X))
    split = int(0.9 * len(X))
    tr, va = idx[:split], idx[split:]
    Xtr, ytr, atr = torch.FloatTensor(X[tr]), torch.FloatTensor(y[tr]).unsqueeze(1), torch.LongTensor(a[tr])
    Xva, yva, ava = torch.FloatTensor(X[va]), torch.FloatTensor(y[va]).unsqueeze(1), torch.LongTensor(a[va])

    model = DualNet(input_dim=X.shape[1])
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    bce = nn.BCELoss()
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(Xtr, ytr, atr), batch_size=batch_size, shuffle=True)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    best_score = -1.0

    for epoch in range(epochs):
        model.train()
        for xb, yb, ab in loader:
            v, logits = model(xb)
            loss = bce(v, yb) + policy_weight * policy_loss(logits, ab)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

        model.eval()
        with torch.no_grad():
            v, logits = model(Xva)
            val_loss = bce(v, yva).item()
            win_acc = ((v > 0.5) == yva).float().mean().item()
            # Binary move/switch accuracy over policy-relevant samples (baseline ~75%)
            relevant = (ava >= 0) | (ava == MOVE_UNKNOWN)
            pred_sw = logits.argmax(1) == SWITCH_ACTION
            ms_acc = ((pred_sw == (ava == SWITCH_ACTION))[relevant].float().mean().item()
                      if relevant.any() else 0.0)
            # Top-1 move-match on slot-resolved moves (argmax over 4 move logits, baseline 25%)
            mv = (ava >= 0) & (ava < SWITCH_ACTION)
            move_top1 = ((logits[mv, :SWITCH_ACTION].argmax(1) == ava[mv]).float().mean().item()
                         if mv.any() else 0.0)

        score = win_acc + move_top1
        star = ""
        if score > best_score:
            best_score = score
            torch.save(model.state_dict(), output_path)
            star = " *"
        print(f"Epoch {epoch+1}/{epochs} | val_loss {val_loss:.4f} | win_acc {win_acc:.4f} | "
              f"move/switch {ms_acc:.4f} | move_top1 {move_top1:.4f}{star}")

    print(f"Training complete. Best (win_acc+move_top1)={best_score:.4f}; saved to {output_path}")
    return model


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Train value network")
    parser.add_argument("--data", default="data/training_data.npz")
    parser.add_argument("--output", default="models/value-net-v1.pt")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--policy-weight", type=float, default=0.5)
    args = parser.parse_args()
    train(args.data, args.output, args.epochs, args.batch_size, args.lr, args.policy_weight)
