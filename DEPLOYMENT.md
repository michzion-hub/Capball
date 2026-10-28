# CAPBALL: laptop and free friend-play setup

## Recommended free-first stack

Use Vercel for the static game and Render for the existing Node.js WebSocket room server. This needs no database for the current match modes. CAPBALL keeps active rooms and the authoritative Matter.js match in server memory; PostgreSQL would not keep the WebSocket process alive or coordinate live physics by itself.

Vercel supports WebSockets on all plans, but a WebSocket runs inside a Function: it closes at that Function's maximum duration, and a reconnect is not guaranteed to reach the same instance. Vercel recommends external coordination for durable room state. Hobby Functions have a listed maximum duration of 300 seconds, and Hobby is restricted to personal, non-commercial use. Making CAPBALL's in-memory, continuously ticking room server run reliably there would require a redesign and shared state, so the split stack above is the simpler fit. [1] [2]

## Setup

1. **Get the code onto your laptop.** Download and extract `capball-source.zip`, or put the project in a private GitHub repository and clone it. Vercel's GitHub import flow is easiest for continuous deploys. The current working project was in the Manus sandbox, not on your laptop or GitHub before this export.
2. **Deploy the frontend to Vercel.** Import the project. Use the Vite preset, `npm install` as the install command, `npm run build` as the build command, and `dist` as the output directory. The npm lockfile is included; the pnpm lockfile is retained for the existing Manus workflow. The build is `tsc --noEmit && vite build`; fonts, icons and share PNGs are checked-in files under `public/`, so no asset restoration or Manus-specific build wrapper is required. Set the production environment variable `CAPBALL_WS_URL` to the Render WebSocket URL shown below, then redeploy. [3]
3. **Deploy the room server to Render.** Create a Node Web Service from the same repository. Use `npm run online:server` as the start command and set `HOST=0.0.0.0` plus `CAPBALL_ALLOWED_ORIGINS=https://YOUR-APP.vercel.app`. Let Render supply `PORT`. Render accepts public WebSockets and recommends `wss://` for public clients. [4]
4. **Connect the two.** Set Vercel's `CAPBALL_WS_URL` to `wss://YOUR-SERVICE.onrender.com/ws`. Copy your Vercel URL to your friends; create a room in the game and send them its invite link.

Replace the example hostnames with the real URLs issued by the services. The allowed origin must match the page origin exactly. Configure any Vercel preview domains separately if you want preview deployments to join rooms.

## Free-tier limits and database

Before calling online play ready, add and test smoother snapshot reconciliation: clients currently apply authoritative body snapshots directly, so real internet delay or jitter may make moving caps visibly jump or rewind. The localhost browser test does not cover that.

Render Free is suitable for trying this with friends, not dependable hosting: it can sleep after 15 minutes without inbound traffic, takes about a minute to wake, has an ephemeral filesystem, and may restart. CAPBALL rooms are in memory, so a server restart loses a live match. Render explicitly says Free instances are for testing/hobby use rather than production. [5]

Do **not** create a database just for casual matches. If you later add saved accounts or a persistent leaderboard, Neon Free is one small PostgreSQL option: its current pricing page lists 1 GB and 100 compute-hours per project each month, with compute scaling to zero when idle. A database is not wired into this game, and this guide does not enable one. [6]

If this becomes an Apex commercial product, do not assume Vercel Hobby or Render Free is permitted or reliable for that use. Review the service terms and budget for a production host before inviting public users.

## References

[1]: https://vercel.com/docs/functions/websockets "Vercel WebSockets"
[2]: https://vercel.com/docs/plans/hobby "Vercel Hobby plan"
[3]: https://vercel.com/docs/frameworks/frontend/vite "Vercel Vite deployments"
[4]: https://render.com/docs/websocket "Render WebSockets"
[5]: https://render.com/docs/free "Render free services"
[6]: https://neon.com/pricing "Neon pricing"
