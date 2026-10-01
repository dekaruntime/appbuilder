// A new app's id: adjective-noun-hash, e.g. excited-strawberry-x83k. It names
// the app's folder; the folder is created exclusively, so a clash (already
// ~1 in 28 billion) gets a fresh id instead of overwriting another app.
const ADJECTIVES = 'amber bold brave breezy bright brisk calm candid cheerful chill clever cosmic cozy crisp curious daring dapper dreamy eager early electric elegant epic excited fancy fearless festive fiery fluffy fond fresh friendly frosty fuzzy gentle giddy glad glowing golden graceful grand happy hearty honest humble hushed icy jolly jovial keen kind lively lucky lunar mellow merry mighty misty modest nimble noble odd plucky polished proud quick quiet radiant rapid rare ready regal rosy royal rustic sandy savvy serene shiny silky silver sleek smooth snappy snowy soft solar sparkly speedy spry steady stellar stormy sturdy sunny super swift tidy tiny trusty upbeat vivid warm wavy whimsical wild windy wise witty zany zesty zippy bubbly cosy dusky earnest feisty gleaming hazy jazzy leafy mossy nifty peppy perky prime'.split(' ');
const NOUNS = 'acorn almond anchor apple apricot aspen badger bagel banana basil beacon bear berry biscuit bison blossom breeze brook bubble cactus canyon carrot cedar cherry chestnut cloud clover cocoa comet cookie coral cricket crystal cypress daisy delta dune ember falcon fern fig finch firefly fjord flamingo forest fox galaxy garnet gecko ginger glacier grape harbor hazel heron honey island ivy jasmine kayak kiwi koala lagoon lantern lemon lily lime lotus lynx mango maple meadow melon meteor mint moose nectar nutmeg oak ocean olive orchid otter owl panda papaya peach pear pebble pepper pine planet plum pony poppy prairie puffin quartz quince rabbit raven reef river robin rocket saffron sage sequoia sparrow spruce squirrel strawberry summit sunflower thistle tiger tulip turtle valley violet walnut willow'.split(' ');
const HASH = 'abcdefghijkmnpqrstuvwxyz23456789';

const pick = <T,>(list: readonly T[], n: number) => list[n % list.length];

export function newAppId(): string {
  const random = crypto.getRandomValues(new Uint32Array(6));
  const hash = Array.from(random.slice(2), n => pick(HASH.split(''), n)).join('');
  return `${pick(ADJECTIVES, random[0])}-${pick(NOUNS, random[1])}-${hash}`;
}
