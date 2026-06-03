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
import { loadNet } from './net-node';
import { BattleStateTracker } from './battle-state';
import { selectAction } from './bot-selector';
import { setSetsDb } from '../src/state/sets-db';
import { toID } from '../src/util/id';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const WS_URL = 'wss://sim3.psim.us/showdown/websocket';
const LOGIN_URL = 'https://play.pokemonshowdown.com/api/login';
const FORMAT = 'gen9randombattle';
const DECISION_THROTTLE_MS = 600;

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
  private trackers: Map<string, BattleStateTracker> = new Map();
  private lastChoiceTime = 0;
  private reconnectCount = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(username: string, password: string, targetGames = 20, select: Selector = chooseDefault) {
    this.username = username;
    this.password = password;
    this.targetGames = targetGames;
    this.select = select;
  }

  start(): Promise<Stats> {
    return new Promise((resolve) => {
      this.connect(resolve);
    });
  }

  private connect(resolve: (s: Stats) => void) {
    this.ws = new WebSocket(WS_URL);
    this.ws.on('open', () => {
      console.log('[ladder] connected');
      this.lastPong = Date.now();
      this.startHeartbeat();
    });
    this.ws.on('message', (data) => {
      this.reconnectCount = 0; // successful message resets cap
      this.lastPong = Date.now(); // any message counts as activity
      this.onMessage(data.toString(), resolve);
    });
    this.ws.on('pong', () => { this.lastPong = Date.now(); });
    this.ws.on('error', (e) => console.error('[ws] error', e));
    this.ws.on('close', () => {
      this.stopHeartbeat();
      this.clearSearchTimeout();
      if (this.done) return;
      if (this.reconnectCount >= 10) {
        console.log('[ladder] reconnect cap reached, giving up');
        resolve(this.stats);
        return;
      }
      this.reconnectCount++;
      console.log(`[ladder] connection lost, reconnecting (${this.reconnectCount})`);
      setTimeout(() => this.connect(resolve), 2000);
    });
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.done || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > 70_000) {
        console.log('[ladder] dead socket detected, terminating');
        this.ws.terminate(); // forces 'close' -> reconnect
        return;
      }
      this.ws.ping();
    }, 30_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
  }

  private clearSearchTimeout() {
    if (this.searchTimeout) { clearTimeout(this.searchTimeout); this.searchTimeout = null; }
  }

  private startSearchTimer() {
    this.clearSearchTimeout();
    this.searchTimeout = setTimeout(() => {
      if (!this.done && !this.currentRoom && this.ws.readyState === WebSocket.OPEN) {
        console.log('[ladder] search timeout, re-searching');
        this.send(`|/search ${FORMAT}`);
        this.startSearchTimer(); // restart for next attempt
      }
    }, 90_000);
  }

  private send(msg: string) { this.ws.send(msg); }

  private async onMessage(raw: string, resolve: (s: Stats) => void) {
    // A message block may start with ">roomid" setting the room for following lines.
    let room = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('>')) { room = line.slice(1); continue; }
      const parts = line.split('|');
      const cmd = parts[1];

      // Feed every line to the room's tracker
      const trackRoom = room || this.currentRoom || '';
      if (trackRoom && this.trackers.has(trackRoom)) {
        this.trackers.get(trackRoom)!.ingest(line);
      }

      if (cmd === 'challstr') {
        await this.login(parts.slice(2).join('|'));
      } else if (cmd === 'updateuser' && parts[3] === '1') {
        console.log(`[ladder] searching ${FORMAT}`);
        this.send(`|/search ${FORMAT}`);
        this.startSearchTimer();
      } else if (cmd === 'init' && parts[2] === 'battle') {
        this.currentRoom = room;
        this.clearSearchTimeout();
        this.trackers.set(room, new BattleStateTracker(this.username));
        console.log(`[ladder] battle ${room} started`);
      } else if (cmd === 'request' && parts[2]) {
        await this.handleRequest(room || this.currentRoom || '', parts.slice(2).join('|'));
      } else if (cmd === 'error' && room) {
        console.warn('[battle] choice error:', parts.slice(2).join('|'));
      } else if (cmd === 'win' || cmd === 'tie') {
        await this.onBattleEnd(room, cmd, parts[2]);
        this.trackers.delete(room);
        if (this.stats.wins + this.stats.losses + this.stats.ties >= this.targetGames) {
          this.done = true;
          this.stopHeartbeat();
          this.clearSearchTimeout();
          this.ws.close();
          resolve(this.stats);
        } else {
          setTimeout(() => {
            console.log(`[ladder] searching ${FORMAT}`);
            this.send(`|/search ${FORMAT}`);
            this.startSearchTimer();
          }, 2500); // respect search cooldown
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
    console.log(`[ladder] logged in as ${this.username}`);
  }

  private async handleRequest(room: string, json: string) {
    let req: BattleRequest;
    try { req = JSON.parse(json) as BattleRequest; } catch { return; }
    if (req.wait) return;

    // Throttle: wait at least DECISION_THROTTLE_MS between decisions
    const now = Date.now();
    const elapsed = now - this.lastChoiceTime;
    if (elapsed < DECISION_THROTTLE_MS) {
      await new Promise(r => setTimeout(r, DECISION_THROTTLE_MS - elapsed));
    }

    const tracker = this.trackers.get(room);
    let choice: Choice | null;
    if (tracker) {
      try {
        choice = await selectAction(req, tracker);
      } catch {
        choice = chooseDefault(req);
      }
    } else {
      choice = this.select(req);
    }
    choice = choice || chooseDefault(req);

    if (choice) {
      this.lastChoiceTime = Date.now();
      this.send(`${room}|/choose ${choice}|${req.rqid ?? ''}`);
    }
  }

  private async onBattleEnd(room: string, kind: string, winner?: string) {
    if (kind === 'tie') this.stats.ties++;
    else if (winner && toID(winner) === toID(this.username)) this.stats.wins++;
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

  // Load sets database and ONNX model before starting
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const setsData = JSON.parse(readFileSync(resolve(__dirname, '../data/gen9randombattle.json'), 'utf-8'));
  setSetsDb(setsData);
  await loadNet(resolve(__dirname, '../models/imitation-dual-v2.onnx'));
  console.log('[ladder] net loaded');

  new LadderClient(user, pass, n).start().then((s) => {
    console.log('[ladder] done:', s);
    process.exit(0);
  });
}
