// Which agent the Agents view is showing, knowing nothing of React.
//
// Separate from the view so that it can be exercised. What it guards against is
// a moment, not a state: the selected identifier and the list of profiles are
// routinely out of step for a fraction of a second — creating one selects it
// before the new state has come back from the main process, and deleting one
// leaves the selection on something already gone.
//
// Reading the profile off the list rather than trusting the identifier is what
// makes those moments harmless. Handing a component `undefined` instead cost an
// afternoon: the view threw while rendering, React unmounted the whole
// application, and the only way back was to restart it.

/**
 * The profile a selection designates, or null.
 *
 * @param {Array<{id: string}>} profiles
 * @param {string|null} selected
 * @returns {object|null}
 */
export function selectedProfile(profiles, selected) {
  if (!Array.isArray(profiles) || selected === null || selected === undefined) return null
  return profiles.find((profile) => profile.id === selected) ?? null
}

/**
 * What the selection should become once the state has caught up.
 *
 * Returns `undefined` when there is nothing to change — the caller only writes
 * when something actually moved, so that a selection the user made is not put
 * back every time the state is republished.
 *
 * @returns {string|null|undefined}
 */
export function correctedSelection(profiles, selected) {
  const list = Array.isArray(profiles) ? profiles : []
  if (selected !== null && list.some((profile) => profile.id === selected)) return undefined
  // Nothing selected and nothing to select: leave it alone rather than writing
  // null over null on every republication.
  if (selected === null && list.length === 0) return undefined
  // A selection pointing at nothing while the list is still empty is the moment
  // just after a creation: the state has not come back yet, and correcting it
  // now would undo the selection the user is about to be given.
  if (selected !== null && list.length === 0) return undefined
  return list[0]?.id ?? null
}
