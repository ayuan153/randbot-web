"""Download Gen 9 Random Battle replays from Pokemon Showdown replay API."""

import json
import time
from pathlib import Path

import requests
from tqdm import tqdm


def scrape_replays(output_dir: str, target_count: int = 100000, min_rating: int = 1400):
    """Download gen9randombattle replays with rating >= min_rating.

    Resumable: skips replay IDs already present in output_dir.
    """
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)

    # Track existing files for resumability
    existing = {f.stem for f in output.glob("*.json")}
    downloaded = len(existing)
    skipped = 0

    if downloaded > 0:
        print(f"Resuming: {downloaded} replays already downloaded")

    before = None  # pagination cursor
    pbar = tqdm(total=target_count, initial=downloaded, desc="Downloading replays")

    while downloaded < target_count:
        url = "https://replay.pokemonshowdown.com/search.json?format=gen9randombattle"
        if before:
            url += f"&before={before}"

        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            results = resp.json()
        except (requests.RequestException, json.JSONDecodeError) as e:
            print(f"\nRequest error: {e}. Retrying in 5s...")
            time.sleep(5)
            continue

        if not results:
            print("\nNo more results from API.")
            break

        for replay in results:
            if not (replay.get("rating") and replay["rating"] >= min_rating):
                continue

            replay_id = replay["id"]
            if replay_id in existing:
                skipped += 1
                continue

            replay_url = f"https://replay.pokemonshowdown.com/{replay_id}.json"
            try:
                r = requests.get(replay_url, timeout=30)
                if r.status_code == 200:
                    data = r.json()
                    filepath = output / f"{replay_id}.json"
                    filepath.write_text(json.dumps(data))
                    existing.add(replay_id)
                    downloaded += 1
                    pbar.update(1)
            except (requests.RequestException, json.JSONDecodeError):
                pass

            time.sleep(0.5)  # rate limit

        before = results[-1].get("uploadtime")
        time.sleep(0.3)

    pbar.close()
    print(f"Done. {downloaded} replays in {output_dir} (skipped {skipped} duplicates)")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Download Pokemon Showdown replays")
    parser.add_argument("--output", default="data/replays")
    parser.add_argument("--count", type=int, default=100000)
    parser.add_argument("--min-rating", type=int, default=1400)
    args = parser.parse_args()
    scrape_replays(args.output, args.count, args.min_rating)
