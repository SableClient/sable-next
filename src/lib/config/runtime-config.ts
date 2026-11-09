import { asset } from '$app/paths';
import * as v from 'valibot';

import { gifProviderIds } from '#lib/gif/providers.js';
import { isRecord } from '#lib/guards.js';

/** Key names follow v1's `config.json` so a deployment can carry its file over. */
export type PushDetails = v.InferOutput<typeof PushSchema>;

export type HomeserversConfig = {
  list: string[];
  default: string;
  allowCustom: boolean;
};

export type CallsConfig = v.InferOutput<typeof CallsSchema>;
export type SupporterConfig = v.InferOutput<typeof SupporterSchema>;
export type EmbedsConfig = v.InferOutput<typeof EmbedsSchema>;
export type BrandingConfig = v.InferOutput<typeof BrandingSchema>;
export type LinksConfig = v.InferOutput<typeof LinksSchema>;
export type AuthPolicyConfig = v.InferOutput<typeof AuthSchema>;
export type RuntimeConfig = v.InferOutput<typeof RuntimeSchema>;

export const BUILT_IN_HOMESERVERS: HomeserversConfig = {
  list: ['matrix.org', 'mozilla.org', 'unredacted.org', 'sable.moe', 'kendama.moe', 'hopium.club'],
  default: 'matrix.org',
  allowCustom: true,
};

const NonBlankText = v.pipe(v.string(), v.trim(), v.minLength(1));
const Text = v.fallback(v.nullable(NonBlankText), null);
const RecordValue = v.custom<Record<string, unknown>>(isRecord);
const TextList = v.fallback(
  v.pipe(
    v.array(Text),
    v.transform((values) => [...new Set(values.filter((value) => value !== null))])
  ),
  []
);
const HttpService = v.pipe(
  NonBlankText,
  v.transform((value) => value.replace(/\/+$/, '')),
  v.regex(/^https?:\/\//)
);

/** The three values a subscription needs are read as one unit; see
    `hasCompleteOverride` for why a partial set is worse than none. */
const PushSchema = v.pipe(
  v.object({
    pushNotifyUrl: NonBlankText,
    vapidPublicKey: NonBlankText,
    webPushAppID: NonBlankText,
    nativePushAppID: Text,
    iosPushAppID: v.optional(Text),
    unifiedPushEmbeddedServerUrl: v.optional(Text),
    unifiedPushGatewayUrl: v.optional(Text),
  }),
  v.transform(({ iosPushAppID, unifiedPushEmbeddedServerUrl, unifiedPushGatewayUrl, ...push }) => ({
    ...push,
    ...(iosPushAppID ? { iosPushAppID } : {}),
    ...(unifiedPushEmbeddedServerUrl ? { unifiedPushEmbeddedServerUrl } : {}),
    ...(unifiedPushGatewayUrl ? { unifiedPushGatewayUrl } : {}),
  }))
);

const ED25519_PUBLIC_KEY = /^[A-Za-z0-9+/_-]{43}$/;
const AwardKey = v.pipe(NonBlankText, v.regex(ED25519_PUBLIC_KEY));
const SupporterSchema = v.object({
  serviceUrl: HttpService,
  keys: v.pipe(
    RecordValue,
    v.transform((keys): Record<string, string> =>
      Object.fromEntries(
        Object.entries(keys).flatMap(([id, raw]) => {
          const key = v.safeParse(AwardKey, raw);
          return key.success ? [[id, key.output]] : [];
        })
      )
    ),
    v.minEntries(1),
    v.readonly()
  ),
});

const GifsSchema = v.object({
  provider: v.fallback(v.nullable(v.pipe(NonBlankText, v.picklist(gifProviderIds))), null),
  proxyUrl: Text,
  klipyApiKey: Text,
  tenorApiKey: Text,
  giphyApiKey: Text,
});
const OptionalHttpService = v.fallback(v.nullable(HttpService), null);
const AssetUrl = v.fallback(v.nullable(v.pipe(NonBlankText, v.regex(/^(https?:\/\/|\/)/))), null);

const BrandingSchema = v.object({
  appName: Text,
  logoUrl: AssetUrl,
  faviconUrl: AssetUrl,
  themeUrl: AssetUrl,
});
const LinksSchema = v.object({
  help: OptionalHttpService,
  privacy: OptionalHttpService,
  bugReport: OptionalHttpService,
  supportRoom: Text,
  terms: v.fallback(v.array(v.object({ text: NonBlankText, url: HttpService })), []),
});
const AuthSchema = v.object({
  ssoRedirect: v.fallback(v.nullable(v.picklist(['immediate', 'loginPage'])), null),
  disableRegistration: v.fallback(v.boolean(), false),
  logoutRedirectUrl: OptionalHttpService,
  deviceDisplayName: Text,
});

const EmbedsSchema = v.object({ serviceUrl: OptionalHttpService });
const CallsSchema = v.object({ livekitServiceUrl: Text });
const StunUrl = v.pipe(NonBlankText, v.regex(/^stuns?:/));
const SearchSharingSchema = v.object({
  stunServers: v.fallback(v.array(StunUrl), ['stun:stun.sable.moe:3478']),
});
export const RuntimeSchema = v.pipe(
  v.object({
    pushNotificationDetails: v.fallback(v.nullable(PushSchema), null),
    supporterAwards: v.fallback(v.nullable(SupporterSchema), null),
    gifs: v.fallback(GifsSchema, v.parse(GifsSchema, {})),
    embeds: v.fallback(EmbedsSchema, v.parse(EmbedsSchema, {})),
    calls: v.fallback(CallsSchema, v.parse(CallsSchema, {})),
    searchSharing: v.fallback(SearchSharingSchema, v.parse(SearchSharingSchema, {})),
    homeserverList: TextList,
    allowCustomHomeservers: v.fallback(v.boolean(), BUILT_IN_HOMESERVERS.allowCustom),
    defaultHomeserver: v.optional(v.unknown()),
    featuredCommunities: v.fallback(v.object({ servers: TextList }), { servers: [] }),
    disableAccountSwitcher: v.fallback(v.boolean(), false),
    settingsDefaults: v.fallback(RecordValue, {}),
    hideUsernamePasswordFields: v.fallback(v.boolean(), false),
    branding: v.fallback(BrandingSchema, v.parse(BrandingSchema, {})),
    links: v.fallback(LinksSchema, v.parse(LinksSchema, {})),
    hideCommunityLinks: v.fallback(v.boolean(), false),
    auth: v.fallback(AuthSchema, v.parse(AuthSchema, {})),
    settingsLocked: v.fallback(RecordValue, {}),
  }),
  v.transform((source) => {
    const list = source.homeserverList;
    const homeservers = list.length
      ? { list, default: list[0], allowCustom: source.allowCustomHomeservers }
      : { ...BUILT_IN_HOMESERVERS, allowCustom: source.allowCustomHomeservers };
    return {
      push: source.pushNotificationDetails,
      embeds: source.embeds,
      supporter: source.supporterAwards,
      gifs: source.gifs,
      homeservers: withDefaultAt(homeservers, source.defaultHomeserver),
      exploreServers: source.featuredCommunities.servers,
      calls: source.calls,
      searchSharing: source.searchSharing,
      disableAccountSwitcher: source.disableAccountSwitcher,
      settingsDefaults: source.settingsDefaults,
      hideUsernamePasswordFields: source.hideUsernamePasswordFields,
      branding: source.branding,
      links: source.links,
      hideCommunityLinks: source.hideCommunityLinks,
      auth: source.auth,
      settingsLocked: source.settingsLocked,
    };
  })
);
export const EMPTY_RUNTIME_CONFIG = v.parse(RuntimeSchema, {});

function withDefaultAt(homeservers: HomeserversConfig, index: unknown): HomeserversConfig {
  if (index === null) return { ...homeservers, default: '' };
  if (typeof index !== 'number' || !Number.isInteger(index)) return homeservers;
  if (index < 0 || index >= homeservers.list.length) return homeservers;

  return { ...homeservers, default: homeservers.list[index] };
}

export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  const result = v.safeParse(RuntimeSchema, raw);
  return result.success ? result.output : EMPTY_RUNTIME_CONFIG;
}

let loading: Promise<RuntimeConfig> | null = null;

/** Read once per session. A network failure is left uncached so that being
    offline at boot does not disable push until the tab is reloaded. */
export function runtimeConfig(): Promise<RuntimeConfig> {
  loading ??= fetch(asset('config.json'), { cache: 'no-cache' })
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
    .then(parseRuntimeConfig)
    .catch((error: unknown) => {
      console.debug('[sable config] runtime config unavailable', error);
      loading = null;
      return EMPTY_RUNTIME_CONFIG;
    });

  return loading;
}
