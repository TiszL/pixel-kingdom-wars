// D-181 shield domes on the web realm map (native cc62ab3, "a Home read never hides the feed's shield dome").
// The engine draws a dome for every kingdom whose `shield` is true (bases.mjs shieldBack / shieldFront, in its own
// passes over the kingdoms); this module only decides that bit, from the host's reads, so no shader or lane changes:
//   - the viewport feed (GET /globe/fantasy/parcels markers[].shielded) is the source: its true ALWAYS draws;
//   - the player's own base read (/base) can only ADD a dome to the player's own kingdom (a shield the feed has not
//     polled yet); a stale or shield-less own read never clears the feed's dome;
//   - no field at all (an older server) is unknown, not "open": undefined, and no Unshielded filter is offered for it
//     (D-191: that chip keeps only an explicit false, so an unknown kingdom never passes it).
// The server still decides every raid; a dome is presentation only.

/** true | false | undefined for one kingdom. feed: the marker's shielded; own: the /base read's shield (own base only). */
export function domeState(feed, own, mine) {
  if (feed === true) return true;
  if (mine && own === true) return true;
  if (feed === false) return false;
  return undefined;
}

/** Whether a read has carried the shielded key at all (the Unshielded chip stays hidden, not faked, until one has). */
export function feedCarriesShield(markers) {
  return Array.isArray(markers) && markers.some(m => typeof m?.shielded === 'boolean');
}
