// Home's filter chips: how well a shelf item matches a chip, and a stable re-sort (matches first, nothing dropped).
/** How well an item matches a chip (higher first). Items: {genre, instrument, level, kind}. */
export function chipScore(chip, it, myInst) {
  if (!chip) return 0;
  const g = it.genre || '', lv = it.level || 0;
  switch (chip) {
    case 'mine': return (it.instrument || '') === myInst ? 2 : 0;
    case 'beginner': return lv && lv <= 1 ? 2 : lv === 2 ? 1 : 0;
    case 'hymn': return g === 'hymn' ? 2 : g === 'choral' || g === 'christmas' ? 1 : 0;
    case 'classical': return ['classical', 'piano', 'chamber'].includes(g) ? 2 : g === 'song' || g === 'guitar' ? 1 : 0;
    case 'pop': return it.kind === 'request' ? 2 : it.kind === 'score' ? 1 : 0;
    case 'exam': return ['classical', 'piano', 'chamber', 'guitar'].includes(g) && lv >= 2 && lv <= 3 ? 2 : 0;
    case 'five': return lv && lv <= 1 ? 2 : (it.measures && it.measures <= 24) ? 2 : lv === 2 ? 1 : 0;
    default: return 0;
  }
}
export const sortBy = (items, chip, myInst) => (chip ? [...items].map((x, i) => [chipScore(chip, x, myInst), i, x]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[2]) : items);

