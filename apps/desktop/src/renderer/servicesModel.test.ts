import { test } from "node:test";
import assert from "node:assert/strict";
import { activeServices, openableUrl, servicesLabel, uptime, type ServiceView } from "./servicesModel.ts";

const base: ServiceView = { serviceId: "local_svc_1", name: "vite", command: "npm run dev", status: "running", url: "http://localhost:5173/", port: 5173, startedAt: 1000, location: "local" };

test("only running services count", () => {
  const list: ServiceView[] = [base, { ...base, serviceId: "x", status: "stopped" }, { ...base, serviceId: "y", status: "failed" }];
  assert.equal(activeServices(list).length, 1);
  assert.equal(servicesLabel(list), "1 service running");
  assert.equal(servicesLabel([]), null);
  assert.equal(servicesLabel([base, { ...base, serviceId: "z", status: "starting" }]), "2 services running");
});

test("uptime reads like a person would say it", () => {
  assert.equal(uptime(0, 42_000), "42s");
  assert.equal(uptime(0, 3 * 60_000 + 5_000), "3m");
  assert.equal(uptime(0, 125 * 60_000), "2h 5m");
});

test("a cloud service's localhost is not offered to the user's browser", () => {
  assert.equal(openableUrl(base), "http://localhost:5173/");
  assert.equal(openableUrl({ ...base, location: "cloud" }), undefined);
});
