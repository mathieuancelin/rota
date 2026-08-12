import { useEffect, useState } from 'react'

/**
 * Subscribes to the state snapshot pushed by the main process.
 * The renderer derives no business state on its side: everything comes from here.
 */
export function useAppState() {
  const [state, setState] = useState(null)

  useEffect(() => {
    let active = true
    window.rota.getState().then((snapshot) => {
      if (active) setState(snapshot)
    })
    const unsubscribe = window.rota.onStateChanged((snapshot) => {
      if (active) setState(snapshot)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}
