import { strict as assert } from "node:assert";

const originalPort = process.env.PORT;
const originalEnabled = process.env.DEBUG_SURFACES_ENABLED;
const originalAccessKey = process.env.DEBUG_SURFACES_ACCESS_KEY;

process.env.PORT = "3012";
delete process.env.DEBUG_SURFACES_ENABLED;
delete process.env.DEBUG_SURFACES_ACCESS_KEY;

const { app } = await import("../src/app.js");

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("debug route is blocked by default", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed"
  });
  assert.equal(response.statusCode, 404);
});

await run("debug route stays blocked when enable flag lacks an access key", async () => {
  process.env.DEBUG_SURFACES_ENABLED = "1";
  delete process.env.DEBUG_SURFACES_ACCESS_KEY;

  const response = await app.inject({
    method: "GET",
    url: "/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed"
  });
  assert.equal(response.statusCode, 404);
});

await run("debug route requires the explicit access key once enabled", async () => {
  process.env.DEBUG_SURFACES_ENABLED = "1";
  process.env.DEBUG_SURFACES_ACCESS_KEY = "test-debug-key";

  const blocked = await app.inject({
    method: "GET",
    url: "/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed"
  });
  assert.equal(blocked.statusCode, 403);

  const wrongKey = await app.inject({
    method: "GET",
    url: "/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed",
    headers: {
      "x-debug-access-key": "wrong-key"
    }
  });
  assert.equal(wrongKey.statusCode, 403);

  const allowed = await app.inject({
    method: "GET",
    url: "/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed",
    headers: {
      "x-debug-access-key": "test-debug-key"
    }
  });
  assert.equal(allowed.statusCode, 200);
});

await app.close();

if (originalPort === undefined) {
  delete process.env.PORT;
} else {
  process.env.PORT = originalPort;
}

if (originalEnabled === undefined) {
  delete process.env.DEBUG_SURFACES_ENABLED;
} else {
  process.env.DEBUG_SURFACES_ENABLED = originalEnabled;
}

if (originalAccessKey === undefined) {
  delete process.env.DEBUG_SURFACES_ACCESS_KEY;
} else {
  process.env.DEBUG_SURFACES_ACCESS_KEY = originalAccessKey;
}

process.exit(0);
