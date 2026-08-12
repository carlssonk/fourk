/**
 * Fallback username for players who leave the name field empty. "Anon" rather
 * than a cute generated name: it should read as "didn't pick one", not as a
 * choice. Purely a display default — collisions are harmless, and the player
 * can overwrite it any time.
 */
export function anonName(): string {
  return `Anon-${1000 + Math.floor(Math.random() * 9000)}`;
}
