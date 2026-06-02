/**
 * Minimal headless Pokémon Showdown ladder client for gen9randombattle.
 * Connects, logs in (registered account via env), queues rated games, plays them
 * with a pluggable selector, and logs the resulting ladder GXE/Elo — the real
 * north-star metric (see docs/intelligence/north-star-imitation-design.md).
 *
 * Run: PS_USERNAME=... PS_PASSWORD=... npx tsx ladder/client.ts [numGames]
 * Requires a REGISTERED account (guests cannot play rated / earn GXE).
 *
 * The default selector (chooseDefault) just validates the loop; wire a trained
 * net selector (Track 2) for real strength. Decision/parse logic lives in the
 * unit-tested ./protocol module.
 */
import WebSocket from 'ws';
import {
  BattleRequest, Choice, chooseDefault, parseLoginResponse, parseLadderRating,
} from './protocol';

const WS_URL = 'wss://sim3.psim.us/showdown/websocket';
const LOGIN_URL = 'https://play.pokemonshowdown.com/api/login';
const FORMAT = 'gen9randombattle';

export type Selector = (req: BattleRequest) => Choice | null;

interface Stats { wins: number; losses: number; ties: number; }

export class LadderClient {
  private ws!: WebSocket;
  private username: string;
  private password: string;
  private targetGames: number;
  private select: Selector;
  private stats: Stats = { wins: 0, losses: 0, ties: 0 };
  private currentRoom: string | null = null;
  private done = false;

  constructor(username: string, password: string, targetGames = 20, select: Selector = chooseDefault) {
    this.username = username;
    this.password = password;
    this.targetGames = targetGames;
    this.select = select;
  }

  start(): Promise<Stats> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on('message', (data) => this.onMessage(data.toString(), resolve));
      this.ws.on('error', (e) => console.error('[ws] error', e));
      this.ws.on('close', () => { if (!this.done) resolve(this.stats); });
    });
  }

  private send(msg: string) { this.ws.send(msg); }

  private async onMessage(raw: string, resolve: (s: Stats) => void) {
    // A message block may start with ">roomid" setting the room for following lines.
    let room = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('>')) { room = line.slice(1); continue; }
      const parts = line.split('|');
      const cmd = parts[1];

      if (cmd === 'challstr') {
        await this.login(parts.slice(2).join('|'));
      } else if (cmd === 'updateuser' && parts[3] === '1') {
        this.send(`|/search ${FORMAT}`);
      } else if (cmd === 'init' && parts[2] === 'battle') {
        this.currentRoom = room;
      } else if (cmd === 'request' && parts[2]) {
        this.handleRequest(room || this.currentRoom || '', parts.slice(2).join('|'));
      } else if (cmd === 'error' && room) {
        console.warn('[battle] choice error:', parts.slice(2).join('|'));
      } else if (cmd === 'win' || cmd === 'tie') {
        await this.onBattleEnd(room, cmd, parts[2]);
        if (this.stats.wins + this.stats.losses + this.stats.ties >= this.targetGames) {
          this.done = true;
          this.ws.close();
          resolve(this.stats);
        } else {
          setTimeout(() => this.send(`|/search ${FORMAT}`), 2500); // respect search cooldown
        }
      }
    }
  }

  private async login(challstr: string) {
    const body = new URLSearchParams({ name: this.username, pass: this.password, challstr });
    const resp = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const parsed = parseLoginResponse(await resp.text());
    if (!parsed) { console.error('[login] failed (check PS_USERNAME/PS_PASSWORD)'); this.ws.close(); return; }
    this.send(`|/trn ${this.username},0,${parsed.assertion}`);
  }

  private handleRequest(room: string, json: string) {
    let req: BattleRequest;
    try { req = JSON.parse(json) as BattleRequest; } catch { return; }
    if (req.wait) return;
    const choice = this.select(req);
    if (choice) this.send(`${room}|/choose ${choice}|${req.rqid ?? ''}`);
  }

  private async onBattleEnd(room: string, kind: string, winner?: string) {
    if (kind === 'tie') this.stats.ties++;
    else if (winner && winner.toLowerCase() === this.username.toLowerCase()) this.stats.wins++;
    else this.stats.losses++;
    if (room) this.send(`|/leave ${room}`);
    this.currentRoom = null;
    const played = this.stats.wins + this.stats.losses + this.stats.ties;
    const rating = await this.fetchRating();
    console.log(`[ladder] game ${played}/${this.targetGames} W${this.stats.wins}-L${this.stats.losses}-T${this.stats.ties}`
      + (rating ? ` | GXE ${rating.gxe ?? '?'} Elo ${rating.elo ?? '?'}` : ''));
  }

  private async fetchRating() {
    const id = this.username.toLowerCase().replace(/[^a-z0-9]/g, '');
    try {
      const resp = await fetch(`https://pokemonshowdown.com/users/${id}.json`);
      return parseLadderRating(await resp.json());
    } catch { return null; }
  }
}

if (process.argv[1] && process.argv[1].endsWith('client.ts')) {
  const user = process.env.PS_USERNAME, pass = process.env.PS_PASSWORD;
  if (!user || !pass) { console.error('Set PS_USERNAME and PS_PASSWORD (registered account).'); process.exit(1); }
  const n = parseInt(process.argv[2] || '20', 10);
  new LadderClient(user, pass, n).start().then((s) => {
    console.log('[ladder] done:', s);
    process.exit(0);
  });
}
