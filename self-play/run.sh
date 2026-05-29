#!/bin/bash
set -euo pipefail

# Resolve directories (works both locally and in Docker)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Find self-play dir (has sim/ subdirectory)
if [ -d "$SCRIPT_DIR/sim" ]; then
    SELF_PLAY_DIR="$SCRIPT_DIR"
elif [ -d "$SCRIPT_DIR/self-play/sim" ]; then
    SELF_PLAY_DIR="$SCRIPT_DIR/self-play"
else
    echo "ERROR: Cannot find sim/ directory" >&2; exit 1
fi

# Find training script
if [ -f "$SELF_PLAY_DIR/training/alphazero_loop.py" ]; then
    TRAIN_SCRIPT="$SELF_PLAY_DIR/training/alphazero_loop.py"
elif [ -f "$SCRIPT_DIR/training/alphazero_loop.py" ]; then
    TRAIN_SCRIPT="$SCRIPT_DIR/training/alphazero_loop.py"
elif [ -f "/app/training/alphazero_loop.py" ]; then
    TRAIN_SCRIPT="/app/training/alphazero_loop.py"
else
    echo "ERROR: Cannot find alphazero_loop.py" >&2; exit 1
fi

NUM_GAMES=${NUM_GAMES:-10000}
NUM_WORKERS=${NUM_WORKERS:-8}
NUM_ITERATIONS=${NUM_ITERATIONS:-100}
OUTPUT_DIR=${OUTPUT_DIR:-$SELF_PLAY_DIR/output}
EPOCHS=${EPOCHS:-20}

mkdir -p "$OUTPUT_DIR/games" "$OUTPUT_DIR/models"

PREV_CHECKPOINT=""

for i in $(seq 1 $NUM_ITERATIONS); do
    echo "=== Iteration $i/$NUM_ITERATIONS ==="

    # 1. Self-play
    echo "Running $NUM_GAMES self-play games..."
    cd "$SELF_PLAY_DIR"
    node --import tsx sim/sim-server.ts \
        --games "$NUM_GAMES" \
        --workers "$NUM_WORKERS" \
        --output "$OUTPUT_DIR/games/iter_${i}.jsonl"

    # 2. Train
    echo "Training on collected games..."
    CHECKPOINT_ARGS=""
    if [ -n "$PREV_CHECKPOINT" ] && [ -f "$PREV_CHECKPOINT" ]; then
        CHECKPOINT_ARGS="--checkpoint $PREV_CHECKPOINT"
    fi

    python3 "$TRAIN_SCRIPT" \
        --data "$OUTPUT_DIR/games/iter_${i}.jsonl" \
        --epochs "$EPOCHS" \
        --output "$OUTPUT_DIR/models/iter_${i}.onnx" \
        --checkpoint "$OUTPUT_DIR/models/checkpoint.pt" \
        $CHECKPOINT_ARGS

    PREV_CHECKPOINT="$OUTPUT_DIR/models/checkpoint.pt"

    echo "Iteration $i complete."
done

echo "Training complete. Models saved to $OUTPUT_DIR/models/"

# Persist artifacts to SageMaker's model dir (only present on SageMaker)
if [ -d /opt/ml/model ]; then
  cp -r "$OUTPUT_DIR/models/." /opt/ml/model/
  echo "Copied artifacts to /opt/ml/model/"
fi
