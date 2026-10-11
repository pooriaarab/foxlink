// A second public origin for e2e/run.mjs on Ichabod. A process has one
// shared quick tunnel, so all its mounts share one origin. This child opens
// its own tunnel, mounts each port in argv, prints the URLs as one JSON line,
// and stays alive until its stdin closes (the parent exits) or it gets SIGTERM.
//
//   node e2e/second-origin.mjs <port> [<port> ...]  ->  ["https://x.trycloudflare.com/_foxkit/1", ...]
import { tunnel } from "create-foxkit/e2e";

const mounts = [];
for (const port of process.argv.slice(2)) mounts.push(await tunnel(Number(port)));
process.stdout.write(`${JSON.stringify(mounts.map((m) => m.url))}\n`);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
