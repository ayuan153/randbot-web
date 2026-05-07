#!/bin/bash
set -euo pipefail

NUM_GAMES=${NUM_GAMES:-10000}
NUM_WORKERS=${NUM_WORKERS:-8}
NUM_ITERATIONS=${NUM_ITERATIONS:-100}
OUTPUT_DIR=${OUTPUT_DIR:-/app/output}

mkdir -p $OUTPUT_DIR/games $OUTPUT_DIR/models

for i in $(seq 1 $NUM_ITERATIONS); do
    echo "=== Iteration $i/$NUM_ITERATIONS ==="

    # 1. Self-play
    echo "Running $NUM_GAMES self-play games..."
    cd /app/self-play
    node --import tsx sim/sim-server.ts \
        --games $NUM_GAMES \
        --workers $NUM_WORKERS \
        --output $OUTPUT_DIR/games/iter_${i}.jsonl

    # 2. Train
    echo "Training on collected games..."
    cd /app/training
    python3 alphazero_loop.py \
        --games-dir $OUTPUT_DIR/games \
        --model-dir $OUTPUT_DIR/models \
        --iteration $i

    echo "Iteration $i complete."
done

echo "Training complete. Models saved to $OUTPUT_DIR/models/"
