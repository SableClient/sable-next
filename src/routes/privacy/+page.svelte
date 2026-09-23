<svelte:head>
  <title>Privacy Policy - Sable</title>
</svelte:head>

<main class="privacy-page">
  <article class="privacy-content">
    <h1>Privacy Policy</h1>
    <p class="effective">Effective date: 2026-09-23</p>

    <p>
      Sable is an open-source Matrix client developed by the SableClient team, for the web, desktop,
      Android and iOS. It runs on your device and talks directly to the homeserver you choose. Your
      homeserver stores your account, messages and rooms under its own privacy policy.
    </p>

    <h2>Who is responsible</h2>
    <p>
      For official Sable builds, the data controller is the SableClient team:
      <a href="mailto:privacy@sable.moe">privacy@sable.moe</a>. Self-hosted, modified or third-party
      builds are the responsibility of whoever runs them.
    </p>

    <h2>What we collect</h2>
    <p>
      Nothing, unless you turn on error reporting, which is off by default. With it on, Sable sends:
    </p>
    <ul>
      <li>error messages and stack traces</li>
      <li>device, browser or operating system name and version</li>
      <li>app version and environment</li>
      <li>performance timings, such as page load, sync or message sending</li>
    </ul>
    <p>
      Matrix IDs and other sensitive values are removed on your device before sending. On desktop
      and mobile, native crash reports follow the same setting.
    </p>

    <h2>What we do not collect</h2>
    <ul>
      <li>message content</li>
      <li>room names or aliases</li>
      <li>display names or avatars</li>
      <li>contacts or room member lists</li>
      <li>passwords or access tokens</li>
      <li>encryption keys</li>
      <li>your location</li>
    </ul>

    <h2>Optional features</h2>
    <h3>Session replay</h3>
    <p>
      Off by default, and only available with error reporting on. All text, inputs and media are
      masked on your device before sending.
    </p>
    <h3>Bug reports</h3>
    <p>
      A bug report contains what you write, your platform and app version, and any logs you attach.
    </p>
    <h3>Push notifications</h3>
    <p>
      Your homeserver sends notifications through sygnal.sable.moe, which forwards them to your
      device's push service: your browser vendor, Google Firebase, Apple or a UnifiedPush
      distributor. The gateway does not store them.
    </p>
    <p>
      By default a notification carries the message, so it can be shown without waiting for a sync.
      Encrypted messages stay encrypted. In unencrypted rooms, the gateway and the push service can
      read the message. Turn off Rich push payloads in Settings → Notifications to send only the
      room and event IDs.
    </p>
    <h3>GIF search</h3>
    <p>GIF searches go through gifs.sable.moe, so the GIF provider does not see your IP address.</p>
    <h3>Maps</h3>
    <p>
      Shared locations are shown with map tiles from OpenStreetMap, which sees your IP address when
      it serves them.
    </p>

    <h2>Device permissions</h2>
    <p>
      The mobile apps ask for a permission only when you use the feature that needs it, and you can
      revoke it in your system settings:
    </p>
    <ul>
      <li>camera and microphone, for calls and recording</li>
      <li>location, to share your location in a room</li>
      <li>photos, to save images and videos</li>
      <li>notifications, to alert you of new messages</li>
    </ul>
    <p>What you capture is sent only to the rooms you choose.</p>

    <h2>Sentry</h2>
    <p>
      Error reports go to Sentry, under its own
      <a href="https://sentry.io/privacy/">privacy policy</a>. Sentry may process them outside your
      country, using Standard Contractual Clauses where required. Reports are kept for the Sentry
      project's retention period. Sable keeps no copy.
    </p>

    <h2>Your controls</h2>
    <p>
      The first time you open Sable, a notice asks whether to turn on error reporting. Dismissing it
      leaves it off. You can change it in Settings → Privacy. Signing out removes your session and
      local data from the device, as does uninstalling the app. To delete your account, ask your
      homeserver.
    </p>

    <h2>Legal basis</h2>
    <p>
      For users in the European Economic Area, diagnostic data is processed with your consent, which
      you can withdraw at any time.
    </p>

    <h2>Children</h2>
    <p>
      Sable is not meant for children under 13. If a child has sent us information, contact
      <a href="mailto:privacy@sable.moe">privacy@sable.moe</a> and we will remove it.
    </p>

    <h2>Changes</h2>
    <p>Changes to this policy are published on this page.</p>

    <h2>Contact</h2>
    <p>
      For questions, or to delete data from a bug report:
      <a href="mailto:privacy@sable.moe">privacy@sable.moe</a>.
    </p>
  </article>
</main>

<style>
  .privacy-page {
    background: var(--surface-container);
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: var(--space-700) var(--page-gutter);
  }

  .privacy-content {
    max-width: 42rem;
    width: 100%;
  }

  .privacy-content h1 {
    font-size: var(--font-size-display);
    margin: 0;
  }

  .privacy-content h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: var(--space-700) 0 var(--space-200);
  }

  .privacy-content h3 {
    font-size: var(--font-size-subheading);
    margin: var(--space-500) 0 var(--space-100);
  }

  .privacy-content p,
  .privacy-content ul {
    margin: 0 0 var(--space-300);
  }

  .effective {
    color: var(--surface-var-on-container);
  }

  .privacy-content a {
    color: var(--primary-main);
  }
</style>
