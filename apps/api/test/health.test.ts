import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("says the process is alive", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers 404 (not 500) for a path that does not exist", async () => {
    expect((await fetch(`${base}/nothing-here`)).status).toBe(404);
  });
});
