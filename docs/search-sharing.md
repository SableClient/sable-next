# Search sharing

Search history is shared between verified devices on the same account over an ordered,
reliable WebRTC data channel. ICE uses `searchSharing.stunServers` from `config.json`
(default `stun:stun.sable.moe:3478`) and the homeserver's TURN server when it has one.

Devices find each other with `moe.sable.search_peer.v1` (`session`, `timestamp`, `kind`):
`probe` picks a device, `ready` answers. The prober becomes the sender.

Signaling then follows Frostbite over encrypted to-device events from verified devices:
`computer.gingershaped.frostbite.negotiate` (`session`, `timestamp`, `description`) and
`computer.gingershaped.frostbite.candidate` (`session`, `candidate`).

Each device requests rooms (`list`, `rooms`), then their parts (`room`, `part`, `next`,
`done`). Parts are JSON, compressed with zlib and encoded as unpadded base64. Their
SHA-256 hashes cover the uncompressed JSON and let a device skip parts it already has.
The first part, `[0, 0)`, carries redactions. The rest cover contiguous time ranges
without splitting events with the same timestamp.

The receiver checks and saves each part before requesting the next one. It can use
shared crawl coverage after receiving contiguous parts for a joined room. Coverage is
only sent from a gap-free checkpoint if the index hasn't changed during the transfer.

The `sable-search-v1` channel starts with `ready` and `ack`. Messages after that are
UTF-8 JSON with a four-byte big-endian length. The codec runs in model WASM; the browser
sends chunks of up to 16 KiB. Frames are limited to 6 MiB, with a bounded receive queue.
