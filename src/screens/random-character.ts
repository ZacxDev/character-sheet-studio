// Random character generator for the create/edit form: one-tap names and
// whole-character rolls (name + description + traits + trigger word).
// Pure functions over an injectable RNG so tests can pin the output.

export type Rng = () => number;

const pick = <T,>(rand: Rng, list: readonly T[]): T =>
  list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

const pickN = <T,>(rand: Rng, list: readonly T[], n: number): T[] => {
  const pool = [...list];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
};

const NAME_ONSETS = [
  'Ka', 'Nyx', 'Ze', 'Tor', 'Mi', 'Ael', 'Vor', 'Sa', 'Ryn', 'Thal',
  'Or', 'Es', 'Ly', 'Dra', 'Fen', 'Is', 'Mor', 'Ash', 'Bel', 'Cor',
  'Dae', 'Ha', 'Ja', 'Kel', 'Lo', 'Na', 'Per', 'Quil', 'Ro', 'Syl',
] as const;

const NAME_ENDINGS = [
  'da', 'x', 'ra', 'ion', 'is', 'eth', 'ara', 'on', 'mir', 'wyn',
  'gar', 'th', 'na', 'lo', 'ri', 'ek', 'um', 'is', 'ov', 'ette',
] as const;

const SURNAMES = [
  'Vale', 'Thorn', 'Ash', 'Reyes', 'Kade', 'Moreau', 'Vex', 'Hallow',
  'Storm', 'Quill', 'Marsh', 'Okafor', 'Lindqvist', 'Petrov', 'Sable',
  'Thistledown',
] as const;

/** A single fantasy/sci-fi flavoured name, sometimes with a surname. */
export function randomName(rand: Rng = Math.random): string {
  const first = pick(rand, NAME_ONSETS) + pick(rand, NAME_ENDINGS);
  return rand() < 0.45 ? `${first} ${pick(rand, SURNAMES)}` : first;
}

const ERAS = [
  'gritty 1800s', 'neon-drenched cyberpunk', 'high-fantasy', 'solarpunk',
  'dieselpunk', 'ancient-world', 'clockwork', 'post-apocalyptic',
  'art-deco', 'spacefaring', 'wild-west', 'deep-sea',
] as const;

const BEINGS = [
  'human', 'elf', 'android', 'fox spirit', 'dwarf', 'tiefling', 'cyborg',
  'vampire', 'werewolf', 'fae', 'golem', 'merfolk', 'dragonborn', 'ghost',
  'star-touched alien', 'minotaur',
] as const;

const ROLES = [
  'adventure miner', 'mercenary', 'knight', 'alchemist', 'void pilot',
  'detective', 'blacksmith', 'wandering monk', 'starship captain',
  'bounty hunter', 'court mage', 'street samurai', 'inventor', 'oracle',
  'smuggler', 'mapmaker', 'beast tamer', 'relic hunter',
] as const;

const DETAILS = [
  'scarred and silver-tongued', 'exiled from their order',
  'never seen without a brass compass', 'collects broken clocks',
  'speaks in a near-whisper', 'owes a debt to a sky pirate',
  'sworn to protect one last relic', 'retired once, it didn’t take',
  'keeps a journal in a dead language', 'laughs in the face of storms',
] as const;

const TRAITS = [
  'neon-blue undercut hair', 'cybernetic left arm', 'worn leather jacket',
  'glowing amber eyes', 'silver-streaked hair', 'freckled, sun-worn skin',
  'a long braided beard with iron rings', 'heterochromatic eyes',
  'a tattooed constellation map across the back', 'one mechanical leg',
  'antlers hung with tiny charms', 'a perpetual five-o’clock shadow',
  'vitiligo patterns like star charts', 'a feathered mane',
  'bioluminescent markings', 'a chipped fang when they grin',
  'round brass goggles, always up', 'flowing iridescent scales',
  'a hat for every occasion', 'soot permanently on the cheek',
] as const;

export interface RandomCharacter {
  name: string;
  description: string;
  traits: string[];
  /** Single slug derived from the name, e.g. "kaida_rin_vale". */
  triggerWord: string;
}

export function triggerWordFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Roll one description line: era + being + role + a characterful detail. */
export function randomDescription(rand: Rng = Math.random): string {
  const era = pick(rand, ERAS);
  const article = /^[aeiou]/i.test(era) ? 'an' : 'a';
  return `${article} ${era} ${pick(rand, BEINGS)} ${pick(rand, ROLES)}, ${pick(rand, DETAILS)}`;
}

/** Roll three distinct appearance traits. */
export function randomTraits(rand: Rng = Math.random): string[] {
  return pickN(rand, TRAITS, 3);
}

/** Roll a standalone trigger-word slug (derived from a fresh random name). */
export function randomTriggerWord(rand: Rng = Math.random): string {
  return triggerWordFor(randomName(rand));
}

/** Roll a whole character: name, one-line description, 3 traits, trigger. */
export function randomCharacter(rand: Rng = Math.random): RandomCharacter {
  const name = randomName(rand);
  return {
    name,
    description: randomDescription(rand),
    traits: randomTraits(rand),
    triggerWord: triggerWordFor(name),
  };
}
