<script setup lang="ts">
const open = ref(false)
const root = ref<HTMLElement | null>(null)

const name = computed(() => account.me?.display_name || account.me?.username || '')

const initials = computed(() =>
  name.value
    .split(/[\s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('') || '?',
)

// warna tetap per username agar avatar mudah dikenali
const hue = computed(() => [...(account.me?.username ?? '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360)

const close = () => {
  open.value = false
}

const onOutside = (event: MouseEvent) => {
  if (root.value && !root.value.contains(event.target as Node)) close()
}
const onKey = (event: KeyboardEvent) => {
  if (event.key === 'Escape') close()
}

onMounted(() => {
  document.addEventListener('click', onOutside)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onOutside)
  document.removeEventListener('keydown', onKey)
})

const logout = async () => {
  close()
  await signOut()
  await navigateTo('/login')
}
</script>

<template>
  <div ref="root" class="account">
    <button
      type="button"
      class="avatar"
      :style="{ background: `hsl(${hue} 55% 42%)` }"
      :aria-expanded="open"
      aria-haspopup="menu"
      aria-label="Menu akun"
      @click="open = !open"
    >
      {{ initials }}
    </button>
    <div v-if="open" class="menu" role="menu">
      <div class="who">
        <strong>{{ name }}</strong>
        <span class="muted">@{{ account.me?.username }}</span>
      </div>
      <NuxtLink to="/akun/profil" role="menuitem" @click="close">Edit profil</NuxtLink>
      <NuxtLink to="/akun/password" role="menuitem" @click="close">Ganti password</NuxtLink>
      <button type="button" role="menuitem" class="danger" @click="logout">Keluar</button>
    </div>
  </div>
</template>

<style scoped>
.account { position: relative; }
.avatar {
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: #fff;
  font-weight: 600;
  letter-spacing: .5px;
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 10;
  min-width: 220px;
  display: grid;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
}
.who {
  display: grid;
  padding: 8px 10px 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.menu a, .menu button {
  display: block;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: inherit;
  text-align: left;
  text-decoration: none;
}
.menu a:hover, .menu button:hover { background: var(--bg); }
.menu .danger { color: var(--danger); }
</style>
