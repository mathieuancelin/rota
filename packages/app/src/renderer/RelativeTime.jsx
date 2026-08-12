import { useEffect, useState } from 'react'

import { formatRelative } from './format.js'

// A countdown that refreshes itself.
//
// The state snapshot is only pushed in reaction to an engine event. Between two
// executions nothing happens, and "in 5 minutes" would stay displayed as it is
// for five minutes. For a menu bar application, whose window often stays open
// with no interaction, that is a false value.
//
// Each instance carries its own timer: refreshing the whole view every second
// would re-render complete lists for a single label.

const SECOND = 1000
const MINUTE = 60 * SECOND

/**
 * Cadence suited to the distance displayed: no point refreshing an "in 3 hours"
 * every second, whose label will not move for half an hour.
 */
function refreshDelay(target, now) {
  const distance = Math.abs(target - now)
  if (distance < 90 * SECOND) return SECOND
  if (distance < 90 * MINUTE) return 30 * SECOND
  return 5 * MINUTE
}

export default function RelativeTime({ iso }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!iso) return undefined
    const target = Date.parse(iso)
    let timer = null

    const tick = () => {
      const current = Date.now()
      setNow(current)
      timer = setTimeout(tick, refreshDelay(target, current))
    }
    timer = setTimeout(tick, refreshDelay(target, Date.now()))

    // The window spends most of its time hidden in the tray, and background
    // timers are throttled. We resynchronise on reappearing rather than showing
    // a stale value until the next tick.
    const resync = () => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(timer)
      tick()
    }
    document.addEventListener('visibilitychange', resync)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', resync)
    }
  }, [iso])

  if (!iso) return null
  return formatRelative(iso, now)
}
