# Training Pipeline

Trains a value network to predict win probability from Pokemon battle state features.
The trained model is exported to ONNX for use in the browser extension's eval worker.

## Setup

```bash
cd training
pip install -r requirements.txt
```

## Pipeline

Run all commands from the `training/` directory:

```bash
# 1. Download replays (rated 1400+ Gen 9 Random Battle)
python -m scraper.download_replays --count 100000

# 2. Extract 206-feature vectors from replay logs
python -m features.extract_features --input data/replays --output data/training_data.npz

# 3. Train the value network
python -m train.train_model --data data/training_data.npz --output models/value-net-v1.pt

# 4. Export to ONNX for browser inference
python -m export.export_onnx --model models/value-net-v1.pt --output models/value-net-v1.onnx
```

## Feature Vector (206 dimensions)

| Group | Count | Description |
|-------|-------|-------------|
| Per-Pokemon ×12 | 156 | hp%, active, alive, status(7), boosts(5), has_item |
| Matchup | 8 | Type effectiveness, speed, turns-to-KO, OHKO flags |
| Team-level | 12 | Alive counts, HP totals, hazards, coverage, status |
| Field | 18 | Weather(6), terrain(5), screens(4), tailwind(2), trick room(1) |
| Tempo | 12 | Setup, KO threats, momentum, tera status, turn |

## Model Architecture

```
Input(206) → Linear(256) → ReLU → Dropout(0.2)
           → Linear(128) → ReLU → Dropout(0.1)
           → Linear(64)  → ReLU
           → Linear(1)   → Sigmoid → win_probability
```

## Output

- `models/value-net-v1.pt` — PyTorch weights
- `models/value-net-v1.onnx` — ONNX model for browser (ONNX Runtime Web)
