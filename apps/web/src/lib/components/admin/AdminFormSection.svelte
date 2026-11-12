<script lang="ts">
  import type { Snippet } from 'svelte';
  // AdminFormSection — a labeled group of form fields inside an AdminSection.
  //
  // Renders an optional heading + optional description, then a responsive
  // grid of fields (defaults to 2 columns on tablet+, 1 on mobile). Use the
  // `columns` prop to opt into 3 or 4 columns when the field set genuinely
  // needs them.
  let {
    heading = '',
    description = '',
    columns = 2,
    children
  }: {
    heading?: string;
    description?: string;
    columns?: 1 | 2 | 3 | 4;
    children: Snippet;
  } = $props();
</script>

<div class="admin-form-section cols-{columns}">
  {#if heading || description}
    <div class="form-section-copy">
      {#if heading}<h3>{heading}</h3>{/if}
      {#if description}<p>{description}</p>{/if}
    </div>
  {/if}
  <div class="form-grid">
    {@render children()}
  </div>
</div>

<style>
  .admin-form-section {
    display: grid;
    gap: 12px;
    padding: 14px 0;
    border-top: 1px solid var(--color-border);
  }
  .admin-form-section:first-of-type { border-top: 0; padding-top: 4px; }
  .form-section-copy { display: grid; gap: 4px; }
  .form-section-copy h3 {
    margin: 0;
    color: var(--color-text);
    font-size: .82rem;
    font-weight: 700;
    letter-spacing: -.005em;
  }
  .form-section-copy p {
    margin: 0;
    color: var(--color-text-muted);
    font-size: .68rem;
    line-height: 1.5;
  }
  .form-grid {
    display: grid;
    gap: 12px;
  }
  .cols-2 .form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cols-3 .form-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .cols-4 .form-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  @media (max-width: 700px) {
    .cols-2 .form-grid,
    .cols-3 .form-grid,
    .cols-4 .form-grid { grid-template-columns: 1fr; }
  }
</style>
