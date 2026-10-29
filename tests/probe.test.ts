// Prints how far / how long caps and the ball travel per surface and power. `pnpm tsx`-free: run with vitest.
import { it } from 'vitest'
import { RULESETS } from '../src/config/rulesets'
import { SURFACES } from '../src/config/tuning'
import type { SurfaceId } from '../src/config/tuning'
import { Match } from '../src/game/match'

it.skipIf(!process.env.PROBE)('probe', () => {
  for (const surface of Object.keys(SURFACES) as SurfaceId[]) {
    for (const slot of [0, 1, 3, 4]) {
      for (const power of [0.25, 0.6, 1]) {
        const m = new Match({ ruleset: RULESETS.street, surface })
        // isolate cap: move everyone else away
        m.world.caps.forEach((b, i) => { if (i !== slot) m.world.place(b, { x: 950 - (i % 5) * 20, y: 20 + i * 10 }) })
        m.world.place(m.world.ball, { x: 980, y: 600 })
        m.world.place(m.world.caps[slot], { x: 60, y: 300 })
        m.tryFlick(slot, { x: 1, y: 0 }, power)
        const v0 = m.world.caps[slot].speed
        let t = 0
        while (m.phase === 'moving' && t < 30000) { m.update(1000 / 60); t += 1000 / 60 }
        const d = m.world.caps[slot].position.x - 60
        console.log(`${surface.padEnd(8)} ${m.world.capInfo(slot).type.id.padEnd(9)} p=${power} v0=${v0.toFixed(1)} dist=${d.toFixed(0)} t=${(t / 1000).toFixed(2)}s`)
        m.destroy()
      }
    }
  }
})
