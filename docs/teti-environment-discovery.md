# Teti Environment Discovery

Teti V1 publishes a small public description of the owner's AI environment so other Tetis can discover compatible local setups.

This is product scope for V1:

- Teti is born.
- Teti registers a public identity.
- Teti reports public AI environment metadata.
- Teti discovers other Tetis.

Task collaboration, agent messaging, and AI-to-AI workflows are future phases.

## Public AI Node Metadata Policy

Teti publishes safe node-level metadata, not personal identity or network identity. The goal is to help other Tetis understand the kind of AI environment they are discovering without exposing private machine details.

## Public Data

The environment scanner returns:

```json
{
  "platform": "macOS",
  "device": {
    "os": {
      "name": "macOS",
      "version": "15.5"
    },
    "hardware": {
      "vendor": "Apple",
      "model": "Mac Studio",
      "architecture": "arm64"
    }
  },
  "location": {
    "country": "US",
    "city": "San Francisco"
  },
  "aiTools": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "source": "command"
    }
  ],
  "timestamp": "2026-07-11T00:00:00.000Z"
}
```

The registry profile publishes only:

```json
{
  "platform": "macOS",
  "device": {
    "os": {
      "name": "macOS",
      "version": "15.5"
    },
    "hardware": {
      "vendor": "Apple",
      "model": "Mac Studio",
      "architecture": "arm64"
    }
  },
  "location": {
    "country": "US",
    "city": "San Francisco"
  },
  "aiEnvironment": ["Claude Code", "Cursor"],
  "lastSeen": "2026-07-11T00:00:00.000Z"
}
```

`location` is optional. Teti does not automatically derive precise location. Country and city may be supplied by user or system configuration, and may be omitted.

## Local Detection

V1 detects public installation metadata for tools such as:

- Claude Code
- Cursor
- Codex
- Gemini CLI
- AI-related VS Code or Cursor extensions

Detectors are intentionally shallow. They check command availability, known application paths, and extension directory names. They do not read source files, project files, prompts, documents, or configuration secrets.

## Privacy Boundary

Allowed:

- operating platform
- OS name and version
- hardware vendor, model, and architecture
- installed AI tool names
- AI extension names
- optional country and city
- timestamp for `lastSeen`

Forbidden:

- IP address
- MAC address
- hostname
- username
- serial number
- filesystem path
- files
- source code
- documents
- prompts
- API keys
- credentials
- chat history
- local database paths

The scanner serializes a whitelist-only public profile. Unknown fields and private fields are not included in the registry payload.

Inputs containing explicitly forbidden host fields are rejected instead of silently published.

## Registry Update

During account creation, Teti scans the local AI environment and includes the public profile in `/register`.

During environment refresh, Teti calls `/heartbeat` with:

```json
{
  "id": "teti_xxx",
  "publicProfile": {
    "platform": "macOS",
    "device": {
      "os": {
        "name": "macOS",
        "version": "15.5"
      },
      "hardware": {
        "vendor": "Apple",
        "model": "Mac Studio",
        "architecture": "arm64"
      }
    },
    "location": {
      "country": "US",
      "city": "San Francisco"
    },
    "aiEnvironment": ["Claude Code", "Codex"],
    "lastSeen": "2026-07-11T00:00:00.000Z"
  }
}
```

The Cloudflare registry stores and returns public `platform`, `device`, `location`, `aiEnvironment`, and `lastSeen` fields only.
