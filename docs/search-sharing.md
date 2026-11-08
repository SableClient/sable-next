# Search sharing

Search history is shared between verified devices on the same account over an ordered,
reliable WebRTC data channel. ICE uses `searchSharing.stunServers` from `config.json`
(default `stun:stun.sable.moe:3478`) and the homeserver's TURN server when it has one.

A device asks for a copy once per launch when it has never synced or its last sync is older
than a week, and again when it gets verified or the network comes back. A sync counts when a
copy completes or no device has anything to copy. The settings button asks right away.

A device remembers the hashes of the parts it imported. It forgets them for a room when it
leaves the room or evicts indexed history from it, and forgets everything when sharing is
turned off, when the index is rebuilt or from the settings reset button.

Discovery uses encrypted `moe.sable.search_peer.v1` to-device events (`version`, `session`,
`timestamp`, `kind`) from verified devices of the same account. `version` is the copy
protocol version, currently `4`. Devices ignore events with another version or none:

- `query`: the requesting device sends it to every verified device seen in the last 90 days.
- `info` (`documents`, `complete_rooms`, `busy`): each device that can serve answers with
  the size of its index. `busy` is set while it is already sending or receiving a copy.
- `request`: after 10 seconds, the requesting device picks the device with the most indexed
  messages, then the most fully indexed rooms. It only picks devices that rank above itself.
  `session` is the Frostbite session ID.

A device takes part in one copy at a time. If the best device is busy, the requesting device
asks every device again 30 seconds later, until that device is free. A busy device refuses a
`request` with an `info` that has `busy` set. When two devices request each other at once,
the one with the smaller device ID drops its own attempt and serves.

The chosen device becomes the Frostbite sender and the requesting device the receiver, as
described in the Frostbite device RTC framework:
`computer.gingershaped.frostbite.negotiate` (`session`, `timestamp`, `description`) and
`computer.gingershaped.frostbite.candidate` (`session`, `candidate`). If the connection
fails within 30 seconds or drops, the next device in the ranking is requested.

The data channel is `sable-search-v1`. The app passes each binary frame to the core as it
arrives, plus an empty frame when the channel opens, and sends back the bytes the core returns.

Each message is a big-endian `u32` length followed by a MessagePack map of that many bytes, at
most 6 MiB, sent in binary frames of up to 16 KiB. A message has a `kind` field. The receiver
speaks first, and the sender only answers, one message at a time. Bytes past the end of a
message close the channel. For each of its joined rooms the receiver sends:

- `room` (`room`): the sender answers `parts` (`room`, `parts`, `cover`). `parts` lists
  `start`, `end` and `sha256` per part and is empty when the sender can't share the room.
- `get` (`room`, `part`): for each listed part whose hash the receiver hasn't imported yet.
  The sender answers `data` (`room`, `part`, `data`).

The first part, `[0, 0)`, carries redactions. The rest cover a contiguous time range
without splitting events with the same timestamp. Part data is JSON compressed with zlib and
sent as MessagePack binary. `sha256` is the unpadded base64 SHA-256 of the uncompressed JSON.
`cover` (`from`, `until`, `resume`, `anchor`) is the sender's gap-free crawl range. It is
only sent when the parts cover exactly that range, and the receiver merges it into its own
crawl progress once every part is imported.
