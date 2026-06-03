/**
 * Generates species_types.json and move_base_powers.json from @pkmn/data,
 * ensuring Python training features use the SAME data as TS inference.
 *
 * Usage: node scripts/gen-data-tables.mjs
 */

import { Generations } from '@pkmn/data';
import { Dex } from '@pkmn/dex';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'training', 'features', 'data');
mkdirSync(outDir, { recursive: true });

function toID(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const gen = new Generations(Dex).get(9);

// Species types
const speciesTypes = {};
for (const species of gen.species) {
  speciesTypes[toID(species.name)] = [...species.types];
}

// Move base powers
const moveBasePowers = {};
for (const move of gen.moves) {
  moveBasePowers[toID(move.name)] = [move.type, move.basePower];
}

writeFileSync(join(outDir, 'species_types.json'), JSON.stringify(speciesTypes, null, 2) + '\n');
writeFileSync(join(outDir, 'move_base_powers.json'), JSON.stringify(moveBasePowers, null, 2) + '\n');

console.log(`species_types.json: ${Object.keys(speciesTypes).length} entries`);
console.log(`move_base_powers.json: ${Object.keys(moveBasePowers).length} entries`);
