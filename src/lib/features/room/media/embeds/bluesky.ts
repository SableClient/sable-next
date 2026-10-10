const APPVIEWS = new Set(['bsky.app', 'witchsky.app', 'blacksky.community', 'reddwarf.app']);

export type AtprotoRecord = {
  repo: string;
  collection?: 'app.bsky.feed.post';
  key?: string;
};

export type MiniDoc = {
  did: string;
  handle: string;
  pds: string;
  signing_key: string;
};

export type BlueskyProfileDetails = {
  uri: string;
  cid: string;
  value: {
    $type: 'app.bsky.actor.profile';
    avatar: ApBlob;
    banner: ApBlob;
    displayName: string;
    description: string;
    createdAt: string;
  };
};

export type BlueskyPostDetails = {
  uri: string;
  cid: string;
  value: {
    text: string;
    createdAt: string;
    embed?: ApEmbed;
  };
};

export type ApBlob = {
  $type: 'blob';
  size: number;
  ref: ApLink;
  mimeType: string;
  ['moe.sable.blob']?: Blob;
};

export type ApLink = {
  $link: string;
};

export type RecordWithMediaEmbed = {
  $type: 'app.bsky.embed.recordWithMedia';
  record: RecordEmbed;
  media: ImageEmbed | VideoEmbed;
};

export type RecordEmbed = {
  $type: 'app.bsky.embed.record';
  record: { cid: string; uri: string };
};

export type VideoEmbed = {
  $type: 'app.bsky.embed.video';
  presentation?: 'default' | 'gif';
  alt?: string;
  aspectRatio: { width: number; height: number };
  video: ApBlob;
};

export type ImageEmbed = {
  $type: 'app.bsky.embed.images';
  images: [
    {
      alt: string;
      image: ApBlob;
      aspectRatio: { width: number; height: number };
    },
  ];
};

export type ApEmbed = ImageEmbed | VideoEmbed | RecordEmbed | RecordWithMediaEmbed;

export function parseAtUri(uri: string): AtprotoRecord | null {
  const [_a, _b, did, _collection, record] = uri.split('/');

  return {
    repo: did,
    collection: 'app.bsky.feed.post',
    key: record,
  };
}
function recordId(url: URL): AtprotoRecord | null {
  if (!APPVIEWS.has(url.hostname)) return null;
  const paths = url.pathname.split('/');

  if (paths[1] === 'profile' && paths[3] === 'post')
    return { repo: paths[2], key: paths[4], collection: 'app.bsky.feed.post' };
  if (paths[1] === 'profile' && paths[2]) return { repo: paths[2] };

  return null;
}

export function parseBlueskyLink(href: string): AtprotoRecord | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const id = recordId(url);

  return id;
}

/*
  if we get a DID, we need to figure out what type of DID it is.
  most of these will be 'plc'. these need to go to plc.directory:

  1. https://plc.directory/did%3Aplc%3Alste6hqdnaxtah6ooaeikhe4
      `-> pds: "https://shimeji.us-east.host.bsky.network"

  1A. if instead we get a domain (e.g. f0rest.net)
      we have to go the long way around:

      https://dns.google/resolve?name=_atproto.f0rest.net&type=TXT
       `-> "did=did:plc:v6qzrzz3w76vr3ngfdvdgaa7"

      now if you are paying attention you'll have noticed that the DID is different.
      that's because the one i provided earlier doesn't work like that! ha! got you!
      because bluesky hates us we have to do this instead:

      https://w0lfertinger666.bsky.social/.well-known/atproto-did
       `-> did:plc:lste6hqdnaxtah6ooaeikhe4

  1B. if we get a did:web: (the other type of DID) we also need to do annoying stuff

      https://kghorvath.com/.well-known/did.json
       `-> pds: "https://atproto.sathani.com"

      thankfully the format is the same as the other thing

  1C. we can circumvent handle -> DID resolution with
      https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=f0rest.net
      (but this makes us dependent on bluesky, eh whatever)

  1D. we can circumvent handle -> DID -> PDS resolution with slingshot!! see resolveMiniDoc

  2. once we have a PDS we can query it for info,
     like blobs (media is stored on the Personal Data Server)

     https://shimeji.us-east.host.bsky.network/xrpc/com.atproto.sync.getBlob?did=did:plc:lste6hqdnaxtah6ooaeikhe4&cid=bafkreiafmxnfcsh7ynmdv7gibhfxq5ojw2vleq6h6e2wb44o2kfb2jzzwu`
      `-> <data>

    (cid is the actual Content Identifier)

  SECURITY:
    due to the fact we are kind of forced to talk to random servers (PDSes, ~~DID:WEB stuff~~ nvm see 1D)
    we could face ipgrabbers. the likelihood of this is small in practice but it's still worth thinking about.
*/
// TODO: cache all of this please
export async function fetchPostDetails(
  pds: string,
  did: string,
  key: string
): Promise<BlueskyPostDetails | null> {
  const url = new URL(
    `${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=app.bsky.feed.post&rkey=${key}`
  );
  url.searchParams.set('format', 'json');
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as BlueskyPostDetails;

  if (body.value.embed) await hydrateBlobs(body.value.embed, did, pds);

  return body;
}

// badly named? fetches full blobs.
// TODO: make this get partials (especially for video!!) and figure out streaming
async function hydrateBlobs(embed: ApEmbed, did: string, pds: string) {
  if (embed.$type === 'app.bsky.embed.images') {
    for (const [idx, image] of ((embed as Partial<ImageEmbed>).images ?? []).entries()) {
      const blob = await fetchBlob(image.image.ref.$link, did, pds);
      if (blob) embed.images[idx].image['moe.sable.blob'] = blob;
    }
  } else if (embed.$type === 'app.bsky.embed.video') {
    console.info(embed);
    const blob = await fetchBlob(embed.video.ref.$link, did, pds);
    if (blob) embed.video['moe.sable.blob'] = blob;
  } else if (embed.$type === 'app.bsky.embed.recordWithMedia') {
    await hydrateBlobs(embed.media, did, pds);
  }
}
export async function fetchProfile(
  pds: string,
  did: string
): Promise<BlueskyProfileDetails | null> {
  const url = new URL(
    `${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=app.bsky.actor.profile&rkey=self`
  );
  url.searchParams.set('format', 'json');
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as BlueskyProfileDetails;

  const blob = await fetchBlob(body.value.avatar.ref.$link, did, pds);
  if (blob) body.value.avatar['moe.sable.blob'] = blob;

  return body;
}

export async function fetchBlob(cid: string, did: string, pds: string): Promise<Blob | null> {
  const url = new URL(`${pds}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`);
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = await response.blob();

  return body;
}

export async function getPostRelationCount(
  did: string,
  record: string
): Promise<{ reposts: number; likes: number; comments: number } | null> {
  const url = new URL(
    `https://constellation.microcosm.blue/links/all?target=${encodeURIComponent(`at://${did}/app.bsky.feed.post/${record}`)}`
  );
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as {
    links: {
      'app.bsky.feed.repost'?: {
        '.subject.uri'?: { records: number; distinct_dids: number };
      };
      'app.bsky.feed.like'?: {
        '.subject.uri'?: { records: number; distinct_dids: number };
      };
      'app.bsky.feed.post'?: {
        '.reply.root.uri'?: { records: number; distinct_dids: number };
        '.reply.parent.uri'?: { records: number; distinct_dids: number };
      };
    };
  };

  return {
    reposts: body.links['app.bsky.feed.repost']?.['.subject.uri']?.distinct_dids ?? 0,
    likes: body.links['app.bsky.feed.like']?.['.subject.uri']?.distinct_dids ?? 0,
    comments: body.links['app.bsky.feed.post']?.['.reply.root.uri']?.records ?? 0,
  };
}

export async function resolveMiniDoc(repo: string): Promise<MiniDoc | null> {
  const url = new URL(
    `https://slingshot.microcosm.blue/xrpc/com.bad-example.identity.resolveMiniDoc?identifier=${repo}`
  );

  const response = await fetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as MiniDoc;

  return body;
}
