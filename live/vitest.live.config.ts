// Separate from the suite in test/, because these talk to the deployed service
// and cost Firecrawl credits. They are opt-in: `npm test` must stay hermetic.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["live/**/*.test.ts"], testTimeout: 60_000 },
});
