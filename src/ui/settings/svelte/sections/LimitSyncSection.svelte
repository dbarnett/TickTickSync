<script lang="ts">
	import CollapsibleSection from '@/ui/settings/svelte/sections/CollapsibleSection.svelte'
	import { createEventDispatcher } from 'svelte';
	import { onMount } from 'svelte';
	import { settingsStore } from '@/ui/settings/settingsstore';

	export let open = false;
	export let plugin;

	let syncTag = '';
	let debounceTimeout: ReturnType<typeof setTimeout>;

	const dispatch = createEventDispatcher();

	function handleHeaderClick() {
		dispatch('toggle');
	}

	// Sync with store on load and change
	$: syncTag = $settingsStore.SyncTag ?? '';

	function handleSyncTagChange(value: string) {
		syncTag = value;
		settingsStore.update((s) => ({ ...s, SyncTag: value }));
		if (debounceTimeout) clearTimeout(debounceTimeout);
		debounceTimeout = setTimeout(async () => {
			await plugin.saveSettings();
		}, 800);
	}
	onMount(async () => {
		syncTag = $settingsStore.SyncTag ?? '';
	});
</script>

<CollapsibleSection
	title="Limit synchronization"
	shortDesc="Synchronization settings added for effect"
	open={open}
	on:headerClick={handleHeaderClick}
>
	<div class="setting-item-description">
		To limit the tasks TickTickSync will synchronize from TickTick to
		Obsidian, enter a tag below. If a tag is entered, only tasks with
		that tag will be synchronized.
	</div>

	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Tag</div>
			<div class="setting-item-description">Tag value, no "#".</div>
		</div>
		<div class="setting-item-control">
			<input
				id="sync-tag"
				type="text"
				bind:value={syncTag}
				placeholder="Only tasks with this tag will be synced"
				on:input={(e: Event) => {
					handleSyncTagChange((e.target as HTMLInputElement).value);}}
			/>
		</div>
	</div>

	<div class="sync-explanation">
		{#if !syncTag}
			<p>No limitation.</p>
		{:else}
			<p>Only tasks tagged with <b>#{syncTag}</b> will be synchronized</p>
		{/if}
	</div>

</CollapsibleSection>
