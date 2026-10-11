/** Delivery groups retain original pins. Island color/mask pairs activate together. */
export function buildWorldContentGroups(files, regionalDetails, chains) {
  const pinned = new Set(files.map(file => file.path));
  if (pinned.size !== files.length) throw new Error('Duplicate world content path');
  const used = new Set();
  function group(kind, sourceId, suffixes) {
    if (!/^[a-z][a-z0-9-]*$/.test(sourceId)) throw new Error('Invalid world source ID');
    const paths = suffixes.map(suffix => `atlas/fantasy/globe/generated/${sourceId}${suffix}`);
    for (const path of paths) {
      if (!pinned.has(path) || used.has(path)) throw new Error(`Missing or overlapping world group file: ${path}`);
      used.add(path);
    }
    return {id: `${kind}-${sourceId}`, sourceId, files: paths};
  }
  const regions = regionalDetails.map(source => group('region', source.id, ['-detail.png']));
  const islandGroups = chains.map(source => group('chain', source.id, ['-detail.png', '-detail-mask.png']));
  const overview = {id: 'overview', files: files.map(file => file.path).filter(path => !used.has(path))};
  if (!overview.files.length) throw new Error('World overview is empty');
  return {version: 1, overview, regions, chains: islandGroups};
}
