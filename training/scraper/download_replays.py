"""
Download Gen 9 Random Battle replays from HuggingFace dataset.

Dataset: HolidayOugi/pokemon-showdown-replays
Files: [Gen 9] RANDOMBATTLE_part1.parquet through part8.parquet

Usage:
    python -m scraper.download_replays --count 100000
    python -m scraper.download_replays --count 10000 --min-rating 1500
"""

import argparse
import json
from pathlib import Path

import pandas as pd
from huggingface_hub import hf_hub_download
from tqdm import tqdm

REPO_ID = "HolidayOugi/pokemon-showdown-replays"
PARQUET_FILES = [f"[Gen 9] RANDOMBATTLE_part{i}.parquet" for i in range(1, 9)]


def download_from_hf(output_dir: str, target_count: int = 100000, min_rating: int = 1400) -> None:
    """Download replays from HuggingFace parquet dataset."""
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)

    existing = set(f.stem for f in output.glob("*.json"))
    if len(existing) >= target_count:
        print(f"Already have {len(existing)} replays (target: {target_count}). Done.")
        return

    print(f"Target: {target_count} replays, min rating: {min_rating}")
    print(f"Existing: {len(existing)}, need: {target_count - len(existing)}")
    collected = len(existing)

    for filename in PARQUET_FILES:
        if collected >= target_count:
            break

        print(f"\nDownloading {filename}...")
        try:
            local_path = hf_hub_download(
                repo_id=REPO_ID,
                filename=filename,
                repo_type="dataset",
            )
        except Exception as e:
            print(f"  Failed: {e}")
            continue

        print(f"  Reading parquet...")
        df = pd.read_parquet(local_path)
        print(f"  Total rows: {len(df)}")

        # Filter by rating
        if "rating" in df.columns:
            mask = df["rating"].notna() & (df["rating"] >= min_rating)
            filtered = df[mask]
        else:
            filtered = df
        print(f"  After rating filter (>={min_rating}): {len(filtered)}")

        for _, row in tqdm(filtered.iterrows(), total=len(filtered), desc="  Saving"):
            replay_id = str(row.get("id", row.name))
            if replay_id in existing:
                continue

            replay_data = {
                "id": replay_id,
                "format": str(row.get("format", "gen9randombattle")),
                "rating": float(row["rating"]) if "rating" in row and pd.notna(row["rating"]) else None,
                "log": str(row.get("log", "")),
                "uploadtime": int(row["uploadtime"]) if "uploadtime" in row and pd.notna(row["uploadtime"]) else None,
            }

            filepath = output / f"{replay_id}.json"
            filepath.write_text(json.dumps(replay_data))
            existing.add(replay_id)
            collected += 1

            if collected >= target_count:
                break

    print(f"\nDone. Total replays: {collected}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Download Pokemon Showdown replays")
    parser.add_argument("--output", default="data/replays", help="Output directory")
    parser.add_argument("--count", type=int, default=100000, help="Target replay count")
    parser.add_argument("--min-rating", type=int, default=1400, help="Minimum player rating")
    args = parser.parse_args()
    download_from_hf(args.output, args.count, args.min_rating)
