"""Lightweight battle state tracker for parsing PS protocol logs."""

from dataclasses import dataclass, field


@dataclass
class Pokemon:
    species: str = ""
    hp: int = 100
    max_hp: int = 100
    status: str = ""  # brn, par, slp, frz, psn, tox, ""
    boosts: dict = field(default_factory=lambda: {"atk": 0, "def": 0, "spa": 0, "spd": 0, "spe": 0})
    has_item: bool = True
    is_alive: bool = True
    types: list = field(default_factory=list)
    moves_known: list = field(default_factory=list)
    ability: str = ""
    tera_type: str = ""

    def hp_fraction(self) -> float:
        if self.max_hp == 0:
            return 0.0
        return self.hp / self.max_hp


@dataclass
class Side:
    pokemon: list = field(default_factory=list)
    active_idx: int = 0
    hazards: dict = field(default_factory=lambda: {
        "spikes": 0, "stealthrock": 0, "toxicspikes": 0, "stickyweb": 0
    })
    screens: dict = field(default_factory=lambda: {
        "reflect": 0, "lightscreen": 0
    })
    tailwind: int = 0
    tera_available: bool = True
    tera_used: bool = False

    def __post_init__(self):
        if not self.pokemon:
            self.pokemon = [Pokemon() for _ in range(6)]

    @property
    def active(self) -> Pokemon:
        return self.pokemon[self.active_idx]


@dataclass
class BattleState:
    sides: list = field(default_factory=list)
    weather: str = ""
    terrain: str = ""
    trick_room: bool = False
    turn: int = 0
    winner: str = ""  # "p1" or "p2"

    def __post_init__(self):
        if not self.sides:
            self.sides = [Side(), Side()]

    def get_side_idx(self, player: str) -> int:
        return 0 if player == "p1" else 1

    def find_pokemon(self, side_idx: int, species: str) -> int:
        """Find pokemon index by species, or first empty slot."""
        for i, mon in enumerate(self.sides[side_idx].pokemon):
            if mon.species == species:
                return i
        # Find first unused slot
        for i, mon in enumerate(self.sides[side_idx].pokemon):
            if mon.species == "":
                return i
        return 5  # fallback to last slot


def parse_pokemon_ident(ident: str) -> tuple[int, str]:
    """Parse 'p1a: Pikachu' -> (0, 'Pikachu')."""
    parts = ident.split(": ", 1)
    player_pos = parts[0]  # e.g. "p1a" or "p2a"
    species = parts[1] if len(parts) > 1 else ""
    side_idx = 0 if player_pos.startswith("p1") else 1
    return side_idx, species


def parse_hp(hp_str: str) -> tuple[int, int]:
    """Parse '150/300' or '0 fnt' -> (hp, max_hp)."""
    if "fnt" in hp_str:
        return 0, 100
    hp_str = hp_str.split(" ")[0]  # strip status suffix
    if "/" in hp_str:
        parts = hp_str.split("/")
        return int(parts[0]), int(parts[1])
    return 100, 100


def update_state(state: BattleState, line: str):
    """Update battle state from a single protocol line."""
    parts = line.split("|")
    if len(parts) < 2:
        return

    cmd = parts[1]

    if cmd == "turn":
        state.turn = int(parts[2])

    elif cmd == "switch" or cmd == "drag":
        if len(parts) < 5:
            return
        side_idx, species = parse_pokemon_ident(parts[2])
        # Details contain species info and types
        details = parts[3]
        hp, max_hp = parse_hp(parts[4])

        side = state.sides[side_idx]
        idx = state.find_pokemon(side_idx, species)
        # Could be a new pokemon
        if side.pokemon[idx].species == "":
            side.pokemon[idx].species = species
        side.pokemon[idx].hp = hp
        side.pokemon[idx].max_hp = max_hp
        side.pokemon[idx].is_alive = hp > 0
        side.pokemon[idx].status = ""  # switch clears volatile statuses
        side.pokemon[idx].boosts = {"atk": 0, "def": 0, "spa": 0, "spd": 0, "spe": 0}
        side.active_idx = idx

    elif cmd == "move":
        if len(parts) < 4:
            return
        side_idx, species = parse_pokemon_ident(parts[2])
        move = parts[3]
        side = state.sides[side_idx]
        mon = side.active
        if move not in mon.moves_known:
            mon.moves_known.append(move)

    elif cmd == "-damage" or cmd == "-heal":
        if len(parts) < 4:
            return
        side_idx, species = parse_pokemon_ident(parts[2])
        hp, max_hp = parse_hp(parts[3])
        side = state.sides[side_idx]
        mon = side.pokemon[state.find_pokemon(side_idx, species)]
        mon.hp = hp
        mon.max_hp = max_hp
        mon.is_alive = hp > 0

    elif cmd == "-status":
        if len(parts) < 4:
            return
        side_idx, _ = parse_pokemon_ident(parts[2])
        status = parts[3]
        state.sides[side_idx].active.status = status

    elif cmd == "-curestatus":
        if len(parts) < 4:
            return
        side_idx, species = parse_pokemon_ident(parts[2])
        idx = state.find_pokemon(side_idx, species)
        state.sides[side_idx].pokemon[idx].status = ""

    elif cmd == "-boost":
        if len(parts) < 5:
            return
        side_idx, _ = parse_pokemon_ident(parts[2])
        stat = parts[3]
        amount = int(parts[4])
        boosts = state.sides[side_idx].active.boosts
        if stat in boosts:
            boosts[stat] = min(6, boosts[stat] + amount)

    elif cmd == "-unboost":
        if len(parts) < 5:
            return
        side_idx, _ = parse_pokemon_ident(parts[2])
        stat = parts[3]
        amount = int(parts[4])
        boosts = state.sides[side_idx].active.boosts
        if stat in boosts:
            boosts[stat] = max(-6, boosts[stat] - amount)

    elif cmd == "-weather":
        if len(parts) < 3:
            return
        weather = parts[2]
        state.weather = "" if weather == "none" else weather

    elif cmd == "-fieldstart":
        if len(parts) < 3:
            return
        field_effect = parts[2].split(": ")[-1].lower().replace(" ", "")
        if "terrain" in field_effect:
            state.terrain = field_effect.replace("terrain", "")
        elif "trickroom" in field_effect:
            state.trick_room = True

    elif cmd == "-fieldend":
        if len(parts) < 3:
            return
        field_effect = parts[2].split(": ")[-1].lower().replace(" ", "")
        if "terrain" in field_effect:
            state.terrain = ""
        elif "trickroom" in field_effect:
            state.trick_room = False

    elif cmd == "-sidestart":
        if len(parts) < 4:
            return
        side_str = parts[2]  # "p1: PlayerName"
        side_idx = 0 if "p1" in side_str else 1
        condition = parts[3].split(": ")[-1].lower().replace(" ", "")
        side = state.sides[side_idx]
        if condition in side.hazards:
            side.hazards[condition] = min(side.hazards[condition] + 1, 3)
        elif condition in ("reflect", "lightscreen"):
            side.screens[condition] = 5

    elif cmd == "-sideend":
        if len(parts) < 4:
            return
        side_str = parts[2]
        side_idx = 0 if "p1" in side_str else 1
        condition = parts[3].split(": ")[-1].lower().replace(" ", "")
        side = state.sides[side_idx]
        if condition in side.hazards:
            side.hazards[condition] = 0
        elif condition in ("reflect", "lightscreen"):
            side.screens[condition] = 0

    elif cmd == "faint":
        if len(parts) < 3:
            return
        side_idx, species = parse_pokemon_ident(parts[2])
        idx = state.find_pokemon(side_idx, species)
        state.sides[side_idx].pokemon[idx].is_alive = False
        state.sides[side_idx].pokemon[idx].hp = 0

    elif cmd == "-item":
        if len(parts) < 3:
            return
        side_idx, species = parse_pokemon_ident(parts[2])
        idx = state.find_pokemon(side_idx, species)
        state.sides[side_idx].pokemon[idx].has_item = True

    elif cmd == "-enditem":
        if len(parts) < 3:
            return
        side_idx, species = parse_pokemon_ident(parts[2])
        idx = state.find_pokemon(side_idx, species)
        state.sides[side_idx].pokemon[idx].has_item = False

    elif cmd == "-ability":
        if len(parts) < 4:
            return
        side_idx, species = parse_pokemon_ident(parts[2])
        idx = state.find_pokemon(side_idx, species)
        state.sides[side_idx].pokemon[idx].ability = parts[3]

    elif cmd == "-terastallize":
        if len(parts) < 4:
            return
        side_idx, _ = parse_pokemon_ident(parts[2])
        state.sides[side_idx].tera_available = False
        state.sides[side_idx].tera_used = True
        state.sides[side_idx].active.tera_type = parts[3]

    elif cmd == "win":
        if len(parts) < 3:
            return
        # We'll resolve winner by player name later
        state.winner = parts[2]
