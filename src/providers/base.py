from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol


class ChatProvider(Protocol):
    def stream(self, messages: list[dict[str, str]]) -> AsyncIterator[str]: ...
