"""Base stats and type data for common Gen 9 randbats Pokemon."""

# {species: (hp, atk, def, spa, spd, spe)}
BASE_STATS: dict[str, tuple[int, int, int, int, int, int]] = {
    "Abomasnow": (90, 92, 75, 92, 85, 60),
    "Absol": (65, 130, 60, 75, 60, 75),
    "Aegislash": (60, 50, 140, 50, 140, 60),
    "Alcremie": (65, 60, 75, 110, 121, 64),
    "Alomomola": (165, 75, 80, 40, 45, 65),
    "Ambipom": (75, 100, 66, 60, 66, 115),
    "Ampharos": (90, 75, 85, 115, 90, 55),
    "Annihilape": (110, 115, 80, 50, 90, 90),
    "Araquanid": (68, 70, 92, 50, 132, 42),
    "Arboliva": (78, 69, 90, 125, 109, 39),
    "Arcanine": (90, 110, 80, 100, 80, 95),
    "Archaludon": (90, 105, 130, 125, 65, 85),
    "Armarouge": (85, 60, 100, 125, 80, 75),
    "Azumarill": (100, 50, 80, 60, 80, 50),
    "Baxcalibur": (115, 145, 92, 75, 86, 87),
    "Bisharp": (65, 125, 100, 60, 70, 70),
    "Blastoise": (79, 83, 100, 85, 105, 78),
    "Blaziken": (80, 120, 70, 110, 70, 80),
    "Blissey": (255, 10, 10, 75, 135, 55),
    "Brambleghast": (55, 115, 70, 80, 70, 90),
    "Breloom": (60, 130, 80, 60, 60, 70),
    "Brute Bonnet": (111, 127, 99, 79, 99, 55),
    "Ceruledge": (75, 125, 80, 60, 100, 85),
    "Chandelure": (60, 55, 90, 145, 90, 80),
    "Chansey": (250, 5, 5, 35, 105, 50),
    "Cinderace": (80, 116, 75, 65, 75, 119),
    "Clefable": (95, 70, 73, 95, 90, 60),
    "Cloyster": (50, 95, 180, 85, 45, 70),
    "Cobalion": (91, 90, 129, 90, 72, 108),
    "Conkeldurr": (105, 140, 95, 55, 65, 45),
    "Corviknight": (98, 87, 105, 53, 85, 67),
    "Cyclizar": (70, 95, 65, 85, 65, 121),
    "Darkrai": (70, 90, 90, 135, 90, 125),
    "Decidueye": (78, 107, 75, 100, 100, 70),
    "Ditto": (48, 48, 48, 48, 48, 48),
    "Donphan": (90, 120, 120, 60, 60, 50),
    "Dragapult": (88, 120, 75, 100, 75, 142),
    "Dragonite": (91, 134, 95, 100, 100, 80),
    "Drapion": (70, 90, 110, 60, 75, 95),
    "Enamorus": (74, 115, 70, 135, 80, 106),
    "Espeon": (65, 65, 60, 130, 95, 110),
    "Excadrill": (110, 135, 60, 50, 65, 88),
    "Ferrothorn": (74, 94, 131, 54, 116, 20),
    "Flamigo": (82, 115, 74, 75, 64, 90),
    "Floatzel": (85, 105, 55, 85, 50, 115),
    "Flygon": (80, 100, 80, 80, 80, 100),
    "Forretress": (75, 90, 140, 60, 60, 40),
    "Gallade": (68, 125, 65, 65, 115, 80),
    "Garchomp": (108, 130, 95, 80, 85, 102),
    "Gardevoir": (68, 65, 65, 125, 115, 80),
    "Gastrodon": (111, 83, 68, 92, 82, 39),
    "Gengar": (60, 65, 60, 130, 75, 110),
    "Glimmora": (83, 55, 90, 130, 81, 86),
    "Gliscor": (75, 95, 125, 45, 75, 95),
    "Goodra": (90, 100, 70, 110, 150, 80),
    "Grafaiai": (63, 95, 65, 80, 72, 110),
    "Great Tusk": (115, 131, 131, 53, 53, 87),
    "Greninja": (72, 95, 67, 103, 71, 122),
    "Grimmsnarl": (95, 120, 65, 95, 75, 60),
    "Gyarados": (95, 125, 79, 60, 100, 81),
    "Hatterene": (57, 90, 95, 136, 103, 29),
    "Hawlucha": (78, 92, 75, 74, 63, 118),
    "Heatran": (91, 90, 106, 130, 106, 77),
    "Heracross": (80, 125, 75, 40, 95, 85),
    "Hippowdon": (108, 112, 118, 68, 72, 47),
    "Hydreigon": (92, 105, 90, 125, 90, 98),
    "Infernape": (76, 104, 71, 104, 71, 108),
    "Iron Bundle": (56, 80, 114, 124, 60, 136),
    "Iron Hands": (154, 140, 108, 50, 68, 50),
    "Iron Jugulis": (94, 80, 86, 122, 80, 108),
    "Iron Moth": (80, 70, 60, 140, 110, 110),
    "Iron Thorns": (100, 134, 110, 70, 84, 72),
    "Iron Valiant": (74, 130, 90, 120, 60, 116),
    "Jirachi": (100, 100, 100, 100, 100, 100),
    "Kartana": (59, 181, 131, 59, 31, 109),
    "Kilowattrel": (70, 70, 60, 105, 60, 125),
    "Kingambit": (100, 135, 120, 60, 85, 50),
    "Kleavor": (70, 135, 95, 45, 70, 85),
    "Kommo-o": (75, 110, 125, 100, 105, 85),
    "Krookodile": (95, 117, 80, 65, 70, 92),
    "Landorus": (89, 125, 90, 115, 80, 101),
    "Landorus-Therian": (89, 145, 90, 105, 80, 91),
    "Lilligant-Hisui": (70, 105, 75, 50, 75, 105),
    "Lokix": (71, 102, 78, 52, 55, 92),
    "Lucario": (70, 110, 70, 115, 70, 90),
    "Lycanroc": (75, 115, 65, 55, 65, 112),
    "Mamoswine": (110, 130, 80, 70, 60, 80),
    "Manaphy": (100, 100, 100, 100, 100, 100),
    "Maushold": (74, 75, 70, 65, 75, 111),
    "Meowscarada": (76, 110, 70, 81, 70, 123),
    "Metagross": (80, 135, 130, 95, 90, 70),
    "Mienshao": (65, 125, 60, 95, 60, 105),
    "Milotic": (95, 60, 79, 100, 125, 81),
    "Mimikyu": (55, 90, 80, 50, 105, 96),
    "Moltres-Galar": (90, 85, 90, 100, 125, 90),
    "Muk-Alola": (105, 105, 75, 65, 100, 50),
    "Ninetales-Alola": (73, 67, 75, 81, 100, 109),
    "Noivern": (85, 70, 80, 97, 80, 123),
    "Ogerpon": (80, 120, 84, 60, 96, 110),
    "Orthworm": (70, 85, 145, 60, 55, 65),
    "Palafin": (100, 160, 97, 106, 87, 100),
    "Pelipper": (60, 50, 100, 95, 70, 65),
    "Polteageist": (60, 65, 65, 134, 114, 70),
    "Primarina": (80, 74, 74, 126, 116, 60),
    "Quaquaval": (85, 120, 80, 85, 75, 85),
    "Raging Bolt": (125, 73, 91, 137, 89, 75),
    "Rillaboom": (100, 125, 90, 60, 70, 85),
    "Roaring Moon": (105, 139, 71, 55, 101, 119),
    "Rotom-Heat": (50, 65, 107, 105, 107, 86),
    "Rotom-Wash": (50, 65, 107, 105, 107, 86),
    "Samurott-Hisui": (90, 108, 80, 100, 65, 85),
    "Sandy Shocks": (85, 81, 97, 121, 85, 101),
    "Scizor": (70, 130, 100, 55, 80, 65),
    "Serperior": (75, 75, 95, 75, 95, 113),
    "Skeledirge": (104, 75, 100, 110, 75, 66),
    "Slowbro": (95, 75, 110, 100, 80, 30),
    "Slowking": (95, 75, 80, 100, 110, 30),
    "Slowking-Galar": (95, 65, 80, 110, 110, 30),
    "Sneasler": (80, 130, 60, 40, 80, 120),
    "Sylveon": (95, 65, 65, 110, 130, 60),
    "Talonflame": (78, 81, 71, 74, 69, 126),
    "Tatsugiri": (68, 50, 60, 120, 95, 82),
    "Tauros-Paldea-Aqua": (75, 110, 105, 30, 70, 100),
    "Tauros-Paldea-Blaze": (75, 110, 105, 30, 70, 100),
    "Tauros-Paldea-Combat": (75, 110, 105, 30, 70, 100),
    "Tentacruel": (80, 70, 65, 80, 120, 100),
    "Tera Captain": (80, 80, 80, 80, 80, 80),
    "Thundurus": (79, 115, 70, 125, 80, 111),
    "Thundurus-Therian": (79, 105, 70, 145, 80, 101),
    "Tinkaton": (85, 75, 77, 70, 105, 94),
    "Tornadus": (79, 115, 70, 125, 80, 111),
    "Tornadus-Therian": (79, 100, 80, 110, 90, 121),
    "Toxapex": (50, 63, 152, 53, 142, 35),
    "Toxtricity": (75, 98, 70, 114, 70, 75),
    "Tsareena": (72, 120, 98, 50, 98, 72),
    "Tyranitar": (100, 134, 110, 95, 100, 61),
    "Umbreon": (95, 65, 110, 60, 130, 65),
    "Ursaluna": (130, 140, 105, 45, 80, 50),
    "Ursaluna-Bloodmoon": (113, 70, 120, 135, 65, 52),
    "Urshifu": (100, 130, 100, 63, 60, 97),
    "Urshifu-Rapid-Strike": (100, 130, 100, 63, 60, 97),
    "Vaporeon": (130, 65, 60, 110, 95, 65),
    "Venusaur": (80, 82, 83, 100, 100, 80),
    "Volcanion": (80, 110, 120, 130, 90, 70),
    "Weavile": (70, 120, 65, 45, 85, 125),
    "Wo-Chien": (85, 85, 100, 95, 135, 70),
    "Zamazenta": (92, 130, 115, 80, 115, 138),
    "Zarude": (105, 120, 105, 70, 95, 105),
    "Zoroark-Hisui": (55, 100, 60, 125, 60, 110),
}

# {id: [type1, type2]} - types loaded from @pkmn/data gen9 (generated by scripts/gen-data-tables.mjs)
import json
import os
import re

_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def _to_id(name: str) -> str:
    """Normalize name to Showdown toID format (lowercase, only a-z0-9)."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


with open(os.path.join(_DATA_DIR, "species_types.json")) as _f:
    SPECIES_TYPES: dict[str, list[str]] = json.load(_f)

with open(os.path.join(_DATA_DIR, "move_base_powers.json")) as _f:
    _raw_moves = json.load(_f)
    MOVE_BASE_POWERS: dict[str, tuple[str, int]] = {
        k: (v[0], int(v[1])) for k, v in _raw_moves.items()
    }

# Move type and base power data loaded from @pkmn/data gen9 (see SPECIES_TYPES load above)


def get_base_speed(species: str) -> int:
    """Return base speed stat for species, default 80."""
    stats = BASE_STATS.get(species)
    return stats[5] if stats else 80


def get_base_stats(species: str) -> tuple[int, int, int, int, int, int]:
    """Return (hp, atk, def, spa, spd, spe), default (80,80,80,80,80,80)."""
    return BASE_STATS.get(species, (80, 80, 80, 80, 80, 80))


def get_types(species: str) -> list[str]:
    """Return type list for species, default ['Normal']."""
    return SPECIES_TYPES.get(_to_id(species), ["Normal"])


def estimate_speed(species: str, level: int = 84) -> float:
    """Estimate speed stat at given level assuming neutral nature, 31 IVs, 84 EVs.
    Formula: ((2*base + 31 + 84/4) * level/100 + 5)
    """
    base_spe = get_base_speed(species)
    return ((2 * base_spe + 31 + 21) * level / 100.0 + 5)


def get_move_type_power(move: str) -> tuple[str, int]:
    """Return (type, base_power) for a move, default ('Normal', 80)."""
    return MOVE_BASE_POWERS.get(_to_id(move), ("Normal", 80))
