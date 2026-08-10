<script lang="ts">
	import { Button, Combobox, Label, Switch, Tooltip } from 'bits-ui';
	import logo from '$lib/assets/logo.svg';
	import { useCoreClient } from '$lib/core/context';

	const core = useCoreClient();
	const homeservers = ['matrix.org', 'mozilla.org', 'unredacted.org', 'sable.moe', 'kendama.moe'];
	const homeserverItems = homeservers.map((value) => ({ value, label: value }));
	let homeserver = $state(homeservers[0]);
	let username = $state('');
	let password = $state('');
	let slidingSync = $state(true);
	let loginError = $state<string | null>(null);
	let isStarting = $derived(core.status === 'starting');

	async function login(): Promise<void> {
		loginError = null;

		try {
			await core.login(homeserver.trim(), username.trim(), password);
		} catch {
			loginError = 'Unable to sign in. Check your homeserver and credentials.';
		}
	}
</script>

<svelte:head>
	<title>Sable</title>
</svelte:head>

<Tooltip.Provider>
	<main class="auth-page">
		<section class="auth-card" aria-labelledby="sable-title">
		<header class="auth-header">
			<img class="logo" src={logo} alt="" />
			<h1 id="sable-title">Sable</h1>
		</header>

		{#if core.status === 'starting' || core.status === 'idle'}
			<div class="bootstrap" aria-live="polite">
				<span class="spinner" aria-hidden="true"></span>
				<p>Starting Sable...</p>
			</div>
		{:else if core.status === 'ready'}
			<div class="bootstrap">
				<p>Signed in as <strong>{core.session?.user_id}</strong>.</p>
			</div>
		{:else}
			<form class="login-form" onsubmit={(event) => { event.preventDefault(); void login(); }}>
				<div class="field">
					<Label.Root for="homeserver">Homeserver</Label.Root>
					<Combobox.Root type="single" bind:value={homeserver} items={homeserverItems}>
						<div class="homeserver-input">
							<Combobox.Input
								id="homeserver"
								class="homeserver-field"
								autocapitalize="off"
								autocorrect="off"
								autocomplete="url"
								spellcheck={false}
								required
								oninput={(event) => (homeserver = event.currentTarget.value)}
							/>
							<Combobox.Trigger class="homeserver-trigger" aria-label="Choose homeserver">⌄</Combobox.Trigger>
						</div>
						<Combobox.Portal>
							<Combobox.Content class="homeserver-menu" sideOffset={4}>
								<p>Homeserver list</p>
								<Combobox.Viewport>
									{#each homeservers as server}
										<Combobox.Item value={server} class="homeserver-option">{server}</Combobox.Item>
									{/each}
								</Combobox.Viewport>
							</Combobox.Content>
						</Combobox.Portal>
					</Combobox.Root>
				</div>
				<div class="sliding-sync">
					<div>
						<Label.Root for="sliding-sync">Use sliding sync</Label.Root>
						<Tooltip.Root>
							<Tooltip.Trigger class="info" aria-label="About sliding sync">i</Tooltip.Trigger>
							<Tooltip.Portal>
								<Tooltip.Content class="tooltip" sideOffset={6}>
									Sliding sync is faster and uses less bandwidth, but it can be buggier.
								</Tooltip.Content>
							</Tooltip.Portal>
						</Tooltip.Root>
					</div>
					<Switch.Root id="sliding-sync" bind:checked={slidingSync} class="sync-switch">
						<Switch.Thumb class="sync-thumb" />
					</Switch.Root>
				</div>
				<div class="field">
					<Label.Root for="username">Username</Label.Root>
					<input id="username" bind:value={username} autocomplete="username" required />
				</div>
				<div class="field">
					<Label.Root for="password">Password</Label.Root>
					<input id="password" type="password" bind:value={password} autocomplete="current-password" required />
				</div>

				{#if loginError || core.status === 'error'}
					<p class="error" role="alert">{loginError ?? 'Unable to start Sable.'}</p>
				{/if}

				<Button.Root class="sign-in" type="submit" disabled={isStarting}>
					{isStarting ? 'Signing in...' : 'Sign in'}
				</Button.Root>
			</form>
		{/if}
		</section>
	</main>
</Tooltip.Provider>

<style>
	.auth-page {
		align-items: flex-start;
		background-color: var(--sable-bg-container);
		background-image: radial-gradient(
			var(--sable-bg-container-active) 0.125rem,
			var(--sable-bg-container) 0.125rem
		);
		background-size: 2.5rem 2.5rem;
		box-sizing: border-box;
		display: flex;
		justify-content: center;
		min-height: 100dvh;
		padding: 0;
		position: relative;
	}

	.auth-card {
		background: var(--sable-surface-container);
		min-height: 100dvh;
		width: 100%;
	}

	.auth-header {
		align-items: center;
		border-bottom: 1px solid var(--sable-surface-container-line);
		display: flex;
		gap: 0.625rem;
		padding: 0 1rem;
		min-height: 3.5rem;
	}

	.logo {
		border-radius: 50%;
		height: 1.625rem;
		width: 1.625rem;
	}

	h1 {
		font-size: 1.125rem;
		font-weight: 700;
		letter-spacing: 0;
		margin: 0;
	}

	.login-form,
	.bootstrap {
		display: grid;
		gap: 2.75rem;
		margin: auto;
		max-width: 25.125rem;
		padding: 2.75rem 1rem;
		width: 100%;
	}

	.bootstrap {
		justify-items: center;
		min-height: 8rem;
		place-content: center;
	}

	.bootstrap p {
		color: var(--muted-foreground);
		margin: 0;
	}

	.field {
		display: grid;
		gap: 0.25rem;
	}

	.homeserver-input {
		position: relative;
	}

	:global(.homeserver-field) {
		background: var(--sable-bg-container);
		border: 1px solid var(--sable-bg-container-line);
		border-radius: 0.375rem;
		box-sizing: border-box;
		color: var(--foreground);
		font: inherit;
		min-height: 2.75rem;
		padding-right: 2.75rem;
		padding-left: 0.75rem;
		width: 100%;
	}

	:global(.homeserver-field:focus-visible) {
		border-color: var(--sable-primary-main);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sable-primary-main) 30%, transparent);
		outline: 0;
	}

	:global(.homeserver-trigger) {
		align-items: center;
		background: transparent;
		border: 0;
		color: var(--muted-foreground);
		font-size: 1.25rem;
		height: 2.75rem;
		position: absolute;
		right: 0.25rem;
		top: 0;
		width: 2.5rem;
	}

	:global(.homeserver-menu) {
		background: var(--sable-surface-container);
		border: 1px solid var(--sable-surface-container-line);
		border-radius: 0.375rem;
		box-shadow: 0 0.125rem 0.5rem rgb(0 0 0 / 16%);
		overflow: hidden;
		width: var(--bits-combobox-anchor-width);
	}

	:global(.homeserver-menu p) {
		font-size: 0.75rem;
		font-weight: 700;
		margin: 0;
		padding: 0.5rem 0.75rem 0.25rem;
	}

	:global(.homeserver-option) {
		cursor: pointer;
		display: block;
		padding: 0.5rem 0.75rem;
	}

	:global(.homeserver-option[data-highlighted]) {
		background: var(--sable-surface-container-hover);
	}

	.sliding-sync {
		align-items: center;
		display: flex;
		justify-content: space-between;
		margin-top: -1.25rem;
	}

	.sliding-sync > div {
		align-items: center;
		display: flex;
		gap: 0.375rem;
	}

	:global(.info) {
		align-items: center;
		background: transparent;
		border: 1px solid currentColor;
		border-radius: 50%;
		color: var(--muted-foreground);
		display: inline-flex;
		font-size: 0.625rem;
		font-weight: 800;
		height: 0.875rem;
		justify-content: center;
		padding: 0;
		width: 0.875rem;
	}

	:global(.tooltip) {
		background: var(--sable-surface-container-active);
		border: 1px solid var(--sable-surface-container-line);
		border-radius: 0.375rem;
		box-shadow: 0 0.125rem 0.5rem rgb(0 0 0 / 16%);
		font-size: 0.75rem;
		line-height: 1.35;
		max-width: 15rem;
		padding: 0.5rem;
	}

	:global(.sync-switch) {
		background: var(--sable-bg-container-line);
		border: 0;
		border-radius: 1rem;
		height: 1.25rem;
		padding: 0.125rem;
		width: 2.125rem;
	}

	:global(.sync-switch[data-state='checked']) {
		background: var(--sable-primary-main);
	}

	:global(.sync-thumb) {
		background: var(--sable-primary-on-main);
		border-radius: 50%;
		display: block;
		height: 1rem;
		transform: translateX(0);
		transition: transform 120ms ease;
		width: 1rem;
	}

	:global(.sync-switch[data-state='checked'] .sync-thumb) {
		transform: translateX(0.875rem);
	}

	.field :global(label) {
		font-size: 0.875rem;
		font-weight: 700;
	}

	input {
		background: var(--sable-bg-container);
		border: 1px solid var(--sable-bg-container-line);
		border-radius: 0.375rem;
		box-sizing: border-box;
		color: var(--foreground);
		font: inherit;
		min-height: 2.75rem;
		padding: 0.5rem 0.75rem;
		width: 100%;
	}

	input:focus-visible {
		border-color: var(--sable-primary-main);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sable-primary-main) 30%, transparent);
		outline: 0;
	}

	:global(.sign-in) {
		background: var(--sable-primary-main);
		border: 0;
		border-radius: 0.375rem;
		color: var(--sable-primary-on-main);
		cursor: pointer;
		font: inherit;
		font-weight: 700;
		min-height: 2.75rem;
	}

	:global(.sign-in:hover:not(:disabled)) {
		background: var(--sable-primary-main-hover);
	}

	:global(.sign-in:disabled) {
		cursor: wait;
		opacity: 0.65;
	}

	.error {
		color: var(--sable-critical-main);
		font-size: 0.875rem;
		margin: -1.75rem 0 0;
	}

	.spinner {
		animation: spin 0.8s linear infinite;
		border: 2px solid var(--sable-bg-container-line);
		border-right-color: var(--sable-primary-main);
		border-radius: 50%;
		height: 1.25rem;
		width: 1.25rem;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	@media (min-width: 40rem) {
		.auth-page {
			align-items: center;
			padding: 1rem;
		}

		.auth-card {
			border: 1px solid var(--sable-surface-container-line);
			border-radius: 0.5rem;
			box-shadow: 0 0.125rem 0.5rem rgb(0 0 0 / 16%);
			max-width: 28.75rem;
			min-height: 0;
			overflow: hidden;
		}
	}

</style>
