#!/usr/bin/env bash
# Retrain imitation-dual-v2 on features regenerated with complete @pkmn data tables.
# Steps: extract 100K features -> train 20ep (value+policy) -> export 265-d ONNX.
# Writes progress to the log it is launched with; touches a status marker on finish.
set -uo pipefail
cd "$(dirname "$0")"   # -> training/

STATUS=/tmp/retrain_v2.status
rm -f "$STATUS"

run() {
  echo "=== [$(date '+%H:%M:%S')] $* ==="
  "$@"
}

{
  echo "START $(date)"

  # Back up the existing (garbage-trained) model so the swap is reversible.
  if [ -f ../models/imitation-dual-v2.onnx ]; then
    cp ../models/imitation-dual-v2.onnx ../models/imitation-dual-v2.onnx.bak
    [ -f ../models/imitation-dual-v2.onnx.data ] && cp ../models/imitation-dual-v2.onnx.data ../models/imitation-dual-v2.onnx.data.bak
    echo "backed up old model to *.bak"
  fi

  run python3 -m features.extract_features --input data/replays --output /tmp/d.npz --min-rating 1500 --limit 100000 || { echo FAIL_EXTRACT > "$STATUS"; exit 1; }
  run python3 -m train.train_model --data /tmp/d.npz --output /tmp/m.pt --epochs 20 --batch-size 1024 --policy-weight 0.5 || { echo FAIL_TRAIN > "$STATUS"; exit 1; }
  run python3 -m export.export_onnx --model /tmp/m.pt --output ../models/imitation-dual-v2.onnx --input-dim 265 || { echo FAIL_EXPORT > "$STATUS"; exit 1; }

  echo "DONE $(date)"
  echo OK > "$STATUS"
}
