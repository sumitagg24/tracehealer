import assert from "node:assert/strict";
import test from "node:test";
import {
  getCustomerEmail,
  OrderContractError,
  resolveReceiptRequest,
} from "../src/order-support.mjs";

const failedTracePayload = {
  order: {
    id: "TH-1048",
    contact: { primaryEmail: "ada@example.com" },
    status: "paid",
  },
  apiVersion: "2026-10-01",
};

test("replays the exact failed trace input", () => {
  assert.deepEqual(resolveReceiptRequest(failedTracePayload), {
    status: "ready",
    orderId: "TH-1048",
    recipient: "ada@example.com",
  });
});

test("accepts the legacy customer.email contract", () => {
  assert.equal(
    getCustomerEmail({ order: { id: "legacy", status: "paid", customer: { email: "LEGACY@example.com" } } }),
    "legacy@example.com",
  );
});

test("accepts the v3 contact.primaryEmail contract", () => {
  assert.equal(getCustomerEmail(failedTracePayload), "ada@example.com");
});

test("rejects a missing email with a typed contract error", () => {
  assert.throws(
    () => getCustomerEmail({ order: { id: "invalid", status: "paid" } }),
    OrderContractError,
  );
});
