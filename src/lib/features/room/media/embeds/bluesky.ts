const VIDEO_HOSTS = new Set(['bsky.app', 'witchsky.app', 'blacksky.community', 'reddwarf.app']);
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
    avatar: ApImage;
    banner: ApImage;
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
    embed?: ImageEmbed;
  };
};

export type ApImage = {
  $type: 'blob';
  size: number;
  ref: ApLink;
  mimeType: string;
  ['moe.sable.blob']?: Blob;
};

export type ApLink = {
  $link: string;
};

export type ImageEmbed = {
  $type: 'app.bsky.embed.images';
  images: [
    {
      alt: string;
      image: ApImage;
      aspectRatio: { width: number; height: number };
    },
  ];
};
function recordId(url: URL): AtprotoRecord | null {
  if (!VIDEO_HOSTS.has(url.hostname)) return null;
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
  console.info(body);

  if (body.value.embed) {
    for (const [idx, image] of body.value.embed.images.entries()) {
      const blob = await fetchBlob(image.image.ref.$link, did, pds);
      if (blob) body.value.embed.images[idx].image['moe.sable.blob'] = blob;
    }
  }

  return body;
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
  record: string,
  collection: string
): Promise<number | null> {
  const url = new URL(
    `https://constellation.microcosm.blue/links/distinct-dids?target=${encodeURIComponent(`at://${did}/app.bsky.feed.post/${record}`)}&collection=${collection}&path=.subject.uri`
  );
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as { total: number };

  return body.total;
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
