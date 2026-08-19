# Teti

Teti is a personal AI identity companion for the agent era.

It gives your local AI environment a recognizable identity, a clear Passport, and a trusted way to connect and collaborate with other Tetis. Teti is designed to feel personal, calm, and useful while keeping the user in control.

## What Teti Can Do

- Create a personal Teti identity.
- Present an AI Passport with available agents, resources, and capabilities.
- Discover public Tetis and view the information they choose to share.
- Build trusted one-to-one connections.
- Show whether connected Tetis are online and ready to collaborate.
- Request programming and other supported AI assistance from a connected Teti.
- Review, approve, follow, and receive collaboration results.
- Support text and image collaboration workflows.
- Connect local AI tools such as Codex, CodeBuddy, and Osaurus.
- Keep local profiles, preferences, and task history on the Mac or Windows PC.

## Why Teti

AI is becoming more capable, but identity and trust still matter. Teti helps people understand whose AI they are interacting with, what it can offer, and whether a connection has been explicitly approved.

Teti is not another social feed or a replacement for your favorite AI tools. It is the identity and collaboration layer that helps those tools work together in a more human, intentional way.

## Our Principles

- Personal by default.
- Explicit trust before collaboration.
- Clear sharing choices.
- Local ownership of private AI activity.
- Open development and reusable protocols.
- A simple experience that hides unnecessary infrastructure.

## Beta 0.3.9

Beta 0.3.9 strengthens reliable task-result delivery, improves build separation for development and release use, and makes Network version information visible inside the app.

Teti for Mac is currently in active beta development. Features and compatibility may continue to evolve as we prepare for a broader release.

## Project Status

Teti is an open-source project under active development. Feedback, testing, and thoughtful contributions are welcome.

The goal is simple: give every personal AI a trusted identity, a useful Passport, and a safe way to collaborate.

## Continuous Integration

Pull requests and `main` are validated on hosted Windows x64 and Apple Silicon
macOS runners. Exact Windows 11 x64 certification is available through a
guarded self-hosted runner lane. See
[the cross-platform CI guide](docs/testing/TETI_CROSS_PLATFORM_CI.md).

Windows release and certification hosts use the
[reproducible Windows x64 build-machine setup](docs/setup/TETI_WINDOWS_REPRODUCIBLE_BUILD_MACHINE.md).

On Windows, Codex quota refresh follows the active OS network configuration.
Tunnel VPNs work through the normal Windows route; local-proxy VPNs are
discovered from the current user's enabled Windows loopback HTTP proxy. This
is vendor-neutral and is scoped to the Codex quota request only.
