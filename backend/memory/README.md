# JARVIS Shared Memory Convention

This document defines the standard Redis key structure used across the JARVIS architecture to ensure consistency between the Python back-end services and the Next.js API layer.

## Core Memory Keys

- **`jarvis:user:profile`**
  Stores user-specific settings, preferences, and profile information.

- **`jarvis:chat:session`**
  Maintains the active conversation history and session state between JARVIS and the user.

- **`jarvis:context:active`**
  Holds short-term memory, current environment context, and active task states.

- **`jarvis:system:status`**
  Tracks system health, operational status of subsystems, and active flags.

## Best Practices
- Always use these predefined prefixes when creating new memory structures.
- Store complex objects as JSON strings when writing to Redis.
- Python services should use `decode_responses=True` to easily read these strings.
- Next.js services must parse the returned JSON string when accessing structured memory.
