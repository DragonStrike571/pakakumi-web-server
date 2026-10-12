import test from "node:test";
import assert from "node:assert/strict";
import { parseUserInput } from "better-auth/db";
import { authorizationFields } from "./access.js";

test("Better Auth rejects privilege fields from client signup and profile updates", () => {
  const options = { user: { additionalFields: authorizationFields } };
  for (const action of ["create", "update"] as const) {
    if (action === "update") assert.throws(() => parseUserInput(options, { role: "admin", accessStatus: "active" }, action), /not allowed/);
    else {
      const denied = parseUserInput(options, { role: "admin", accessStatus: "active" }, action);
      assert.notEqual(denied.role, "admin"); assert.notEqual(denied.accessStatus, "active");
    }
    const accepted = parseUserInput(options, { name: "New User" }, action);
    assert.notEqual(accepted.role, "admin");
    assert.notEqual(accepted.accessStatus, "active");
  }
});
