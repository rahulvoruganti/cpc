import jwt from "jsonwebtoken";
import axios from "axios";

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
const JWT_EXPIRY = process.env.JWT_EXPIRY || "8h";

export function issueToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      source: user.source,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// --- Entra ID (Azure AD) OIDC ---
// Frontend uses the auth-code flow and sends us the `code`; we exchange it
// for tokens, then read the id_token claims.
const {
  ENTRA_TENANT_ID,
  ENTRA_CLIENT_ID,
  ENTRA_CLIENT_SECRET,
  ENTRA_REDIRECT_URI,
} = process.env;

export function isEntraConfigured() {
  return Boolean(ENTRA_TENANT_ID && ENTRA_CLIENT_ID && ENTRA_CLIENT_SECRET && ENTRA_REDIRECT_URI);
}

export function getEntraAuthUrl(state) {
  const base = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/authorize`;
  const params = new URLSearchParams({
    client_id: ENTRA_CLIENT_ID,
    response_type: "code",
    redirect_uri: ENTRA_REDIRECT_URI,
    response_mode: "query",
    scope: "openid profile email",
    state: state || "",
  });
  return `${base}?${params.toString()}`;
}

export async function exchangeEntraCode(code) {
  const tokenUrl = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: ENTRA_CLIENT_ID,
    client_secret: ENTRA_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: ENTRA_REDIRECT_URI,
    scope: "openid profile email",
  });

  const res = await axios.post(tokenUrl, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const idToken = res.data.id_token;
  // Decode without verifying signature here for simplicity; in production
  // validate against the tenant's JWKS. The token came directly from Microsoft
  // over TLS via the code exchange, so it's trustworthy for a hackathon build.
  const claims = jwt.decode(idToken);
  return {
    username: claims.preferred_username || claims.email || claims.sub,
    displayName: claims.name || claims.preferred_username,
    email: claims.email || claims.preferred_username || "",
  };
}
