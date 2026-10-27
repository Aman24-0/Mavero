<script lang="ts">
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<AdminPage eyebrow="Mavero / System" title="App Config" accent="cyan">
  {#if form?.notice}
    <p class="ac-notice ac-ok" role="status">{form.notice}</p>
  {:else if form?.message}
    <p class="ac-notice ac-error" role="alert">{form.message}</p>
  {/if}

  <AdminFormSection heading="Social links">
    <p class="a2-field-hint">
      Shown in the footer and the Account menu. Leave a field empty to hide that
      icon; leave both empty to hide the whole row.
    </p>
    <form method="POST" action="?/saveSocial" use:enhance class="ac-form">
      <label class="a2-field"><span>Telegram URL</span>
        <input name="telegram_url" type="url" placeholder="https://t.me/yourchannel" value={data.config.telegramUrl ?? ''} />
      </label>
      <label class="a2-field"><span>Discord URL</span>
        <input name="discord_url" type="url" placeholder="https://discord.gg/yourinvite" value={data.config.discordUrl ?? ''} />
      </label>
      <button type="submit" class="a2-btn a2-btn-primary">Save social links</button>
    </form>
  </AdminFormSection>
</AdminPage>

<style>
  .ac-form { display: flex; flex-direction: column; gap: var(--a2-space-3); max-width: 520px; }
  .ac-notice { margin: 0 0 var(--a2-space-3); padding: var(--a2-space-2) var(--a2-space-3); border-radius: var(--a2-radius-sm); font-size: var(--a2-text-sm); }
  .ac-ok { background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); color: var(--a2-green); }
  .ac-error { background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); color: var(--a2-red); }
</style>
