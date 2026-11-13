<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>()
</script>

<template>
  <main class="auth">
    <section class="card stack">
      <header>
        <p class="brand">seru24</p>
        <h1>{{ title }}</h1>
        <p v-if="subtitle" class="muted">{{ subtitle }}</p>
      </header>
      <slot />
    </section>
  </main>
</template>

<style scoped>
.auth {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 16px;
}
.card {
  width: 100%;
  max-width: 400px;
  padding: 28px 24px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.brand { margin: 0; color: var(--accent); font-weight: 700; letter-spacing: .5px; }
h1 { margin: 4px 0 0; font-size: 22px; }
header p.muted { margin: 6px 0 0; }
</style>
