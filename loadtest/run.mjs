// Load test: 200 different buyers send a request AT THE SAME MOMENT, all wanting one of the same 10 seats
// (20 buyers per seat). Every seat must end up with exactly one owner.
//
//   pnpm install && BASE_URL=http://localhost:8080 pnpm loadtest
//
// It talks to the real stack through nginx. All requests come from one address, so the pauses below keep the
// api's per-address rate limit (300 requests per 10 seconds by default) out of the way of what is being measured.
import autocannon from "autocannon";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const BUYERS = 200;
const SEATS = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

// 1. an event far in the future (so nothing else is going on there) and 10 of its free seats
const list = await api("/events?limit=50");
const events = list.body.items.slice(30);
const event = events[Math.floor(Math.random() * events.length)];
const map = (await api(`/events/${event.id}/seats`)).body;
const seatIds = map.rows.flatMap((row) => row.seats).filter((seat) => seat.status === "free").slice(0, SEATS).map((seat) => seat.id);
if (seatIds.length < SEATS) throw new Error(`event ${event.id} has fewer than ${SEATS} free seats; run the test again`);
console.log(`event ${event.id} "${event.title}", seats ${seatIds.join(",")}`);

// 2. 200 new buyers (a few at a time, to stay under the rate limit)
const run = Date.now().toString(36);
const buyers = [];
for (let i = 0; i < BUYERS; i += 20) {
  const batch = await Promise.all(
    Array.from({ length: Math.min(20, BUYERS - i) }, async (_, k) => {
      const email = `load-${run}-${i + k}@loadtest.local`;
      const reply = await api("/auth/register", { method: "POST", body: { email, password: "load-test-password" } });
      if (reply.status !== 201) throw new Error(`registration failed: ${reply.status} ${JSON.stringify(reply.body)}`);
      return { email, cookie: reply.headers.get("set-cookie").split(";")[0] };
    }),
  );
  buyers.push(...batch);
  await sleep(700);
}
console.log(`${buyers.length} buyers registered; waiting for the rate-limit window to pass ...`);
await sleep(11_000);

// 3. THE TEST: 200 connections, one request each, fired together. Buyer n wants seat n mod 10.
let next = 0;
const started = Date.now();
const result = await autocannon({
  url: BASE_URL,
  connections: BUYERS,
  amount: BUYERS,
  timeout: 30,
  requests: [
    {
      method: "POST",
      path: `/api/events/${event.id}/holds`,
      setupRequest(request, context) {
        if (context.index === undefined) context.index = next++;
        const buyer = buyers[context.index];
        return {
          ...request,
          headers: { "content-type": "application/json", cookie: buyer.cookie, "idempotency-key": `load-${run}-${context.index}` },
          body: JSON.stringify({ seatIds: [seatIds[context.index % SEATS]] }),
        };
      },
    },
  ],
});
const elapsedMs = Date.now() - started;

// 4. what happened
const codes = result.statusCodeStats;
const created = codes["201"]?.count ?? 0;
const refused = codes["409"]?.count ?? 0;
console.log(`\nautocannon: ${result.requests.total} requests in ${(elapsedMs / 1000).toFixed(2)} s`);
console.log(`  latency  avg ${result.latency.average} ms, p50 ${result.latency.p50} ms, p97.5 ${result.latency.p97_5} ms, p99 ${result.latency.p99} ms, max ${result.latency.max} ms`);
console.log(`  answers  201 created: ${created}, 409 refused: ${refused}, other: ${result.requests.total - created - refused}  (errors ${result.errors}, timeouts ${result.timeouts}, non-2xx ${result.non2xx})`);

await sleep(11_000);
// 5. the proof: ask every buyer which seats are theirs
const mine = new Map();
for (let i = 0; i < buyers.length; i += 25) {
  await Promise.all(
    buyers.slice(i, i + 25).map(async (buyer, k) => {
      const reply = await api(`/events/${event.id}/seats`, { cookie: buyer.cookie });
      const seats = reply.body.rows.flatMap((row) => row.seats).filter((seat) => seat.mine && seatIds.includes(seat.id)).map((seat) => seat.id);
      mine.set(i + k, seats);
    }),
  );
  await sleep(300);
}
const owners = new Map();
for (const [buyer, seats] of mine) for (const seat of seats) owners.set(seat, [...(owners.get(seat) ?? []), buyer]);
const problems = [];
for (const seat of seatIds) {
  const who = owners.get(seat) ?? [];
  if (who.length !== 1) problems.push(`seat ${seat} has ${who.length} owners`);
}
if (created !== SEATS) problems.push(`${created} holds were created, expected ${SEATS}`);
if (created + refused !== BUYERS) problems.push(`${BUYERS - created - refused} requests were neither 201 nor 409`);
const finalMap = (await api(`/events/${event.id}/seats`)).body;
const heldNow = finalMap.rows.flatMap((row) => row.seats).filter((seat) => seatIds.includes(seat.id) && seat.status === "held").length;
console.log(`  result   ${owners.size} of ${SEATS} seats have an owner; ${heldNow} are shown as held; owners per seat: ${seatIds.map((s) => (owners.get(s) ?? []).length).join(",")}`);
if (problems.length > 0) {
  console.error(`\nFAILED:\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log("\nOK: every one of the 10 seats has exactly one owner.");
