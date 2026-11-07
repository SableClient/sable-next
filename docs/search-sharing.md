# Search sharing

Search history is shared between verified devices on the same account over an ordered,
reliable WebRTC data channel. ICE uses `searchSharing.stunServers` from `config.json`
(default `stun:stun.sable.moe:3478`) and the homeserver's TURN server when it has one.

A device asks for a copy after it is verified for the first time, after it has been away for
a week, or from the settings button. It keeps asking every minute while it is open, for up
to a day, until a copy completes.

Discovery uses encrypted `moe.sable.search_peer.v1` to-device events (`session`,
`timestamp`, `kind`) from verified devices of the same account:

- `query`: the requesting device sends it to every verified device seen in the last 90 days.
- `info` (`documents`, `complete_rooms`): each device that can serve right now answers with
  the size of its index.
- `request`: after 10 seconds, the requesting device picks the device with the most indexed
  messages, then the most fully indexed rooms. `session` is the Frostbite session ID.

The chosen device becomes the Frostbite sender and the requesting device the receiver, as
described in the Frostbite device RTC framework:
`computer.gingershaped.frostbite.negotiate` (`session`, `timestamp`, `description`) and
`computer.gingershaped.frostbite.candidate` (`session`, `candidate`). If the connection
fails within 30 seconds or drops, the next device in the ranking is requested. A device
serves at most two copies at once and one per requesting device.

The receiver requests rooms (`list`, `rooms`), then their parts (`room`, `part`, `next`,
`done`). The sender only answers. Parts are JSON, compressed with zlib and encoded as
unpadded base64. Their SHA-256 hashes cover the uncompressed JSON and let a device skip
parts it already has. The first part, `[0, 0)`, carries redactions. The rest cover
contiguous time ranges without splitting events with the same timestamp.

The receiver checks and saves each part before requesting the next one. It can use
shared crawl coverage after receiving contiguous parts for a joined room. Coverage is
only sent from a gap-free checkpoint if the index hasn't changed during the transfer.

The `sable-search-v1` channel starts with `ready` and `ack`. Messages after that are
UTF-8 JSON with a four-byte big-endian length. The codec runs in model WASM; the browser
sends chunks of up to 16 KiB. Frames are limited to 6 MiB, with a bounded receive queue.
