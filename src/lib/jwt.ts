import { SignJWT, jwtVerify } from "jose";

export const AUTH_COOKIE = "firechat_token";
export const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface TokenClaims {
  userId: string;
  sessionId: string;
}

function getSecretKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export async function signToken(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setJti(sessionId)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

/** Returns the token's claims, or null when invalid/expired. Session revocation is checked separately (DB). */
export async function verifyToken(token: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload.sub !== "string" || typeof payload.jti !== "string") return null;
    return { userId: payload.sub, sessionId: payload.jti };
  } catch {
    return null;
  }
}
