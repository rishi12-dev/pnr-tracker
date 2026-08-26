import { configure, checkPNRStatus } from "railkit";

const pnr = process.argv[2];

if (!pnr || !/^\d{10}$/.test(pnr)) {
  console.error("PNR must be exactly 10 digits");
  process.exit(2);
}

const key = process.env.RAILKIT_API_KEY;
if (!key) {
  console.error("RAILKIT_API_KEY is missing");
  process.exit(2);
}

try {
  configure(key);
  const result = await checkPNRStatus(pnr);
  process.stdout.write(JSON.stringify(result));
  if (!result.success) process.exitCode = 1;
} catch (err) {
  console.error(err?.message || String(err));
  process.exitCode = 1;
}
