"""Create or update Ali and Hamza accounts using interactive password prompts."""

from __future__ import annotations

import getpass
import uuid

from database import create_user, initialize, user_by_username
from security import hash_password


def main() -> None:
    initialize()
    for username, display_name in (("ali", "Ali"), ("hamza", "Hamza")):
        existing = user_by_username(username)
        if existing:
            answer = (
                input(f"{display_name} exists. Reset password? [y/N] ").strip().lower()
            )
            if answer != "y":
                continue
        password = getpass.getpass(f"Set password for {display_name}: ")
        if len(password) < 12:
            raise SystemExit("Use at least 12 characters.")
        confirmation = getpass.getpass("Confirm password: ")
        if password != confirmation:
            raise SystemExit("Passwords did not match.")
        if existing:
            from database import connection

            with connection() as db:
                user = db.execute(
                    "SELECT id FROM users WHERE username=?", (username,)
                ).fetchone()
                db.execute(
                    "UPDATE users SET password_hash=? WHERE username=?",
                    (hash_password(password), username),
                )
                db.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
        else:
            create_user(
                str(uuid.uuid4()), username, display_name, hash_password(password)
            )
        print(f"{display_name} account configured.")


if __name__ == "__main__":
    main()
