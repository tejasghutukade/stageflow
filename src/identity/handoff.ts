import { createLocalJWKSet, jwtVerify } from "jose";
import { ConsumerIdentityStore } from "./store.js";
import { ConsumerAccessError } from "./types.js";

export async function admitEmbeddedConsumer(store: ConsumerIdentityStore, connectionId: string, agentId: string, assertion: string,
  now: () => number = Date.now): Promise<string> {
  try {
    if (assertion.length > 16_384) throw new Error("invalid");
    const connection = store.connection(connectionId);
    if (connection.agentId !== agentId) throw new Error("invalid");
    const { payload } = await jwtVerify(assertion, createLocalJWKSet(connection.publicJwks), {
      issuer: connection.issuer,
      audience: connection.audience,
      algorithms: connection.algorithms,
      typ: "stageflow-agent-handoff+jwt",
      requiredClaims: ["sub", "jti", "iat", "exp", "workspace", "agent"],
      maxTokenAge: 300,
      clockTolerance: 0,
      currentDate: new Date(now()),
    });
    if (!payload.sub || !payload.jti || payload.jti.length > 256 || payload.sub.length > 512
      || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
      || payload.iat! > Math.floor(now() / 1000) || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 300
      || payload.workspace !== store.workspaceId || payload.agent !== agentId) throw new Error("invalid");
    return store.admit(connection, payload.sub, payload.jti, Math.min(payload.exp! * 1000, now() + 300_000));
  } catch {
    throw new ConsumerAccessError("identity.verification_required");
  }
}
