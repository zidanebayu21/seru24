<script setup lang="ts">
import { parseAppRelease, type AppRelease } from '#shared/app-release'

const open = ref(false)
const androidRelease = ref<AppRelease | null>(null)
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
  // versi APK Android terbaru dan link Google Drive-nya (diunggah release_apk.ps1)
  fetch('/api/app/latest')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => { androidRelease.value = parseAppRelease(data?.latest) })
    .catch(() => undefined)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onOutside)
  document.removeEventListener('keydown', onKey)
})

const theme = useTheme()
const notifyHint = ref('')

const toggleNotifications = async () => {
  notifyHint.value = ''
  if (notifyState.enabled) {
    disableNotifications()
    return
  }
  if (!(await enableNotifications())) {
    notifyHint.value = 'Izin notifikasi diblokir. Aktifkan lewat ikon gembok di address bar browser.'
  }
}

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
      <NuxtLink to="/akun/profil" role="menuitem" @click="close">Profil &amp; penyimpanan</NuxtLink>
      <NuxtLink to="/akun/password" role="menuitem" @click="close">Ganti password</NuxtLink>
      <button
        v-if="notifyState.supported"
        type="button"
        role="menuitemcheckbox"
        class="toggle"
        :aria-checked="notifyState.enabled"
        @click="toggleNotifications"
      >
        <span>Notifikasi</span>
        <span class="switch" :class="{ on: notifyState.enabled }" aria-hidden="true" />
      </button>
      <p v-if="notifyHint" class="hint">{{ notifyHint }}</p>
      <div class="themes" role="group" aria-label="Tema tampilan">
        <span class="muted">Tema</span>
        <div class="theme-options">
          <button
            v-for="option in theme.options"
            :key="option.value"
            type="button"
            :class="{ active: theme.pref.value === option.value }"
            :aria-pressed="theme.pref.value === option.value"
            @click="theme.setTheme(option.value)"
          >{{ option.label }}</button>
        </div>
      </div>
      <a
        v-if="androidRelease"
        :href="androidRelease.url"
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        @click="close"
      >Unduh aplikasi Android v{{ androidRelease.versionName }}</a>
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
.menu .toggle { display: flex; justify-content: space-between; align-items: center; }
.switch {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: var(--border);
  transition: background .15s;
}
.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--surface);
  transition: transform .15s;
}
.switch.on { background: var(--accent); }
.switch.on::after { transform: translateX(14px); }
.themes { padding: 6px 10px 8px; }
.theme-options { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.menu .theme-options button {
  width: auto;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
}
.menu .theme-options button.active { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.hint { margin: 0; padding: 4px 10px 8px; font-size: 12px; color: var(--danger); }
</style>
