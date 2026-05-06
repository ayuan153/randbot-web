"""Pokemon type chart for effectiveness calculations."""

TYPES = [
    "Normal", "Fire", "Water", "Grass", "Electric", "Ice",
    "Fighting", "Poison", "Ground", "Flying", "Psychic",
    "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy",
]

# TYPE_CHART[attacking_type][defending_type] = multiplier
TYPE_CHART: dict[str, dict[str, float]] = {t: {d: 1.0 for d in TYPES} for t in TYPES}

_SUPER = {
    "Fire": ["Grass", "Ice", "Bug", "Steel"],
    "Water": ["Fire", "Ground", "Rock"],
    "Grass": ["Water", "Ground", "Rock"],
    "Electric": ["Water", "Flying"],
    "Ice": ["Grass", "Ground", "Flying", "Dragon"],
    "Fighting": ["Normal", "Ice", "Rock", "Dark", "Steel"],
    "Poison": ["Grass", "Fairy"],
    "Ground": ["Fire", "Electric", "Poison", "Rock", "Steel"],
    "Flying": ["Grass", "Fighting", "Bug"],
    "Psychic": ["Fighting", "Poison"],
    "Bug": ["Grass", "Psychic", "Dark"],
    "Rock": ["Fire", "Ice", "Flying", "Bug"],
    "Ghost": ["Psychic", "Ghost"],
    "Dragon": ["Dragon"],
    "Dark": ["Psychic", "Ghost"],
    "Steel": ["Ice", "Rock", "Fairy"],
    "Fairy": ["Fighting", "Dragon", "Dark"],
    "Normal": [],
}

_RESIST = {
    "Fire": ["Fire", "Water", "Rock", "Dragon"],
    "Water": ["Water", "Grass", "Dragon"],
    "Grass": ["Fire", "Grass", "Poison", "Flying", "Bug", "Dragon", "Steel"],
    "Electric": ["Electric", "Grass", "Dragon"],
    "Ice": ["Fire", "Water", "Ice", "Steel"],
    "Fighting": ["Poison", "Flying", "Psychic", "Bug", "Fairy"],
    "Poison": ["Poison", "Ground", "Rock", "Ghost"],
    "Ground": ["Grass", "Bug"],
    "Flying": ["Electric", "Rock", "Steel"],
    "Psychic": ["Psychic", "Steel"],
    "Bug": ["Fire", "Fighting", "Poison", "Flying", "Ghost", "Steel", "Fairy"],
    "Rock": ["Fighting", "Ground", "Steel"],
    "Ghost": ["Dark"],
    "Dragon": ["Steel"],
    "Dark": ["Fighting", "Dark", "Fairy"],
    "Steel": ["Fire", "Water", "Electric", "Steel"],
    "Fairy": ["Fire", "Poison", "Steel"],
    "Normal": ["Rock", "Steel"],
}

_IMMUNE = {
    "Normal": ["Ghost"],
    "Fighting": ["Ghost"],
    "Poison": ["Steel"],
    "Ground": ["Flying"],
    "Ghost": ["Normal"],
    "Electric": ["Ground"],
    "Psychic": ["Dark"],
    "Dragon": ["Fairy"],
}

for atk, defs in _SUPER.items():
    for d in defs:
        TYPE_CHART[atk][d] = 2.0
for atk, defs in _RESIST.items():
    for d in defs:
        TYPE_CHART[atk][d] = 0.5
for atk, defs in _IMMUNE.items():
    for d in defs:
        TYPE_CHART[atk][d] = 0.0


def type_effectiveness(atk_type: str, def_types: list[str]) -> float:
    """Calculate type effectiveness multiplier for attack vs defender types."""
    mult = 1.0
    for dt in def_types:
        mult *= TYPE_CHART.get(atk_type, {}).get(dt, 1.0)
    return mult
