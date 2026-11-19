<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>()
</script>

<template>
  <main class="auth">
    <aside class="panel" aria-hidden="true">
      <div class="panel-top">
        <img src="/favicon.svg" alt="" width="40" height="40">
        <span class="wordmark">seru24</span>
      </div>
      <div class="panel-body">
        <p class="headline">Obrolan yang hanya bisa dibaca kalian berdua.</p>
        <ul>
          <li>Pesan dienkripsi di perangkatmu sebelum dikirim.</li>
          <li>Server hanya menyimpan pesan yang sudah terenkripsi.</li>
          <li>Kode keamanan memastikan lawan bicaramu benar-benar dia.</li>
        </ul>
      </div>
    </aside>

    <section class="form">
      <div class="form-inner stack">
        <p class="mini"><img src="/favicon.svg" alt="" width="28" height="28"> seru24</p>
        <header>
          <h1>{{ title }}</h1>
          <p v-if="subtitle" class="muted">{{ subtitle }}</p>
        </header>
        <slot />
      </div>
    </section>
  </main>
</template>

<style scoped>
.auth { min-height: 100dvh; display: grid; grid-template-columns: minmax(0, 1fr); }

.panel { display: none; }
.form { display: grid; align-items: center; justify-items: center; padding: 28px 20px; }
.form-inner { width: 100%; max-width: 380px; gap: 18px; }

.mini { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-weight: 700; letter-spacing: -.01em; }
h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: -.02em; }
header p.muted { margin: 6px 0 0; font-size: 14px; }

@media (min-width: 900px) {
  .auth { grid-template-columns: minmax(0, 5fr) minmax(0, 4fr); }
  .mini { display: none; }
  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 44px 52px;
    overflow: hidden;
    color: #fff;
    background:
      radial-gradient(70% 55% at 85% 105%, rgb(255 255 255 / 14%), transparent 70%),
      radial-gradient(50% 40% at 0% 0%, rgb(255 255 255 / 10%), transparent 70%),
      linear-gradient(165deg, color-mix(in srgb, var(--accent) 62%, #000), color-mix(in srgb, var(--accent) 88%, #000));
  }
  .panel-top { display: flex; align-items: center; gap: 12px; }
  .wordmark { font-size: 22px; font-weight: 700; letter-spacing: -.02em; }
  .headline { max-width: 15em; margin: 0 0 26px; font-size: 34px; line-height: 1.15; font-weight: 700; letter-spacing: -.025em; }
  ul { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; max-width: 26em; }
  li { padding-left: 18px; position: relative; font-size: 15px; line-height: 1.45; color: rgb(255 255 255 / 82%); }
  li::before { content: ''; position: absolute; left: 0; top: .6em; width: 7px; height: 7px; border-radius: 50%; background: rgb(255 255 255 / 55%); }
}
</style>
