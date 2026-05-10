#!/bin/bash
set -euo pipefail

# Resolve script directory (works both locally and in Docker)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

NUM_GAMES=${NUM_GAMES:-10000}
NUM_WORKERS=${NUM_WORKERS:-8}
NUM_ITERATIONS=${NUM_ITERATIONS:-100}
OUTPUT_DIR=${OUTPUT_DIR:-$SCRIPT_DIR/output}
EPOCHS=${EPOCHS:-20}

mkdir -p "$OUTPUT_DIR/games" "$OUTPUT_DIR/models"

PREV_CHECKPOINT=""

for i in $(seq 1 $NUM_ITERATIONS); do
    echo "=== Iteration $i/$NUM_ITERATIONS ==="

    # 1. Self-play
    echo "Running $NUM_GAMES self-play games..."
    node --import tsx "$SCRIPT_DIR/sim/sim-server.ts" \
        --games "$NUM_GAMES" \
        --workers "$NUM_WORKERS" \
        --output "$OUTPUT_DIR/games/iter_${i}.jsonl"

    # 2. Train
    echo "Training on collected games..."
    CHECKPOINT_ARGS=""
    if [ -n "$PREV_CHECKPOINT" ] && [ -f "$PREV_CHECKPOINT" ]; then
        CHECKPOINT_ARGS="--checkpoint $PREV_CHECKPOINT"
    fi

    python3 "$SCRIPT_DIR/training/alphazero_loop.py" \
        --data "$OUTPUT_DIR/games/iter_${i}.jsonl" \
        --epochs "$EPOCHS" \
        --output "$OUTPUT_DIR/models/iter_${i}.onnx" \
        $CHECKPOINT_ARGS

    PREV_CHECKPOINT="$OUTPUT_DIR/models/checkpoint.pt"

    echo "Iteration $i complete."
done

echo "Training complete. Models saved to $OUTPUT_DIR/models/"
