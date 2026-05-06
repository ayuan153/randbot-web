"""Train a value network to predict win probability from battle state features."""

import numpy as np
import torch
import torch.nn as nn
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


def train(data_path: str, output_path: str, epochs: int = 50, batch_size: int = 512, lr: float = 1e-3):
    """Train ValueNet on extracted features.

    Args:
        data_path: Path to .npz file with 'features' and 'labels' arrays.
        output_path: Where to save the best model weights.
        epochs: Number of training epochs.
        batch_size: Mini-batch size.
        lr: Learning rate for Adam optimizer.
    """
    # Load data
    data = np.load(data_path)
    X, y = data["features"], data["labels"]
    print(f"Loaded {len(X)} samples, {X.shape[1]} features, {y.mean():.2%} win rate")

    # Train/val split (90/10)
    n = len(X)
    idx = np.random.permutation(n)
    split = int(0.9 * n)
    X_train, X_val = X[idx[:split]], X[idx[split:]]
    y_train, y_val = y[idx[:split]], y[idx[split:]]

    # To tensors
    X_train = torch.FloatTensor(X_train)
    y_train = torch.FloatTensor(y_train).unsqueeze(1)
    X_val = torch.FloatTensor(X_val)
    y_val = torch.FloatTensor(y_val).unsqueeze(1)

    # Model
    model = ValueNet(input_dim=X_train.shape[1])
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.BCELoss()

    # Training loop
    dataset = torch.utils.data.TensorDataset(X_train, y_train)
    loader = torch.utils.data.DataLoader(dataset, batch_size=batch_size, shuffle=True)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    best_val_acc = 0.0

    for epoch in range(epochs):
        model.train()
        for xb, yb in loader:
            pred = model(xb)
            loss = criterion(pred, yb)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

        # Validation
        model.eval()
        with torch.no_grad():
            val_pred = model(X_val)
            val_loss = criterion(val_pred, y_val).item()
            val_acc = ((val_pred > 0.5) == y_val).float().mean().item()

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            torch.save(model.state_dict(), output_path)

        print(f"Epoch {epoch+1}/{epochs} | Val Loss: {val_loss:.4f} | Val Acc: {val_acc:.4f} | Best: {best_val_acc:.4f}")

    print(f"Training complete. Best val accuracy: {best_val_acc:.4f}")
    return model


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Train value network")
    parser.add_argument("--data", default="data/training_data.npz")
    parser.add_argument("--output", default="models/value-net-v1.pt")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--lr", type=float, default=1e-3)
    args = parser.parse_args()
    train(args.data, args.output, args.epochs, args.batch_size, args.lr)
