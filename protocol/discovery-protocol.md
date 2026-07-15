# Discovery Protocol V1

Teti Discovery Registry V1 exposes public identity cards through a native Cloudflare Worker backed by KV.

## Endpoints

- `POST /register`
- `POST /heartbeat`
- `GET /discover`
- `GET /profile/:id`

Records use KV keys in the format `teti:{id}` and expire after 604800 seconds.

