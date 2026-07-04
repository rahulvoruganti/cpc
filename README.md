# Colruyt Private Cloud (CPC)

Enterprise self-service cloud portal on top of Proxmox. Employees sign in, provision
VMs / containers / stacks, manage their lifecycle, and connect over an in-browser SSH
terminal — all behind authentication with role-based access and a full audit trail.

This is a **separate codebase** from the original `cloudportal` build. They run on
different ports and can be developed independently.

| | CPC | cloudportal (original) |
|---|---|---|
| Backend port | 4100 | 4000 |
| Frontend port | 5273 | 5173 |

## What's included

- **Auth**: local username/password (JWT) + Entra ID (Azure AD) OIDC sign-in
- **Roles**: `admin` and `user`. Admins get Users + Audit pages and delete rights.
- **Dashboard**: live VM/container counts and node CPU/memory/uptime
- **Provision**: catalog flow (VM / container / stack) with IP allocation + cloud-init
- **Resources**: inventory with start / shutdown / reboot / delete controls
- **Users**: admin-managed local accounts; Entra users auto-appear after first login
- **Audit log**: every provisioning, lifecycle, and auth event, persisted and filterable
- **AI chat**: same Gemini-powered free-text provisioning as the original, now authenticated
- **Web terminal**: xterm.js + SSH proxy, per-connection username/password login

## Prerequisites

Node.js 18+ (the project pins vite 8 / plugin-react 6 / xterm 6).

## Setup

```bash
cd backend && npm install
cd ../frontend && npm install
```

Edit `backend/.env`:

- Proxmox connection (host/node/credentials — use a scoped API user, not root)
- `GEMINI_API_KEY` for the chat assistant
- `VM_SSH_PASSWORD` — initial cloud-init password set on new VMs
- `JWT_SECRET` — set a long random string
- `CPC_ADMIN_PASSWORD` — password for the seeded `admin` account (default `admin123`)
- Entra ID block — fill `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`,
  `ENTRA_REDIRECT_URI` to enable Microsoft sign-in. Leave blank to hide that option.

## Running

```bash
./start.sh    # backend :4100 + frontend :5273, detached
./status.sh
./stop.sh
```

First sign-in: username `admin`, password from `CPC_ADMIN_PASSWORD` (default `admin123`).
Change it / create real users from the Users page.

## Entra ID setup (optional)

In the Azure portal, register an app:

1. Redirect URI (Web): `http://<your-host>:5273/auth/entra/callback`
2. Create a client secret
3. Copy tenant ID, client ID, secret into `backend/.env`
4. Grant `openid`, `profile`, `email` delegated permissions

New Entra users are created with the `user` role on first login; an admin can promote them.

## Data & persistence

JSON files under `backend/data/` (gitignored):
- `users.json` — accounts (passwords bcrypt-hashed)
- `audit.json` — audit log (capped at 5000 entries)
- `ip-pool.json` — IP allocations

## Notes / next steps

- Entra ID token signature isn't validated against JWKS (the code exchange happens
  server-side over TLS, which is fine for internal use; add JWKS validation for production).
- Job store is in-memory — provisioning history resets on backend restart.
- Resources page lists everything on the node; lifecycle actions are audited.
