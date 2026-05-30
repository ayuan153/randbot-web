"""Elo tracking: play model against baselines and compute ratings."""
import subprocess, json, argparse, math
from pathlib import Path


def compute_elo(wins: int, losses: int, draws: int = 0, opponent_elo: int = 1000) -> float:
    """Compute Elo from win/loss record against a known-Elo opponent."""
    total = wins + losses + draws
    if total == 0:
        return opponent_elo
    score = (wins + 0.5 * draws) / total
    if score <= 0:
        return opponent_elo - 400
    if score >= 1:
        return opponent_elo + 400
    return opponent_elo - 400 * math.log10(1 / score - 1)


def play_matches(model_path: str | None, baseline: str, num_games: int = 100,
                 mcts_sims: int = 16) -> dict:
    """Play model vs baseline using the sim server. Returns {wins, losses, draws}."""
    cmd = [
        'node', '--import', 'tsx',
        str(Path(__file__).resolve().parent.parent / 'sim' / 'sim-server.ts'),
        '--games', str(num_games),
        '--workers', '4',
        '--output', '/dev/stdout',
        '--p1-policy', model_path or 'random',
        '--p2-policy', baseline,
        '--mcts-sims', str(mcts_sims),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                                cwd=str(Path(__file__).resolve().parent.parent))
        # Parse JSONL output — each line has {winner, numTurns, ...}
        wins = losses = draws = 0
        for line in result.stdout.strip().split('\n'):
            if not line.strip():
                continue
            try:
                game = json.loads(line)
                if game.get('winner') == 'p1':
                    wins += 1
                elif game.get('winner') == 'p2':
                    losses += 1
                else:
                    draws += 1
            except json.JSONDecodeError:
                continue
        if wins + losses + draws == 0:
            print(f"Warning: 0 games parsed (rc={result.returncode}); "
                  f"stderr tail: {result.stderr.strip()[-800:]}")
        return {'wins': wins, 'losses': losses, 'draws': draws}
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"Warning: match execution failed: {e}")
        return {'wins': 0, 'losses': 0, 'draws': 0}

def track_elo(model_path: str | None, num_games: int = 200, mcts_sims: int = 16) -> dict:
    """Run Elo evaluation for a model against baselines."""
    results = {}

    # Play against random baseline (anchored at Elo 800)
    random_results = play_matches(model_path, 'random', num_games, mcts_sims)
    random_elo = compute_elo(random_results['wins'], random_results['losses'], opponent_elo=800)
    results['vs_random'] = {'elo': random_elo, **random_results}

    # Play against heuristic baseline (anchored at Elo 1000)
    heuristic_results = play_matches(model_path, 'heuristic', num_games, mcts_sims)
    heuristic_elo = compute_elo(
        heuristic_results['wins'], heuristic_results['losses'], opponent_elo=1000
    )
    results['vs_heuristic'] = {'elo': heuristic_elo, **heuristic_results}

    # Average Elo across baselines
    results['estimated_elo'] = (random_elo + heuristic_elo) / 2

    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Elo tracking for self-play models')
    parser.add_argument('--model', default=None, help='Model checkpoint path')
    parser.add_argument('--games', type=int, default=200, help='Games per baseline')
    parser.add_argument('--mcts-sims', type=int, default=16, help='MCTS simulations per move')
    parser.add_argument('--output', default='elo_results.json', help='Output JSON path')
    args = parser.parse_args()

    results = track_elo(args.model, args.games, args.mcts_sims)
    Path(args.output).write_text(json.dumps(results, indent=2))
    print(f"Estimated Elo: {results['estimated_elo']:.0f}")
    for baseline, data in results.items():
        if baseline != 'estimated_elo':
            print(f"  {baseline}: {data}")
    print(f"[Elo] vs_random={results['vs_random']['elo']:.1f} vs_heuristic={results['vs_heuristic']['elo']:.1f} estimated={results['estimated_elo']:.1f}")
