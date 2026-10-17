"""Create (or reuse) confirmed Supabase Auth users for the first admin and demo seeds.

With SUPABASE_SECRET_KEY set, the Supabase Admin API is used (preferred). Without it, the user is written to
auth.users/auth.identities through the owner DB connection, the same shape Supabase's own seed files use.
Passwords are never printed or logged."""

import uuid

import httpx
import psycopg

from scripts._env import libpq_url, load_env


def ensure_auth_user(email: str, password: str, full_name: str) -> uuid.UUID:
    env = load_env()
    email = email.lower()
    with psycopg.connect(libpq_url(env["MIGRATION_DATABASE_URL"]), autocommit=True) as c:
        row = c.execute("SELECT id FROM auth.users WHERE lower(email) = %s", (email,)).fetchone()
        if row:
            return row[0]
        key = env.get("SUPABASE_SECRET_KEY", "")
        if key.startswith(("sb_secret_", "eyJ")):
            r = httpx.post(
                f"{env['SUPABASE_URL'].rstrip('/')}/auth/v1/admin/users",
                headers={"apikey": key, "Authorization": f"Bearer {key}"},
                json={"email": email, "password": password, "email_confirm": True,
                      "user_metadata": {"full_name": full_name}},
                timeout=20.0,
            )
            r.raise_for_status()
            return uuid.UUID(r.json()["id"])
        uid = uuid.uuid4()
        c.execute(
            """
            INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
                email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token,
                reauthentication_token, is_sso_user, is_anonymous)
            VALUES ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s,
                extensions.crypt(%s, extensions.gen_salt('bf')), now(),
                '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', %s::text), now(), now(),
                '', '', '', '', '', '', '', '', false, false)
            """,
            (uid, email, password, full_name),
        )
        c.execute(
            """
            INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at,
                updated_at)
            VALUES (%s, %s, jsonb_build_object('sub', %s::text, 'email', %s::text, 'email_verified', true),
                'email', now(), now(), now())
            """,
            (str(uid), uid, str(uid), email),
        )
        return uid
