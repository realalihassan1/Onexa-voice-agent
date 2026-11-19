"""Password and session primitives for the local ONEXAI service."""

from __future__ import annotations

import hashlib
import hmac
import secrets

PASSWORD_N = 2**15
PASSWORD_R = 8
PASSWORD_P = 1
SESSION_BYTES = 32


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode(),
        salt=salt,
        n=PASSWORD_N,
        r=PASSWORD_R,
        p=PASSWORD_P,
        maxmem=64 * 1024 * 1024,
    )
    return f"scrypt${PASSWORD_N}${PASSWORD_R}${PASSWORD_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, n, r, p, salt_hex, digest_hex = stored.split("$")
        if algorithm != "scrypt":
            return False
        candidate = hashlib.scrypt(
            password.encode(),
            salt=bytes.fromhex(salt_hex),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(bytes.fromhex(digest_hex)),
            maxmem=64 * 1024 * 1024,
        )
        return hmac.compare_digest(candidate.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(SESSION_BYTES)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
